import { Inject, Injectable, Optional, ServiceUnavailableException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../database/database.service.js";
import { LedgerType, Prisma } from "../generated/prisma/client.js";
import { CreditAccountService, InsufficientCreditsException } from "./credit-account.service.js";

export interface DirectCreditReservation {
  id: string;
  accountId: string;
  apiKeyId?: string;
  requestId: string;
  amountMicro: number;
  unlimited: boolean;
  persistent: boolean;
}

function safeMicro(value: unknown): number {
  const parsed = Math.ceil(Number(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ServiceUnavailableException("Nilai billing request tidak valid.");
  return parsed;
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

@Injectable()
export class DirectCreditService {
  private readonly reservations = new Map<string, DirectCreditReservation>();

  constructor(
    @Inject(CreditAccountService) private readonly memory: CreditAccountService,
    @Optional() @Inject(DatabaseService) private readonly database?: DatabaseService,
  ) {}

  async reserve(accountId: string, apiKeyId: string | undefined, requestId: string, amountMicro: number): Promise<DirectCreditReservation> {
    const amount = safeMicro(amountMicro);
    if (!this.usesPostgres()) {
      const reservation = this.memory.reserve(accountId, requestId, amount);
      return { ...reservation, apiKeyId, unlimited: false, persistent: false };
    }
    const client = this.database!.client();
    const entitlement = await client.user.findUnique({ where: { id: accountId }, select: { unlimitedCredits: true } });
    if (!entitlement) throw new ServiceUnavailableException("Akun gateway tidak ditemukan.");
    const id = randomUUID();
    const reservation: DirectCreditReservation = {
      id,
      accountId,
      apiKeyId,
      requestId,
      amountMicro: entitlement.unlimitedCredits ? 0 : amount,
      unlimited: entitlement.unlimitedCredits,
      persistent: true,
    };
    if (reservation.unlimited) {
      this.reservations.set(id, reservation);
      return reservation;
    }
    await client.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "user_credits" WHERE "userId" = ${accountId} FOR UPDATE`);
      const account = await tx.userCreditAccount.findUnique({ where: { userId: accountId } });
      const available = account ? account.balanceMicro - account.reservedMicro : 0n;
      if (!account || available < BigInt(amount)) {
        throw new InsufficientCreditsException(Number(available), amount, requestId);
      }
      const trustedKey = apiKeyId
        ? await tx.apiKey.findFirst({ where: { id: apiKeyId, userId: accountId }, select: { id: true } })
        : null;
      reservation.apiKeyId = trustedKey?.id;
      const updated = await tx.userCreditAccount.update({
        where: { id: account.id },
        data: { reservedMicro: { increment: BigInt(amount) } },
      });
      await tx.creditLedger.create({
        data: {
          accountId: account.id,
          apiKeyId: trustedKey?.id,
          type: LedgerType.AI_RESERVATION,
          amountMicro: -BigInt(amount),
          balanceAfterMicro: updated.balanceMicro,
          idempotencyKey: `direct-reserve:${accountId}:${requestId}`,
          description: "Reserve biaya AI request langsung",
          costSnapshot: jsonValue({ requestId, reservationId: id, reservedMicro: amount }),
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    this.reservations.set(id, reservation);
    return reservation;
  }

  async settle(reservation: DirectCreditReservation, actualMicro: number): Promise<void> {
    const actual = reservation.unlimited ? 0 : safeMicro(actualMicro);
    if (!reservation.persistent) {
      this.memory.settle(reservation.id, actual);
      return;
    }
    this.reservations.delete(reservation.id);
    if (reservation.unlimited) return;
    const client = this.database!.client();
    await client.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "user_credits" WHERE "userId" = ${reservation.accountId} FOR UPDATE`);
      const account = await tx.userCreditAccount.findUniqueOrThrow({ where: { userId: reservation.accountId } });
      const reserved = BigInt(reservation.amountMicro);
      const actualValue = BigInt(actual);
      const reservedForOthers = account.reservedMicro - reserved;
      if (reservedForOthers < 0n || account.balanceMicro - reservedForOthers < actualValue) {
        throw new InsufficientCreditsException(Number(account.balanceMicro - account.reservedMicro), actual, reservation.requestId);
      }
      const updated = await tx.userCreditAccount.update({
        where: { id: account.id },
        data: {
          balanceMicro: { decrement: actualValue },
          reservedMicro: { decrement: reserved },
          lifetimeSpentMicro: { increment: actualValue },
        },
      });
      const released = reserved > actualValue ? reserved - actualValue : 0n;
      if (released > 0n) {
        await tx.creditLedger.create({
          data: {
            accountId: account.id,
            apiKeyId: reservation.apiKeyId,
            type: LedgerType.AI_RESERVATION_RELEASE,
            amountMicro: released,
            balanceAfterMicro: updated.balanceMicro,
            idempotencyKey: `direct-release:${reservation.accountId}:${reservation.requestId}`,
            description: "Release sisa reserve AI request langsung",
          },
        });
      }
      if (actualValue > 0n) {
        await tx.creditLedger.create({
          data: {
            accountId: account.id,
            apiKeyId: reservation.apiKeyId,
            type: LedgerType.AI_SETTLEMENT,
            amountMicro: -actualValue,
            balanceAfterMicro: updated.balanceMicro,
            idempotencyKey: `direct-settle:${reservation.accountId}:${reservation.requestId}`,
            description: "Settlement biaya AI request langsung",
          },
        });
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async release(reservation: DirectCreditReservation): Promise<void> {
    if (!reservation.persistent) {
      this.memory.release(reservation.id);
      return;
    }
    this.reservations.delete(reservation.id);
    if (reservation.unlimited || reservation.amountMicro <= 0) return;
    const client = this.database!.client();
    await client.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "user_credits" WHERE "userId" = ${reservation.accountId} FOR UPDATE`);
      const account = await tx.userCreditAccount.findUniqueOrThrow({ where: { userId: reservation.accountId } });
      const reserved = BigInt(reservation.amountMicro);
      if (account.reservedMicro < reserved) return;
      const updated = await tx.userCreditAccount.update({
        where: { id: account.id },
        data: { reservedMicro: { decrement: reserved } },
      });
      await tx.creditLedger.createMany({
        data: [{
          accountId: account.id,
          apiKeyId: reservation.apiKeyId,
          type: LedgerType.AI_RESERVATION_RELEASE,
          amountMicro: reserved,
          balanceAfterMicro: updated.balanceMicro,
          idempotencyKey: `direct-failed-release:${reservation.accountId}:${reservation.requestId}`,
          description: "Release reserve karena AI request gagal",
        }],
        skipDuplicates: true,
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private usesPostgres(): boolean {
    const enabled = String(process.env.ANALYSIS_BILLING_STORAGE || (process.env.NODE_ENV === "production" ? "postgres" : "memory")).toLowerCase() === "postgres";
    if (enabled && !this.database?.configured()) throw new ServiceUnavailableException("Direct billing membutuhkan PostgreSQL yang aktif.");
    return enabled;
  }
}

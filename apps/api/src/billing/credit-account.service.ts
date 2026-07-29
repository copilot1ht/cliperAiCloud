import { ForbiddenException, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";

export type CreditTransactionType = "reserve" | "settle" | "release" | "grant" | "adjustment";

export interface CreditTransactionRecord {
  id: string;
  accountId: string;
  requestId: string;
  type: CreditTransactionType;
  amountMicro: number;
  balanceAfterMicro: number;
  reservedAfterMicro: number;
  createdAt: string;
}

export interface CreditAccountState {
  accountId: string;
  balanceMicro: number;
  reservedMicro: number;
}

export interface CreditReservation {
  id: string;
  accountId: string;
  requestId: string;
  amountMicro: number;
}

export class InsufficientCreditsException extends HttpException {
  constructor(availableMicro: number, requiredMicro: number, requestId?: string) {
    super({
      ok: false,
      code: "INSUFFICIENT_CREDITS",
      message: "Saldo Cliper Credits tidak mencukupi.",
      availableCredits: Number((availableMicro / 1_000_000).toFixed(6)),
      requiredCredits: Number((requiredMicro / 1_000_000).toFixed(6)),
      minimumTopupIdr: Number(process.env.PAYMENT_MIN_TOPUP_IDR || 25_000),
      topupUrl: String(process.env.CLIPER_TOPUP_URL || `${String(process.env.WEB_ORIGIN || "http://localhost:3000").replace(/\/$/, "")}/topup`),
      requestId,
    }, HttpStatus.PAYMENT_REQUIRED);
  }
}

function safeMicro(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isSafeInteger(Math.ceil(parsed))) throw new Error("Nilai credit micro tidak valid.");
  return Math.ceil(parsed);
}

@Injectable()
export class CreditAccountService {
  private readonly accounts = new Map<string, CreditAccountState>();
  private readonly reservations = new Map<string, CreditReservation>();
  private readonly reservationByRequest = new Map<string, string>();
  private readonly transactionsValue: CreditTransactionRecord[] = [];

  reserve(accountId: string, requestId: string, amountMicro: number): CreditReservation {
    const requestKey = `${accountId}:${requestId}`;
    const existingId = this.reservationByRequest.get(requestKey);
    const existing = existingId ? this.reservations.get(existingId) : undefined;
    if (existing) return { ...existing };
    const account = this.account(accountId);
    const amount = safeMicro(amountMicro);
    const available = account.balanceMicro - account.reservedMicro;
    if (available < amount) throw new InsufficientCreditsException(available, amount, requestId);
    const reservation = { id: randomUUID(), accountId, requestId, amountMicro: amount };
    account.reservedMicro += amount;
    this.reservations.set(reservation.id, reservation);
    this.reservationByRequest.set(requestKey, reservation.id);
    this.record(account, requestId, "reserve", -amount);
    return { ...reservation };
  }

  settle(reservationId: string, actualMicro: number): CreditAccountState {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) throw new Error("Credit reservation tidak ditemukan atau sudah diselesaikan.");
    const account = this.account(reservation.accountId);
    const actual = safeMicro(actualMicro);
    const reservedForOthers = Math.max(0, account.reservedMicro - reservation.amountMicro);
    const availableForSettlement = account.balanceMicro - reservedForOthers;
    if (availableForSettlement < actual) {
      throw new ForbiddenException("Saldo credit berubah dan tidak cukup saat settlement.");
    }
    account.reservedMicro = reservedForOthers;
    account.balanceMicro -= actual;
    this.reservations.delete(reservationId);
    this.reservationByRequest.delete(`${reservation.accountId}:${reservation.requestId}`);
    const released = Math.max(0, reservation.amountMicro - actual);
    if (released > 0) this.record(account, reservation.requestId, "release", released);
    this.record(account, reservation.requestId, "settle", -actual);
    return { ...account };
  }

  increaseReservation(reservationId: string, additionalMicro: number): CreditReservation {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) throw new Error("Credit reservation tidak ditemukan atau sudah diselesaikan.");
    const additional = safeMicro(additionalMicro);
    if (additional === 0) return { ...reservation };
    const account = this.account(reservation.accountId);
    const available = account.balanceMicro - account.reservedMicro;
    if (available < additional) throw new ForbiddenException("Saldo credit tidak cukup untuk biaya pemakaian aktual.");
    account.reservedMicro += additional;
    reservation.amountMicro += additional;
    this.record(account, reservation.requestId, "reserve", -additional);
    return { ...reservation };
  }

  release(reservationId: string): CreditAccountState | undefined {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return undefined;
    const account = this.account(reservation.accountId);
    account.reservedMicro = Math.max(0, account.reservedMicro - reservation.amountMicro);
    this.reservations.delete(reservationId);
    this.reservationByRequest.delete(`${reservation.accountId}:${reservation.requestId}`);
    this.record(account, reservation.requestId, "release", reservation.amountMicro);
    return { ...account };
  }

  grant(accountId: string, amountMicro: number, reference = "manual-grant"): CreditAccountState {
    const account = this.account(accountId);
    const amount = safeMicro(amountMicro);
    account.balanceMicro += amount;
    this.record(account, reference, "grant", amount);
    return { ...account };
  }

  initialize(accountId: string, balanceMicro: number): CreditAccountState {
    const existing = this.accounts.get(accountId);
    if (existing) return { ...existing };
    const account = { accountId, balanceMicro: safeMicro(balanceMicro), reservedMicro: 0 };
    this.accounts.set(accountId, account);
    this.record(account, "account-initialized", "grant", account.balanceMicro);
    return { ...account };
  }

  setBalance(accountId: string, balanceMicro: number, reference = "admin-balance-adjustment"): CreditAccountState {
    const account = this.account(accountId);
    const nextBalance = safeMicro(balanceMicro);
    if (nextBalance < account.reservedMicro) throw new ForbiddenException("Saldo baru tidak boleh lebih kecil dari credit yang sedang direservasi.");
    const delta = nextBalance - account.balanceMicro;
    account.balanceMicro = nextBalance;
    this.record(account, reference, "adjustment", delta);
    return { ...account };
  }

  balance(accountId: string): CreditAccountState & { availableMicro: number } {
    const account = this.account(accountId);
    return { ...account, availableMicro: account.balanceMicro - account.reservedMicro };
  }

  transactions(accountId?: string): CreditTransactionRecord[] {
    return this.transactionsValue.filter((item) => !accountId || item.accountId === accountId).map((item) => ({ ...item }));
  }

  private account(accountId: string): CreditAccountState {
    let account = this.accounts.get(accountId);
    if (!account) {
      const initial = safeMicro(process.env.CLIPER_DEV_CREDIT_BALANCE_MICRO || 1_000_000_000_000);
      account = { accountId, balanceMicro: initial, reservedMicro: 0 };
      this.accounts.set(accountId, account);
    }
    return account;
  }

  private record(account: CreditAccountState, requestId: string, type: CreditTransactionType, amountMicro: number): void {
    this.transactionsValue.unshift({
      id: randomUUID(), accountId: account.accountId, requestId, type, amountMicro,
      balanceAfterMicro: account.balanceMicro, reservedAfterMicro: account.reservedMicro, createdAt: new Date().toISOString(),
    });
    if (this.transactionsValue.length > 1000) this.transactionsValue.length = 1000;
  }
}

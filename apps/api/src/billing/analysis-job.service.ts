import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { type JobPricingQuote } from "@cliper/billing";
import { randomUUID } from "node:crypto";
import type { AiModule, CliperChatRequest, CliperInternalChatResponse } from "@cliper/contracts";
import { DatabaseService } from "../database/database.service.js";
import { AnalysisJobStatus, LedgerType, Prisma } from "../generated/prisma/client.js";
import { CreditAccountService, InsufficientBalanceException } from "./credit-account.service.js";
import { PricingService } from "./pricing.service.js";

export type AnalysisJobStatusValue = "active" | "completed" | "failed";

export interface StartAnalysisJobInput {
  requestId?: string;
  sourceId?: string;
  sourceDurationSeconds?: number;
  requestedClipCount?: number;
}

export interface CompleteAnalysisJobInput {
  jobId?: string;
  clipScores?: number[];
  usableResult?: boolean;
}

interface AnalysisJobRecord {
  id: string;
  requestId: string;
  accountId: string;
  sourceId: string;
  sourceDurationSeconds: number;
  requestedClipCount: number;
  reservationId: string;
  reservedMicro: number;
  providerCostUsd: number;
  providerCostIdr: number;
  requestCount: number;
  modules: Partial<Record<AiModule, number>>;
  status: AnalysisJobStatusValue;
  clipScores: number[];
  finalChargeMicro: number;
  releasedMicro: number;
  quote?: JobPricingQuote;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
function usdToMicro(value: number): number {
  return Math.ceil(Math.max(0, Number(value || 0)) * 1_000_000);
}

function microToUsd(value: bigint | number): number {
  return Number(value) / 1_000_000;
}


function safePositiveNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function safeClipCount(value: unknown): number {
  // Zero is the desktop contract for "all qualified recommendations". This
  // is not converted to a hidden product cap; provider-cost and wallet guards
  // still protect the analysis job.
  return Math.max(0, Math.min(10_000, Math.floor(safePositiveNumber(value))));
}

function safeScores(value: unknown, maximum: number): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, Math.max(1, maximum))
    .map((score) => Math.max(0, Math.min(100, Number(score || 0))));
}

function configuredClipLimit(): number {
  const configured = Math.floor(Number(process.env.MAX_CLIPS_PER_JOB || 0));
  // Zero means adaptive: the timeline and quality engine determine the count.
  return Number.isFinite(configured) && configured > 0 ? configured : 0;
}

function settlementScoreLimit(): number {
  const configured = Math.floor(Number(process.env.MAX_SETTLEMENT_CLIP_SCORES || 1_000));
  return Number.isFinite(configured) && configured > 0 ? configured : 1_000;
}

function staleJobMinutes(): number {
  const configured = Math.floor(Number(process.env.ANALYSIS_JOB_STALE_MINUTES || 12 * 60));
  return Number.isFinite(configured)
    ? Math.max(60, Math.min(7 * 24 * 60, configured))
    : 12 * 60;
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function snapshotMicroUsd(value: unknown, fallback: bigint): bigint {
  try {
    const parsed = BigInt(String(value ?? ""));
    return parsed;
  } catch {
    return fallback;
  }
}


function jobQuoteSnapshot(quote: JobPricingQuote): Record<string, unknown> {
  return {
    providerCostMicroUsd: quote.providerCostMicroUsd.toString(),
    internalCostMicroUsd: quote.internalCostMicroUsd.toString(),
    protectedChargeMicroUsd: quote.protectedChargeMicroUsd.toString(),
    userChargeMicroUsd: quote.userChargeMicroUsd.toString(),
    reservationMicroUsd: quote.reservationMicroUsd.toString(),
    reservationCapped: quote.reservationCapped,
    grossProfitMicroUsd: quote.grossProfitMicroUsd.toString(),
    grossMarginBps: quote.grossMarginBps,
    capSafe: quote.capSafe,
    budgetStatus: quote.budgetStatus,
  };
}

function statusValue(value: AnalysisJobStatus): AnalysisJobStatusValue {
  if (value === AnalysisJobStatus.COMPLETED) return "completed";
  if (value === AnalysisJobStatus.FAILED || value === AnalysisJobStatus.CANCELLED) return "failed";
  return "active";
}

@Injectable()
export class AnalysisJobService {
  private readonly jobs = new Map<string, AnalysisJobRecord>();
  private readonly jobByRequest = new Map<string, string>();

  constructor(
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(CreditAccountService) private readonly credits: CreditAccountService,
    @Optional() @Inject(DatabaseService) private readonly database?: DatabaseService,
  ) {}

  async start(accountId: string, input: StartAnalysisJobInput, apiKeyId?: string) {
    return this.usesPostgres()
      ? this.startPersistent(accountId, input, apiKeyId)
      : this.startMemory(accountId, input);
  }

  async assertProviderCallAllowed(
    jobId: string,
    accountId: string,
    request: CliperChatRequest,
    estimatedProviderCostUsd: number,
  ): Promise<void> {
    const job = this.usesPostgres()
      ? await this.persistentJob(jobId, accountId, true)
      : this.activeMemoryJob(jobId, accountId);
    const policy = this.pricingPolicy();
    const currentProviderCostMicroUsd = "providerCostMicroUsd" in job
      ? job.providerCostMicroUsd
      : BigInt(usdToMicro(job.providerCostUsd));
    const estimatedCostMicroUsd = BigInt(usdToMicro(estimatedProviderCostUsd));
    const projectedProviderCostMicroUsd = currentProviderCostMicroUsd + estimatedCostMicroUsd;
    if (projectedProviderCostMicroUsd > BigInt(policy.hardProviderCostMicroUsd)) {
      throw new ServiceUnavailableException({
        code: "COST_LIMIT_REACHED",
        message: "Budget AI job tercapai. Hasil terbaik yang sudah tersedia akan digunakan.",
        jobId,
      });
    }
    const module = this.pricing.moduleForRequest(request);
    const optionalModule = module === "title" || module === "hook" || module === "metadata" || module === "caption";
    if (optionalModule && currentProviderCostMicroUsd >= BigInt(policy.warningProviderCostMicroUsd)) {
      throw new ServiceUnavailableException({
        code: "COST_LIMIT_REACHED",
        message: "Budget warning tercapai; rewrite opsional dihentikan dan fallback lokal digunakan.",
        jobId,
      });
    }
    const projectedQuote = this.pricing.quoteAnalysisJob({
      providerCostMicroUsd: projectedProviderCostMicroUsd,
      usableResult: true,
    });
    const reservedMicro = "reservedCreditMicro" in job
      ? job.reservedCreditMicro
      : BigInt(job.reservedMicro);
    const unlimited = "pricingSnapshot" in job
      && objectValue(job.pricingSnapshot).unlimitedCredits === true;
    if (!unlimited && (!projectedQuote.capSafe || projectedQuote.userChargeMicroUsd > reservedMicro)) {
      throw new ServiceUnavailableException({
        code: "COST_LIMIT_REACHED",
        message: "Estimasi biaya berikutnya melewati reservation job. Fallback lokal akan digunakan.",
        jobId,
      });
    }
  }

  async recordProviderUsage(
    jobId: string,
    accountId: string,
    response: CliperInternalChatResponse,
    module: AiModule,
  ): Promise<void> {
    if (!this.usesPostgres()) {
      const job = this.activeMemoryJob(jobId, accountId);
      job.providerCostUsd = Number((job.providerCostUsd + Math.max(0, response.billing.provider_cost_usd)).toFixed(9));
      job.providerCostIdr = this.pricing.providerCostIdr(job.providerCostUsd);
      job.requestCount += 1;
      job.modules[module] = (job.modules[module] || 0) + 1;
      job.updatedAt = new Date().toISOString();
      return;
    }
    const client = this.database!.client();
    const job = await this.persistentJob(jobId, accountId, true);
    const providerCostMicroUsd = job.providerCostMicroUsd
      + BigInt(Math.ceil(Math.max(0, response.billing.provider_cost_usd) * 1_000_000));
    const modules = objectValue(job.modules);
    modules[module] = Number(modules[module] || 0) + 1;
    await client.analysisJob.update({
      where: { id: job.id },
      data: {
        providerCostMicroUsd,
        providerCostIdr: this.pricing.providerCostIdr(Number(providerCostMicroUsd) / 1_000_000),
        requestCount: { increment: 1 },
        modules: jsonValue(modules),
      },
    });
  }

  async complete(accountId: string, input: CompleteAnalysisJobInput) {
    return this.usesPostgres()
      ? this.completePersistent(accountId, input)
      : this.completeMemory(accountId, input);
  }

  async fail(accountId: string, jobId: string, reason = "analysis_failed") {
    return this.usesPostgres()
      ? this.failPersistent(accountId, jobId, reason)
      : this.failMemory(accountId, jobId, reason);
  }

  async walletSummary(accountId: string) {
    if (!this.usesPostgres()) return this.memoryWalletSummary(accountId);
    await this.recoverStalePersistentJobs(accountId);
    const [account, user] = await Promise.all([
      this.database!.client().userCreditAccount.findUnique({ where: { userId: accountId } }),
      this.database!.client().user.findUnique({ where: { id: accountId }, select: { unlimitedCredits: true } }),
    ]);
    const balanceMicro = account?.balanceMicro || 0n;
    const reservedMicro = account?.reservedMicro || 0n;
    const payload = this.walletPayload(Number(balanceMicro), Number(reservedMicro));
    return user?.unlimitedCredits
      ? {
        ...payload,
        availableMicroUsd: Number.MAX_SAFE_INTEGER,
        availableUsd: Number.MAX_SAFE_INTEGER / 1_000_000,
        spendableMicroUsd: Number.MAX_SAFE_INTEGER,
        spendableUsd: Number.MAX_SAFE_INTEGER / 1_000_000,
        billingMode: "per_job_usd",
        keyType: "internal",
        cloudConnected: true,
        billingEligible: true,
        balanceStatus: "unlimited",
        unlimited: true,
      }
      : payload;
  }

  async summary() {
    if (!this.usesPostgres()) return this.memorySummary();
    await this.recoverStalePersistentJobs();
    const jobs = await this.database!.client().analysisJob.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { account: { select: { balanceMicro: true, reservedMicro: true } } },
    });
    const completed = jobs.filter((job) => job.status === AnalysisJobStatus.COMPLETED);
    const providerCostIdr = completed.reduce(
      (total, job) => total + this.pricing.microUsdToIdr(job.providerCostMicroUsd),
      0,
    );
    const customerRevenueIdr = completed.reduce(
      (total, job) => total + this.pricing.microUsdToIdr(job.finalChargeMicro),
      0,
    );
    const internalCostIdr = completed.reduce((total, job) => {
      const snapshot = objectValue(job.pricingSnapshot);
      const internalCostMicroUsd = snapshotMicroUsd(
        snapshot.internalCostMicroUsd,
        job.providerCostMicroUsd,
      );
      return total + this.pricing.microUsdToIdr(internalCostMicroUsd);
    }, 0);
    return {
      storage: "postgres",
      total: jobs.length,
      active: jobs.filter((job) => job.status === AnalysisJobStatus.ACTIVE).length,
      completed: completed.length,
      failed: jobs.filter((job) => job.status === AnalysisJobStatus.FAILED).length,
      providerCostIdr,
      customerRevenueIdr,
      grossProfitIdr: customerRevenueIdr - internalCostIdr,
      usdCharged: completed.reduce(
        (total, job) => total + microToUsd(job.finalChargeMicro),
        0,
      ),
      recent: jobs.slice(0, 12).map((job) => this.adminPersistentJob(job)),
    };
  }

  storageMode(): "memory" | "postgres" {
    return this.usesPostgres() ? "postgres" : "memory";
  }

  private usesPostgres(): boolean {
    const configured = String(
      process.env.ANALYSIS_BILLING_STORAGE
      || (process.env.NODE_ENV === "production" ? "postgres" : "memory"),
    ).toLowerCase() === "postgres";
    if (configured && !this.database?.configured()) {
      throw new ServiceUnavailableException("Analysis billing membutuhkan PostgreSQL yang aktif.");
    }
    return configured;
  }

  private async startPersistent(accountId: string, input: StartAnalysisJobInput, apiKeyId?: string) {
    const requestId = this.requestId(input.requestId);
    const requestedClipCount = this.validatedClipCount(input.requestedClipCount);
    const client = this.database!.client();
    await this.recoverStalePersistentJobs(accountId);
    const entitlement = await client.user.findUnique({ where: { id: accountId }, select: { unlimitedCredits: true } });
    if (!entitlement) throw new NotFoundException("Akun analysis tidak ditemukan.");
    const estimate = this.pricing.estimateAnalysisJob({
      sourceDurationSeconds: input.sourceDurationSeconds,
      requestedClipCount,
    });
    const reservedMicro = entitlement.unlimitedCredits ? 0n : estimate.reservationMicroUsd;
    const existing = await client.analysisJob.findUnique({
      where: { userId_requestId: { userId: accountId, requestId } },
      include: { account: { select: { balanceMicro: true, reservedMicro: true } } },
    });
    if (existing) return this.publicPersistentJob(existing);

    const jobId = randomUUID();
    await client.$transaction(async (tx) => {
      const duplicate = await tx.analysisJob.findUnique({
        where: { userId_requestId: { userId: accountId, requestId } },
      });
      if (duplicate) return;
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "user_credits" WHERE "userId" = ${accountId} FOR UPDATE`);
      const account = await tx.userCreditAccount.findUnique({ where: { userId: accountId } });
      const available = account ? account.balanceMicro - account.reservedMicro : 0n;
      if (!account || (!entitlement.unlimitedCredits && available < reservedMicro)) {
        throw new InsufficientBalanceException(Number(available), Number(reservedMicro), requestId);
      }
      const trustedApiKey = apiKeyId && apiKeyId !== "development-key"
        ? await tx.apiKey.findUnique({ where: { id: apiKeyId }, select: { id: true } })
        : undefined;
      const updated = await tx.userCreditAccount.update({
        where: { id: account.id },
        data: { reservedMicro: { increment: reservedMicro } },
      });
      const job = await tx.analysisJob.create({
        data: {
          id: jobId,
          userId: accountId,
          accountId: account.id,
          apiKeyId: trustedApiKey?.id,
          requestId,
          sourceId: String(input.sourceId || "").slice(0, 240) || null,
          sourceDurationSeconds: Math.round(safePositiveNumber(input.sourceDurationSeconds)),
          requestedClipCount,
          reservedCreditMicro: reservedMicro,
          modules: {},
          pricingSnapshot: jsonValue({
            unlimitedCredits: entitlement.unlimitedCredits,
            estimated: jobQuoteSnapshot(estimate),
            reservationMicroUsd: reservedMicro.toString(),
          }),
        },
      });
      if (reservedMicro > 0n) {
        await tx.creditLedger.create({
          data: {
            accountId: account.id,
            apiKeyId: trustedApiKey?.id,
            analysisJobId: job.id,
            type: LedgerType.AI_RESERVATION,
            amountMicro: -reservedMicro,
            balanceAfterMicro: updated.balanceMicro,
            idempotencyKey: `analysis-reserve:${job.id}`,
            description: "Reserve estimasi biaya analysis job",
            costSnapshot: jsonValue({
              requestId,
              reservedUsd: microToUsd(reservedMicro),
              estimate: jobQuoteSnapshot(estimate),
            }),
          },
        });
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    const created = await client.analysisJob.findUniqueOrThrow({
      where: { userId_requestId: { userId: accountId, requestId } },
      include: { account: { select: { balanceMicro: true, reservedMicro: true } } },
    });
    return this.publicPersistentJob(created);
  }

  private async completePersistent(accountId: string, input: CompleteAnalysisJobInput) {
    const jobId = String(input.jobId || "");
    const clipScores = safeScores(input.clipScores, settlementScoreLimit());
    const client = this.database!.client();
    await client.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "analysis_jobs" WHERE "id" = ${jobId} FOR UPDATE`);
      const job = await tx.analysisJob.findFirst({ where: { id: jobId, userId: accountId } });
      if (!job) throw new NotFoundException("Analysis job tidak ditemukan.");
      if (job.status === AnalysisJobStatus.COMPLETED) return;
      if (job.status !== AnalysisJobStatus.ACTIVE) throw new BadRequestException("Job sudah gagal dan reservation telah dilepas.");
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "user_credits" WHERE "id" = ${job.accountId} FOR UPDATE`);
      const account = await tx.userCreditAccount.findUniqueOrThrow({ where: { id: job.accountId } });
      const entitlement = await tx.user.findUniqueOrThrow({ where: { id: accountId }, select: { unlimitedCredits: true } });
      const quote = this.pricing.quoteAnalysisJob({
        providerCostMicroUsd: job.providerCostMicroUsd,
        usableResult: input.usableResult !== false && clipScores.length > 0,
      });
      const reservedMicro = job.reservedCreditMicro;
      if (!entitlement.unlimitedCredits && (!quote.capSafe || quote.userChargeMicroUsd > reservedMicro)) {
        throw new ServiceUnavailableException({
          code: "COST_LIMIT_REACHED",
          message: "Biaya job melewati batas aman sebelum settlement. Reservation akan dilepas oleh jalur gagal.",
          jobId,
        });
      }
      const finalChargeMicro = entitlement.unlimitedCredits ? 0n : quote.userChargeMicroUsd;
      const releasedMicro = reservedMicro - finalChargeMicro;
      if (account.reservedMicro < reservedMicro || account.balanceMicro < finalChargeMicro) {
        throw new ServiceUnavailableException("Saldo wallet berubah saat settlement. Job tidak dipotong.");
      }
      const updated = await tx.userCreditAccount.update({
        where: { id: account.id },
        data: {
          balanceMicro: { decrement: finalChargeMicro },
          reservedMicro: { decrement: reservedMicro },
          lifetimeSpentMicro: { increment: finalChargeMicro },
        },
      });
      if (releasedMicro > 0n) {
        await tx.creditLedger.create({
          data: {
            accountId: account.id,
            apiKeyId: job.apiKeyId,
            analysisJobId: job.id,
            type: LedgerType.AI_RESERVATION_RELEASE,
            amountMicro: releasedMicro,
            balanceAfterMicro: updated.balanceMicro,
            idempotencyKey: `analysis-release:${job.id}`,
            description: "Release sisa reservation analysis job",
          },
        });
      }
      if (finalChargeMicro > 0n) {
        await tx.creditLedger.create({
          data: {
            accountId: account.id,
            apiKeyId: job.apiKeyId,
            analysisJobId: job.id,
            type: LedgerType.AI_SETTLEMENT,
            amountMicro: -finalChargeMicro,
            balanceAfterMicro: updated.balanceMicro,
            idempotencyKey: `analysis-settle:${job.id}`,
            description: "Settlement biaya analysis job",
            costSnapshot: jsonValue(jobQuoteSnapshot(quote)),
          },
        });
      }
      await tx.analysisJob.update({
        where: { id: job.id },
        data: {
          status: AnalysisJobStatus.COMPLETED,
          clipScores: jsonValue(clipScores),
          finalChargeMicro,
          releasedMicro,
          pricingSnapshot: jsonValue({ ...jobQuoteSnapshot(quote), unlimitedCredits: entitlement.unlimitedCredits }),
          completedAt: new Date(),
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    const completed = await client.analysisJob.findFirst({
      where: { id: jobId, userId: accountId },
      include: { account: { select: { balanceMicro: true, reservedMicro: true } } },
    });
    if (!completed) throw new NotFoundException("Analysis job tidak ditemukan.");
    return this.publicPersistentJob(completed);
  }

  private async failPersistent(accountId: string, jobId: string, reason: string) {
    const client = this.database!.client();
    await client.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "analysis_jobs" WHERE "id" = ${jobId} FOR UPDATE`);
      const job = await tx.analysisJob.findFirst({ where: { id: jobId, userId: accountId } });
      if (!job) throw new NotFoundException("Analysis job tidak ditemukan.");
      if (job.status !== AnalysisJobStatus.ACTIVE) return;
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "user_credits" WHERE "id" = ${job.accountId} FOR UPDATE`);
      const account = await tx.userCreditAccount.findUniqueOrThrow({ where: { id: job.accountId } });
      if (account.reservedMicro < job.reservedCreditMicro) {
        throw new ServiceUnavailableException("Reservation wallet tidak konsisten.");
      }
      const updated = await tx.userCreditAccount.update({
        where: { id: account.id },
        data: { reservedMicro: { decrement: job.reservedCreditMicro } },
      });
      if (job.reservedCreditMicro > 0n) {
        await tx.creditLedger.create({
          data: {
            accountId: account.id,
            apiKeyId: job.apiKeyId,
            analysisJobId: job.id,
            type: LedgerType.AI_RESERVATION_RELEASE,
            amountMicro: job.reservedCreditMicro,
            balanceAfterMicro: updated.balanceMicro,
            idempotencyKey: `analysis-failed-release:${job.id}`,
            description: "Release reservation karena analysis job gagal",
            costSnapshot: jsonValue({ reason: String(reason || "analysis_failed").slice(0, 300) }),
          },
        });
      }
      await tx.analysisJob.update({
        where: { id: job.id },
        data: {
          status: AnalysisJobStatus.FAILED,
          releasedMicro: job.reservedCreditMicro,
          failureReason: String(reason || "analysis_failed").slice(0, 300),
          completedAt: new Date(),
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    const failed = await client.analysisJob.findFirst({
      where: { id: jobId, userId: accountId },
      include: { account: { select: { balanceMicro: true, reservedMicro: true } } },
    });
    if (!failed) throw new NotFoundException("Analysis job tidak ditemukan.");
    return this.publicPersistentJob(failed);
  }

  private async recoverStalePersistentJobs(accountId?: string): Promise<number> {
    const client = this.database!.client();
    const cutoff = new Date(Date.now() - staleJobMinutes() * 60_000);
    const stale = await client.analysisJob.findMany({
      where: {
        status: AnalysisJobStatus.ACTIVE,
        updatedAt: { lt: cutoff },
        ...(accountId ? { userId: accountId } : {}),
      },
      orderBy: { updatedAt: "asc" },
      take: 100,
      select: { id: true, userId: true },
    });
    let recovered = 0;
    for (const job of stale) {
      try {
        await this.failPersistent(job.userId, job.id, "stale_analysis_job_recovered");
        recovered += 1;
      } catch {
        // The transaction path handles concurrent completion and inconsistent
        // reservations. Never guess or partially release wallet credits here.
      }
    }
    return recovered;
  }

  private async persistentJob(jobId: string, accountId: string, activeOnly = false) {
    const job = await this.database!.client().analysisJob.findFirst({
      where: {
        id: jobId,
        userId: accountId,
        ...(activeOnly ? { status: AnalysisJobStatus.ACTIVE } : {}),
      },
    });
    if (!job) throw new NotFoundException("Analysis job tidak ditemukan.");
    return job;
  }

  private publicPersistentJob(job: {
    id: string;
    requestId: string;
    status: AnalysisJobStatus;
    reservedCreditMicro: bigint;
    finalChargeMicro: bigint;
    releasedMicro: bigint;
    providerCostIdr: number;
    providerCostMicroUsd: bigint;
    pricingSnapshot: unknown;
    createdAt: Date;
    completedAt: Date | null;
    account: { balanceMicro: bigint; reservedMicro: bigint };
  }) {
    const quote = objectValue(job.pricingSnapshot);
    const unlimited = quote.unlimitedCredits === true;
    const balanceMicro = job.account.balanceMicro;
    const spendableMicro = balanceMicro - job.account.reservedMicro;
    const availableUsd = unlimited
      ? Number.MAX_SAFE_INTEGER / 1_000_000
      : microToUsd(balanceMicro);
    const spendableUsd = unlimited
      ? Number.MAX_SAFE_INTEGER / 1_000_000
      : microToUsd(spendableMicro);
    const reservedUsd = microToUsd(job.reservedCreditMicro);
    const finalChargeUsd = microToUsd(job.finalChargeMicro);
    const releasedUsd = microToUsd(job.releasedMicro);
    const estimatedReservationUsd = microToUsd(
      snapshotMicroUsd(quote.reservationMicroUsd, job.reservedCreditMicro),
    );
    const jobChargeCeilingUsd = microToUsd(this.pricing.maximumJobChargeMicroUsd());
    return {
      id: job.id,
      requestId: job.requestId,
      status: statusValue(job.status),
      walletCurrency: "USD",
      billingMode: "per_job_usd",
      reservedMicroUsd: Number(job.reservedCreditMicro),
      spendableMicroUsd: unlimited ? Number.MAX_SAFE_INTEGER : Number(spendableMicro),
      finalChargeMicroUsd: Number(job.finalChargeMicro),
      releasedMicroUsd: Number(job.releasedMicro),
      reservedUsd,
      finalChargeUsd,
      chargedUsd: finalChargeUsd,
      releasedUsd,
      availableUsd,
      spendableUsd,
      estimatedReservationUsd,
      jobChargeCeilingUsd,
      acceptedClipCount: 0,
      rejectedClipCount: 0,
      budgetStatus: String(
        quote.budgetStatus
        || (job.providerCostMicroUsd >= BigInt(this.pricingPolicy().warningProviderCostMicroUsd)
          ? "warning"
          : "target"),
      ),
      unlimited,
      storage: "postgres",
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt?.toISOString(),
    };
  }

  private adminPersistentJob(job: Parameters<AnalysisJobService["publicPersistentJob"]>[0] & {
    sourceId: string | null;
    sourceDurationSeconds: number;
    requestedClipCount: number;
    providerCostMicroUsd: bigint;
    requestCount: number;
    modules: unknown;
    failureReason: string | null;
  }) {
    const quote = objectValue(job.pricingSnapshot);
    const base = this.publicPersistentJob(job);
    const internalCostMicroUsd = snapshotMicroUsd(
      quote.internalCostMicroUsd,
      job.providerCostMicroUsd,
    );
    const grossProfitMicroUsd = snapshotMicroUsd(
      quote.grossProfitMicroUsd,
      job.finalChargeMicro - internalCostMicroUsd,
    );
    return {
      ...base,
      sourceId: job.sourceId || "",
      sourceDurationSeconds: job.sourceDurationSeconds,
      requestedClipCount: job.requestedClipCount,
      providerCostUsd: microToUsd(job.providerCostMicroUsd),
      providerCostIdr: this.pricing.microUsdToIdr(job.providerCostMicroUsd),
      internalCostIdr: this.pricing.microUsdToIdr(internalCostMicroUsd),
      finalChargeIdr: this.pricing.microUsdToIdr(job.finalChargeMicro),
      releasedIdr: this.pricing.microUsdToIdr(job.releasedMicro),
      grossProfitIdr: this.pricing.microUsdToIdr(grossProfitMicroUsd),
      requestCount: job.requestCount,
      modules: objectValue(job.modules),
      tierCounts: {},
      capApplied: false,
      capSafe: quote.capSafe !== false,
      failureReason: job.failureReason || undefined,
    };
  }

  private startMemory(accountId: string, input: StartAnalysisJobInput) {
    const requestId = this.requestId(input.requestId);
    const idempotencyKey = `${accountId}:${requestId}`;
    const existingId = this.jobByRequest.get(idempotencyKey);
    const existing = existingId ? this.jobs.get(existingId) : undefined;
    if (existing) return this.publicMemoryJob(existing);
    const requestedClipCount = this.validatedClipCount(input.requestedClipCount);
    const estimate = this.pricing.estimateAnalysisJob({
      sourceDurationSeconds: input.sourceDurationSeconds,
      requestedClipCount,
    });
    const reservedMicro = Number(estimate.reservationMicroUsd);
    const reservation = this.credits.reserve(accountId, `analysis-job:${requestId}`, reservedMicro);
    const now = new Date().toISOString();
    const job: AnalysisJobRecord = {
      id: randomUUID(),
      requestId,
      accountId,
      sourceId: String(input.sourceId || "").slice(0, 240),
      sourceDurationSeconds: safePositiveNumber(input.sourceDurationSeconds),
      requestedClipCount,
      reservationId: reservation.id,
      reservedMicro: reservation.amountMicro,
      providerCostUsd: 0,
      providerCostIdr: 0,
      requestCount: 0,
      modules: {},
      status: "active",
      clipScores: [],
      finalChargeMicro: 0,
      releasedMicro: 0,
      quote: estimate,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    this.jobByRequest.set(idempotencyKey, job.id);
    return this.publicMemoryJob(job);
  }

  private completeMemory(accountId: string, input: CompleteAnalysisJobInput) {
    const job = this.memoryJob(String(input.jobId || ""), accountId);
    if (job.status === "completed") return this.publicMemoryJob(job);
    if (job.status === "failed") throw new BadRequestException("Job sudah gagal dan reservation telah dilepas.");
    const clipScores = safeScores(input.clipScores, settlementScoreLimit());
    const quote = this.pricing.quoteAnalysisJob({
      providerCostMicroUsd: BigInt(usdToMicro(job.providerCostUsd)),
      usableResult: input.usableResult !== false && clipScores.length > 0,
    });
    if (!quote.capSafe || quote.userChargeMicroUsd > BigInt(job.reservedMicro)) {
      throw new ServiceUnavailableException({
        code: "COST_LIMIT_REACHED",
        message: "Biaya job melewati batas aman sebelum settlement.",
        jobId: job.id,
      });
    }
    const finalChargeMicro = Number(quote.userChargeMicroUsd);
    this.credits.settle(job.reservationId, finalChargeMicro);
    job.status = "completed";
    job.clipScores = clipScores;
    job.finalChargeMicro = finalChargeMicro;
    job.releasedMicro = Math.max(0, job.reservedMicro - finalChargeMicro);
    job.quote = quote;
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    return this.publicMemoryJob(job);
  }

  private failMemory(accountId: string, jobId: string, reason: string) {
    const job = this.memoryJob(jobId, accountId);
    if (job.status === "completed" || job.status === "failed") return this.publicMemoryJob(job);
    this.credits.release(job.reservationId);
    job.status = "failed";
    job.failureReason = String(reason || "analysis_failed").slice(0, 300);
    job.releasedMicro = job.reservedMicro;
    job.updatedAt = new Date().toISOString();
    job.completedAt = job.updatedAt;
    return this.publicMemoryJob(job);
  }

  private memoryWalletSummary(accountId: string) {
    const balance = this.credits.balance(accountId);
    return this.walletPayload(balance.balanceMicro, balance.reservedMicro);
  }

  private walletPayload(balanceMicro: number, reservedMicro: number) {
    const maximumJobMicroUsd = this.pricing.maximumJobChargeMicroUsd();
    const spendableMicro = Math.max(0, balanceMicro - reservedMicro);
    const availableUsd = microToUsd(balanceMicro);
    const reservedUsd = microToUsd(reservedMicro);
    const spendableUsd = microToUsd(spendableMicro);
    const jobChargeCeilingUsd = microToUsd(maximumJobMicroUsd);
    return {
      walletCurrency: "USD",
      billingMode: "per_job_usd",
      availableMicroUsd: balanceMicro,
      reservedMicroUsd: reservedMicro,
      spendableMicroUsd: spendableMicro,
      jobChargeCeilingMicroUsd: maximumJobMicroUsd,
      availableUsd,
      reservedUsd,
      spendableUsd,
      keyType: "user",
      cloudConnected: true,
      billingEligible: spendableMicro > 0,
      balanceStatus: spendableMicro === 0
        ? "empty"
        : spendableMicro <= this.pricingPolicy().lowBalanceWarningMicroUsd ? "low" : "ready",
      minimumTopupUsd: Number(process.env.PAYMENT_MIN_TOPUP_USD || 1),
      topupUrl: String(
        process.env.CLIPER_TOPUP_URL
        || `${String(process.env.WEB_ORIGIN || "http://localhost:3000").replace(/\/$/, "")}/billing?source=desktop`,
      ),
      storage: this.storageMode(),
    };
  }

  private memorySummary() {
    const jobs = Array.from(this.jobs.values());
    const completed = jobs.filter((job) => job.status === "completed");
    const providerCostIdr = completed.reduce(
      (total, job) => total + this.pricing.providerCostIdr(job.providerCostUsd),
      0,
    );
    const customerRevenueIdr = completed.reduce(
      (total, job) => total + this.pricing.microUsdToIdr(job.finalChargeMicro),
      0,
    );
    const internalCostIdr = completed.reduce(
      (total, job) => total + this.pricing.microUsdToIdr(
        job.quote?.internalCostMicroUsd ?? BigInt(usdToMicro(job.providerCostUsd)),
      ),
      0,
    );
    const chargedUsd = completed.reduce(
      (total, job) => total + microToUsd(job.finalChargeMicro),
      0,
    );
    return {
      storage: "memory",
      total: jobs.length,
      active: jobs.filter((job) => job.status === "active").length,
      completed: completed.length,
      failed: jobs.filter((job) => job.status === "failed").length,
      providerCostIdr,
      customerRevenueIdr,
      grossProfitIdr: customerRevenueIdr - internalCostIdr,
      usdCharged: chargedUsd,
      recent: jobs
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 12)
        .map((job) => this.adminMemoryJob(job)),
    };
  }

  private requestId(value: unknown): string {
    const requestId = String(value || `analysis-${randomUUID()}`).trim();
    if (!requestId || requestId.length > 160) throw new BadRequestException("requestId job tidak valid.");
    return requestId;
  }

  private validatedClipCount(value: unknown): number {
    const requestedClipCount = safeClipCount(value);
    const maxClips = configuredClipLimit();
    if (maxClips > 0 && requestedClipCount > maxClips) {
      throw new BadRequestException(`Job meminta ${requestedClipCount} clip; batas operasional server ${maxClips}.`);
    }
    return requestedClipCount;
  }

  private pricingPolicy() {
    return this.pricing.analysisJobPolicy();
  }

  private activeMemoryJob(jobId: string, accountId: string): AnalysisJobRecord {
    const job = this.memoryJob(jobId, accountId);
    if (job.status !== "active") throw new BadRequestException("Analysis job tidak aktif.");
    return job;
  }

  private memoryJob(jobId: string, accountId: string): AnalysisJobRecord {
    const job = this.jobs.get(jobId);
    if (!job || job.accountId !== accountId) throw new NotFoundException("Analysis job tidak ditemukan.");
    return job;
  }

  private publicMemoryJob(job: AnalysisJobRecord) {
    const balance = this.credits.balance(job.accountId);
    const availableUsd = microToUsd(balance.balanceMicro);
    const spendableUsd = microToUsd(balance.availableMicro);
    const reservedUsd = microToUsd(job.reservedMicro);
    const finalChargeUsd = microToUsd(job.finalChargeMicro);
    const releasedUsd = microToUsd(job.releasedMicro);
    const estimatedReservationUsd = microToUsd(job.reservedMicro);
    const jobChargeCeilingUsd = microToUsd(this.pricing.maximumJobChargeMicroUsd());
    return {
      id: job.id,
      requestId: job.requestId,
      status: job.status,
      walletCurrency: "USD",
      billingMode: "per_job_usd",
      reservedMicroUsd: job.reservedMicro,
      spendableMicroUsd: balance.availableMicro,
      finalChargeMicroUsd: job.finalChargeMicro,
      releasedMicroUsd: job.releasedMicro,
      reservedUsd,
      finalChargeUsd,
      chargedUsd: finalChargeUsd,
      releasedUsd,
      availableUsd,
      spendableUsd,
      estimatedReservationUsd,
      jobChargeCeilingUsd,
      acceptedClipCount: job.clipScores.length,
      rejectedClipCount: 0,
      budgetStatus: job.quote?.budgetStatus
        || (BigInt(usdToMicro(job.providerCostUsd)) >= BigInt(this.pricingPolicy().warningProviderCostMicroUsd)
          ? "warning"
          : "target"),
      unlimited: false,
      storage: "memory",
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    };
  }

  private adminMemoryJob(job: AnalysisJobRecord) {
    const providerCostMicroUsd = BigInt(usdToMicro(job.providerCostUsd));
    const internalCostMicroUsd = job.quote?.internalCostMicroUsd ?? providerCostMicroUsd;
    const grossProfitMicroUsd = job.quote?.grossProfitMicroUsd
      ?? BigInt(job.finalChargeMicro) - internalCostMicroUsd;
    return {
      ...this.publicMemoryJob(job),
      sourceId: job.sourceId,
      sourceDurationSeconds: job.sourceDurationSeconds,
      requestedClipCount: job.requestedClipCount,
      providerCostUsd: job.providerCostUsd,
      providerCostIdr: this.pricing.microUsdToIdr(providerCostMicroUsd),
      internalCostIdr: this.pricing.microUsdToIdr(internalCostMicroUsd),
      finalChargeIdr: this.pricing.microUsdToIdr(job.finalChargeMicro),
      releasedIdr: this.pricing.microUsdToIdr(job.releasedMicro),
      grossProfitIdr: this.pricing.microUsdToIdr(grossProfitMicroUsd),
      requestCount: job.requestCount,
      modules: { ...job.modules },
      tierCounts: {},
      capApplied: false,
      capSafe: job.quote?.capSafe ?? true,
      failureReason: job.failureReason,
    };
  }
}

import { Inject, Injectable, Optional, ServiceUnavailableException } from "@nestjs/common";
import type { CliperInternalChatResponse } from "@cliper/contracts";
import { DatabaseService } from "../database/database.service.js";
import { Prisma } from "../generated/prisma/client.js";

export interface UsageRecord {
  id: string;
  jobId?: string;
  accountId: string;
  accountEmail?: string;
  provider: string;
  model: string;
  module: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  providerCostUsd: number;
  serviceCostUsd: number;
  billedCostUsd: number;
  grossProfitUsd: number;
  creditChargeMicro: number;
  markupBps: number;
  latencyMs: number;
  createdAt: string;
}

export interface UsageRecordOptions {
  jobId?: string;
  apiKeyId?: string;
  deferCustomerBilling?: boolean;
  waiveCustomerBilling?: boolean;
  usageSource?: "provider" | "estimated";
  retryCount?: number;
  fallbackCount?: number;
}

function usageNumber(usage: unknown, keys: string[]): number {
  const source = usage && typeof usage === "object" ? usage as Record<string, unknown> : {};
  for (const key of keys) {
    if (!(key in source) || source[key] === null || source[key] === undefined) continue;
    const value = Number(source[key]);
    if (Number.isFinite(value) && value >= 0) return Math.floor(value);
  }
  return 0;
}

function microUsd(value: number): bigint {
  return BigInt(Math.ceil(Math.max(0, Number(value || 0)) * 1_000_000));
}

function signedMicroUsd(value: number): bigint {
  const parsed = Number(value || 0);
  return BigInt(Math.round((Number.isFinite(parsed) ? parsed : 0) * 1_000_000));
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

@Injectable()
export class UsageService {
  private readonly records: UsageRecord[] = [];

  constructor(@Optional() @Inject(DatabaseService) private readonly database?: DatabaseService) {}

  async record(
    response: CliperInternalChatResponse,
    module: string,
    latencyMs: number,
    accountId = "development-account",
    options: UsageRecordOptions = {},
  ): Promise<{ persisted: boolean; jobCostAggregated: boolean }> {
    const customerBillingWaived = Boolean(options.deferCustomerBilling || options.waiveCustomerBilling);
    const billedCostUsd = customerBillingWaived ? 0 : response.billing.billed_cost_usd;
    const creditChargeMicro = customerBillingWaived ? 0 : response.billing.credit_charge_micro;
    const inputTokens = usageNumber(response.usage, ["prompt_tokens", "input_tokens"]);
    const cachedInputTokens = Math.min(
      inputTokens,
      usageNumber(response.usage, ["cached_input_tokens", "cached_tokens"]),
    );
    const outputTokens = usageNumber(response.usage, ["completion_tokens", "output_tokens"]);
    const reasoningTokens = usageNumber(response.usage, ["reasoning_tokens"]);
    const totalTokens = usageNumber(response.usage, ["total_tokens"])
      || inputTokens + outputTokens;
    const retryCount = Math.max(
      0,
      Math.floor(Number(options.retryCount ?? response.routing?.retry_count ?? 0)),
    );
    const fallbackCount = Math.max(
      0,
      Math.floor(Number(options.fallbackCount ?? response.routing?.fallback_count ?? 0)),
    );
    const usageSource = options.usageSource || response.usage.usage_source || "provider";
    const record: UsageRecord = {
      id: response.id,
      jobId: options.jobId,
      accountId,
      provider: response.provider,
      model: response.model,
      module,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningTokens,
      providerCostUsd: response.billing.provider_cost_usd,
      serviceCostUsd: response.billing.service_cost_usd,
      billedCostUsd,
      grossProfitUsd: options.deferCustomerBilling
        ? 0
        : options.waiveCustomerBilling
          ? -response.billing.service_cost_usd
          : response.billing.gross_profit_usd,
      creditChargeMicro,
      markupBps: response.billing.markup_bps,
      latencyMs,
      createdAt: new Date().toISOString(),
    };
    this.records.unshift(record);
    if (this.records.length > 500) this.records.length = 500;
    if (!this.usesPostgres()) return { persisted: true, jobCostAggregated: false };

    const apiKeyId = String(options.apiKeyId || "").trim();
    if (!apiKeyId || apiKeyId === "development-key") {
      throw new ServiceUnavailableException("API key database diperlukan untuk menyimpan usage production.");
    }
    const client = this.database!.client();
    const providerCostIdr = Math.ceil(
      Math.max(0, response.billing.provider_cost_usd)
      * Number(process.env.PLATFORM_USD_TO_IDR || 16_000),
    );
    const persisted = await client.$transaction(async (tx) => {
      const [apiKey, provider] = await Promise.all([
        tx.apiKey.findUnique({ where: { id: apiKeyId }, select: { id: true, userId: true } }),
        tx.aiProvider.findUnique({ where: { code: response.provider }, select: { id: true } }),
      ]);
      if (!apiKey || apiKey.userId !== accountId) {
        throw new ServiceUnavailableException("API key usage tidak ditemukan di database.");
      }
      let job: {
        id: string;
        apiKeyId: string | null;
        providerCostMicroUsd: bigint;
        modules: unknown;
      } | null = null;
      if (options.jobId) {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "analysis_jobs" WHERE "id" = ${options.jobId} FOR UPDATE`);
        job = await tx.analysisJob.findFirst({
          where: { id: options.jobId, userId: accountId },
          select: { id: true, apiKeyId: true, providerCostMicroUsd: true, modules: true },
        });
        if (!job || (job.apiKeyId && job.apiKeyId !== apiKey.id)) {
          throw new ServiceUnavailableException("Analysis job usage tidak cocok dengan API key.");
        }
      }
      const created = await tx.aiUsage.createMany({
        data: [{
          apiKeyId: apiKey.id,
          providerId: provider?.id,
          analysisJobId: options.jobId,
          module,
          model: response.model,
          requestId: response.id,
          inputTokens,
          cachedInputTokens,
          outputTokens,
          reasoningTokens,
          totalTokens,
          retryCount,
          fallbackCount,
          usageSource,
          providerCostMicro: microUsd(response.billing.provider_cost_usd),
          providerCostIdr,
          serviceCostMicro: microUsd(response.billing.service_cost_usd),
          billedCostMicro: microUsd(billedCostUsd),
          grossProfitMicro: signedMicroUsd(record.grossProfitUsd),
          creditChargeMicro: BigInt(Math.max(0, Math.ceil(creditChargeMicro))),
          markupBps: response.billing.markup_bps,
          pricingSnapshot: jsonValue({
            provider: response.provider,
            model: response.model,
            providerCostUsd: response.billing.provider_cost_usd,
            serviceCostUsd: response.billing.service_cost_usd,
            billedCostUsd,
            providerCostIdr,
            exchangeRateUsdIdr: Number(process.env.PLATFORM_USD_TO_IDR || 16_000),
            deferredToJob: Boolean(options.deferCustomerBilling),
            customerBillingWaived: Boolean(options.waiveCustomerBilling),
          }),
          latencyMs,
          success: true,
        }],
        skipDuplicates: true,
      });
      if (created.count === 0) return false;
      if (job) {
        const providerCostMicroUsd = job.providerCostMicroUsd
          + microUsd(response.billing.provider_cost_usd);
        const modules = objectValue(job.modules);
        modules[module] = Number(modules[module] || 0) + 1;
        await tx.analysisJob.update({
          where: { id: job.id },
          data: {
            providerCostMicroUsd,
            providerCostIdr: Math.ceil(
              Number(providerCostMicroUsd) / 1_000_000
              * Number(process.env.PLATFORM_USD_TO_IDR || 16_000),
            ),
            requestCount: { increment: 1 },
            modules: jsonValue(modules),
          },
        });
      }
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return {
      persisted,
      jobCostAggregated: Boolean(options.jobId && persisted),
    };
  }

  async summary(accountId?: string) {
    if (!this.usesPostgres()) return this.memorySummary(accountId);
    const where = accountId ? { apiKey: { userId: accountId } } : {};
    const rows = await this.database!.client().aiUsage.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 500,
      include: {
        provider: { select: { code: true } },
        apiKey: { select: { userId: true, user: { select: { email: true } } } },
      },
    });
    const records: UsageRecord[] = rows.map((item) => ({
      id: item.requestId,
      jobId: item.analysisJobId || undefined,
      accountId: item.apiKey?.userId || accountId || "",
      accountEmail: item.apiKey?.user?.email,
      provider: item.provider?.code
        || String(objectValue(item.pricingSnapshot).provider || "unknown"),
      model: item.model,
      module: item.module,
      inputTokens: item.inputTokens,
      cachedInputTokens: item.cachedInputTokens,
      outputTokens: item.outputTokens,
      reasoningTokens: item.reasoningTokens,
      providerCostUsd: Number(item.providerCostMicro) / 1_000_000,
      serviceCostUsd: Number(item.serviceCostMicro) / 1_000_000,
      billedCostUsd: Number(item.billedCostMicro) / 1_000_000,
      grossProfitUsd: Number(item.grossProfitMicro) / 1_000_000,
      creditChargeMicro: Number(item.creditChargeMicro),
      markupBps: item.markupBps,
      latencyMs: item.latencyMs,
      createdAt: item.createdAt.toISOString(),
    }));
    return this.summarize(records, "postgres");
  }

  storageMode(): "memory" | "postgres" {
    return this.usesPostgres() ? "postgres" : "memory";
  }

  private usesPostgres(): boolean {
    const enabled = String(
      process.env.ANALYSIS_BILLING_STORAGE
      || (process.env.NODE_ENV === "production" ? "postgres" : "memory"),
    ).toLowerCase() === "postgres";
    if (enabled && !this.database?.configured()) {
      throw new ServiceUnavailableException("Usage persistence membutuhkan PostgreSQL yang aktif.");
    }
    return enabled;
  }

  private memorySummary(accountId?: string) {
    return this.summarize(
      this.records.filter((item) => !accountId || item.accountId === accountId),
      "memory",
    );
  }

  private summarize(records: UsageRecord[], storage: "memory" | "postgres") {
    const latencies = records.map((item) => item.latencyMs).sort((a, b) => a - b);
    const providerCostUsd = records.reduce((total, item) => total + item.providerCostUsd, 0);
    const billedCostUsd = records.reduce((total, item) => total + item.billedCostUsd, 0);
    const serviceCostUsd = records.reduce((total, item) => total + item.serviceCostUsd, 0);
    const grossProfitUsd = records.reduce((total, item) => total + item.grossProfitUsd, 0);
    return {
      storage,
      requests: records.length,
      inputTokens: records.reduce((total, item) => total + item.inputTokens, 0),
      cachedInputTokens: records.reduce((total, item) => total + item.cachedInputTokens, 0),
      outputTokens: records.reduce((total, item) => total + item.outputTokens, 0),
      reasoningTokens: records.reduce((total, item) => total + item.reasoningTokens, 0),
      providerCostUsd: Number(providerCostUsd.toFixed(6)),
      serviceCostUsd: Number(serviceCostUsd.toFixed(6)),
      billedCostUsd: Number(billedCostUsd.toFixed(6)),
      grossMarginUsd: Number(grossProfitUsd.toFixed(6)),
      creditChargeMicro: records.reduce((total, item) => total + item.creditChargeMicro, 0),
      averageLatencyMs: records.length
        ? Math.round(records.reduce((total, item) => total + item.latencyMs, 0) / records.length)
        : 0,
      p95LatencyMs: latencies.length
        ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)]
        : 0,
      recent: records.slice(0, 12),
    };
  }
}

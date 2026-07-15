import { Injectable } from "@nestjs/common";
import type { CliperInternalChatResponse } from "@cliper/contracts";

export interface UsageRecord {
  id: string;
  accountId: string;
  provider: string;
  model: string;
  module: string;
  inputTokens: number;
  outputTokens: number;
  providerCostUsd: number;
  serviceCostUsd: number;
  billedCostUsd: number;
  grossProfitUsd: number;
  creditChargeMicro: number;
  markupBps: number;
  latencyMs: number;
  createdAt: string;
}

@Injectable()
export class UsageService {
  private readonly records: UsageRecord[] = [];

  record(response: CliperInternalChatResponse, module: string, latencyMs: number, accountId = "development-account"): void {
    this.records.unshift({
      id: response.id,
      accountId,
      provider: response.provider,
      model: response.model,
      module,
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
      providerCostUsd: response.billing.provider_cost_usd,
      serviceCostUsd: response.billing.service_cost_usd,
      billedCostUsd: response.billing.billed_cost_usd,
      grossProfitUsd: response.billing.gross_profit_usd,
      creditChargeMicro: response.billing.credit_charge_micro,
      markupBps: response.billing.markup_bps,
      latencyMs,
      createdAt: new Date().toISOString(),
    });
    if (this.records.length > 500) this.records.length = 500;
  }

  summary(accountId?: string) {
    const records = this.records.filter((item) => !accountId || item.accountId === accountId);
    const latencies = records.map((item) => item.latencyMs).sort((a, b) => a - b);
    const providerCostUsd = records.reduce((total, item) => total + item.providerCostUsd, 0);
    const billedCostUsd = records.reduce((total, item) => total + item.billedCostUsd, 0);
    const serviceCostUsd = records.reduce((total, item) => total + item.serviceCostUsd, 0);
    const grossProfitUsd = records.reduce((total, item) => total + item.grossProfitUsd, 0);
    return {
      requests: records.length,
      inputTokens: records.reduce((total, item) => total + item.inputTokens, 0),
      outputTokens: records.reduce((total, item) => total + item.outputTokens, 0),
      providerCostUsd: Number(providerCostUsd.toFixed(6)),
      serviceCostUsd: Number(serviceCostUsd.toFixed(6)),
      billedCostUsd: Number(billedCostUsd.toFixed(6)),
      grossMarginUsd: Number(grossProfitUsd.toFixed(6)),
      creditChargeMicro: records.reduce((total, item) => total + item.creditChargeMicro, 0),
      averageLatencyMs: records.length ? Math.round(records.reduce((total, item) => total + item.latencyMs, 0) / records.length) : 0,
      p95LatencyMs: latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] : 0,
      recent: records.slice(0, 12),
    };
  }
}

import { Inject, Injectable } from "@nestjs/common";
import {
  quoteJobCost,
  quoteUsageCost,
  validateJobPricingPolicy,
  type JobPricingInput,
  type JobPricingQuote,
  type JobPricingValidation,
  type UsageCostQuote,
} from "@cliper/billing";
import type { AiModule, CliperChatRequest, CliperInternalChatResponse } from "@cliper/contracts";
import { AdminStoreService } from "../admin/admin-store.service.js";

export interface AnalysisJobEstimateInput {
  sourceDurationSeconds?: number;
  requestedClipCount?: number;
}

function usdToMicro(value: number): bigint {
  return BigInt(Math.ceil(Math.max(0, Number(value || 0)) * 1_000_000));
}

function microToUsd(value: bigint): number {
  return Number(value) / 1_000_000;
}

@Injectable()
export class PricingService {
  constructor(@Inject(AdminStoreService) private readonly adminStore: AdminStoreService) {}

  quoteAnalysisJob(input: JobPricingInput): JobPricingQuote {
    return quoteJobCost(input, this.adminStore.pricingPolicy());
  }

  estimateAnalysisJob(input: AnalysisJobEstimateInput): JobPricingQuote {
    const policy = this.adminStore.pricingPolicy();
    const durationSeconds = Math.max(0, Math.round(Number(input.sourceDurationSeconds || 0)));
    const requestedClipCount = Math.max(0, Math.round(Number(input.requestedClipCount || 0)));
    // An estimate remains deliberately conservative without turning a safety
    // ceiling into a blanket reservation. Duration and requested output size
    // are the only inputs available before the provider is called.
    const durationBlocks = Math.max(1, Math.ceil(durationSeconds / 600));
    const expectedClipCount = requestedClipCount > 0
      ? Math.min(requestedClipCount, 25)
      : 4;
    const durationBps = Math.min(5_000, Math.max(0, durationBlocks - 1) * 250);
    const clipBps = Math.min(2_500, Math.max(0, expectedClipCount - 3) * 500);
    const scaleBps = 10_000 + durationBps + clipBps;
    const estimatedProviderCostMicroUsd = BigInt(Math.min(
      policy.hardProviderCostMicroUsd,
      Math.max(
        policy.targetProviderCostMicroUsd,
        Math.ceil(policy.targetProviderCostMicroUsd * scaleBps / 10_000),
      ),
    ));
    return quoteJobCost({ providerCostMicroUsd: estimatedProviderCostMicroUsd, usableResult: true }, policy);
  }

  simulateAnalysisJob(
    input: { providerCostIdr?: number; providerCostMicroUsd?: number; usableResult?: boolean },
    policyOverride: Record<string, unknown> = {},
  ) {
    const policy = { ...this.adminStore.pricingPolicy(), ...policyOverride };
    const validation = validateJobPricingPolicy(policy);
    if (!validation.valid) {
      return {
        validation: this.serializeAnalysisJobValidation(validation, policy.usdToIdr),
      };
    }
    const providerCostMicroUsd = input.providerCostMicroUsd === undefined
      ? this.idrToMicroUsd(Number(input.providerCostIdr || 0), policy.usdToIdr)
      : BigInt(Math.max(0, Math.round(input.providerCostMicroUsd)));
    return {
      validation: this.serializeAnalysisJobValidation(validation, policy.usdToIdr),
      quote: this.serializeAnalysisJobQuote(
        quoteJobCost({ providerCostMicroUsd, usableResult: input.usableResult }, policy),
        policy.usdToIdr,
      ),
    };
  }

  serializeAnalysisJobValidation(
    validation: JobPricingValidation,
    usdToIdr = this.adminStore.pricingPolicy().usdToIdr,
  ) {
    return {
      ...validation,
      hardLimitProtectedMicroUsd: Number(validation.hardLimitProtectedMicroUsd),
      hardLimitProtectedIdr: this.microUsdToIdr(
        validation.hardLimitProtectedMicroUsd,
        usdToIdr,
      ),
    };
  }

  serializeAnalysisJobQuote(
    quote: JobPricingQuote,
    usdToIdr = this.adminStore.pricingPolicy().usdToIdr,
  ) {
    return {
      providerCostMicroUsd: Number(quote.providerCostMicroUsd),
      internalCostMicroUsd: Number(quote.internalCostMicroUsd),
      protectedChargeMicroUsd: Number(quote.protectedChargeMicroUsd),
      userChargeMicroUsd: Number(quote.userChargeMicroUsd),
      reservationMicroUsd: Number(quote.reservationMicroUsd),
      reservationCapped: quote.reservationCapped,
      grossProfitMicroUsd: Number(quote.grossProfitMicroUsd),
      providerCostIdr: this.microUsdToIdr(quote.providerCostMicroUsd, usdToIdr),
      internalCostIdr: this.microUsdToIdr(quote.internalCostMicroUsd, usdToIdr),
      protectedChargeIdr: this.microUsdToIdr(quote.protectedChargeMicroUsd, usdToIdr),
      userChargeIdr: this.microUsdToIdr(quote.userChargeMicroUsd, usdToIdr),
      reservationIdr: this.microUsdToIdr(quote.reservationMicroUsd, usdToIdr),
      grossProfitIdr: this.microUsdToIdr(quote.grossProfitMicroUsd, usdToIdr),
      grossMarginBps: quote.grossMarginBps,
      capSafe: quote.capSafe,
      budgetStatus: quote.budgetStatus,
    };
  }

  validateAnalysisJobPolicy(): JobPricingValidation {
    return validateJobPricingPolicy(this.adminStore.pricingPolicy());
  }

  providerCostIdr(providerCostUsd: number): number {
    return this.microUsdToIdr(usdToMicro(providerCostUsd));
  }

  microUsdToIdr(value: bigint | number, usdToIdr = this.adminStore.pricingPolicy().usdToIdr): number {
    const converted = Number(value) * usdToIdr / 1_000_000;
    return converted < 0 ? Math.floor(converted) : Math.ceil(converted);
  }

  idrToMicroUsd(value: number, usdToIdr = this.adminStore.pricingPolicy().usdToIdr): bigint {
    return BigInt(Math.ceil(Math.max(0, Number(value || 0)) * 1_000_000 / Math.max(1, usdToIdr)));
  }

  maximumJobChargeMicroUsd(): number {
    return this.adminStore.pricingPolicy().maximumJobChargeMicroUsd;
  }

  analysisJobPolicy() {
    return this.adminStore.pricingPolicy();
  }

  quoteProviderCost(providerCostUsd: number, module?: AiModule): UsageCostQuote {
    const policy = this.adminStore.pricingPolicy();
    return quoteUsageCost({
      providerCostMicroUsd: usdToMicro(providerCostUsd),
      computeCostMicroUsd: BigInt(policy.computeCostMicroUsd),
      paymentFeeBps: policy.paymentFeeBps,
      reserveBps: policy.reserveBps,
      minimumChargeMicroUsd: BigInt(this.isClipModule(module)
        ? Math.max(policy.minimumChargeMicroUsd, policy.minimumClipChargeMicroUsd)
        : policy.minimumChargeMicroUsd),
      minimumMarginBps: policy.minimumMarginBps,
      microUsdPerCredit: 1n,
    });
  }

  estimateRequest(request: CliperChatRequest): UsageCostQuote {
    const promptChars = request.messages.reduce((total, message) => total + message.content.length, 0);
    const module = this.moduleForRequest(request);
    const estimatedInputTokens = Math.max(1, Math.ceil(promptChars / 4 * 1.25));
    const moduleBudgets = this.adminStore.moduleMaxTokens();
    const estimatedOutputTokens = Math.max(32, Number(request.max_tokens || moduleBudgets[module] || moduleBudgets.default || 1000));
    const providers = this.adminStore.providersForRouter().filter((provider) => provider.enabled !== false && provider.apiKeys.length > 0);
    const maxInputRate = providers.reduce((value, provider) => Math.max(value, provider.inputUsdPerM || 0), 0);
    const maxOutputRate = providers.reduce((value, provider) => Math.max(value, provider.outputUsdPerM || 0), 0);
    const estimatedProviderCost = estimatedInputTokens / 1_000_000 * maxInputRate + estimatedOutputTokens / 1_000_000 * maxOutputRate;
    return this.quoteProviderCost(estimatedProviderCost, module);
  }

  priceResponse(response: CliperInternalChatResponse, module?: AiModule): CliperInternalChatResponse {
    const quote = this.quoteProviderCost(response.billing.provider_cost_usd, module);
    return {
      ...response,
      billing: {
        provider_cost_usd: microToUsd(quote.providerCostMicroUsd),
        service_cost_usd: microToUsd(quote.serviceCostMicroUsd),
        billed_cost_usd: microToUsd(quote.userChargeMicroUsd),
        gross_profit_usd: microToUsd(quote.grossProfitMicroUsd),
        credit_charge_micro: Number(quote.creditChargeMicro),
        markup_bps: quote.markupBps,
        markup_percent: quote.markupBps / 100,
      },
    };
  }

  moduleForRequest(request: CliperChatRequest): AiModule {
    const value = String(request.module || request.metadata?.module || "default").toLowerCase();
    if (["story", "ranking", "highlight", "review", "title", "hook", "caption", "metadata", "publishing", "test", "default"].includes(value)) return value as AiModule;
    if (value.includes("highlight") || value.includes("moment")) return "highlight";
    if (value.includes("review") || value.includes("director")) return "review";
    if (value.includes("rank")) return "ranking";
    if (value.includes("story")) return "story";
    if (value.includes("title")) return "title";
    if (value.includes("hook")) return "hook";
    if (value.includes("caption") || value.includes("subtitle")) return "caption";
    if (value.includes("metadata") || value.includes("upload")) return "metadata";
    if (value.includes("publishing") || value.includes("schedule")) return "publishing";
    return "default";
  }

  private isClipModule(module?: AiModule): boolean {
    return module === "story" || module === "ranking" || module === "highlight" || module === "review";
  }
}

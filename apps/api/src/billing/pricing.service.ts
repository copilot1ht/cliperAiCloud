import { Inject, Injectable } from "@nestjs/common";
import {
  quoteClipJob,
  quoteUsageCost,
  validateClipJobPricingPolicy,
  type ClipJobPricingInput,
  type ClipJobPricingQuote,
  type ClipJobPricingValidation,
  type UsageCostQuote,
} from "@cliper/billing";
import type { AiModule, CliperChatRequest, CliperInternalChatResponse } from "@cliper/contracts";
import { AdminStoreService } from "../admin/admin-store.service.js";

function usdToMicro(value: number): bigint {
  return BigInt(Math.ceil(Math.max(0, Number(value || 0)) * 1_000_000));
}

function microToUsd(value: bigint): number {
  return Number(value) / 1_000_000;
}

@Injectable()
export class PricingService {
  constructor(@Inject(AdminStoreService) private readonly adminStore: AdminStoreService) {}

  quoteAnalysisJob(input: ClipJobPricingInput): ClipJobPricingQuote {
    return quoteClipJob(input, this.adminStore.pricingPolicy());
  }

  simulateAnalysisJob(input: ClipJobPricingInput, policyOverride: Record<string, unknown> = {}) {
    const policy = {
      ...this.adminStore.pricingPolicy(),
      ...policyOverride,
    };
    const validation = validateClipJobPricingPolicy(policy);
    if (!validation.valid) return { validation };
    return { validation, quote: quoteClipJob(input, policy) };
  }

  validateAnalysisJobPolicy(): ClipJobPricingValidation {
    return validateClipJobPricingPolicy(this.adminStore.pricingPolicy());
  }

  providerCostIdr(providerCostUsd: number): number {
    return Math.ceil(Math.max(0, Number(providerCostUsd || 0)) * this.adminStore.pricingPolicy().usdToIdr);
  }

  maximumJobCredits(): number {
    return this.adminStore.pricingPolicy().maximumJobCredits;
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
      minimumChargeMicroUsd: BigInt(this.isClipModule(module) ? Math.max(policy.minimumChargeMicroUsd, policy.minimumClipChargeMicroUsd) : policy.minimumChargeMicroUsd),
      markupBps: policy.markupBps,
      minimumMarginBps: policy.minimumMarginBps,
      microUsdPerCredit: BigInt(policy.microUsdPerCredit),
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
    if (["story", "ranking", "highlight", "title", "hook", "caption", "metadata", "test", "default"].includes(value)) return value as AiModule;
    if (value.includes("highlight") || value.includes("moment")) return "highlight";
    if (value.includes("rank")) return "ranking";
    if (value.includes("story")) return "story";
    if (value.includes("title")) return "title";
    if (value.includes("hook")) return "hook";
    if (value.includes("caption") || value.includes("subtitle")) return "caption";
    if (value.includes("metadata") || value.includes("upload")) return "metadata";
    return "default";
  }

  private isClipModule(module?: AiModule): boolean {
    return module === "story" || module === "ranking" || module === "highlight";
  }
}

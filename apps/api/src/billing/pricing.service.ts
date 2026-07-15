import { Injectable } from "@nestjs/common";
import { quoteUsageCost, type UsageCostQuote } from "@cliper/billing";
import type { CliperChatRequest, CliperInternalChatResponse } from "@cliper/contracts";
import { AdminStoreService } from "../admin/admin-store.service.js";

function usdToMicro(value: number): bigint {
  return BigInt(Math.ceil(Math.max(0, Number(value || 0)) * 1_000_000));
}

function microToUsd(value: bigint): number {
  return Number(value) / 1_000_000;
}

@Injectable()
export class PricingService {
  constructor(private readonly adminStore: AdminStoreService) {}

  quoteProviderCost(providerCostUsd: number): UsageCostQuote {
    const policy = this.adminStore.pricingPolicy();
    return quoteUsageCost({
      providerCostMicroUsd: usdToMicro(providerCostUsd),
      computeCostMicroUsd: BigInt(policy.computeCostMicroUsd),
      paymentFeeBps: policy.paymentFeeBps,
      reserveBps: policy.reserveBps,
      minimumChargeMicroUsd: BigInt(policy.minimumChargeMicroUsd),
      markupBps: policy.markupBps,
      microUsdPerCredit: BigInt(policy.microUsdPerCredit),
    });
  }

  estimateRequest(request: CliperChatRequest): UsageCostQuote {
    const promptChars = request.messages.reduce((total, message) => total + message.content.length, 0);
    const estimatedInputTokens = Math.max(1, Math.ceil(promptChars / 4 * 1.15));
    const moduleBudgets = this.adminStore.moduleMaxTokens();
    const estimatedOutputTokens = Math.max(32, Number(request.max_tokens || moduleBudgets[request.module || "default"] || 1000));
    const providers = this.adminStore.providersForRouter().filter((provider) => provider.enabled !== false && provider.apiKeys.length > 0);
    const maxInputRate = providers.reduce((value, provider) => Math.max(value, provider.inputUsdPerM || 0), 0);
    const maxOutputRate = providers.reduce((value, provider) => Math.max(value, provider.outputUsdPerM || 0), 0);
    const estimatedProviderCost = estimatedInputTokens / 1_000_000 * maxInputRate + estimatedOutputTokens / 1_000_000 * maxOutputRate;
    return this.quoteProviderCost(estimatedProviderCost);
  }

  priceResponse(response: CliperInternalChatResponse): CliperInternalChatResponse {
    const quote = this.quoteProviderCost(response.billing.provider_cost_usd);
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
}

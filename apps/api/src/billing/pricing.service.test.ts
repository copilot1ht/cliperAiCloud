import { describe, expect, it } from "vitest";
import { AdminStoreService } from "../admin/admin-store.service.js";
import { PricingService } from "./pricing.service.js";

describe("PricingService", () => {
  it("prices provider cost using the current markup policy", () => {
    const store = new AdminStoreService();
    store.updatePricingPolicy({ markupBps: 5000, microUsdPerCredit: 100, computeCostMicroUsd: 0, paymentFeeBps: 0, reserveBps: 0 });
    const pricing = new PricingService(store);
    const quote = pricing.quoteProviderCost(0.0001);
    expect(quote.providerCostMicroUsd).toBe(100n);
    expect(quote.userChargeMicroUsd).toBe(200n);
    expect(quote.grossProfitMicroUsd).toBe(100n);
    expect(quote.creditChargeMicro).toBe(2_000_000n);
  });

  it("keeps provider cost private from policy overhead calculations", () => {
    const store = new AdminStoreService();
    store.updatePricingPolicy({ markupBps: 2500, computeCostMicroUsd: 20, reserveBps: 500, minimumChargeMicroUsd: 0, microUsdPerCredit: 10 });
    const quote = new PricingService(store).quoteProviderCost(0.00008);
    expect(quote.providerCostMicroUsd).toBe(80n);
    expect(quote.serviceCostMicroUsd).toBe(105n);
    expect(quote.userChargeMicroUsd).toBe(210n);
  });
});

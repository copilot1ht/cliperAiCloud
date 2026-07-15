import { describe, expect, it } from "vitest";
import { quoteUsageCost } from "./index.js";

describe("quoteUsageCost", () => {
  it("applies a 50 percent markup without confusing it with margin rate", () => {
    const quote = quoteUsageCost({ providerCostMicroUsd: 80n, markupBps: 5000, microUsdPerCredit: 1n });
    expect(quote.serviceCostMicroUsd).toBe(80n);
    expect(quote.userChargeMicroUsd).toBe(120n);
    expect(quote.grossProfitMicroUsd).toBe(40n);
    expect(quote.markupBps).toBe(5000);
    expect(quote.grossMarginBps).toBe(3333);
  });

  it("includes compute, payment fee, and reserve before markup", () => {
    const quote = quoteUsageCost({
      providerCostMicroUsd: 1_000n,
      computeCostMicroUsd: 200n,
      paymentFeeBps: 300,
      reserveBps: 200,
      markupBps: 3500,
      microUsdPerCredit: 100n,
    });
    expect(quote.serviceCostMicroUsd).toBe(1_260n);
    expect(quote.userChargeMicroUsd).toBe(1_701n);
    expect(quote.creditChargeMicro).toBe(17_010_000n);
  });

  it("rejects invalid credit value", () => {
    expect(() => quoteUsageCost({ providerCostMicroUsd: 1n, markupBps: 0, microUsdPerCredit: 0n })).toThrow();
  });

  it("uses a minimum request charge without falsifying provider cost", () => {
    const quote = quoteUsageCost({ providerCostMicroUsd: 10n, minimumChargeMicroUsd: 100n, markupBps: 5000, microUsdPerCredit: 10n });
    expect(quote.providerCostMicroUsd).toBe(10n);
    expect(quote.serviceCostMicroUsd).toBe(100n);
    expect(quote.userChargeMicroUsd).toBe(150n);
    expect(quote.grossProfitMicroUsd).toBe(50n);
  });
});

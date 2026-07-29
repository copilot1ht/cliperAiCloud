import { describe, expect, it } from "vitest";
import {
  classifyClipScore,
  quoteClipJob,
  validateClipJobPricingPolicy,
  type ClipJobPricingPolicy,
} from "./index.js";

const policy: ClipJobPricingPolicy = {
  creditValueIdr: 1,
  minimumGrossMarginBps: 5_000,
  targetGrossMarginBps: 6_000,
  baseAnalysisCredits: 300,
  optionalClipCredits: 50,
  goodClipCredits: 100,
  premiumClipCredits: 150,
  optionalScoreMin: 70,
  goodScoreMin: 78,
  premiumScoreMin: 90,
  minimumJobCredits: 300,
  maximumJobCredits: 2_000,
  infrastructureFeeIdr: 50,
  safetyBufferBps: 1_000,
  retryAllowanceBps: 500,
  paymentFeeAllocationBps: 0,
  targetProviderCostIdr: 250,
  warningProviderCostIdr: 400,
  hardProviderCostIdr: 500,
  lowBalanceWarningCredits: 5_000,
};

describe("clip job pricing", () => {
  it("classifies score without inflating rejected clips", () => {
    expect(classifyClipScore(69, policy)).toBe("rejected");
    expect(classifyClipScore(70, policy)).toBe("optional");
    expect(classifyClipScore(78, policy)).toBe("good");
    expect(classifyClipScore(90, policy)).toBe("premium");
  });

  it("charges once per analysis job using quality tiers", () => {
    const quote = quoteClipJob({
      providerCostIdr: 250,
      clipScores: [72, 75, 77, 80, 81, 82, 83, 84, 85, 86, 91, 92, 93, 94, 45],
    }, policy);
    expect(quote.tierCounts).toEqual({ rejected: 1, optional: 3, good: 7, premium: 4 });
    expect(quote.qualityPriceCredits).toBe(1_750);
    expect(quote.finalChargeCredits).toBe(1_750);
    expect(quote.reservationCredits).toBe(2_000);
    expect(quote.grossMarginBps).toBeGreaterThanOrEqual(5_000);
  });

  it("uses protected price when quality pricing is too low", () => {
    const quote = quoteClipJob({ providerCostIdr: 400, clipScores: [71] }, policy);
    expect(quote.finalChargeCredits).toBeGreaterThan(350);
    expect(quote.finalChargeCredits).toBe(quote.protectedPriceCredits);
    expect(quote.grossMarginBps).toBeGreaterThanOrEqual(policy.targetGrossMarginBps - 10);
  });

  it("charges zero and releases the reservation for an unusable result", () => {
    const quote = quoteClipJob({ providerCostIdr: 180, clipScores: [], usableResult: false }, policy);
    expect(quote.finalChargeCredits).toBe(0);
    expect(quote.acceptedClipCount).toBe(0);
  });

  it("rejects a cap that would make the configured hard budget unsafe", () => {
    const unsafe = { ...policy, maximumJobCredits: 900 };
    const validation = validateClipJobPricingPolicy(unsafe);
    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toMatch(/tidak menutup protected price/i);
  });
});

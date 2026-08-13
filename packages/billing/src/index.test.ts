import { describe, expect, it } from "vitest";
import { paymentEventPayload, paymentPayloadHash, quoteJobCost, quoteUsageCost, signPaymentWebhook, verifyPaymentWebhookSignature } from "./index.js";

const jobPolicy = {
  minimumMarginBps: 5000,
  targetMarginBps: 6000,
  infrastructureCostMicroUsd: 2_000,
  paymentFeeBps: 0,
  safetyBufferBps: 1_000,
  retryAllowanceBps: 500,
  minimumJobChargeMicroUsd: 20_000,
  maximumJobChargeMicroUsd: 500_000,
  reservationHeadroomBps: 2_000,
  targetProviderCostMicroUsd: 15_000,
  warningProviderCostMicroUsd: 25_000,
  hardProviderCostMicroUsd: 50_000,
  lowBalanceWarningMicroUsd: 1_000_000,
  usdToIdr: 17_700,
};

describe("quoteJobCost", () => {
  it("reserves only the protected estimate plus headroom, never the global ceiling", () => {
    const quote = quoteJobCost({ providerCostMicroUsd: 15_000n }, jobPolicy);
    expect(quote.reservationMicroUsd).toBeGreaterThan(quote.userChargeMicroUsd);
    expect(quote.reservationMicroUsd).toBeLessThan(500_000n);
    expect(quote.reservationCapped).toBe(false);
  });
});

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
    expect(quote.creditChargeMicro).toBe(1_701n);
  });

  it("does not transform wallet values through the retired credit unit", () => {
    const quote = quoteUsageCost({ providerCostMicroUsd: 1n, markupBps: 0, microUsdPerCredit: 0n });
    expect(quote.creditChargeMicro).toBe(1n);
  });

  it("uses a minimum request charge without falsifying provider cost", () => {
    const quote = quoteUsageCost({ providerCostMicroUsd: 10n, minimumChargeMicroUsd: 100n, markupBps: 5000, microUsdPerCredit: 10n });
    expect(quote.providerCostMicroUsd).toBe(10n);
    expect(quote.serviceCostMicroUsd).toBe(10n);
    expect(quote.userChargeMicroUsd).toBe(100n);
    expect(quote.grossProfitMicroUsd).toBe(90n);
  });

  it("enforces a real 50 percent gross margin when configured", () => {
    const quote = quoteUsageCost({ providerCostMicroUsd: 100n, markupBps: 5000, minimumMarginBps: 5000, microUsdPerCredit: 1n });
    expect(quote.userChargeMicroUsd).toBe(200n);
    expect(quote.grossProfitMicroUsd).toBe(100n);
    expect(quote.markupBps).toBe(10000);
    expect(quote.grossMarginBps).toBe(5000);
  });
});

describe("payment webhook security", () => {
  const secret = "sandbox-webhook-secret-32-characters";
  const raw = Buffer.from(paymentEventPayload({
    eventId: "evt-1",
    externalId: "pay-1",
    invoiceNumber: "INV-1",
    amountIdr: 99_000,
    status: "paid",
    occurredAt: "2026-07-15T00:00:00.000Z",
  }));

  it("accepts a valid HMAC and rejects a tampered body", () => {
    const signature = signPaymentWebhook(secret, raw);
    expect(verifyPaymentWebhookSignature(secret, raw, signature)).toBe(true);
    expect(verifyPaymentWebhookSignature(secret, Buffer.from(`${raw.toString()}x`), signature)).toBe(false);
  });

  it("creates a stable payload hash without exposing the payload", () => {
    expect(paymentPayloadHash(raw)).toMatch(/^[a-f0-9]{64}$/);
    expect(paymentPayloadHash(raw)).toBe(paymentPayloadHash(Buffer.from(raw)));
  });
});

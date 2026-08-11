import { describe, expect, it } from "vitest";
import { WalletPaymentSettingsService } from "./wallet-payment-settings.service.js";

const settings = {
  source: "database" as const,
  walletCurrency: "USD" as const,
  paymentCurrency: "IDR" as const,
  minPurchaseUsd: "1.000000",
  maxPurchaseUsd: "500.000000",
  minPurchaseMicroUsd: 1_000_000n,
  maxPurchaseMicroUsd: 500_000_000n,
  usdToIdrRate: 17_700,
  serviceFeeIdr: 1_000,
  uniqueCodeEnabled: true,
  uniqueCodeMin: 99,
  uniqueCodeMax: 299,
  maxTotalPaymentIdr: 8_851_299,
};

describe("WalletPaymentSettingsService", () => {
  it("creates an IDR payment quote while crediting only the USD purchase", () => {
    const service = new WalletPaymentSettingsService({ configured: () => false } as never);
    const quote = service.quote(1_000_000n, settings);
    expect(quote.purchaseUsd).toBe("1.000000");
    expect(quote.subtotalIdr).toBe(17_700);
    expect(quote.serviceFeeIdr).toBe(1_000);
    expect(quote.uniqueCodeIdr).toBeGreaterThanOrEqual(99);
    expect(quote.uniqueCodeIdr).toBeLessThanOrEqual(299);
    expect(quote.totalPaymentIdr).toBe(quote.subtotalIdr + quote.serviceFeeIdr + quote.uniqueCodeIdr);
  });

  it("does not permit a purchase outside the configured USD bounds", () => {
    const service = new WalletPaymentSettingsService({ configured: () => false } as never);
    expect(() => service.quote(999_999n, settings)).toThrow("Top-up harus antara");
  });
});

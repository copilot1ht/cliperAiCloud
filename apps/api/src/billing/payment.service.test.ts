import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configuredTopupMinimumIdr,
  configuredTopupMinimumUsd,
  configuredTopupUsdToIdrDisplayRate,
  detectMidtransDashboardTestNotification,
  paymentEnvironment,
  PaymentService,
  providerInvoiceExpiry,
  transientQrDataUrl,
} from "./payment.service.js";

describe("Billing top-up helpers", () => {
  afterEach(() => {
    delete process.env.PAYMENT_MIN_TOPUP_IDR;
    delete process.env.PAYMENT_MIN_TOPUP_USD;
    delete process.env.PAYMENT_USD_TO_IDR_DISPLAY_RATE;
    delete process.env.PLATFORM_USD_TO_IDR;
  });

  it("uses the configured IDR minimum as the payment authority", () => {
    process.env.PAYMENT_MIN_TOPUP_IDR = "100000";
    expect(configuredTopupMinimumIdr()).toBe(100000);
  });

  it("defaults to Rp17.000 while USD remains a display reference", () => {
    expect(configuredTopupMinimumUsd()).toBe(1);
    expect(configuredTopupUsdToIdrDisplayRate()).toBe(17700);
    expect(configuredTopupMinimumIdr()).toBe(17000);
  });

  it("ignores invalid top-up overrides", () => {
    process.env.PAYMENT_MIN_TOPUP_IDR = "not-a-number";
    process.env.PAYMENT_MIN_TOPUP_USD = "not-a-number";
    process.env.PAYMENT_USD_TO_IDR_DISPLAY_RATE = "not-a-number";
    expect(configuredTopupMinimumIdr()).toBe(17000);
  });

  it("creates a temporary QR image only when a provider QR payload exists", async () => {
    expect(await transientQrDataUrl(null)).toBeNull();
    await expect(transientQrDataUrl("CLIPER:payment:test")).resolves.toMatch(
      /^data:image\/png;base64,/,
    );
  });

});

describe("non-financial payment webhooks", () => {
  it("recognizes the reserved Midtrans dashboard test prefix only", () => {
    const test = detectMidtransDashboardTestNotification(
      Buffer.from(
        JSON.stringify({
          order_id: "payment_notif_test_20260809_001",
          status_code: "200",
          transaction_status: "pending",
        }),
      ),
    );
    expect(test?.signaturePresent).toBe(false);
    expect(
      detectMidtransDashboardTestNotification(
        Buffer.from(JSON.stringify({ order_id: "CLP-20260809-REAL" })),
      ),
    ).toBeNull();
  });

  it("keeps Xendit QRIS invoices open for the provider payment window", () => {
    const now = Date.UTC(2026, 7, 9, 0, 0, 0);
    expect(providerInvoiceExpiry("xendit", now).getTime() - now).toBe(
      48 * 60 * 60_000,
    );
    expect(providerInvoiceExpiry("midtrans", now).getTime() - now).toBe(
      15 * 60_000,
    );
  });

  it("keeps test and sandbox transactions out of production payment reporting", () => {
    expect(paymentEnvironment({ environment: "test" })).toBe("test");
    expect(paymentEnvironment({ provider: { mode: "sandbox" } })).toBe("test");
    expect(paymentEnvironment({ environment: "live" })).toBe("production");
  });

  it("refuses to simulate an invoice that was not created in test mode", async () => {
    const database = {
      configured: () => true,
      client: () => ({
        invoice: {
          findFirst: vi.fn().mockResolvedValue({
            metadata: { environment: "production" },
            status: "OPEN",
            payment: { provider: "xendit", externalId: "pr-live" },
          }),
        },
      }),
    };
    const providers = { simulateXenditTestPayment: vi.fn() };
    const service = new PaymentService(
      database as never,
      providers as never,
      {} as never,
    );

    await expect(
      service.simulateXenditTestInvoice("admin-user", "CLP-LIVE"),
    ).rejects.toThrow("Xendit test mode");
    expect(providers.simulateXenditTestPayment).not.toHaveBeenCalled();
  });

  it("acknowledges a verified Xendit informational callback without provider or wallet work", async () => {
    const database = {
      configured: () => false,
      client: vi.fn(),
    };
    const providers = {
      byCode: vi.fn().mockResolvedValue({
        code: "xendit",
        verifyWebhook: () => ({ verified: true, payloadHash: "test-payload" }),
      }),
    };
    const service = new PaymentService(
      database as never,
      providers as never,
      {} as never,
    );
    await expect(
      service.processWebhook("xendit", Buffer.from("{}"), {}),
    ).resolves.toMatchObject({ ok: true, processed: false, test: true });
    expect(providers.byCode).toHaveBeenCalledWith("xendit");
  });
});

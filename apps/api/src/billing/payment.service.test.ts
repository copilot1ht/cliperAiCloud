import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectMidtransDashboardTestNotification,
  paymentEnvironment,
  PaymentService,
  providerInvoiceExpiry,
  transientQrDataUrl,
} from "./payment.service.js";
import { microToUsd, usdToMicro } from "./wallet-payment-settings.service.js";

describe("USD wallet helpers", () => {
  it("stores exact USD wallet values as micro-USD", () => {
    expect(usdToMicro("1")).toBe(1_000_000n);
    expect(usdToMicro("1.25")).toBe(1_250_000n);
    expect(microToUsd(1_000_000n)).toBe("1.000000");
  });

  it("rejects floating point and malformed purchase values", () => {
    expect(() => usdToMicro("1.0000001")).toThrow("maksimal 6 digit");
    expect(() => usdToMicro("1e3")).toThrow("angka USD");
  });

  it("creates a temporary QR image only when a provider QR payload exists", async () => {
    expect(await transientQrDataUrl(null)).toBeNull();
    await expect(transientQrDataUrl("CLIPER:payment:test")).resolves.toMatch(
      /^data:image\/png;base64,/,
    );
  });

  it("returns a QR image only for an open invoice and never exposes its raw payload", async () => {
    const service = new PaymentService({} as never, {} as never, {} as never);
    const safeInvoice = Reflect.get(service, "safeInvoice") as (
      invoice: Record<string, unknown>,
    ) => Promise<{
      qrString: string | null;
      qrImageBase64: string | null;
      qrImageUrl: string | null;
    }>;
    const baseInvoice = {
      number: "CLP-QR-TEST",
      subtotalIdr: 17_000,
      taxIdr: 0,
      totalIdr: 17_000,
      provider: "xendit",
      paymentUrl: null,
      qrString: "0002010102122665TEST-QR-PAYLOAD",
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      paidAt: null,
      metadata: { kind: "topup", creditMicro: "1000000" },
      payment: null,
      items: [],
    };

    const open = await safeInvoice({ ...baseInvoice, status: "OPEN" });
    const paid = await safeInvoice({
      ...baseInvoice,
      status: "PAID",
      paidAt: new Date(),
    });

    expect(open.qrString).toBeNull();
    expect(open.qrImageBase64).toMatch(/^data:image\/png;base64,/);
    expect(paid.qrString).toBeNull();
    expect(paid.qrImageBase64).toBeNull();
    expect(paid.qrImageUrl).toBeNull();
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

  it("acknowledges an old verified Xendit dashboard event for an unknown invoice", async () => {
    const paymentLog = {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    };
    const database = {
      configured: () => true,
      client: () => ({
        $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
          work({
            paymentLog,
            paymentTransaction: { findUnique: vi.fn().mockResolvedValue(null) },
          }),
      }),
    };
    const providers = {
      byCode: vi.fn().mockResolvedValue({
        code: "xendit",
        verifyWebhook: () => ({
          verified: true,
          payloadHash: "test-payload",
          signature: "verified-token",
          event: {
            eventId: "xendit:payment.capture:dashboard-sample",
            externalId: "pr-dashboard-sample",
            invoiceNumber: "dashboard-sample-reference",
            amountIdr: 10_000,
            status: "paid",
            occurredAt: "2025-02-13T00:00:00.000Z",
          },
        }),
      }),
    };
    const service = new PaymentService(
      database as never,
      providers as never,
      {} as never,
    );

    await expect(
      service.processWebhook("xendit", Buffer.from("{}"), {}),
    ).resolves.toMatchObject({
      ok: true,
      processed: false,
      accepted: false,
    });
    expect(paymentLog.create).toHaveBeenCalledOnce();
  });

  it("rejects a stale known payment before any wallet mutation", async () => {
    const paymentLog = {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    };
    const wallet = { upsert: vi.fn() };
    const database = {
      configured: () => true,
      client: () => ({
        $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
          work({
            paymentLog,
            userCreditAccount: wallet,
            paymentTransaction: {
              findUnique: vi.fn().mockResolvedValue({
                id: "payment-1",
                amountIdr: 17_000,
                invoice: {
                  id: "invoice-1",
                  number: "CLP-20260809-STALE",
                  totalIdr: 17_000,
                },
              }),
            },
          }),
      }),
    };
    const providers = {
      byCode: vi.fn().mockResolvedValue({
        code: "xendit",
        verifyWebhook: () => ({
          verified: true,
          payloadHash: "test-payload",
          signature: "verified-token",
          event: {
            eventId: "xendit:payment.capture:stale",
            externalId: "pr-stale",
            invoiceNumber: "CLP-20260809-STALE",
            amountIdr: 17_000,
            status: "paid",
            occurredAt: "2025-02-13T00:00:00.000Z",
          },
        }),
      }),
    };
    const service = new PaymentService(
      database as never,
      providers as never,
      {} as never,
    );

    await expect(
      service.processWebhook("xendit", Buffer.from("{}"), {}),
    ).resolves.toMatchObject({
      ok: true,
      processed: false,
      accepted: false,
      reason: "Webhook berada di luar replay window.",
    });
    expect(wallet.upsert).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaymentWebhookEvent } from "@cliper/billing";
import { createHash } from "node:crypto";
import { MidtransPaymentProvider, SandboxPaymentProvider } from "./payment-provider.service.js";

describe("SandboxPaymentProvider", () => {
  const provider = new SandboxPaymentProvider("payment-secret-with-at-least-32-characters", "http://localhost:3000");
  const event: PaymentWebhookEvent = {
    eventId: "sbx-event-001",
    externalId: "sbx-payment-001",
    invoiceNumber: "CLP-20260715-TEST",
    amountIdr: 99_000,
    status: "paid",
    occurredAt: "2026-07-15T00:00:00.000Z",
  };

  afterEach(() => {
    delete process.env.PAYMENT_PROVIDER;
    delete process.env.ALLOW_SANDBOX_PAYMENTS;
  });

  it("creates a unique dynamic sandbox payment reference", async () => {
    const first = await provider.createPayment({ invoiceNumber: "INV-1", amountIdr: 99_000, expiresAt: new Date().toISOString(), customer: { id: "u1", email: "user@example.com", displayName: "User" }, description: "Starter" });
    const second = await provider.createPayment({ invoiceNumber: "INV-2", amountIdr: 99_000, expiresAt: new Date().toISOString(), customer: { id: "u1", email: "user@example.com", displayName: "User" }, description: "Starter" });
    expect(first.externalId).not.toBe(second.externalId);
    expect(first.qrString).toMatch(/^CLIPER-SANDBOX:/);
  });

  it("verifies the exact signed webhook body", () => {
    const signed = provider.signedEvent(event);
    expect(provider.verifyWebhook(signed.rawBody, { "x-cliper-signature": signed.signature })).toMatchObject({ verified: true, event });
    expect(provider.verifyWebhook(Buffer.from(`${signed.rawBody.toString()} `), { "x-cliper-signature": signed.signature }).verified).toBe(false);
  });
});

describe("MidtransPaymentProvider", () => {
  const serverKey = "SB-Mid-server-test-key-with-enough-length";
  const provider = new MidtransPaymentProvider(serverKey, "https://cliper.example", false);

  afterEach(() => vi.unstubAllGlobals());

  it("creates a hosted Snap checkout without exposing the server key", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ token: "snap-token", redirect_url: "https://app.sandbox.midtrans.com/snap/v2/vtweb/snap-token" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await provider.createPayment({ invoiceNumber: "CLP-20260715-TEST", amountIdr: 25_000, expiresAt: new Date(Date.now() + 900_000).toISOString(), customer: { id: "u1", email: "user@example.com", displayName: "User" }, description: "Top-up" });
    expect(result.provider).toBe("midtrans");
    expect(result.paymentUrl).toContain("snap/v2/vtweb");
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const request = calls[0]?.[1] || {};
    expect(String(request.headers && (request.headers as Record<string, string>).Authorization)).not.toContain(serverKey);
    expect(String(request.body)).toContain("25000");
  });

  it("validates Midtrans signature and maps settlement to paid", () => {
    const orderId = "CLP-20260715-TEST";
    const grossAmount = "25000.00";
    const statusCode = "200";
    const signature = createHash("sha512").update(`${orderId}${statusCode}${grossAmount}${serverKey}`).digest("hex");
    const raw = Buffer.from(JSON.stringify({ order_id: orderId, status_code: statusCode, gross_amount: grossAmount, signature_key: signature, transaction_status: "settlement", transaction_id: "trx-1", transaction_time: "2026-07-15 12:00:00" }));
    expect(provider.verifyWebhook(raw, {})).toMatchObject({ verified: true, event: { externalId: orderId, amountIdr: 25_000, status: "paid" } });
    expect(provider.verifyWebhook(Buffer.from(raw.toString().replace("25000.00", "26000.00")), {}).verified).toBe(false);
  });

  it("reads the official transaction status without exposing the server key", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      order_id: "CLP-20260715-TEST",
      gross_amount: "25000.00",
      transaction_status: "settlement",
      transaction_id: "trx-status-1",
      settlement_time: "2026-07-15 12:00:00",
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const event = await provider.getTransactionStatus("CLP-20260715-TEST");
    expect(event).toMatchObject({ externalId: "CLP-20260715-TEST", invoiceNumber: "CLP-20260715-TEST", amountIdr: 25_000, status: "paid" });
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]?.[0]).toContain("/v2/CLP-20260715-TEST/status");
    expect(String(calls[0]?.[1]?.headers && (calls[0][1].headers as Record<string, string>).Authorization)).not.toContain(serverKey);
  });
});

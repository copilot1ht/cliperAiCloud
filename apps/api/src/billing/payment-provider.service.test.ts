import { afterEach, describe, expect, it } from "vitest";
import type { PaymentWebhookEvent } from "@cliper/billing";
import { SandboxPaymentProvider } from "./payment-provider.service.js";

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

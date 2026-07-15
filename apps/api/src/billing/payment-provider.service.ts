import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import {
  paymentEventPayload,
  paymentPayloadHash,
  signPaymentWebhook,
  verifyPaymentWebhookSignature,
  type CreateProviderPaymentInput,
  type CreateProviderPaymentResult,
  type PaymentProvider,
  type PaymentWebhookEvent,
  type VerifiedPaymentWebhook,
} from "@cliper/billing";
import { randomUUID } from "node:crypto";

const SANDBOX_CODE = "sandbox";
const LOCAL_SANDBOX_SECRET = "cliper-local-sandbox-secret-change-me";

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

function validEvent(value: unknown): value is PaymentWebhookEvent {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PaymentWebhookEvent>;
  return Boolean(
    String(item.eventId || "").length >= 6
    && String(item.externalId || "").length >= 6
    && String(item.invoiceNumber || "").length >= 6
    && Number.isSafeInteger(item.amountIdr)
    && Number(item.amountIdr) > 0
    && ["pending", "paid", "failed", "expired", "refunded"].includes(String(item.status))
    && Number.isFinite(new Date(String(item.occurredAt || "")).getTime()),
  );
}

export class SandboxPaymentProvider implements PaymentProvider {
  readonly code = SANDBOX_CODE;

  constructor(private readonly secret: string, private readonly webOrigin: string) {}

  async createPayment(input: CreateProviderPaymentInput): Promise<CreateProviderPaymentResult> {
    const externalId = `sbx_pay_${randomUUID()}`;
    const payload = Buffer.from(JSON.stringify({
      version: 1,
      provider: this.code,
      externalId,
      invoice: input.invoiceNumber,
      amountIdr: input.amountIdr,
      expiresAt: input.expiresAt,
      nonce: randomUUID(),
    })).toString("base64url");
    return {
      provider: this.code,
      externalId,
      status: "pending",
      paymentUrl: `${this.webOrigin.replace(/\/$/, "")}/invoices?invoice=${encodeURIComponent(input.invoiceNumber)}`,
      qrString: `CLIPER-SANDBOX:${payload}`,
      safeMetadata: { mode: "sandbox", dynamic: true },
    };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): VerifiedPaymentWebhook {
    const signature = headerValue(headers, "x-cliper-signature");
    const payloadHash = paymentPayloadHash(rawBody);
    if (!verifyPaymentWebhookSignature(this.secret, rawBody, signature)) {
      return { verified: false, reason: "Webhook signature tidak valid.", payloadHash, signature };
    }
    try {
      const event = JSON.parse(rawBody.toString("utf8")) as unknown;
      if (!validEvent(event)) return { verified: false, reason: "Payload webhook tidak valid.", payloadHash, signature };
      return { verified: true, event, payloadHash, signature };
    } catch {
      return { verified: false, reason: "Payload webhook bukan JSON valid.", payloadHash, signature };
    }
  }

  async refund(externalId: string, _amountIdr: number): Promise<{ ok: true; reference: string }> {
    return { ok: true, reference: `sbx_ref_${externalId}_${randomUUID()}` };
  }

  signedEvent(event: PaymentWebhookEvent): { rawBody: Buffer; signature: string } {
    const rawBody = Buffer.from(paymentEventPayload(event));
    return { rawBody, signature: signPaymentWebhook(this.secret, rawBody) };
  }
}

@Injectable()
export class PaymentProviderService {
  private readonly sandbox: SandboxPaymentProvider;

  constructor() {
    const secret = String(process.env.PAYMENT_SANDBOX_WEBHOOK_SECRET || LOCAL_SANDBOX_SECRET);
    this.sandbox = new SandboxPaymentProvider(secret, process.env.WEB_ORIGIN || "http://localhost:3000");
  }

  active(): PaymentProvider {
    const code = String(process.env.PAYMENT_PROVIDER || SANDBOX_CODE).trim().toLowerCase();
    if (code !== SANDBOX_CODE) {
      throw new ServiceUnavailableException(`Payment provider '${code}' belum memiliki adapter aktif.`);
    }
    const production = process.env.NODE_ENV === "production";
    const sandboxAllowed = String(process.env.ALLOW_SANDBOX_PAYMENTS || "false").toLowerCase() === "true";
    if (production && !sandboxAllowed) {
      throw new ServiceUnavailableException("Sandbox payment dinonaktifkan di production. Konfigurasikan adapter QRIS resmi.");
    }
    return this.sandbox;
  }

  byCode(code: string): PaymentProvider {
    if (String(code).toLowerCase() !== SANDBOX_CODE) throw new BadRequestException("Payment provider tidak didukung.");
    return this.active();
  }

  sandboxEvent(event: PaymentWebhookEvent): { rawBody: Buffer; signature: string } {
    return this.sandbox.signedEvent(event);
  }
}

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
import { createHash, randomUUID } from "node:crypto";

const SANDBOX_CODE = "sandbox";
const MIDTRANS_CODE = "midtrans";
const LOCAL_SANDBOX_SECRET = "cliper-local-sandbox-secret-change-me";

function midtransAmount(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function midtransStatus(value: unknown, fraudStatus?: unknown): PaymentWebhookEvent["status"] {
  const status = String(value || "").toLowerCase();
  if (status === "settlement") return "paid";
  if (status === "capture") return String(fraudStatus || "accept").toLowerCase() === "accept" ? "paid" : "failed";
  if (status === "expire") return "expired";
  if (status === "cancel" || status === "deny" || status === "failure") return "failed";
  if (status === "refund" || status === "partial_refund") return "refunded";
  return "pending";
}

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

export class MidtransPaymentProvider implements PaymentProvider {
  readonly code = MIDTRANS_CODE;
  private readonly serverKey: string;
  private readonly apiOrigin: string;
  private readonly snapOrigin: string;
  private readonly webOrigin: string;

  constructor(serverKey: string, webOrigin: string, production = false) {
    this.serverKey = String(serverKey || "").trim();
    this.apiOrigin = production ? "https://api.midtrans.com" : "https://api.sandbox.midtrans.com";
    this.snapOrigin = production ? "https://app.midtrans.com" : "https://app.sandbox.midtrans.com";
    this.webOrigin = webOrigin;
    if (this.serverKey.length < 20) throw new ServiceUnavailableException("MIDTRANS_SERVER_KEY belum dikonfigurasi.");
  }

  private headers(): Record<string, string> {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${this.serverKey}:`).toString("base64")}`,
    };
  }

  private async request(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) {
        const message = String(payload.status_message || payload.error_messages || `Midtrans HTTP ${response.status}`);
        throw new ServiceUnavailableException(`Midtrans request gagal: ${message.slice(0, 240)}`);
      }
      return payload;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException("Midtrans tidak dapat dihubungi. Coba lagi beberapa saat.");
    } finally {
      clearTimeout(timer);
    }
  }

  async createPayment(input: CreateProviderPaymentInput): Promise<CreateProviderPaymentResult> {
    const expiresAt = new Date(input.expiresAt).getTime();
    const durationMinutes = Math.max(5, Math.min(7 * 24 * 60, Math.ceil((expiresAt - Date.now()) / 60_000)));
    const payload = await this.request(`${this.snapOrigin}/snap/v1/transactions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        transaction_details: { order_id: input.invoiceNumber, gross_amount: input.amountIdr },
        item_details: [{ id: input.invoiceNumber, price: input.amountIdr, quantity: 1, name: input.description.slice(0, 50) }],
        customer_details: { first_name: input.customer.displayName.slice(0, 50), email: input.customer.email },
        callbacks: { finish: `${this.webOrigin.replace(/\/$/, "")}/invoices?invoice=${encodeURIComponent(input.invoiceNumber)}` },
        expiry: { unit: "minute", duration: durationMinutes },
      }),
    });
    const redirectUrl = String(payload.redirect_url || "").trim();
    const token = String(payload.token || "").trim();
    if (!redirectUrl && !token) throw new ServiceUnavailableException("Midtrans tidak mengembalikan payment URL.");
    return {
      provider: this.code,
      externalId: input.invoiceNumber,
      status: "pending",
      paymentUrl: redirectUrl || `${this.snapOrigin}/snap/v2/vtweb/${encodeURIComponent(token)}`,
      safeMetadata: { mode: "midtrans", checkout: "snap", orderId: input.invoiceNumber },
    };
  }

  verifyWebhook(rawBody: Buffer, _headers: Record<string, string | string[] | undefined>): VerifiedPaymentWebhook {
    const payloadHash = paymentPayloadHash(rawBody);
    try {
      const payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
      const orderId = String(payload.order_id || "").trim();
      const statusCode = String(payload.status_code || "").trim();
      const grossAmount = String(payload.gross_amount || "").trim();
      const signature = String(payload.signature_key || "").trim().toLowerCase();
      const expected = createHash("sha512").update(`${orderId}${statusCode}${grossAmount}${this.serverKey}`).digest("hex");
      if (!orderId || !statusCode || !grossAmount || !signature || signature !== expected) {
        return { verified: false, reason: "Signature Midtrans tidak valid.", payloadHash, signature };
      }
      const amountIdr = midtransAmount(grossAmount);
      const status = midtransStatus(payload.transaction_status, payload.fraud_status);
      const transactionId = String(payload.transaction_id || "").trim();
      const event: PaymentWebhookEvent = {
        eventId: `midtrans:${orderId}:${String(payload.transaction_status || "pending")}:${transactionId || signature.slice(0, 16)}`,
        externalId: orderId,
        invoiceNumber: orderId,
        amountIdr,
        status,
        occurredAt: String(payload.settlement_time || payload.transaction_time || new Date().toISOString()),
      };
      if (!Number.isSafeInteger(amountIdr) || amountIdr <= 0 || !validEvent(event)) {
        return { verified: false, reason: "Payload notification Midtrans tidak valid.", payloadHash, signature };
      }
      return { verified: true, event, payloadHash, signature };
    } catch {
      return { verified: false, reason: "Payload notification Midtrans bukan JSON valid.", payloadHash };
    }
  }

  async refund(externalId: string, amountIdr: number): Promise<{ ok: true; reference: string }> {
    const refundKey = `cliper-refund-${externalId}`.slice(0, 50);
    const payload = await this.request(`${this.apiOrigin}/v2/${encodeURIComponent(externalId)}/refund`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ refund_key: refundKey, gross_amount: amountIdr, reason: "Cliper Cloud admin refund" }),
    });
    return { ok: true, reference: String(payload.refund_chargeback_id || payload.transaction_id || refundKey) };
  }
}

@Injectable()
export class PaymentProviderService {
  private readonly sandbox: SandboxPaymentProvider;
  private readonly midtrans?: MidtransPaymentProvider;

  constructor() {
    const secret = String(process.env.PAYMENT_SANDBOX_WEBHOOK_SECRET || LOCAL_SANDBOX_SECRET);
    this.sandbox = new SandboxPaymentProvider(secret, process.env.WEB_ORIGIN || "http://localhost:3000");
    if (process.env.MIDTRANS_SERVER_KEY) {
      this.midtrans = new MidtransPaymentProvider(
        process.env.MIDTRANS_SERVER_KEY,
        process.env.WEB_ORIGIN || "http://localhost:3000",
        String(process.env.MIDTRANS_IS_PRODUCTION || "false").toLowerCase() === "true",
      );
    }
  }

  active(): PaymentProvider {
    const code = String(process.env.PAYMENT_PROVIDER || SANDBOX_CODE).trim().toLowerCase();
    if (code === MIDTRANS_CODE) {
      if (!this.midtrans) throw new ServiceUnavailableException("Midtrans belum dikonfigurasi. Isi MIDTRANS_SERVER_KEY di environment API.");
      return this.midtrans;
    }
    if (code !== SANDBOX_CODE) throw new ServiceUnavailableException(`Payment provider '${code}' belum memiliki adapter aktif.`);
    const production = process.env.NODE_ENV === "production";
    const sandboxAllowed = String(process.env.ALLOW_SANDBOX_PAYMENTS || "false").toLowerCase() === "true";
    if (production && !sandboxAllowed) {
      throw new ServiceUnavailableException("Sandbox payment dinonaktifkan di production. Konfigurasikan adapter QRIS resmi.");
    }
    return this.sandbox;
  }

  byCode(code: string): PaymentProvider {
    if (![SANDBOX_CODE, MIDTRANS_CODE].includes(String(code).toLowerCase())) throw new BadRequestException("Payment provider tidak didukung.");
    return this.active();
  }

  sandboxEvent(event: PaymentWebhookEvent): { rawBody: Buffer; signature: string } {
    return this.sandbox.signedEvent(event);
  }
}

import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
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
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";

const SANDBOX_CODE = "sandbox";
const MIDTRANS_CODE = "midtrans";
const LOCAL_SANDBOX_SECRET = "cliper-local-sandbox-secret-change-me";

function midtransAmount(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function midtransStatus(
  value: unknown,
  fraudStatus?: unknown,
): PaymentWebhookEvent["status"] {
  const status = String(value || "").toLowerCase();
  if (status === "settlement") return "paid";
  if (status === "capture")
    return String(fraudStatus || "accept").toLowerCase() === "accept"
      ? "paid"
      : "failed";
  if (status === "expire") return "expired";
  if (status === "cancel" || status === "deny" || status === "failure")
    return "failed";
  if (status === "refund" || status === "partial_refund") return "refunded";
  return "pending";
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function validEvent(value: unknown): value is PaymentWebhookEvent {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PaymentWebhookEvent>;
  return Boolean(
    String(item.eventId || "").length >= 6 &&
    String(item.externalId || "").length >= 6 &&
    String(item.invoiceNumber || "").length >= 6 &&
    Number.isSafeInteger(item.amountIdr) &&
    Number(item.amountIdr) > 0 &&
    ["pending", "paid", "failed", "expired", "refunded"].includes(
      String(item.status),
    ) &&
    Number.isFinite(new Date(String(item.occurredAt || "")).getTime()),
  );
}

export class SandboxPaymentProvider implements PaymentProvider {
  readonly code = SANDBOX_CODE;

  constructor(
    private readonly secret: string,
    _webOrigin: string,
  ) {}

  async createPayment(
    input: CreateProviderPaymentInput,
  ): Promise<CreateProviderPaymentResult> {
    const externalId = `sbx_pay_${randomUUID()}`;
    const payload = Buffer.from(
      JSON.stringify({
        version: 1,
        provider: this.code,
        externalId,
        invoice: input.invoiceNumber,
        amountIdr: input.amountIdr,
        expiresAt: input.expiresAt,
        nonce: randomUUID(),
      }),
    ).toString("base64url");
    const qrString = `CLIPER-SANDBOX:${payload}`;
    return {
      provider: this.code,
      externalId,
      status: "pending",
      qrString,
      qrImageBase64: await QRCode.toDataURL(qrString, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 320,
      }),
      safeMetadata: {
        mode: "sandbox",
        paymentType: "qris",
        dynamic: true,
      },
    };
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): VerifiedPaymentWebhook {
    const signature = headerValue(headers, "x-cliper-signature");
    const payloadHash = paymentPayloadHash(rawBody);
    if (!verifyPaymentWebhookSignature(this.secret, rawBody, signature)) {
      return {
        verified: false,
        reason: "Webhook signature tidak valid.",
        payloadHash,
        signature,
      };
    }
    try {
      const event = JSON.parse(rawBody.toString("utf8")) as unknown;
      if (!validEvent(event))
        return {
          verified: false,
          reason: "Payload webhook tidak valid.",
          payloadHash,
          signature,
        };
      return { verified: true, event, payloadHash, signature };
    } catch {
      return {
        verified: false,
        reason: "Payload webhook bukan JSON valid.",
        payloadHash,
        signature,
      };
    }
  }

  async refund(
    externalId: string,
    _amountIdr: number,
  ): Promise<{ ok: true; reference: string }> {
    return { ok: true, reference: `sbx_ref_${externalId}_${randomUUID()}` };
  }

  signedEvent(event: PaymentWebhookEvent): {
    rawBody: Buffer;
    signature: string;
  } {
    const rawBody = Buffer.from(paymentEventPayload(event));
    return { rawBody, signature: signPaymentWebhook(this.secret, rawBody) };
  }
}

export class MidtransPaymentProvider implements PaymentProvider {
  readonly code = MIDTRANS_CODE;
  private readonly serverKey: string;
  private readonly apiOrigin: string;

  constructor(serverKey: string, _webOrigin: string, production = false) {
    this.serverKey = String(serverKey || "").trim();
    this.apiOrigin = production
      ? "https://api.midtrans.com"
      : "https://api.sandbox.midtrans.com";
    if (this.serverKey.length < 20)
      throw new ServiceUnavailableException(
        "MIDTRANS_SERVER_KEY belum dikonfigurasi.",
      );
    if (production && /^SB-Mid-server-/i.test(this.serverKey)) {
      throw new ServiceUnavailableException(
        "Mode Midtrans Production membutuhkan Server Key Production.",
      );
    }
    if (!production && /^Mid-server-/i.test(this.serverKey)) {
      throw new ServiceUnavailableException(
        "Mode Midtrans Sandbox membutuhkan Server Key Sandbox. Jangan gunakan key Production di localhost.",
      );
    }
  }

  private headers(): Record<string, string> {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${this.serverKey}:`).toString("base64")}`,
    };
  }

  private async request(
    url: string,
    init: RequestInit,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const payload = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!response.ok) {
        const message = String(
          payload.status_message ||
            payload.error_messages ||
            `Midtrans HTTP ${response.status}`,
        );
        throw new ServiceUnavailableException(
          `Midtrans request gagal: ${message.slice(0, 240)}`,
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException(
        "Midtrans tidak dapat dihubungi. Coba lagi beberapa saat.",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async qrImageDataUrl(url: string): Promise<string> {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      (parsed.hostname !== "midtrans.com" &&
        !parsed.hostname.endsWith(".midtrans.com"))
    ) {
      throw new ServiceUnavailableException(
        "Midtrans mengembalikan QR URL yang tidak valid.",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(parsed.toString(), {
        method: "GET",
        headers: {
          Accept: "image/png",
          Authorization: this.headers()["Authorization"] || "",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ServiceUnavailableException(
          `Gambar QRIS Midtrans gagal dimuat (HTTP ${response.status}).`,
        );
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 64 || bytes.length > 2_000_000) {
        throw new ServiceUnavailableException(
          "Ukuran gambar QRIS Midtrans tidak valid.",
        );
      }
      const contentType = (String(response.headers.get("content-type") || "")
        .split(";")[0] || "")
        .trim()
        .toLowerCase();
      const mime = contentType === "image/svg+xml" ? contentType : "image/png";
      return `data:${mime};base64,${bytes.toString("base64")}`;
    } finally {
      clearTimeout(timer);
    }
  }

  async createPayment(
    input: CreateProviderPaymentInput,
  ): Promise<CreateProviderPaymentResult> {
    const payload = await this.request(
      `${this.apiOrigin}/v2/charge`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          payment_type: "qris",
          transaction_details: {
            order_id: input.invoiceNumber,
            gross_amount: input.amountIdr,
          },
          item_details: [
            {
              id: input.invoiceNumber,
              price: input.amountIdr,
              quantity: 1,
              name: input.description.slice(0, 50),
            },
          ],
          customer_details: {
            first_name: input.customer.displayName.slice(0, 50),
            email: input.customer.email,
          },
        }),
      },
    );
    const actions = Array.isArray(payload.actions)
      ? (payload.actions as Array<Record<string, unknown>>)
      : [];
    const qrAction =
      actions.find((item) => item.name === "generate-qr-code-v2") ||
      actions.find((item) => item.name === "generate-qr-code");
    const qrImageUrl = String(qrAction?.url || "").trim();
    const qrString = String(payload.qr_string || "").trim();
    if (!qrImageUrl && !qrString)
      throw new ServiceUnavailableException(
        "Midtrans tidak mengembalikan data QRIS.",
      );
    const qrImageBase64 = qrImageUrl
      ? await this.qrImageDataUrl(qrImageUrl)
      : await QRCode.toDataURL(qrString, {
          errorCorrectionLevel: "M",
          margin: 2,
          width: 320,
        });
    return {
      provider: this.code,
      externalId: input.invoiceNumber,
      status: "pending",
      qrString,
      qrImageBase64,
      qrImageUrl: qrImageUrl || undefined,
      safeMetadata: {
        mode: "midtrans",
        checkout: "core-api",
        orderId: input.invoiceNumber,
        transactionId: String(payload.transaction_id || ""),
        paymentType: "qris",
      },
    };
  }

  verifyWebhook(
    rawBody: Buffer,
    _headers: Record<string, string | string[] | undefined>,
  ): VerifiedPaymentWebhook {
    const payloadHash = paymentPayloadHash(rawBody);
    try {
      const payload = JSON.parse(rawBody.toString("utf8")) as Record<
        string,
        unknown
      >;
      const orderId = String(payload.order_id || "").trim();
      const statusCode = String(payload.status_code || "").trim();
      const grossAmount = String(payload.gross_amount || "").trim();
      const signature = String(payload.signature_key || "")
        .trim()
        .toLowerCase();
      const expected = createHash("sha512")
        .update(`${orderId}${statusCode}${grossAmount}${this.serverKey}`)
        .digest("hex");
      if (
        !orderId ||
        !statusCode ||
        !grossAmount ||
        !signature ||
        !secureEqual(signature, expected)
      ) {
        return {
          verified: false,
          reason: "Signature Midtrans tidak valid.",
          payloadHash,
          signature,
        };
      }
      const amountIdr = midtransAmount(grossAmount);
      const status = midtransStatus(
        payload.transaction_status,
        payload.fraud_status,
      );
      const transactionId = String(payload.transaction_id || "").trim();
      const event: PaymentWebhookEvent = {
        eventId: `midtrans:${orderId}:${String(payload.transaction_status || "pending")}:${transactionId || signature.slice(0, 16)}`,
        externalId: orderId,
        invoiceNumber: orderId,
        amountIdr,
        status,
        occurredAt: String(
          payload.settlement_time ||
            payload.transaction_time ||
            new Date().toISOString(),
        ),
      };
      if (
        !Number.isSafeInteger(amountIdr) ||
        amountIdr <= 0 ||
        !validEvent(event)
      ) {
        return {
          verified: false,
          reason: "Payload notification Midtrans tidak valid.",
          payloadHash,
          signature,
        };
      }
      return { verified: true, event, payloadHash, signature };
    } catch {
      return {
        verified: false,
        reason: "Payload notification Midtrans bukan JSON valid.",
        payloadHash,
      };
    }
  }

  async getTransactionStatus(
    externalId: string,
    expectedAmountIdr?: number,
  ): Promise<PaymentWebhookEvent> {
    const requestedOrderId = String(externalId || "").trim();
    if (!requestedOrderId)
      throw new BadRequestException("Midtrans order ID kosong.");
    const payload = await this.request(
      `${this.apiOrigin}/v2/${encodeURIComponent(requestedOrderId)}/status`,
      {
        method: "GET",
        headers: this.headers(),
      },
    );
    if (String(payload.status_code || "") === "404") {
      if (
        !Number.isSafeInteger(expectedAmountIdr) ||
        Number(expectedAmountIdr) <= 0
      ) {
        throw new BadRequestException(
          "Transaksi Midtrans belum dibuka oleh pengguna.",
        );
      }
      return {
        eventId: `midtrans:status:${requestedOrderId}:checkout-not-opened`,
        externalId: requestedOrderId,
        invoiceNumber: requestedOrderId,
        amountIdr: Number(expectedAmountIdr),
        status: "pending",
        occurredAt: new Date().toISOString(),
      };
    }
    const orderId = String(payload.order_id || "").trim();
    const amountIdr = midtransAmount(payload.gross_amount);
    if (
      !orderId ||
      orderId !== requestedOrderId ||
      !Number.isSafeInteger(amountIdr) ||
      amountIdr <= 0
    ) {
      throw new BadRequestException(
        "Respons status Midtrans tidak cocok dengan invoice.",
      );
    }
    const transactionStatus = String(
      payload.transaction_status || "pending",
    ).toLowerCase();
    const transactionId = String(payload.transaction_id || "").trim();
    const signaturePart = createHash("sha256")
      .update(`${orderId}:${transactionStatus}:${transactionId}:${amountIdr}`)
      .digest("hex")
      .slice(0, 16);
    const event: PaymentWebhookEvent = {
      eventId: `midtrans:status:${orderId}:${transactionStatus}:${transactionId || signaturePart}`,
      externalId: orderId,
      invoiceNumber: orderId,
      amountIdr,
      status: midtransStatus(transactionStatus, payload.fraud_status),
      occurredAt: String(
        payload.settlement_time ||
          payload.transaction_time ||
          new Date().toISOString(),
      ),
    };
    if (!validEvent(event))
      throw new BadRequestException("Status transaksi Midtrans tidak valid.");
    return event;
  }

  async refund(
    externalId: string,
    amountIdr: number,
  ): Promise<{ ok: true; reference: string }> {
    const refundKey = `cliper-refund-${externalId}`.slice(0, 50);
    const payload = await this.request(
      `${this.apiOrigin}/v2/${encodeURIComponent(externalId)}/refund`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          refund_key: refundKey,
          gross_amount: amountIdr,
          reason: "Cliper Cloud admin refund",
        }),
      },
    );
    return {
      ok: true,
      reference: String(
        payload.refund_chargeback_id || payload.transaction_id || refundKey,
      ),
    };
  }
}

@Injectable()
export class PaymentProviderService {
  private readonly sandbox: SandboxPaymentProvider;
  private readonly midtrans?: MidtransPaymentProvider;

  constructor() {
    const secret = String(
      process.env.PAYMENT_SANDBOX_WEBHOOK_SECRET || LOCAL_SANDBOX_SECRET,
    );
    this.sandbox = new SandboxPaymentProvider(
      secret,
      process.env.WEB_ORIGIN || "http://localhost:3000",
    );
    const configuredProvider = String(
      process.env.PAYMENT_PROVIDER || SANDBOX_CODE,
    )
      .trim()
      .toLowerCase();
    // Keep an inactive Midtrans credential out of the local runtime entirely.
    // This makes the internal sandbox test safe even when an operator still has
    // an old production credential in a private .env pending rotation.
    if (
      configuredProvider === MIDTRANS_CODE &&
      process.env.MIDTRANS_SERVER_KEY
    ) {
      this.midtrans = new MidtransPaymentProvider(
        process.env.MIDTRANS_SERVER_KEY,
        process.env.WEB_ORIGIN || "http://localhost:3000",
        String(process.env.MIDTRANS_IS_PRODUCTION || "false").toLowerCase() ===
          "true",
      );
    }
  }

  active(): PaymentProvider {
    const code = String(process.env.PAYMENT_PROVIDER || SANDBOX_CODE)
      .trim()
      .toLowerCase();
    if (code === MIDTRANS_CODE) {
      if (!this.midtrans)
        throw new ServiceUnavailableException(
          "Midtrans belum dikonfigurasi. Isi MIDTRANS_SERVER_KEY di environment API.",
        );
      return this.midtrans;
    }
    if (code !== SANDBOX_CODE)
      throw new ServiceUnavailableException(
        `Payment provider '${code}' belum memiliki adapter aktif.`,
      );
    const production = process.env.NODE_ENV === "production";
    const sandboxAllowed =
      String(process.env.ALLOW_SANDBOX_PAYMENTS || "false").toLowerCase() ===
      "true";
    if (production && !sandboxAllowed) {
      throw new ServiceUnavailableException(
        "Sandbox payment dinonaktifkan di production. Konfigurasikan adapter QRIS resmi.",
      );
    }
    return this.sandbox;
  }

  byCode(code: string): PaymentProvider {
    const normalized = String(code || "")
      .trim()
      .toLowerCase();
    if (normalized === MIDTRANS_CODE) {
      if (!this.midtrans)
        throw new ServiceUnavailableException(
          "Midtrans belum dikonfigurasi. Isi MIDTRANS_SERVER_KEY di environment API.",
        );
      return this.midtrans;
    }
    if (normalized === SANDBOX_CODE) {
      const production = process.env.NODE_ENV === "production";
      const sandboxAllowed =
        String(process.env.ALLOW_SANDBOX_PAYMENTS || "false").toLowerCase() ===
        "true";
      if (production && !sandboxAllowed)
        throw new ServiceUnavailableException(
          "Sandbox payment dinonaktifkan di production.",
        );
      return this.sandbox;
    }
    throw new BadRequestException("Payment provider tidak didukung.");
  }

  sandboxEvent(event: PaymentWebhookEvent): {
    rawBody: Buffer;
    signature: string;
  } {
    return this.sandbox.signedEvent(event);
  }
}

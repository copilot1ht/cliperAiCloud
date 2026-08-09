import {
  BadRequestException,
  Injectable,
  Logger,
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
import {
  PaymentConfigurationService,
  type MidtransCredentials,
} from "./payment-configuration.service.js";

const SANDBOX_CODE = "sandbox";
const MIDTRANS_CODE = "midtrans";
const LOCAL_SANDBOX_SECRET = "cliper-local-sandbox-secret-change-me";

function midtransAmount(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function midtransResponseValue(
  payload: Record<string, unknown>,
  key: string,
): unknown {
  const direct = payload[key];
  if (direct !== undefined && direct !== null && String(direct).trim()) {
    return direct;
  }
  const transactionDetails = payload.transaction_details;
  if (
    !transactionDetails ||
    typeof transactionDetails !== "object" ||
    Array.isArray(transactionDetails)
  )
    return undefined;
  return (transactionDetails as Record<string, unknown>)[key];
}

const MIDTRANS_RESPONSE_WRAPPER_KEYS = [
  "data",
  "body",
  "transaction",
  "result",
  "response",
] as const;

interface MidtransResponseSelection {
  payload: Record<string, unknown>;
  shape: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasMidtransTransactionEvidence(payload: Record<string, unknown>): boolean {
  const directFields = ["order_id", "gross_amount", "payment_type"];
  if (
    directFields.some((key) => {
      const value = payload[key];
      return (
        value !== undefined &&
        value !== null &&
        (typeof value !== "string" || value.trim().length > 0)
      );
    })
  ) {
    return true;
  }
  const details = asRecord(payload.transaction_details);
  return Boolean(
    details &&
      ["order_id", "gross_amount"].some((key) => {
        const value = details[key];
        return (
          value !== undefined &&
          value !== null &&
          (typeof value !== "string" || value.trim().length > 0)
        );
      }),
  );
}

function selectMidtransTransactionPayload(
  payload: Record<string, unknown>,
): MidtransResponseSelection | null {
  const queue: Array<MidtransResponseSelection> = [
    { payload, shape: "root" },
  ];
  const visited = new Set<Record<string, unknown>>();

  while (queue.length > 0 && visited.size < 16) {
    const current = queue.shift();
    if (!current || visited.has(current.payload)) continue;
    visited.add(current.payload);
    if (hasMidtransTransactionEvidence(current.payload)) return current;

    for (const key of MIDTRANS_RESPONSE_WRAPPER_KEYS) {
      const nested = asRecord(current.payload[key]);
      if (nested && !visited.has(nested)) {
        queue.push({ payload: nested, shape: current.shape + "." + key });
      }
    }
  }

  return null;
}

function safeResponseKeys(payload: Record<string, unknown>): string[] {
  return Object.keys(payload)
    .filter(
      (key) =>
        !/(authorization|key|token|secret|signature|qr[_-]?(string|content|image))/i.test(
          key,
        ),
    )
    .sort()
    .slice(0, 16);
}

function maskedOrderId(value: unknown): string | null {
  const normalized = String(value || "").trim();
  return normalized ? "***" + normalized.slice(-8) : null;
}
function midtransText(
  payload: Record<string, unknown>,
  keys: string[],
): string {
  for (const key of keys) {
    const value = String(payload[key] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function midtransMessage(payload: Record<string, unknown>): string {
  return midtransText(payload, ["status_message", "response_message"])
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .slice(0, 180);
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
  private readonly logger = new Logger(MidtransPaymentProvider.name);
  private readonly serverKey: string;
  private readonly apiOrigin: string;
  private readonly qrisAcquirer: "gopay" | "airpay_shopee";

  constructor(
    serverKey: string,
    _webOrigin: string,
    production = false,
    qrisAcquirer = "gopay",
  ) {
    this.serverKey = String(serverKey || "").trim();
    this.apiOrigin = production
      ? "https://api.midtrans.com"
      : "https://api.sandbox.midtrans.com";
    const normalizedAcquirer = String(qrisAcquirer || "gopay")
      .trim()
      .toLowerCase();
    if (
      normalizedAcquirer !== "gopay" &&
      normalizedAcquirer !== "airpay_shopee"
    ) {
      throw new ServiceUnavailableException(
        "MIDTRANS_QRIS_ACQUIRER harus bernilai gopay atau airpay_shopee.",
      );
    }
    this.qrisAcquirer = normalizedAcquirer;
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

  private logQrisResponseRejected(
    reason: string,
    input: CreateProviderPaymentInput,
    rawPayload: Record<string, unknown>,
    responsePayload?: Record<string, unknown>,
    responseShape?: string,
  ): void {
    const payload = responsePayload || {};
    const responseOrderId = String(
      midtransResponseValue(payload, "order_id") || "",
    ).trim();
    const responseAmountIdr = midtransAmount(
      midtransResponseValue(payload, "gross_amount"),
    );
    const responsePaymentType = String(
      midtransResponseValue(payload, "payment_type") || "",
    )
      .trim()
      .toLowerCase();
    const actionNames = Array.isArray(payload.actions)
      ? (payload.actions as Array<Record<string, unknown>>)
          .map((item) =>
            String(item.name || "")
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean)
      : [];

    this.logger.warn(
      JSON.stringify({
        event: "midtrans_qris_response_rejected",
        reason,
        httpStatus: String(rawPayload.__httpStatus || ""),
        providerStatusCode: String(
          rawPayload.status_code || rawPayload.responseCode || "",
        ),
        responseShape: responseShape || "none",
        localOrderId: maskedOrderId(input.invoiceNumber),
        responseOrderId: maskedOrderId(responseOrderId),
        orderIdMatch: responseOrderId === input.invoiceNumber,
        localAmountIdr: input.amountIdr,
        responseAmountIdr,
        amountMatch: responseAmountIdr === input.amountIdr,
        expectedPaymentType: "qris",
        responsePaymentType: responsePaymentType || null,
        paymentTypeMatch: responsePaymentType === "qris",
        transactionStatus: String(
          midtransResponseValue(payload, "transaction_status") || "",
        ).toLowerCase() || null,
        actionNames,
        rootKeys: safeResponseKeys(rawPayload),
        responseKeys: safeResponseKeys(payload),
      }),
    );
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
    acceptedErrorStatuses: number[] = [],
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const payload = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!response.ok && !acceptedErrorStatuses.includes(response.status)) {
        const message = String(
          payload.status_message ||
            payload.error_messages ||
            `Midtrans HTTP ${response.status}`,
        );
        throw new ServiceUnavailableException(
          `Midtrans request gagal: ${message.slice(0, 240)}`,
        );
      }
      return { ...payload, __httpStatus: response.status };
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
        // The QR URL comes from Midtrans, but redirects can otherwise turn this
        // into an outbound fetch to an unrelated host. Reject them instead of
        // following them with the API credential attached.
        redirect: "error",
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
      const contentType = (
        String(response.headers.get("content-type") || "").split(";")[0] || ""
      )
        .trim()
        .toLowerCase();
      if (contentType !== "image/png") {
        throw new ServiceUnavailableException(
          "Midtrans mengembalikan gambar QRIS dengan tipe file yang tidak valid.",
        );
      }
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (Number.isFinite(contentLength) && contentLength > 2_000_000) {
        throw new ServiceUnavailableException(
          "Ukuran gambar QRIS Midtrans melebihi batas aman.",
        );
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 64 || bytes.length > 2_000_000) {
        throw new ServiceUnavailableException(
          "Ukuran gambar QRIS Midtrans tidak valid.",
        );
      }
      return `data:image/png;base64,${bytes.toString("base64")}`;
    } finally {
      clearTimeout(timer);
    }
  }

  async createPayment(
    input: CreateProviderPaymentInput,
  ): Promise<CreateProviderPaymentResult> {
    const rawPayload = await this.request(`${this.apiOrigin}/v2/charge`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        payment_type: "qris",
        qris: {
          // Core API requires the QRIS acquirer to be selected. The default
          // is GoPay, which is also the documented QRIS Core API example.
          acquirer: this.qrisAcquirer,
        },
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
    });
    const responseSelection = selectMidtransTransactionPayload(rawPayload);
    if (!responseSelection) {
      this.logQrisResponseRejected(
        "MIDTRANS_RESPONSE_SCHEMA_INVALID",
        input,
        rawPayload,
      );
      throw new ServiceUnavailableException(
        "Midtrans mengembalikan respons QRIS tanpa payload transaksi [MIDTRANS_RESPONSE_SCHEMA_INVALID]. Pastikan GoPay Dynamic QRIS sudah aktif di Midtrans.",
      );
    }
    const payload = responseSelection.payload;
    const responseOrderId = String(
      midtransResponseValue(payload, "order_id") || "",
    ).trim();
    const responseAmountIdr = midtransAmount(
      midtransResponseValue(payload, "gross_amount"),
    );
    const responsePaymentType = String(
      midtransResponseValue(payload, "payment_type") || "",
    )
      .trim()
      .toLowerCase();
    const transactionStatus = String(
      midtransResponseValue(payload, "transaction_status") || "pending",
    )
      .trim()
      .toLowerCase();
    const validationErrors: string[] = [];
    if (responseOrderId !== input.invoiceNumber) {
      validationErrors.push("MIDTRANS_ORDER_ID_MISMATCH");
    }
    if (responseAmountIdr !== input.amountIdr) {
      validationErrors.push("MIDTRANS_AMOUNT_MISMATCH");
    }
    if (responsePaymentType !== "qris") {
      validationErrors.push("MIDTRANS_PAYMENT_TYPE_MISMATCH");
    }
    if (!["pending", "capture", "settlement"].includes(transactionStatus)) {
      validationErrors.push("MIDTRANS_TRANSACTION_STATUS_INVALID");
    }
    if (validationErrors.length > 0) {
      this.logQrisResponseRejected(
        validationErrors.join(","),
        input,
        rawPayload,
        payload,
        responseSelection.shape,
      );
      throw new ServiceUnavailableException(
        `Validasi respons QRIS Midtrans gagal: ${validationErrors.join(", ")}.`,
      );
    }
    const actions = Array.isArray(payload.actions)
      ? (payload.actions as Array<Record<string, unknown>>)
      : [];
    const actionNames = actions
      .map((item) =>
        String(item.name || "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean);
    const qrAction =
      actions.find(
        (item) =>
          String(item.name || "")
            .trim()
            .toLowerCase() === "generate-qr-code-v2",
      ) ||
      actions.find(
        (item) =>
          String(item.name || "")
            .trim()
            .toLowerCase() === "generate-qr-code",
      );
    const qrImageUrl = String(qrAction?.url || "").trim();
    const qrString = midtransText(payload, [
      "qr_string",
      "qrString",
      "qr_content",
      "qrContent",
    ]);
    if (!qrImageUrl && !qrString) {
      const statusCode = String(
        payload.status_code || payload.__httpStatus || "",
      );
      const message = midtransMessage(payload);
      const actionSummary =
        actionNames.length > 0 ? actionNames.join(", ") : "none";
      this.logQrisResponseRejected(
        "MIDTRANS_QR_ACTION_MISSING",
        input,
        rawPayload,
        payload,
        responseSelection.shape,
      );
      throw new ServiceUnavailableException(
        `Midtrans belum membuat QRIS [MIDTRANS_QR_ACTION_MISSING]${statusCode ? ` (status ${statusCode})` : ""}; actions=${actionSummary}${message ? `: ${message}` : ". Pastikan channel QRIS Production aktif dan credential sudah benar."}`,
      );
    }
    let qrImageBase64: string;
    if (qrImageUrl) {
      try {
        qrImageBase64 = await this.qrImageDataUrl(qrImageUrl);
      } catch (error) {
        // The signed charge response can include a usable QR payload even when
        // Midtrans's separate image endpoint is briefly unavailable.
        if (!qrString) throw error;
        qrImageBase64 = await QRCode.toDataURL(qrString, {
          errorCorrectionLevel: "M",
          margin: 2,
          width: 320,
        });
      }
    } else {
      qrImageBase64 = await QRCode.toDataURL(qrString, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 320,
      });
    }
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
      [404],
    );
    if (
      Number(payload.__httpStatus || 0) === 404 ||
      String(payload.status_code || "") === "404"
    ) {
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

  async testConnection(): Promise<{
    ok: true;
    latencyMs: number;
    verification: "credentials-accepted";
  }> {
    const startedAt = Date.now();
    await this.request(
      `${this.apiOrigin}/v2/cliper-connection-check-${randomUUID()}/status`,
      { method: "GET", headers: this.headers() },
      [404],
    );
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      verification: "credentials-accepted",
    };
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

  constructor(private readonly configuration: PaymentConfigurationService) {
    const secret = String(
      process.env.PAYMENT_SANDBOX_WEBHOOK_SECRET || LOCAL_SANDBOX_SECRET,
    );
    this.sandbox = new SandboxPaymentProvider(
      secret,
      process.env.WEB_ORIGIN || "http://localhost:3000",
    );
  }

  private midtrans(credentials: MidtransCredentials): MidtransPaymentProvider {
    return new MidtransPaymentProvider(
      credentials.serverKey,
      process.env.WEB_ORIGIN || "http://localhost:3000",
      credentials.isProduction,
      process.env.MIDTRANS_QRIS_ACQUIRER || "gopay",
    );
  }

  async active(): Promise<PaymentProvider> {
    const active = await this.configuration.resolveActive();
    if (active.provider === MIDTRANS_CODE) {
      if (!active.enabled || !active.midtrans) {
        throw new ServiceUnavailableException(
          "Midtrans belum dikonfigurasi. Gunakan Railway Variables atau Admin Payment Settings pada API.",
        );
      }
      return this.midtrans(active.midtrans);
    }
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

  async byCode(code: string): Promise<PaymentProvider> {
    const normalized = String(code || "")
      .trim()
      .toLowerCase();
    if (normalized === MIDTRANS_CODE) {
      const saved = await this.configuration.resolveMidtransForOperations();
      if (!saved)
        throw new ServiceUnavailableException(
          "Konfigurasi Midtrans untuk invoice ini tidak tersedia. Periksa Railway Variables atau Admin Payment Settings.",
        );
      return this.midtrans(saved.credentials);
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

  async testMidtransConnection() {
    const saved = await this.configuration.resolveMidtransForOperations();
    if (!saved) {
      throw new ServiceUnavailableException(
        "Midtrans belum memiliki Merchant ID, Client Key, dan Server Key lengkap.",
      );
    }
    const result = await this.midtrans(saved.credentials).testConnection();
    return {
      ...result,
      environment: saved.credentials.isProduction ? "production" : "sandbox",
      source:
        saved.source === "admin-settings"
          ? "Encrypted Admin Settings"
          : "Railway ENV",
    };
  }

  sandboxEvent(event: PaymentWebhookEvent): {
    rawBody: Buffer;
    signature: string;
  } {
    return this.sandbox.signedEvent(event);
  }
}

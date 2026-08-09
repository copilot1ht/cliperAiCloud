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
  type XenditCredentials,
} from "./payment-configuration.service.js";

const SANDBOX_CODE = "sandbox";
const MIDTRANS_CODE = "midtrans";
const XENDIT_CODE = "xendit";
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

function hasMidtransTransactionEvidence(
  payload: Record<string, unknown>,
): boolean {
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
  const queue: Array<MidtransResponseSelection> = [{ payload, shape: "root" }];
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
function normalizedMidtransNotificationUrl(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || !parsed.hostname) {
      throw new Error("notification URL must be HTTPS");
    }
    return parsed.toString();
  } catch {
    throw new ServiceUnavailableException(
      "MIDTRANS_NOTIFICATION_URL harus berupa URL HTTPS publik.",
    );
  }
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

function safeMidtransStatusMessage(payload: Record<string, unknown>): string {
  return midtransMessage(payload)
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b(basic|bearer)\s+\S+/gi, "$1 [redacted]");
}

function midtransProviderStatusCode(payload: Record<string, unknown>): string {
  return String(payload.status_code || payload.responseCode || "").trim();
}

function isMidtransProviderRejection(
  payload: Record<string, unknown>,
): boolean {
  const httpStatus = Number(payload.__httpStatus || 0);
  const providerStatus = Number(midtransProviderStatusCode(payload));
  return (
    (Number.isInteger(httpStatus) && (httpStatus < 200 || httpStatus >= 300)) ||
    (Number.isInteger(providerStatus) && providerStatus >= 400)
  );
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
  private readonly notificationUrl: string;

  constructor(
    serverKey: string,
    _webOrigin: string,
    production = false,
    qrisAcquirer = "gopay",
    notificationUrl = "",
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
    this.notificationUrl = normalizedMidtransNotificationUrl(notificationUrl);
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
    const transactionStatus =
      String(
        midtransResponseValue(payload, "transaction_status") || "",
      ).toLowerCase() || null;

    this.logger.warn(
      JSON.stringify({
        event: "midtrans_qris_response_rejected",
        reason,
        httpStatus: String(rawPayload.__httpStatus || ""),
        providerStatusCode: midtransProviderStatusCode(rawPayload),
        providerStatusMessage: safeMidtransStatusMessage(rawPayload) || null,
        responseShape: responseShape || "none",
        wrapperType: responseShape || "none",
        localOrderId: maskedOrderId(input.invoiceNumber),
        responseOrderId: maskedOrderId(responseOrderId),
        orderIdPresent: Boolean(responseOrderId),
        orderIdMatch: responseOrderId === input.invoiceNumber,
        localAmountIdr: input.amountIdr,
        responseAmountIdr,
        amountPresent: responseAmountIdr > 0,
        amountMatch: responseAmountIdr === input.amountIdr,
        expectedPaymentType: "qris",
        responsePaymentType: responsePaymentType || null,
        paymentTypePresent: Boolean(responsePaymentType),
        paymentTypeMatch: responsePaymentType === "qris",
        transactionStatus,
        acquirer: this.qrisAcquirer,
        actionNames,
        rootKeys: safeResponseKeys(rawPayload),
        topLevelKeys: safeResponseKeys(rawPayload),
        responseKeys: safeResponseKeys(payload),
        payloadKeys: safeResponseKeys(payload),
      }),
    );
  }

  private logQrisChargeResponse(rawPayload: Record<string, unknown>): void {
    const selection = selectMidtransTransactionPayload(rawPayload);
    const payload = selection?.payload || {};
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

    this.logger.log(
      JSON.stringify({
        event: "midtrans_qris_charge_response",
        httpStatus: String(rawPayload.__httpStatus || ""),
        providerStatusCode: midtransProviderStatusCode(rawPayload),
        providerStatusMessage: safeMidtransStatusMessage(rawPayload) || null,
        wrapperType: selection?.shape || "none",
        topLevelKeys: safeResponseKeys(rawPayload),
        payloadKeys: safeResponseKeys(payload),
        orderIdPresent: Boolean(responseOrderId),
        amountPresent: responseAmountIdr > 0,
        paymentTypePresent: Boolean(responsePaymentType),
        transactionStatus:
          String(
            midtransResponseValue(payload, "transaction_status") || "",
          ).toLowerCase() || null,
        acquirer: this.qrisAcquirer,
        actionNames,
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
    returnErrorPayload = false,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const payload = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (
        !response.ok &&
        !acceptedErrorStatuses.includes(response.status) &&
        !returnErrorPayload
      ) {
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
    const headers = this.headers();
    if (this.notificationUrl) {
      headers["X-Override-Notification"] = this.notificationUrl;
    }
    const rawPayload = await this.request(
      `${this.apiOrigin}/v2/charge`,
      {
        method: "POST",
        headers,
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
      },
      [],
      true,
    );
    this.logQrisChargeResponse(rawPayload);
    if (isMidtransProviderRejection(rawPayload)) {
      this.logQrisResponseRejected(
        "MIDTRANS_PROVIDER_REJECTED",
        input,
        rawPayload,
        rawPayload,
        "root",
      );
      const statusCode = midtransProviderStatusCode(rawPayload);
      const message = safeMidtransStatusMessage(rawPayload);
      throw new ServiceUnavailableException(
        `Midtrans menolak pembuatan QRIS [MIDTRANS_PROVIDER_REJECTED]${statusCode ? ` (status ${statusCode})` : ""}${message ? `: ${message}` : "."}`,
      );
    }
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

function xenditAmount(value: unknown): number {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : 0;
}

function xenditStatus(
  eventName: unknown,
  providerStatus: unknown,
): PaymentWebhookEvent["status"] {
  const event = String(eventName || "").trim().toLowerCase();
  const status = String(providerStatus || "").trim().toUpperCase();
  if (event === "payment.capture" || status === "SUCCEEDED") return "paid";
  if (event === "payment_request.expiry" || status === "EXPIRED")
    return "expired";
  if (event === "payment.failure" || ["FAILED", "CANCELED"].includes(status))
    return "failed";
  if (event === "refund.succeeded" || status === "REFUNDED") return "refunded";
  return "pending";
}

function xenditAction(
  actions: unknown,
  descriptor: string,
): Record<string, unknown> | undefined {
  if (!Array.isArray(actions)) return undefined;
  return actions
    .map((action) => asRecord(action))
    .find(
      (action) =>
        action &&
        String(action.type || "").trim().toUpperCase() ===
          "PRESENT_TO_CUSTOMER" &&
        String(action.descriptor || "").trim().toUpperCase() === descriptor,
    ) || undefined;
}

function xenditPayload(
  rawBody: Buffer,
): { payload: Record<string, unknown>; data: Record<string, unknown> } | null {
  try {
    const payload = asRecord(JSON.parse(rawBody.toString("utf8")));
    if (!payload) return null;
    return { payload, data: asRecord(payload.data) || {} };
  } catch {
    return null;
  }
}

export class XenditPaymentProvider implements PaymentProvider {
  readonly code = XENDIT_CODE;
  private readonly secretKey: string;
  private readonly webhookToken: string;
  private readonly mode: "test" | "live";
  private readonly apiVersion: string;
  private readonly apiOrigin = "https://api.xendit.co";

  constructor(credentials: XenditCredentials) {
    this.secretKey = String(credentials.secretKey || "").trim();
    this.webhookToken = String(credentials.webhookToken || "").trim();
    this.mode = credentials.mode;
    this.apiVersion = String(credentials.apiVersion || "2024-11-11").trim();
    if (this.secretKey.length < 20) {
      throw new ServiceUnavailableException(
        "XENDIT_SECRET_KEY belum dikonfigurasi.",
      );
    }
    if (/^xnd_public_/i.test(this.secretKey)) {
      throw new ServiceUnavailableException(
        "XENDIT_SECRET_KEY harus memakai Secret API Key, bukan Public API Key.",
      );
    }
    if (this.webhookToken.length < 16) {
      throw new ServiceUnavailableException(
        "XENDIT_WEBHOOK_TOKEN belum dikonfigurasi.",
      );
    }
    if (!/^20\d{2}-\d{2}-\d{2}$/.test(this.apiVersion)) {
      throw new ServiceUnavailableException(
        "XENDIT_API_VERSION tidak valid.",
      );
    }
  }

  private headers(): Record<string, string> {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      "api-version": this.apiVersion,
      Authorization: `Basic ${Buffer.from(`${this.secretKey}:`).toString("base64")}`,
    };
  }

  private async request(
    url: string,
    init: RequestInit,
    acceptedErrorStatuses: number[] = [],
  ): Promise<{ payload: Record<string, unknown>; status: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const payload = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!response.ok && !acceptedErrorStatuses.includes(response.status)) {
        const errorCode = String(payload.error_code || "").trim();
        const category =
          response.status === 401 || response.status === 403
            ? "XENDIT_CREDENTIALS_INVALID"
            : response.status === 408 || response.status === 504
              ? "XENDIT_TIMEOUT"
              : response.status >= 500
                ? "XENDIT_PROVIDER_UNAVAILABLE"
                : errorCode === "CHANNEL_UNAVAILABLE"
                  ? "XENDIT_CHANNEL_UNAVAILABLE"
                  : "XENDIT_REQUEST_INVALID";
        throw new ServiceUnavailableException(
          `Xendit tidak dapat membuat pembayaran [${category}].`,
        );
      }
      return { payload, status: response.status };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException(
        "Xendit tidak dapat dihubungi. Coba lagi beberapa saat.",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async createPayment(
    input: CreateProviderPaymentInput,
  ): Promise<CreateProviderPaymentResult> {
    const { payload } = await this.request(
      `${this.apiOrigin}/v3/payment_requests`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          reference_id: input.invoiceNumber,
          type: "PAY",
          country: "ID",
          currency: "IDR",
          request_amount: input.amountIdr,
          capture_method: "AUTOMATIC",
          channel_code: "QRIS",
          channel_properties: {},
          description: input.description.slice(0, 1_000),
          metadata: {
            cliper_invoice_number: input.invoiceNumber,
            payment_kind: "cliper_wallet",
          },
        }),
      },
    );
    const paymentRequestId = String(payload.payment_request_id || "").trim();
    const referenceId = String(payload.reference_id || "").trim();
    const amountIdr = xenditAmount(payload.request_amount);
    const channelCode = String(payload.channel_code || "").trim().toUpperCase();
    if (
      !paymentRequestId ||
      referenceId !== input.invoiceNumber ||
      amountIdr !== input.amountIdr ||
      channelCode !== "QRIS"
    ) {
      throw new ServiceUnavailableException(
        "Xendit mengembalikan respons pembayaran yang tidak cocok dengan invoice [XENDIT_RESPONSE_INVALID].",
      );
    }
    const qrAction = xenditAction(payload.actions, "QR_STRING");
    const qrString = String(qrAction?.value || "").trim();
    if (!qrString) {
      throw new ServiceUnavailableException(
        "Xendit belum mengembalikan QRIS yang dapat ditampilkan [XENDIT_QR_ACTION_MISSING].",
      );
    }
    const paymentUrl = String(xenditAction(payload.actions, "WEB_URL")?.value || "").trim();
    return {
      provider: this.code,
      externalId: paymentRequestId,
      status: "pending",
      paymentUrl: paymentUrl || undefined,
      qrString,
      qrImageBase64: await QRCode.toDataURL(qrString, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 320,
      }),
      safeMetadata: {
        environment: this.mode,
        paymentRequestId,
        channel: channelCode,
        status: String(payload.status || "").trim().toUpperCase() || null,
      },
    };
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): VerifiedPaymentWebhook {
    const payloadHash = paymentPayloadHash(rawBody);
    const callbackToken = headerValue(headers, "x-callback-token");
    if (!secureEqual(callbackToken, this.webhookToken)) {
      return {
        verified: false,
        reason: "Xendit callback token tidak valid.",
        payloadHash,
      };
    }
    const normalized = xenditPayload(rawBody);
    if (!normalized) {
      return {
        verified: false,
        reason: "Payload webhook Xendit bukan JSON valid.",
        payloadHash,
      };
    }
    const { payload, data } = normalized;
    const eventName = String(payload.event || "").trim().toLowerCase();
    const paymentRequestId = String(data.payment_request_id || "").trim();
    const referenceId = String(data.reference_id || "").trim();
    const amountIdr = xenditAmount(data.request_amount);
    if (!eventName || !paymentRequestId || !referenceId || !amountIdr) {
      // A verified dashboard probe or informational event is acknowledged by
      // PaymentService without becoming a financial mutation.
      return { verified: true, payloadHash };
    }
    const paymentId = String(
      data.capture_id || data.payment_id || paymentRequestId,
    ).trim();
    const event: PaymentWebhookEvent = {
      eventId: `xendit:${eventName}:${paymentId}:${String(data.status || "pending").toLowerCase()}`,
      externalId: paymentRequestId,
      invoiceNumber: referenceId,
      amountIdr,
      status: xenditStatus(eventName, data.status),
      occurredAt: String(data.updated || payload.created || new Date().toISOString()),
    };
    if (!validEvent(event)) {
      return {
        verified: false,
        reason: "Payload webhook Xendit tidak valid.",
        payloadHash,
      };
    }
    return { verified: true, event, payloadHash };
  }

  async getTransactionStatus(
    externalId: string,
    expectedAmountIdr?: number,
  ): Promise<PaymentWebhookEvent> {
    const paymentRequestId = String(externalId || "").trim();
    if (!paymentRequestId)
      throw new BadRequestException("Xendit payment request ID kosong.");
    const { payload, status } = await this.request(
      `${this.apiOrigin}/v3/payment_requests/${encodeURIComponent(paymentRequestId)}`,
      { method: "GET", headers: this.headers() },
      [404],
    );
    if (status === 404) {
      if (!Number.isSafeInteger(expectedAmountIdr) || Number(expectedAmountIdr) <= 0) {
        throw new BadRequestException("Payment request Xendit tidak ditemukan.");
      }
      return {
        eventId: `xendit:status:${paymentRequestId}:not-found`,
        externalId: paymentRequestId,
        invoiceNumber: paymentRequestId,
        amountIdr: Number(expectedAmountIdr),
        status: "pending",
        occurredAt: new Date().toISOString(),
      };
    }
    const referenceId = String(payload.reference_id || "").trim();
    const amountIdr = xenditAmount(payload.request_amount);
    if (!referenceId || !amountIdr) {
      throw new BadRequestException("Respons status Xendit tidak cocok dengan invoice.");
    }
    return {
      eventId: `xendit:status:${paymentRequestId}:${String(payload.status || "pending").toLowerCase()}`,
      externalId: paymentRequestId,
      invoiceNumber: referenceId,
      amountIdr,
      status: xenditStatus("payment_request.status", payload.status),
      occurredAt: String(payload.updated || payload.created || new Date().toISOString()),
    };
  }

  async simulatePayment(
    externalId: string,
    amountIdr: number,
  ): Promise<{ ok: true; status: string }> {
    if (this.mode !== "test") {
      throw new BadRequestException(
        "Simulate Success hanya tersedia ketika XENDIT_MODE=test.",
      );
    }
    const paymentRequestId = String(externalId || "").trim();
    if (!paymentRequestId || !Number.isSafeInteger(amountIdr) || amountIdr <= 0) {
      throw new BadRequestException("Invoice test Xendit tidak valid.");
    }
    const { payload } = await this.request(
      `${this.apiOrigin}/v3/payment_requests/${encodeURIComponent(paymentRequestId)}/simulate`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ amount: amountIdr }),
      },
    );
    const status = String(payload.status || "").trim().toUpperCase();
    if (status && status !== "PENDING") {
      throw new ServiceUnavailableException(
        "Xendit menolak simulasi pembayaran test.",
      );
    }
    return { ok: true, status: status || "PENDING" };
  }

  async testConnection(): Promise<{
    ok: true;
    latencyMs: number;
    verification: "credentials-accepted";
  }> {
    const startedAt = Date.now();
    await this.request(
      `${this.apiOrigin}/v3/payment_requests/pr-00000000-0000-0000-0000-000000000000`,
      { method: "GET", headers: this.headers() },
      [404],
    );
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      verification: "credentials-accepted",
    };
  }
}

@Injectable()
export class PaymentProviderService {
  private readonly sandbox: SandboxPaymentProvider;
  private lastConnectionCheck:
    | {
        provider: string;
        checkedAt: string;
        ok: boolean;
        latencyMs?: number;
      }
    | undefined;

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
      credentials.notificationUrl,
    );
  }

  private xendit(credentials: XenditCredentials): XenditPaymentProvider {
    return new XenditPaymentProvider(credentials);
  }

  async active(): Promise<PaymentProvider> {
    const active = await this.configuration.resolveActive();
    if (active.provider === XENDIT_CODE) {
      if (!active.enabled || !active.xendit) {
        throw new ServiceUnavailableException(
          "Xendit belum dikonfigurasi. Atur XENDIT_SECRET_KEY dan XENDIT_WEBHOOK_TOKEN pada Railway @cliper/api.",
        );
      }
      return this.xendit(active.xendit);
    }
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
    if (normalized === XENDIT_CODE) {
      const saved = await this.configuration.resolveXenditForOperations();
      if (!saved) {
        throw new ServiceUnavailableException(
          "Konfigurasi Xendit untuk invoice ini tidak tersedia. Periksa Railway Variables @cliper/api.",
        );
      }
      return this.xendit(saved.credentials);
    }
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

  async testActiveConnection() {
    const active = await this.configuration.resolveActive();
    try {
      let result: {
        ok: true;
        latencyMs: number;
        verification: "credentials-accepted";
        provider: string;
        environment: string;
        source: string;
      };
      if (active.provider === XENDIT_CODE) {
        if (!active.enabled || !active.xendit) {
          throw new ServiceUnavailableException("Xendit belum dikonfigurasi.");
        }
        result = {
          ...(await this.xendit(active.xendit).testConnection()),
          provider: XENDIT_CODE,
          environment: active.xendit.mode,
          source: "Railway ENV",
        };
      } else {
        result = {
          ...(await this.testMidtransConnection()),
          provider: MIDTRANS_CODE,
        };
      }
      this.lastConnectionCheck = {
        provider: result.provider,
        checkedAt: new Date().toISOString(),
        ok: true,
        latencyMs: result.latencyMs,
      };
      return result;
    } catch (error) {
      this.lastConnectionCheck = {
        provider: active.provider,
        checkedAt: new Date().toISOString(),
        ok: false,
      };
      throw error;
    }
  }

  async activeConnectionStatus() {
    const active = await this.configuration.resolveActive();
    const current =
      this.lastConnectionCheck?.provider === active.provider
        ? this.lastConnectionCheck
        : undefined;
    return {
      provider: active.provider,
      state: current ? (current.ok ? "healthy" : "failed") : "not-tested",
      checkedAt: current?.checkedAt || null,
      latencyMs: current?.latencyMs || null,
    };
  }

  async createXenditTestProvider(): Promise<XenditPaymentProvider> {
    const active = await this.configuration.resolveActive();
    if (
      active.provider !== XENDIT_CODE ||
      !active.enabled ||
      !active.xendit
    ) {
      throw new BadRequestException(
        "Create Test QRIS memerlukan Xendit sebagai provider aktif.",
      );
    }
    if (active.xendit.mode !== "test") {
      throw new BadRequestException(
        "Create Test QRIS hanya tersedia ketika XENDIT_MODE=test.",
      );
    }
    return this.xendit(active.xendit);
  }

  async simulateXenditTestPayment(
    externalId: string,
    amountIdr: number,
  ) {
    const provider = await this.createXenditTestProvider();
    return provider.simulatePayment(externalId, amountIdr);
  }

  sandboxEvent(event: PaymentWebhookEvent): {
    rawBody: Buffer;
    signature: string;
  } {
    return this.sandbox.signedEvent(event);
  }
}

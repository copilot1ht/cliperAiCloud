import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { paymentPayloadHash, type PaymentWebhookEvent } from "@cliper/billing";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { DatabaseService } from "../database/database.service.js";
import {
  InvoiceStatus,
  LedgerType,
  PaymentStatus,
  PlanCode,
  Prisma,
  SubscriptionStatus,
} from "../generated/prisma/client.js";
import { PaymentProviderService } from "./payment-provider.service.js";
import { AuthService, type MemberPlan } from "../auth/auth.service.js";
import {
  microToUsd,
  usdToMicro,
  WalletPaymentSettingsService,
} from "./wallet-payment-settings.service.js";

interface PaymentIdentity {
  id: string;
  email: string;
  displayName: string;
}

interface PlanDefinition {
  code: typeof PlanCode.STARTER | typeof PlanCode.PRO;
  name: string;
  priceIdr: number;
  credits: number;
  creditMicro: bigint;
  deviceLimit: number;
  durationDays: number;
  description: string;
}

const plans: PlanDefinition[] = [
  {
    code: PlanCode.STARTER,
    name: "Starter",
    priceIdr: 99_000,
    credits: 50_000,
    creditMicro: 50_000_000_000n,
    deviceLimit: 1,
    durationDays: 30,
    description: "50.000 Cliper Credits untuk satu desktop.",
  },
  {
    code: PlanCode.PRO,
    name: "Pro",
    priceIdr: 299_000,
    credits: 500_000,
    creditMicro: 500_000_000_000n,
    deviceLimit: 3,
    durationDays: 30,
    description: "500.000 Cliper Credits dan routing AI prioritas.",
  },
];

const DEFAULT_INVOICE_EXPIRY_MS = 15 * 60_000;
// Xendit's one-off QRIS payment requests remain payable for up to 48 hours.
// Keep the local invoice open for that same window so a customer cannot pay a
// still-valid provider QR after Cliper has already rejected the invoice.
const XENDIT_QRIS_INVOICE_EXPIRY_MS = 48 * 60 * 60_000;

export async function transientQrDataUrl(
  qrString: string | null | undefined,
): Promise<string | null> {
  if (!qrString) return null;
  try {
    return await QRCode.toDataURL(qrString, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 320,
    });
  } catch {
    return null;
  }
}

function planByCode(value: unknown): PlanDefinition {
  const code = String(value || "")
    .trim()
    .toUpperCase();
  const found = plans.find((item) => item.code === code);
  if (!found) throw new BadRequestException("Plan pembayaran tidak valid.");
  return found;
}

function invoiceNumber(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  return `CLP-${stamp}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

function paymentStatus(status: string): PaymentStatus {
  if (status === "paid") return PaymentStatus.PAID;
  if (status === "failed") return PaymentStatus.FAILED;
  if (status === "expired") return PaymentStatus.EXPIRED;
  if (status === "refunded") return PaymentStatus.REFUNDED;
  return PaymentStatus.PENDING;
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function safeBigInt(value: unknown): bigint {
  try {
    return BigInt(String(value || "0"));
  } catch {
    throw new ConflictException("Snapshot credit invoice tidak valid.");
  }
}

function asNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new ConflictException("Nilai credit melebihi batas aman JavaScript.");
  return result;
}

interface MidtransDashboardTestNotification {
  eventId: string;
  payloadHash: string;
  statusCode: string | null;
  transactionStatus: string | null;
  signaturePresent: boolean;
}

export function paymentEnvironment(value: unknown): "test" | "production" {
  const metadata = metadataRecord(value);
  const provider = metadataRecord(metadata.provider);
  const configured = String(
    metadata.environment || provider.environment || provider.mode || "",
  )
    .trim()
    .toLowerCase();
  return configured === "test" || configured === "sandbox"
    ? "test"
    : "production";
}

export function providerInvoiceExpiry(
  providerCode: string,
  now = Date.now(),
): Date {
  const duration =
    String(providerCode || "").trim().toLowerCase() === "xendit"
      ? XENDIT_QRIS_INVOICE_EXPIRY_MS
      : DEFAULT_INVOICE_EXPIRY_MS;
  return new Date(now + duration);
}

/**
 * The Midtrans dashboard sends a non-financial probe with this reserved order
 * prefix. It is never a Cliper invoice (our invoices begin with CLP-), so it
 * can be acknowledged without weakening signature checks for real payments.
 */
export function detectMidtransDashboardTestNotification(
  rawBody: Buffer,
): MidtransDashboardTestNotification | null {
  if (rawBody.length > 64 * 1024) return null;
  try {
    const payload = JSON.parse(rawBody.toString("utf8")) as Record<
      string,
      unknown
    >;
    const orderId = String(payload.order_id || "").trim();
    if (!/^payment_notif_test_[A-Za-z0-9._-]{4,}$/i.test(orderId))
      return null;
    const payloadHash = paymentPayloadHash(rawBody);
    const statusCode = String(payload.status_code || "").trim();
    const transactionStatus = String(payload.transaction_status || "")
      .trim()
      .toLowerCase();
    return {
      eventId: `midtrans:dashboard-test:${payloadHash}`,
      payloadHash,
      statusCode: statusCode || null,
      transactionStatus: transactionStatus || null,
      signaturePresent: Boolean(String(payload.signature_key || "").trim()),
    };
  } catch {
    return null;
  }
}

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PaymentProviderService)
    private readonly providers: PaymentProviderService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Optional()
    @Inject(WalletPaymentSettingsService)
    private readonly walletPaymentSettings?: WalletPaymentSettingsService,
  ) {}

  planCatalog() {
    return plans.map(({ creditMicro: _creditMicro, ...plan }) => ({
      ...plan,
      code: plan.code.toLowerCase(),
    }));
  }

  private localReadMode(): boolean {
    return !this.database.configured();
  }

  private async topupConfiguration() {
    if (!this.walletPaymentSettings) {
      throw new ServiceUnavailableException("Konfigurasi wallet USD belum tersedia.");
    }
    const settings = await this.walletPaymentSettings.get();
    return {
      currency: settings.walletCurrency,
      paymentCurrency: settings.paymentCurrency,
      minPurchaseUsd: settings.minPurchaseUsd,
      maxPurchaseUsd: settings.maxPurchaseUsd,
      usdToIdrRate: settings.usdToIdrRate,
      serviceFeeIdr: settings.serviceFeeIdr,
      uniqueCodeEnabled: settings.uniqueCodeEnabled,
      uniqueCodeMin: settings.uniqueCodeMin,
      uniqueCodeMax: settings.uniqueCodeMax,
      maxTotalPaymentIdr: settings.maxTotalPaymentIdr,
    };
  }

  async createInvoice(identity: PaymentIdentity, requestedPlan: unknown) {
    const plan = planByCode(requestedPlan);
    const client = this.database.client();
    await this.expireOpenInvoices(identity.id);
    const number = invoiceNumber();
    const provider = await this.providers.active();
    const expiresAt = providerInvoiceExpiry(provider.code);
    const providerPayment = await provider.createPayment({
      invoiceNumber: number,
      amountIdr: plan.priceIdr,
      expiresAt: expiresAt.toISOString(),
      customer: identity,
      description: `Cliper AI Cloud ${plan.name} - 30 hari`,
    });
    const environment = paymentEnvironment(providerPayment.safeMetadata);

    const invoice = await this.serializable(async (tx) => {
      await tx.user.upsert({
        where: { id: identity.id },
        create: {
          id: identity.id,
          email: identity.email.toLowerCase(),
          displayName: identity.displayName,
          passwordHash: "external-bootstrap-auth",
        },
        update: {
          email: identity.email.toLowerCase(),
          displayName: identity.displayName,
        },
      });
      await tx.plan.upsert({
        where: { code: plan.code },
        create: {
          code: plan.code,
          name: plan.name,
          priceIdr: plan.priceIdr,
          monthlyCreditMicro: plan.creditMicro,
          deviceLimit: plan.deviceLimit,
          durationDays: plan.durationDays,
        },
        update: {
          name: plan.name,
          priceIdr: plan.priceIdr,
          monthlyCreditMicro: plan.creditMicro,
          deviceLimit: plan.deviceLimit,
          durationDays: plan.durationDays,
          isActive: true,
        },
      });
      const payment = await tx.paymentTransaction.create({
        data: {
          userId: identity.id,
          provider: providerPayment.provider,
          externalId: providerPayment.externalId,
          amountIdr: plan.priceIdr,
          status: PaymentStatus.PENDING,
          idempotencyKey: `invoice:${number}`,
          metadata: jsonInput({
            provider: providerPayment.safeMetadata || {},
            invoiceNumber: number,
            environment,
          }),
        },
      });
      return tx.invoice.create({
        data: {
          number,
          userId: identity.id,
          paymentId: payment.id,
          provider: providerPayment.provider,
          providerReference: providerPayment.externalId,
          paymentUrl: providerPayment.paymentUrl,
          qrString: providerPayment.qrString,
          status: InvoiceStatus.OPEN,
          subtotalIdr: plan.priceIdr,
          totalIdr: plan.priceIdr,
          dueAt: expiresAt,
          expiresAt,
          metadata: {
            planCode: plan.code,
            creditMicro: plan.creditMicro.toString(),
            credits: plan.credits,
            durationDays: plan.durationDays,
            deviceLimit: plan.deviceLimit,
            environment,
          },
          items: {
            create: [
              {
                description: `${plan.name} subscription - ${plan.durationDays} hari`,
                quantity: 1,
                unitPriceIdr: plan.priceIdr,
                amountIdr: plan.priceIdr,
                metadata: { planCode: plan.code, credits: plan.credits },
              },
            ],
          },
        },
        include: { payment: true, items: true },
      });
    });
    return await this.safeInvoice(invoice);
  }

  async createTopupInvoice(
    identity: PaymentIdentity,
    requestedPurchaseUsd: unknown,
  ) {
    if (!this.walletPaymentSettings) {
      throw new ServiceUnavailableException("Konfigurasi wallet USD belum tersedia.");
    }
    const settings = await this.walletPaymentSettings.get();
    const purchaseMicroUsd = usdToMicro(requestedPurchaseUsd, "Nilai top-up USD");
    const quote = this.walletPaymentSettings.quote(purchaseMicroUsd, settings);
    const paymentMethod = "qris";
    await this.expireOpenInvoices(identity.id);
    const number = invoiceNumber();
    const provider = await this.providers.active();
    const expiresAt = providerInvoiceExpiry(provider.code);
    const providerPayment = await provider.createPayment({
      invoiceNumber: number,
      amountIdr: quote.totalPaymentIdr,
      expiresAt: expiresAt.toISOString(),
      customer: identity,
      description: `Cliper AI Cloud wallet top-up US$${quote.purchaseUsd}`,
    });
    const environment = paymentEnvironment(providerPayment.safeMetadata);
    const invoice = await this.serializable(async (tx) => {
      await tx.user.upsert({
        where: { id: identity.id },
        create: {
          id: identity.id,
          email: identity.email.toLowerCase(),
          displayName: identity.displayName,
          passwordHash: "external-bootstrap-auth",
        },
        update: {
          email: identity.email.toLowerCase(),
          displayName: identity.displayName,
        },
      });
      const payment = await tx.paymentTransaction.create({
        data: {
          userId: identity.id,
          provider: providerPayment.provider,
          externalId: providerPayment.externalId,
          amountIdr: quote.totalPaymentIdr,
          status: PaymentStatus.PENDING,
          idempotencyKey: `invoice:${number}`,
          metadata: jsonInput({
            provider: providerPayment.safeMetadata || {},
            invoiceNumber: number,
            kind: "topup",
            paymentMethod,
            qrImageUrl: providerPayment.qrImageUrl || null,
            environment,
            purchaseUsd: quote.purchaseUsd,
            purchaseMicroUsd: quote.purchaseMicroUsd.toString(),
            subtotalIdr: quote.subtotalIdr,
            serviceFeeIdr: quote.serviceFeeIdr,
            uniqueCodeIdr: quote.uniqueCodeIdr,
            totalPaymentIdr: quote.totalPaymentIdr,
          }),
        },
      });
      return tx.invoice.create({
        data: {
          number,
          userId: identity.id,
          paymentId: payment.id,
          provider: providerPayment.provider,
          providerReference: providerPayment.externalId,
          paymentUrl: providerPayment.paymentUrl,
          qrString: providerPayment.qrString,
          status: InvoiceStatus.OPEN,
          subtotalIdr: quote.subtotalIdr,
          totalIdr: quote.totalPaymentIdr,
          dueAt: expiresAt,
          expiresAt,
          metadata: {
            kind: "topup",
            walletCurrency: "USD",
            paymentCurrency: "IDR",
            creditMicro: quote.purchaseMicroUsd.toString(),
            purchaseMicroUsd: quote.purchaseMicroUsd.toString(),
            purchaseUsd: quote.purchaseUsd,
            credits: Number(quote.purchaseMicroUsd / 1_000_000n),
            subtotalIdr: quote.subtotalIdr,
            exchangeRate: quote.usdToIdrRate,
            serviceFeeIdr: quote.serviceFeeIdr,
            uniqueCodeIdr: quote.uniqueCodeIdr,
            totalPaymentIdr: quote.totalPaymentIdr,
            grossAmountIdr: quote.totalPaymentIdr,
            paymentMethod,
            qrImageUrl: providerPayment.qrImageUrl || null,
            environment,
          },
          items: {
            create: [
              {
                description: `Cliper wallet top-up US$${quote.purchaseUsd}`,
                quantity: 1,
                unitPriceIdr: quote.subtotalIdr,
                amountIdr: quote.subtotalIdr,
                metadata: {
                  kind: "topup",
                  walletCurrency: "USD",
                  purchaseUsd: quote.purchaseUsd,
                },
              },
            ],
          },
        },
        include: { payment: true, items: true },
      });
    });
    return await this.safeInvoice(invoice);
  }

  async createXenditTestTopup(identity: PaymentIdentity) {
    await this.providers.createXenditTestProvider();
    if (!this.walletPaymentSettings) {
      throw new ServiceUnavailableException("Konfigurasi wallet USD belum tersedia.");
    }
    const settings = await this.walletPaymentSettings.get();
    return this.createTopupInvoice(identity, settings.minPurchaseUsd);
  }

  async simulateXenditTestInvoice(userId: string, number: string) {
    if (this.localReadMode()) {
      throw new ServiceUnavailableException(
        "Simulasi Xendit memerlukan PostgreSQL aktif.",
      );
    }
    const invoice = await this.database.client().invoice.findFirst({
      where: { userId, number },
      include: { payment: true, items: true },
    });
    if (!invoice?.payment) {
      throw new NotFoundException("Invoice test tidak ditemukan.");
    }
    if (invoice.payment.provider !== "xendit") {
      throw new BadRequestException("Invoice ini bukan QRIS Xendit.");
    }
    if (paymentEnvironment(invoice.metadata) !== "test") {
      throw new BadRequestException(
        "Simulasi hanya boleh digunakan untuk invoice yang dibuat di Xendit test mode.",
      );
    }
    if (invoice.status !== InvoiceStatus.OPEN) {
      throw new ConflictException("Hanya invoice test yang masih OPEN dapat disimulasikan.");
    }
    if (invoice.expiresAt && invoice.expiresAt.getTime() <= Date.now()) {
      throw new ConflictException("Invoice test sudah expired.");
    }
    const simulation = await this.providers.simulateXenditTestPayment(
      invoice.payment.externalId,
      invoice.totalIdr,
    );
    try {
      await this.database.client().auditLog.create({
        data: {
          actorId: userId,
          action: "payment.test_simulation_requested",
          entityType: "invoice",
          entityId: invoice.id,
          metadata: {
            provider: "xendit",
            invoice: invoice.number,
            amountIdr: invoice.totalIdr,
          },
        },
      });
    } catch {
      this.logger.warn(
        JSON.stringify({
          event: "XENDIT_TEST_SIMULATION_AUDIT_UNAVAILABLE",
          invoice: invoice.number.slice(-8),
        }),
      );
    }
    return {
      simulation,
      invoice: await this.safeInvoice(invoice),
    };
  }

  async processWebhook(
    providerCode: string,
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ) {
    const dashboardTest =
      providerCode.trim().toLowerCase() === "midtrans"
        ? detectMidtransDashboardTestNotification(rawBody)
        : null;
    if (dashboardTest) {
      await this.acknowledgeMidtransDashboardTest(dashboardTest);
      return {
        ok: true,
        processed: false,
        accepted: false,
        test: true,
      };
    }
    const provider = await this.providers.byCode(providerCode);
    const verified = provider.verifyWebhook(rawBody, headers);
    if (!verified.verified || !verified.event) {
      if (verified.verified) {
        await this.acknowledgeInformationalWebhook(
          provider.code,
          verified.payloadHash,
        );
        return {
          ok: true,
          processed: false,
          accepted: false,
          test: true,
        };
      }
      await this.recordRejectedWebhook(
        provider.code,
        verified.payloadHash,
        verified.signature,
        verified.reason || "Webhook ditolak.",
      );
      throw new UnauthorizedException(
        verified.reason || "Webhook tidak valid.",
      );
    }
    const event = verified.event;
    const eventAge = Math.abs(
      Date.now() - new Date(event.occurredAt).getTime(),
    );
    const result = await this.applyWebhook(
      provider.code,
      event,
      verified.payloadHash,
      verified.signature,
      eventAge > 24 * 60 * 60_000,
    );
    if (result.accepted && event.status === "paid")
      await this.syncRuntimeBilling(provider.code, event.externalId);
    return result;
  }

  async completeSandboxInvoice(userId: string, number: string) {
    if (
      process.env.NODE_ENV === "production" &&
      String(process.env.ALLOW_SANDBOX_PAYMENTS || "false").toLowerCase() !==
        "true"
    ) {
      throw new UnauthorizedException(
        "Sandbox payment tidak tersedia di production.",
      );
    }
    const invoice = await this.database
      .client()
      .invoice.findFirst({
        where: { number, userId },
        include: { payment: true },
      });
    if (!invoice?.payment)
      throw new NotFoundException("Invoice sandbox tidak ditemukan.");
    const event: PaymentWebhookEvent = {
      eventId: `sbx_evt_${randomBytes(12).toString("hex")}`,
      externalId: invoice.payment.externalId,
      invoiceNumber: invoice.number,
      amountIdr: invoice.totalIdr,
      status: "paid",
      occurredAt: new Date().toISOString(),
    };
    const signed = this.providers.sandboxEvent(event);
    return this.processWebhook("sandbox", signed.rawBody, {
      "x-cliper-signature": signed.signature,
    });
  }

  async memberBilling(userId: string) {
    const topup = await this.topupConfiguration();
    if (this.localReadMode()) {
      return {
        mode: "development-memory",
        plans: this.planCatalog(),
        wallet: {
          currency: "USD",
          availableUsd: "0.000000",
          reservedUsd: "0.000000",
          spendableUsd: "0.000000",
          lifetimePurchasedUsd: "0.000000",
          lifetimeSpentUsd: "0.000000",
        },
        topup,
        subscription: null,
        invoices: [],
        notice:
          "Pembayaran lokal aktif. Hubungkan PostgreSQL dan Midtrans untuk transaksi nyata.",
      };
    }
    await this.expireOpenInvoices(userId);
    const client = this.database.client();
    const [invoices, account, subscription] = await Promise.all([
      client.invoice.findMany({
        where: { userId },
        include: { payment: true, items: true },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      client.userCreditAccount.findUnique({ where: { userId } }),
      client.subscription.findFirst({
        where: { userId },
        include: { planDefinition: true },
        orderBy: { updatedAt: "desc" },
      }),
    ]);
    return {
      mode: "postgresql",
      plans: this.planCatalog(),
      wallet: {
        currency: "USD",
        availableUsd: microToUsd(account?.balanceMicro || 0n),
        reservedUsd: microToUsd(account?.reservedMicro || 0n),
        spendableUsd: microToUsd(
          (account?.balanceMicro || 0n) - (account?.reservedMicro || 0n),
        ),
        lifetimePurchasedUsd: microToUsd(account?.lifetimeGrantedMicro || 0n),
        lifetimeSpentUsd: microToUsd(account?.lifetimeSpentMicro || 0n),
      },
      topup,
      subscription: subscription
        ? {
            id: subscription.id,
            plan: subscription.planCode.toLowerCase(),
            status: subscription.status.toLowerCase(),
            currentPeriodStart: subscription.currentPeriodStart.toISOString(),
            currentPeriodEnd: subscription.currentPeriodEnd?.toISOString(),
            autoRenew: subscription.autoRenew,
          }
        : null,
      invoices: await Promise.all(
        invoices.map((invoice) => this.safeInvoice(invoice)),
      ),
    };
  }

  async invoiceStatus(userId: string, number: string) {
    await this.expireOpenInvoices(userId);
    const invoice = await this.database
      .client()
      .invoice.findFirst({
        where: { userId, number },
        include: { payment: true, items: true },
      });
    if (!invoice) throw new NotFoundException("Invoice tidak ditemukan.");
    return await this.safeInvoice(invoice);
  }

  async syncInvoiceStatus(userId: string, number: string) {
    if (this.localReadMode())
      throw new ServiceUnavailableException(
        "Status Midtrans membutuhkan PostgreSQL aktif.",
      );
    const invoice = await this.database.client().invoice.findFirst({
      where: { userId, number },
      include: { payment: true, items: true },
    });
    if (!invoice?.payment)
      throw new NotFoundException("Invoice payment tidak ditemukan.");
    return this.syncPaymentStatus(invoice.payment.id, userId);
  }

  async syncPaymentStatus(paymentId: string, actorId = "bootstrap-admin") {
    if (this.localReadMode())
      throw new ServiceUnavailableException(
        "Status Midtrans membutuhkan PostgreSQL aktif.",
      );
    const payment = await this.database.client().paymentTransaction.findUnique({
      where: { id: paymentId },
      include: { invoice: true },
    });
    if (!payment?.invoice)
      throw new NotFoundException("Payment atau invoice tidak ditemukan.");
    if (actorId !== "bootstrap-admin" && payment.userId !== actorId)
      throw new UnauthorizedException("Invoice bukan milik user ini.");
    const provider = await this.providers.byCode(payment.provider);
    if (!provider.getTransactionStatus) {
      throw new ConflictException(
        "Provider payment ini tidak mendukung status sync otomatis.",
      );
    }
    const event = await provider.getTransactionStatus(
      payment.externalId,
      payment.amountIdr,
    );
    if (
      event.externalId !== payment.externalId ||
      event.invoiceNumber !== payment.invoice.number ||
      event.amountIdr !== payment.amountIdr
    ) {
      throw new ConflictException(
        "Status provider tidak cocok dengan payment yang tersimpan.",
      );
    }
    const normalizedBody = Buffer.from(JSON.stringify(event));
    const result = await this.applyWebhook(
      provider.code,
      event,
      paymentPayloadHash(normalizedBody),
      undefined,
    );
    if (result.accepted && event.status === "paid")
      await this.syncRuntimeBilling(provider.code, event.externalId);
    const latest = await this.database
      .client()
      .invoice.findUnique({
        where: { id: payment.invoice.id },
        include: { payment: true, items: true },
      });
    return {
      ...result,
      synced: true,
      invoice: latest ? await this.safeInvoice(latest) : undefined,
    };
  }

  async adminPayments() {
    if (this.localReadMode()) {
      return {
        mode: "development-memory",
        summary: {
          grossIdr: 0,
          refundedIdr: 0,
          netIdr: 0,
          paidCount: 0,
          pendingCount: 0,
          failedCount: 0,
          expiredCount: 0,
          activeSubscriptions: 0,
        },
        payments: [],
        notice: "Data payment sementara kosong pada mode lokal.",
      };
    }
    const client = this.database.client();
    await this.expireOpenInvoices();
    const [payments, activeSubscriptions] = await Promise.all([
      client.paymentTransaction.findMany({
        include: { user: true, invoice: true },
        orderBy: { createdAt: "desc" },
        take: 250,
      }),
      client.subscription.count({
        where: {
          status: SubscriptionStatus.ACTIVE,
          currentPeriodEnd: { gt: new Date() },
        },
      }),
    ]);
    const productionPayments = payments.filter(
      (item) => paymentEnvironment(item.metadata) === "production",
    );
    const testPayments = payments.filter(
      (item) => paymentEnvironment(item.metadata) === "test",
    );
    const paid = productionPayments.filter(
      (item) => item.status === PaymentStatus.PAID,
    );
    const refunded = productionPayments.filter(
      (item) => item.status === PaymentStatus.REFUNDED,
    );
    const grossIdr = [...paid, ...refunded].reduce(
      (total, item) => total + item.amountIdr,
      0,
    );
    const refundedIdr = refunded.reduce(
      (total, item) => total + item.amountIdr,
      0,
    );
    return {
      mode: "postgresql",
      summary: {
        grossIdr,
        refundedIdr,
        netIdr: grossIdr - refundedIdr,
        paidCount: paid.length,
        pendingCount: payments.filter(
          (item) => item.status === PaymentStatus.PENDING,
        ).length,
        failedCount: payments.filter(
          (item) => item.status === PaymentStatus.FAILED,
        ).length,
          expiredCount: payments.filter(
            (item) => item.status === PaymentStatus.EXPIRED,
          ).length,
          activeSubscriptions,
          testPaymentCount: testPayments.length,
          testPaidCount: testPayments.filter(
            (item) => item.status === PaymentStatus.PAID,
          ).length,
      },
      payments: payments.map((item) => ({
        id: item.id,
        reference: item.invoice?.number || item.externalId,
        customerEmail: item.user.email,
        amountIdr: item.amountIdr,
        walletCreditUsd:
          item.invoice && String(metadataRecord(item.invoice.metadata).kind || "") === "topup"
            ? String(metadataRecord(item.invoice.metadata).purchaseUsd || "") || null
            : null,
        subtotalIdr: item.invoice?.subtotalIdr || item.amountIdr,
        serviceFeeIdr: item.invoice
          ? Number(metadataRecord(item.invoice.metadata).serviceFeeIdr || 0)
          : 0,
        uniqueCodeIdr: item.invoice
          ? Number(metadataRecord(item.invoice.metadata).uniqueCodeIdr || 0)
          : 0,
        method: item.provider,
        status: item.status.toLowerCase(),
        environment: paymentEnvironment(item.metadata),
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      })),
    };
  }

  async refund(paymentId: string, actorId = "bootstrap-admin") {
    const client = this.database.client();
    const payment = await client.paymentTransaction.findUnique({
      where: { id: paymentId },
      include: { invoice: true },
    });
    if (!payment?.invoice)
      throw new NotFoundException("Payment atau invoice tidak ditemukan.");
    if (payment.status === PaymentStatus.REFUNDED)
      return { ok: true, duplicate: true };
    if (payment.status !== PaymentStatus.PAID)
      throw new ConflictException("Hanya pembayaran PAID yang dapat direfund.");
    const metadata = metadataRecord(payment.invoice.metadata);
    const creditMicro = safeBigInt(metadata.creditMicro);
    const accountBeforeRefund = await client.userCreditAccount.findUnique({
      where: { userId: payment.userId },
    });
    if (
      !accountBeforeRefund ||
      accountBeforeRefund.balanceMicro < creditMicro ||
      accountBeforeRefund.balanceMicro - creditMicro <
        accountBeforeRefund.reservedMicro
    ) {
      throw new ConflictException(
        "Credit hasil pembelian sudah dipakai atau sedang direservasi; refund otomatis ditolak sebelum provider dipanggil.",
      );
    }
    const provider = await this.providers.byCode(payment.provider);
    if (!provider.refund) {
      throw new ConflictException(
        "Provider payment ini belum mendukung refund yang telah direkonsiliasi. Wallet tidak diubah.",
      );
    }
    const providerRefund = await provider.refund(
      payment.externalId,
      payment.amountIdr,
    );

    const result = await this.serializable(async (tx) => {
      const current = await tx.paymentTransaction.findUnique({
        where: { id: paymentId },
        include: { invoice: true },
      });
      if (!current?.invoice)
        throw new NotFoundException("Payment tidak ditemukan.");
      if (current.status === PaymentStatus.REFUNDED)
        return { ok: true, duplicate: true };
      const account = await tx.userCreditAccount.findUnique({
        where: { userId: current.userId },
      });
      if (
        !account ||
        account.balanceMicro < creditMicro ||
        account.balanceMicro - creditMicro < account.reservedMicro
      ) {
        throw new ConflictException(
          "Credit hasil pembelian sudah dipakai atau sedang direservasi; refund otomatis ditolak.",
        );
      }
      const updatedAccount = await tx.userCreditAccount.update({
        where: { userId: current.userId },
        data: {
          balanceMicro: { decrement: creditMicro },
          lifetimeGrantedMicro: { decrement: creditMicro },
        },
      });
      await tx.creditLedger.create({
        data: {
          accountId: updatedAccount.id,
          subscriptionId: current.subscriptionId,
          invoiceId: current.invoice.id,
          type: LedgerType.REFUND,
          amountMicro: -creditMicro,
          balanceAfterMicro: updatedAccount.balanceMicro,
          idempotencyKey: `payment-refund:${current.id}`,
          description: `Refund ${current.invoice.number}`,
          costSnapshot: {
            amountIdr: current.amountIdr,
            providerReference: providerRefund?.reference || null,
          },
        },
      });
      if (current.subscriptionId) {
        await tx.subscription.update({
          where: { id: current.subscriptionId },
          data: {
            status: SubscriptionStatus.CANCELED,
            currentPeriodEnd: new Date(),
          },
        });
      }
      await tx.paymentTransaction.update({
        where: { id: current.id },
        data: { status: PaymentStatus.REFUNDED },
      });
      await tx.invoice.update({
        where: { id: current.invoice.id },
        data: { status: InvoiceStatus.REFUNDED },
      });
      await tx.auditLog.create({
        data: {
          actorId: actorId === "bootstrap-admin" ? null : actorId,
          action: "payment.refund",
          entityType: "payment",
          entityId: current.id,
          metadata: {
            invoice: current.invoice.number,
            amountIdr: current.amountIdr,
          },
        },
      });
      return {
        ok: true,
        duplicate: false,
        providerReference: providerRefund?.reference,
      };
    });
    await this.syncRuntimeBilling(payment.provider, payment.externalId);
    return result;
  }

  private async applyWebhook(
    provider: string,
    event: PaymentWebhookEvent,
    payloadHash: string,
    signature?: string,
    outsideReplayWindow = false,
  ) {
    return this.serializable(async (tx) => {
      const duplicate = await tx.paymentLog.findUnique({
        where: { provider_eventId: { provider, eventId: event.eventId } },
      });
      if (duplicate)
        return { ok: true, duplicate: true, accepted: duplicate.accepted };
      const payment = await tx.paymentTransaction.findUnique({
        where: {
          provider_externalId: { provider, externalId: event.externalId },
        },
        include: { invoice: true },
      });
      if (!payment?.invoice || payment.invoice.number !== event.invoiceNumber) {
        await tx.paymentLog.create({
          data: this.paymentLogData(
            provider,
            event,
            payloadHash,
            signature,
            false,
            "Invoice/provider reference tidak cocok.",
          ),
        });
        return {
          ok: true,
          duplicate: false,
          accepted: false,
          processed: false,
          reason: "Invoice tidak ditemukan.",
        };
      }
      const invoice = payment.invoice;
      if (outsideReplayWindow) {
        await tx.paymentLog.create({
          data: {
            ...this.paymentLogData(
              provider,
              event,
              payloadHash,
              signature,
              false,
              "Webhook untuk invoice yang dikenal berada di luar replay window.",
            ),
            invoiceId: invoice.id,
          },
        });
        return {
          ok: true,
          duplicate: false,
          accepted: false,
          processed: false,
          reason: "Webhook berada di luar replay window.",
        };
      }
      if (
        payment.amountIdr !== event.amountIdr ||
        invoice.totalIdr !== event.amountIdr
      ) {
        await tx.paymentLog.create({
          data: {
            ...this.paymentLogData(
              provider,
              event,
              payloadHash,
              signature,
              false,
              "Nominal callback tidak cocok.",
            ),
            invoiceId: invoice.id,
          },
        });
        return {
          ok: false,
          duplicate: false,
          accepted: false,
          reason: "Nominal tidak cocok.",
        };
      }
      if (
        event.status === "refunded" &&
        payment.status !== PaymentStatus.REFUNDED
      ) {
        await tx.paymentLog.create({
          data: {
            ...this.paymentLogData(
              provider,
              event,
              payloadHash,
              signature,
              false,
              "Refund provider memerlukan rekonsiliasi internal agar credit tidak mismatch.",
            ),
            invoiceId: invoice.id,
          },
        });
        return {
          ok: false,
          duplicate: false,
          accepted: false,
          reason: "Refund memerlukan rekonsiliasi admin.",
        };
      }
      if (event.status !== "paid") {
        await tx.paymentLog.create({
          data: {
            ...this.paymentLogData(
              provider,
              event,
              payloadHash,
              signature,
              true,
            ),
            invoiceId: invoice.id,
          },
        });
        await tx.paymentTransaction.update({
          where: { id: payment.id },
          data: { status: paymentStatus(event.status) },
        });
        if (event.status === "expired")
          await tx.invoice.update({
            where: { id: invoice.id },
            data: { status: InvoiceStatus.OVERDUE },
          });
        return {
          ok: true,
          duplicate: false,
          accepted: true,
          status: event.status,
        };
      }
      if (invoice.expiresAt && invoice.expiresAt.getTime() < Date.now()) {
        await tx.paymentLog.create({
          data: {
            ...this.paymentLogData(
              provider,
              event,
              payloadHash,
              signature,
              false,
              "Callback diterima setelah invoice expired.",
            ),
            invoiceId: invoice.id,
          },
        });
        await tx.paymentTransaction.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.EXPIRED },
        });
        await tx.invoice.update({
          where: { id: invoice.id },
          data: { status: InvoiceStatus.OVERDUE },
        });
        return {
          ok: false,
          duplicate: false,
          accepted: false,
          reason: "Invoice expired.",
        };
      }
      if (
        payment.status === PaymentStatus.PAID ||
        invoice.status === InvoiceStatus.PAID
      ) {
        await tx.paymentLog.create({
          data: {
            ...this.paymentLogData(
              provider,
              event,
              payloadHash,
              signature,
              true,
              "Duplicate paid callback ignored.",
            ),
            invoiceId: invoice.id,
          },
        });
        return { ok: true, duplicate: true, accepted: true };
      }
      const metadata = metadataRecord(invoice.metadata);
      if (String(metadata.kind || "plan") === "topup") {
        const creditMicro = safeBigInt(metadata.creditMicro);
        const account = await tx.userCreditAccount.upsert({
          where: { userId: payment.userId },
          create: {
            userId: payment.userId,
            balanceMicro: creditMicro,
            lifetimeGrantedMicro: creditMicro,
          },
          update: {
            balanceMicro: { increment: creditMicro },
            lifetimeGrantedMicro: { increment: creditMicro },
          },
        });
        await tx.creditLedger.create({
          data: {
            accountId: account.id,
            invoiceId: invoice.id,
            type: LedgerType.GRANT,
            amountMicro: creditMicro,
            balanceAfterMicro: account.balanceMicro,
            idempotencyKey: `payment-paid:${provider}:${event.eventId}`,
            description: `Top-up credit ${invoice.number}`,
            costSnapshot: {
              amountIdr: event.amountIdr,
              provider,
              externalId: event.externalId,
              kind: "topup",
            },
          },
        });
        const now = new Date();
        await tx.paymentTransaction.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.PAID, paidAt: now },
        });
        await tx.invoice.update({
          where: { id: invoice.id },
          data: { status: InvoiceStatus.PAID, paidAt: now },
        });
        await tx.paymentLog.create({
          data: {
            ...this.paymentLogData(
              provider,
              event,
              payloadHash,
              signature,
              true,
            ),
            invoiceId: invoice.id,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: payment.userId,
            action: "payment.topup_paid",
            entityType: "invoice",
            entityId: invoice.id,
            metadata: {
              invoice: invoice.number,
              amountIdr: event.amountIdr,
              creditMicro: creditMicro.toString(),
            },
          },
        });
        return {
          ok: true,
          duplicate: false,
          accepted: true,
          status: "paid",
          invoice: invoice.number,
        };
      }
      const plan = planByCode(metadata.planCode);
      const creditMicro = safeBigInt(metadata.creditMicro);
      if (creditMicro !== plan.creditMicro)
        throw new ConflictException(
          "Snapshot credit invoice tidak cocok dengan plan.",
        );
      const now = new Date();
      const existingSubscription = await tx.subscription.findFirst({
        where: {
          userId: payment.userId,
          status: {
            in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
          },
        },
        orderBy: { currentPeriodEnd: "desc" },
      });
      const periodBase =
        existingSubscription?.currentPeriodEnd &&
        existingSubscription.currentPeriodEnd > now
          ? existingSubscription.currentPeriodEnd
          : now;
      const currentPeriodEnd = new Date(
        periodBase.getTime() + plan.durationDays * 24 * 60 * 60_000,
      );
      const subscription = existingSubscription
        ? await tx.subscription.update({
            where: { id: existingSubscription.id },
            data: {
              planCode: plan.code,
              status: SubscriptionStatus.ACTIVE,
              monthlyCreditMicro: creditMicro,
              currentPeriodEnd,
              cancelAtPeriodEnd: false,
            },
          })
        : await tx.subscription.create({
            data: {
              userId: payment.userId,
              planCode: plan.code,
              status: SubscriptionStatus.ACTIVE,
              monthlyCreditMicro: creditMicro,
              currentPeriodStart: now,
              currentPeriodEnd,
            },
          });
      const account = await tx.userCreditAccount.upsert({
        where: { userId: payment.userId },
        create: {
          userId: payment.userId,
          subscriptionId: subscription.id,
          balanceMicro: creditMicro,
          lifetimeGrantedMicro: creditMicro,
        },
        update: {
          subscriptionId: subscription.id,
          balanceMicro: { increment: creditMicro },
          lifetimeGrantedMicro: { increment: creditMicro },
        },
      });
      await tx.creditLedger.create({
        data: {
          accountId: account.id,
          subscriptionId: subscription.id,
          invoiceId: invoice.id,
          type: LedgerType.GRANT,
          amountMicro: creditMicro,
          balanceAfterMicro: account.balanceMicro,
          idempotencyKey: `payment-paid:${provider}:${event.eventId}`,
          description: `${plan.name} payment ${invoice.number}`,
          costSnapshot: {
            amountIdr: event.amountIdr,
            provider,
            externalId: event.externalId,
          },
        },
      });
      await tx.paymentTransaction.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.PAID,
          paidAt: now,
          subscriptionId: subscription.id,
        },
      });
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          status: InvoiceStatus.PAID,
          paidAt: now,
          subscriptionId: subscription.id,
        },
      });
      await tx.paymentLog.create({
        data: {
          ...this.paymentLogData(provider, event, payloadHash, signature, true),
          invoiceId: invoice.id,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: payment.userId,
          action: "payment.paid",
          entityType: "invoice",
          entityId: invoice.id,
          metadata: {
            invoice: invoice.number,
            plan: plan.code,
            amountIdr: event.amountIdr,
            creditMicro: creditMicro.toString(),
          },
        },
      });
      return {
        ok: true,
        duplicate: false,
        accepted: true,
        status: "paid",
        invoice: invoice.number,
      };
    });
  }

  private paymentLogData(
    provider: string,
    event: PaymentWebhookEvent,
    payloadHash: string,
    signature: string | undefined,
    accepted: boolean,
    reason?: string,
  ) {
    return {
      provider,
      eventId: event.eventId,
      eventType: `payment.${event.status}`,
      payloadHash,
      signature: signature?.slice(0, 128),
      verified: true,
      accepted,
      reason,
      safePayload: {
        externalId: event.externalId,
        invoiceNumber: event.invoiceNumber,
        amountIdr: event.amountIdr,
        status: event.status,
        occurredAt: event.occurredAt,
      },
    };
  }

  private async acknowledgeMidtransDashboardTest(
    notification: MidtransDashboardTestNotification,
  ): Promise<void> {
    const diagnostic = {
      event: "MIDTRANS_WEBHOOK_TEST_OR_UNKNOWN_ORDER",
      provider: "midtrans",
      statusCode: notification.statusCode,
      transactionStatus: notification.transactionStatus,
      signaturePresent: notification.signaturePresent,
    };
    this.logger.log(JSON.stringify(diagnostic));
    if (!this.database.configured()) return;
    try {
      await this.database.client().paymentLog.upsert({
        where: {
          provider_eventId: {
            provider: "midtrans",
            eventId: notification.eventId,
          },
        },
        create: {
          provider: "midtrans",
          eventId: notification.eventId,
          eventType: "payment.dashboard_test",
          payloadHash: notification.payloadHash,
          verified: false,
          accepted: true,
          reason: "MIDTRANS_WEBHOOK_TEST_OR_UNKNOWN_ORDER",
          safePayload: {
            kind: "dashboard_test",
            statusCode: notification.statusCode,
            transactionStatus: notification.transactionStatus,
            signaturePresent: notification.signaturePresent,
          },
        },
        update: {
          accepted: true,
          reason: "MIDTRANS_WEBHOOK_TEST_OR_UNKNOWN_ORDER",
        },
      });
    } catch {
      // A dashboard probe has no financial effect, so an audit-log outage
      // must not make an otherwise public notification endpoint fail.
      this.logger.warn(
        JSON.stringify({
          event: "MIDTRANS_WEBHOOK_TEST_LOG_UNAVAILABLE",
          provider: "midtrans",
        }),
      );
    }
  }

  private async acknowledgeInformationalWebhook(
    provider: string,
    payloadHash: string,
  ): Promise<void> {
    this.logger.log(
      JSON.stringify({
        event: "PAYMENT_WEBHOOK_INFORMATIONAL_ACKNOWLEDGED",
        provider,
      }),
    );
    if (!this.database.configured()) return;
    try {
      await this.database.client().paymentLog.upsert({
        where: {
          provider_eventId: {
            provider,
            eventId: `${provider}:informational:${payloadHash}`,
          },
        },
        create: {
          provider,
          eventId: `${provider}:informational:${payloadHash}`,
          eventType: "payment.informational",
          payloadHash,
          verified: true,
          accepted: true,
          reason: "Informational provider webhook acknowledged without financial mutation.",
          safePayload: { kind: "informational" },
        },
        update: { accepted: true },
      });
    } catch {
      this.logger.warn(
        JSON.stringify({
          event: "PAYMENT_WEBHOOK_INFORMATIONAL_LOG_UNAVAILABLE",
          provider,
        }),
      );
    }
  }

  private async recordRejectedWebhook(
    provider: string,
    payloadHash: string,
    signature?: string,
    reason?: string,
    event?: PaymentWebhookEvent,
  ) {
    if (!this.database.configured()) return;
    const eventId = event?.eventId || `rejected-${payloadHash}`;
    await this.database.client().paymentLog.upsert({
      where: { provider_eventId: { provider, eventId } },
      create: {
        provider,
        eventId,
        eventType: event ? `payment.${event.status}` : "payment.invalid",
        payloadHash,
        signature: signature?.slice(0, 128),
        verified: false,
        accepted: false,
        reason,
        safePayload: event
          ? {
              invoiceNumber: event.invoiceNumber,
              amountIdr: event.amountIdr,
              status: event.status,
            }
          : undefined,
      },
      update: { reason, signature: signature?.slice(0, 128) },
    });
  }

  private async expireOpenInvoices(userId?: string) {
    if (!this.database.configured()) return;
    const client = this.database.client();
    const expired = await client.invoice.findMany({
      where: {
        ...(userId ? { userId } : {}),
        status: InvoiceStatus.OPEN,
        expiresAt: { lt: new Date() },
      },
      select: { id: true, paymentId: true },
    });
    if (!expired.length) return;
    await client.$transaction([
      client.invoice.updateMany({
        where: { id: { in: expired.map((item) => item.id) } },
        data: { status: InvoiceStatus.OVERDUE },
      }),
      client.paymentTransaction.updateMany({
        where: {
          id: {
            in: expired.flatMap((item) =>
              item.paymentId ? [item.paymentId] : [],
            ),
          },
          status: PaymentStatus.PENDING,
        },
        data: { status: PaymentStatus.EXPIRED },
      }),
    ]);
  }

  private async syncRuntimeBilling(
    provider: string,
    externalId: string,
  ): Promise<void> {
    const payment = await this.database.client().paymentTransaction.findUnique({
      where: { provider_externalId: { provider, externalId } },
      include: {
        user: true,
        subscription: { include: { planDefinition: true } },
        invoice: true,
      },
    });
    if (!payment) return;
    const account = await this.database
      .client()
      .userCreditAccount.findUnique({ where: { userId: payment.userId } });
    const plan = payment.subscription?.planCode.toLowerCase() as
      MemberPlan | undefined;
    await this.auth.syncBillingState(payment.userId, {
      plan,
      balanceMicro: asNumber(account?.balanceMicro || 0n),
      deviceLimit: payment.subscription?.planDefinition.deviceLimit,
    });
  }

  private async safeInvoice(invoice: {
    number: string;
    status: InvoiceStatus;
    subtotalIdr: number;
    taxIdr: number;
    totalIdr: number;
    provider: string | null;
    paymentUrl: string | null;
    qrString: string | null;
    issuedAt: Date;
    expiresAt: Date | null;
    paidAt: Date | null;
    metadata: unknown;
    payment?: { id: string; status: PaymentStatus; externalId: string } | null;
    items?: Array<{
      id: string;
      description: string;
      quantity: number;
      amountIdr: number;
    }>;
  }) {
    const metadata = metadataRecord(invoice.metadata);
    const canShowQr = invoice.status === InvoiceStatus.OPEN && Boolean(invoice.qrString);
    // QR image data is generated on demand from the stored payment payload.
    // Do not persist Base64 blobs in invoice metadata.
    const qrImageBase64 = canShowQr
      ? await transientQrDataUrl(invoice.qrString)
      : null;
    return {
      number: invoice.number,
      status:
        invoice.status === InvoiceStatus.OVERDUE
          ? "expired"
          : invoice.status.toLowerCase(),
      subtotalIdr: invoice.subtotalIdr,
      taxIdr: invoice.taxIdr,
      totalIdr: invoice.totalIdr,
      subtotalPaymentIdr: Number(metadata.subtotalIdr || invoice.subtotalIdr),
      serviceFeeIdr: Number(metadata.serviceFeeIdr || 0),
      uniqueCodeIdr: Number(metadata.uniqueCodeIdr || 0),
      walletCurrency: String(metadata.walletCurrency || "USD"),
      purchaseUsd:
        String(metadata.purchaseUsd || "") ||
        (String(metadata.kind || "") === "topup"
          ? microToUsd(safeBigInt(metadata.creditMicro))
          : null),
      provider: invoice.provider,
      paymentUrl: invoice.paymentUrl,
      // The EMV payload is only needed server-side to create the temporary QR
      // image for an open invoice. Never return it to the browser as text.
      qrString: null,
      qrImageBase64,
      qrImageUrl: canShowQr
        ? String(metadata.qrImageUrl || "") || null
        : null,
      issuedAt: invoice.issuedAt.toISOString(),
      expiresAt: invoice.expiresAt?.toISOString(),
      paidAt: invoice.paidAt?.toISOString(),
      plan: String(metadata.planCode || "").toLowerCase(),
      paymentMethod: String(metadata.paymentMethod || "qris"),
      kind: String(metadata.kind || "plan"),
      environment: paymentEnvironment(metadata),
      payment: invoice.payment
        ? {
            id: invoice.payment.id,
            status: invoice.payment.status.toLowerCase(),
            externalId: invoice.payment.externalId,
          }
        : null,
      items: invoice.items || [],
    };
  }

  private async serializable<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const client = this.database.client();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        return await client.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5_000,
          timeout: 10_000,
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2034" &&
          attempt < 4
        )
          continue;
        throw error;
      }
    }
    throw new ConflictException(
      "Transaksi payment gagal setelah retry serializable.",
    );
  }
}

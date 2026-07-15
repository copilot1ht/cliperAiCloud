import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { PaymentWebhookEvent } from "@cliper/billing";
import { randomBytes } from "node:crypto";
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

function planByCode(value: unknown): PlanDefinition {
  const code = String(value || "").trim().toUpperCase();
  const found = plans.find((item) => item.code === code);
  if (!found) throw new BadRequestException("Plan pembayaran tidak valid.");
  return found;
}

function invoiceNumber(): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
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
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
  if (!Number.isSafeInteger(result)) throw new ConflictException("Nilai credit melebihi batas aman JavaScript.");
  return result;
}

@Injectable()
export class PaymentService {
  constructor(
    private readonly database: DatabaseService,
    private readonly providers: PaymentProviderService,
    private readonly auth: AuthService,
  ) {}

  planCatalog() {
    return plans.map(({ creditMicro: _creditMicro, ...plan }) => ({ ...plan, code: plan.code.toLowerCase() }));
  }

  async createInvoice(identity: PaymentIdentity, requestedPlan: unknown) {
    const plan = planByCode(requestedPlan);
    const client = this.database.client();
    await this.expireOpenInvoices(identity.id);
    const number = invoiceNumber();
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    const provider = this.providers.active();
    const providerPayment = await provider.createPayment({
      invoiceNumber: number,
      amountIdr: plan.priceIdr,
      expiresAt: expiresAt.toISOString(),
      customer: identity,
      description: `Cliper AI Cloud ${plan.name} - 30 hari`,
    });

    const invoice = await this.serializable(async (tx) => {
      await tx.user.upsert({
        where: { id: identity.id },
        create: {
          id: identity.id,
          email: identity.email.toLowerCase(),
          displayName: identity.displayName,
          passwordHash: "external-bootstrap-auth",
        },
        update: { email: identity.email.toLowerCase(), displayName: identity.displayName },
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
          metadata: jsonInput({ provider: providerPayment.safeMetadata || {}, invoiceNumber: number }),
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
          },
          items: {
            create: [{
              description: `${plan.name} subscription - ${plan.durationDays} hari`,
              quantity: 1,
              unitPriceIdr: plan.priceIdr,
              amountIdr: plan.priceIdr,
              metadata: { planCode: plan.code, credits: plan.credits },
            }],
          },
        },
        include: { payment: true, items: true },
      });
    });
    return this.safeInvoice(invoice);
  }

  async processWebhook(providerCode: string, rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
    const provider = this.providers.byCode(providerCode);
    const verified = provider.verifyWebhook(rawBody, headers);
    if (!verified.verified || !verified.event) {
      await this.recordRejectedWebhook(provider.code, verified.payloadHash, verified.signature, verified.reason || "Webhook ditolak.");
      throw new UnauthorizedException(verified.reason || "Webhook tidak valid.");
    }
    const event = verified.event;
    const eventAge = Math.abs(Date.now() - new Date(event.occurredAt).getTime());
    if (eventAge > 24 * 60 * 60_000) {
      await this.recordRejectedWebhook(provider.code, verified.payloadHash, verified.signature, "Webhook berada di luar replay window.", event);
      throw new UnauthorizedException("Webhook berada di luar replay window.");
    }
    const result = await this.applyWebhook(provider.code, event, verified.payloadHash, verified.signature);
    if (result.accepted && event.status === "paid") await this.syncRuntimeBilling(provider.code, event.externalId);
    return result;
  }

  async completeSandboxInvoice(userId: string, number: string) {
    if (process.env.NODE_ENV === "production" && String(process.env.ALLOW_SANDBOX_PAYMENTS || "false").toLowerCase() !== "true") {
      throw new UnauthorizedException("Sandbox payment tidak tersedia di production.");
    }
    const invoice = await this.database.client().invoice.findFirst({ where: { number, userId }, include: { payment: true } });
    if (!invoice?.payment) throw new NotFoundException("Invoice sandbox tidak ditemukan.");
    const event: PaymentWebhookEvent = {
      eventId: `sbx_evt_${randomBytes(12).toString("hex")}`,
      externalId: invoice.payment.externalId,
      invoiceNumber: invoice.number,
      amountIdr: invoice.totalIdr,
      status: "paid",
      occurredAt: new Date().toISOString(),
    };
    const signed = this.providers.sandboxEvent(event);
    return this.processWebhook("sandbox", signed.rawBody, { "x-cliper-signature": signed.signature });
  }

  async memberBilling(userId: string) {
    await this.expireOpenInvoices(userId);
    const client = this.database.client();
    const [invoices, account, subscription] = await Promise.all([
      client.invoice.findMany({ where: { userId }, include: { payment: true, items: true }, orderBy: { createdAt: "desc" }, take: 50 }),
      client.userCreditAccount.findUnique({ where: { userId } }),
      client.subscription.findFirst({ where: { userId }, include: { planDefinition: true }, orderBy: { updatedAt: "desc" } }),
    ]);
    return {
      mode: "postgresql",
      plans: this.planCatalog(),
      wallet: {
        balanceMicro: asNumber(account?.balanceMicro || 0n),
        reservedMicro: asNumber(account?.reservedMicro || 0n),
        availableMicro: asNumber((account?.balanceMicro || 0n) - (account?.reservedMicro || 0n)),
        lifetimeGrantedMicro: asNumber(account?.lifetimeGrantedMicro || 0n),
        lifetimeSpentMicro: asNumber(account?.lifetimeSpentMicro || 0n),
      },
      subscription: subscription ? {
        id: subscription.id,
        plan: subscription.planCode.toLowerCase(),
        status: subscription.status.toLowerCase(),
        currentPeriodStart: subscription.currentPeriodStart.toISOString(),
        currentPeriodEnd: subscription.currentPeriodEnd?.toISOString(),
        autoRenew: subscription.autoRenew,
      } : null,
      invoices: invoices.map((invoice) => this.safeInvoice(invoice)),
    };
  }

  async invoiceStatus(userId: string, number: string) {
    await this.expireOpenInvoices(userId);
    const invoice = await this.database.client().invoice.findFirst({ where: { userId, number }, include: { payment: true, items: true } });
    if (!invoice) throw new NotFoundException("Invoice tidak ditemukan.");
    return this.safeInvoice(invoice);
  }

  async adminPayments() {
    const client = this.database.client();
    await this.expireOpenInvoices();
    const [payments, activeSubscriptions] = await Promise.all([
      client.paymentTransaction.findMany({ include: { user: true, invoice: true }, orderBy: { createdAt: "desc" }, take: 250 }),
      client.subscription.count({ where: { status: SubscriptionStatus.ACTIVE, currentPeriodEnd: { gt: new Date() } } }),
    ]);
    const paid = payments.filter((item) => item.status === PaymentStatus.PAID);
    const refunded = payments.filter((item) => item.status === PaymentStatus.REFUNDED);
    const grossIdr = [...paid, ...refunded].reduce((total, item) => total + item.amountIdr, 0);
    const refundedIdr = refunded.reduce((total, item) => total + item.amountIdr, 0);
    return {
      mode: "postgresql",
      summary: {
        grossIdr,
        refundedIdr,
        netIdr: grossIdr - refundedIdr,
        paidCount: paid.length,
        pendingCount: payments.filter((item) => item.status === PaymentStatus.PENDING).length,
        failedCount: payments.filter((item) => item.status === PaymentStatus.FAILED).length,
        expiredCount: payments.filter((item) => item.status === PaymentStatus.EXPIRED).length,
        activeSubscriptions,
      },
      payments: payments.map((item) => ({
        id: item.id,
        reference: item.invoice?.number || item.externalId,
        customerEmail: item.user.email,
        amountIdr: item.amountIdr,
        method: item.provider,
        status: item.status.toLowerCase(),
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      })),
    };
  }

  async refund(paymentId: string, actorId = "bootstrap-admin") {
    const client = this.database.client();
    const payment = await client.paymentTransaction.findUnique({ where: { id: paymentId }, include: { invoice: true } });
    if (!payment?.invoice) throw new NotFoundException("Payment atau invoice tidak ditemukan.");
    if (payment.status === PaymentStatus.REFUNDED) return { ok: true, duplicate: true };
    if (payment.status !== PaymentStatus.PAID) throw new ConflictException("Hanya pembayaran PAID yang dapat direfund.");
    const metadata = metadataRecord(payment.invoice.metadata);
    const creditMicro = safeBigInt(metadata.creditMicro);
    const accountBeforeRefund = await client.userCreditAccount.findUnique({ where: { userId: payment.userId } });
    if (!accountBeforeRefund || accountBeforeRefund.balanceMicro < creditMicro || accountBeforeRefund.balanceMicro - creditMicro < accountBeforeRefund.reservedMicro) {
      throw new ConflictException("Credit hasil pembelian sudah dipakai atau sedang direservasi; refund otomatis ditolak sebelum provider dipanggil.");
    }
    const provider = this.providers.byCode(payment.provider);
    const providerRefund = provider.refund ? await provider.refund(payment.externalId, payment.amountIdr) : undefined;

    const result = await this.serializable(async (tx) => {
      const current = await tx.paymentTransaction.findUnique({ where: { id: paymentId }, include: { invoice: true } });
      if (!current?.invoice) throw new NotFoundException("Payment tidak ditemukan.");
      if (current.status === PaymentStatus.REFUNDED) return { ok: true, duplicate: true };
      const account = await tx.userCreditAccount.findUnique({ where: { userId: current.userId } });
      if (!account || account.balanceMicro < creditMicro || account.balanceMicro - creditMicro < account.reservedMicro) {
        throw new ConflictException("Credit hasil pembelian sudah dipakai atau sedang direservasi; refund otomatis ditolak.");
      }
      const updatedAccount = await tx.userCreditAccount.update({
        where: { userId: current.userId },
        data: { balanceMicro: { decrement: creditMicro }, lifetimeGrantedMicro: { decrement: creditMicro } },
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
          costSnapshot: { amountIdr: current.amountIdr, providerReference: providerRefund?.reference || null },
        },
      });
      if (current.subscriptionId) {
        await tx.subscription.update({ where: { id: current.subscriptionId }, data: { status: SubscriptionStatus.CANCELED, currentPeriodEnd: new Date() } });
      }
      await tx.paymentTransaction.update({ where: { id: current.id }, data: { status: PaymentStatus.REFUNDED } });
      await tx.invoice.update({ where: { id: current.invoice.id }, data: { status: InvoiceStatus.REFUNDED } });
      await tx.auditLog.create({ data: { actorId: actorId === "bootstrap-admin" ? null : actorId, action: "payment.refund", entityType: "payment", entityId: current.id, metadata: { invoice: current.invoice.number, amountIdr: current.amountIdr } } });
      return { ok: true, duplicate: false, providerReference: providerRefund?.reference };
    });
    await this.syncRuntimeBilling(payment.provider, payment.externalId);
    return result;
  }

  private async applyWebhook(provider: string, event: PaymentWebhookEvent, payloadHash: string, signature?: string) {
    return this.serializable(async (tx) => {
      const duplicate = await tx.paymentLog.findUnique({ where: { provider_eventId: { provider, eventId: event.eventId } } });
      if (duplicate) return { ok: true, duplicate: true, accepted: duplicate.accepted };
      const payment = await tx.paymentTransaction.findUnique({
        where: { provider_externalId: { provider, externalId: event.externalId } },
        include: { invoice: true },
      });
      if (!payment?.invoice || payment.invoice.number !== event.invoiceNumber) {
        await tx.paymentLog.create({ data: this.paymentLogData(provider, event, payloadHash, signature, false, "Invoice/provider reference tidak cocok.") });
        return { ok: false, duplicate: false, accepted: false, reason: "Invoice tidak ditemukan." };
      }
      const invoice = payment.invoice;
      if (payment.amountIdr !== event.amountIdr || invoice.totalIdr !== event.amountIdr) {
        await tx.paymentLog.create({ data: { ...this.paymentLogData(provider, event, payloadHash, signature, false, "Nominal callback tidak cocok."), invoiceId: invoice.id } });
        return { ok: false, duplicate: false, accepted: false, reason: "Nominal tidak cocok." };
      }
      if (event.status === "refunded" && payment.status !== PaymentStatus.REFUNDED) {
        await tx.paymentLog.create({ data: { ...this.paymentLogData(provider, event, payloadHash, signature, false, "Refund provider memerlukan rekonsiliasi internal agar credit tidak mismatch."), invoiceId: invoice.id } });
        return { ok: false, duplicate: false, accepted: false, reason: "Refund memerlukan rekonsiliasi admin." };
      }
      if (event.status !== "paid") {
        await tx.paymentLog.create({ data: { ...this.paymentLogData(provider, event, payloadHash, signature, true), invoiceId: invoice.id } });
        await tx.paymentTransaction.update({ where: { id: payment.id }, data: { status: paymentStatus(event.status) } });
        if (event.status === "expired") await tx.invoice.update({ where: { id: invoice.id }, data: { status: InvoiceStatus.OVERDUE } });
        return { ok: true, duplicate: false, accepted: true, status: event.status };
      }
      if (invoice.expiresAt && invoice.expiresAt.getTime() < Date.now()) {
        await tx.paymentLog.create({ data: { ...this.paymentLogData(provider, event, payloadHash, signature, false, "Callback diterima setelah invoice expired."), invoiceId: invoice.id } });
        await tx.paymentTransaction.update({ where: { id: payment.id }, data: { status: PaymentStatus.EXPIRED } });
        await tx.invoice.update({ where: { id: invoice.id }, data: { status: InvoiceStatus.OVERDUE } });
        return { ok: false, duplicate: false, accepted: false, reason: "Invoice expired." };
      }
      if (payment.status === PaymentStatus.PAID || invoice.status === InvoiceStatus.PAID) {
        await tx.paymentLog.create({ data: { ...this.paymentLogData(provider, event, payloadHash, signature, true, "Duplicate paid callback ignored."), invoiceId: invoice.id } });
        return { ok: true, duplicate: true, accepted: true };
      }
      const metadata = metadataRecord(invoice.metadata);
      const plan = planByCode(metadata.planCode);
      const creditMicro = safeBigInt(metadata.creditMicro);
      if (creditMicro !== plan.creditMicro) throw new ConflictException("Snapshot credit invoice tidak cocok dengan plan.");
      const now = new Date();
      const existingSubscription = await tx.subscription.findFirst({
        where: { userId: payment.userId, status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] } },
        orderBy: { currentPeriodEnd: "desc" },
      });
      const periodBase = existingSubscription?.currentPeriodEnd && existingSubscription.currentPeriodEnd > now ? existingSubscription.currentPeriodEnd : now;
      const currentPeriodEnd = new Date(periodBase.getTime() + plan.durationDays * 24 * 60 * 60_000);
      const subscription = existingSubscription
        ? await tx.subscription.update({
          where: { id: existingSubscription.id },
          data: { planCode: plan.code, status: SubscriptionStatus.ACTIVE, monthlyCreditMicro: creditMicro, currentPeriodEnd, cancelAtPeriodEnd: false },
        })
        : await tx.subscription.create({
          data: { userId: payment.userId, planCode: plan.code, status: SubscriptionStatus.ACTIVE, monthlyCreditMicro: creditMicro, currentPeriodStart: now, currentPeriodEnd },
        });
      const account = await tx.userCreditAccount.upsert({
        where: { userId: payment.userId },
        create: { userId: payment.userId, subscriptionId: subscription.id, balanceMicro: creditMicro, lifetimeGrantedMicro: creditMicro },
        update: { subscriptionId: subscription.id, balanceMicro: { increment: creditMicro }, lifetimeGrantedMicro: { increment: creditMicro } },
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
          costSnapshot: { amountIdr: event.amountIdr, provider, externalId: event.externalId },
        },
      });
      await tx.paymentTransaction.update({ where: { id: payment.id }, data: { status: PaymentStatus.PAID, paidAt: now, subscriptionId: subscription.id } });
      await tx.invoice.update({ where: { id: invoice.id }, data: { status: InvoiceStatus.PAID, paidAt: now, subscriptionId: subscription.id } });
      await tx.paymentLog.create({ data: { ...this.paymentLogData(provider, event, payloadHash, signature, true), invoiceId: invoice.id } });
      await tx.auditLog.create({ data: { actorId: payment.userId, action: "payment.paid", entityType: "invoice", entityId: invoice.id, metadata: { invoice: invoice.number, plan: plan.code, amountIdr: event.amountIdr, creditMicro: creditMicro.toString() } } });
      return { ok: true, duplicate: false, accepted: true, status: "paid", invoice: invoice.number };
    });
  }

  private paymentLogData(provider: string, event: PaymentWebhookEvent, payloadHash: string, signature: string | undefined, accepted: boolean, reason?: string) {
    return {
      provider,
      eventId: event.eventId,
      eventType: `payment.${event.status}`,
      payloadHash,
      signature: signature?.slice(0, 128),
      verified: true,
      accepted,
      reason,
      safePayload: { externalId: event.externalId, invoiceNumber: event.invoiceNumber, amountIdr: event.amountIdr, status: event.status, occurredAt: event.occurredAt },
    };
  }

  private async recordRejectedWebhook(provider: string, payloadHash: string, signature?: string, reason?: string, event?: PaymentWebhookEvent) {
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
        safePayload: event ? { invoiceNumber: event.invoiceNumber, amountIdr: event.amountIdr, status: event.status } : undefined,
      },
      update: { reason, signature: signature?.slice(0, 128) },
    });
  }

  private async expireOpenInvoices(userId?: string) {
    if (!this.database.configured()) return;
    const client = this.database.client();
    const expired = await client.invoice.findMany({
      where: { ...(userId ? { userId } : {}), status: InvoiceStatus.OPEN, expiresAt: { lt: new Date() } },
      select: { id: true, paymentId: true },
    });
    if (!expired.length) return;
    await client.$transaction([
      client.invoice.updateMany({ where: { id: { in: expired.map((item) => item.id) } }, data: { status: InvoiceStatus.OVERDUE } }),
      client.paymentTransaction.updateMany({ where: { id: { in: expired.flatMap((item) => item.paymentId ? [item.paymentId] : []) }, status: PaymentStatus.PENDING }, data: { status: PaymentStatus.EXPIRED } }),
    ]);
  }

  private async syncRuntimeBilling(provider: string, externalId: string): Promise<void> {
    const payment = await this.database.client().paymentTransaction.findUnique({
      where: { provider_externalId: { provider, externalId } },
      include: {
        user: true,
        subscription: { include: { planDefinition: true } },
        invoice: true,
      },
    });
    if (!payment) return;
    const account = await this.database.client().userCreditAccount.findUnique({ where: { userId: payment.userId } });
    const plan = payment.subscription?.planCode.toLowerCase() as MemberPlan | undefined;
    this.auth.syncBillingState(payment.userId, {
      plan: plan || "free",
      balanceMicro: asNumber(account?.balanceMicro || 0n),
      deviceLimit: payment.subscription?.planDefinition.deviceLimit || 1,
    });
  }

  private safeInvoice(invoice: {
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
    items?: Array<{ id: string; description: string; quantity: number; amountIdr: number }>;
  }) {
    const metadata = metadataRecord(invoice.metadata);
    return {
      number: invoice.number,
      status: invoice.status === InvoiceStatus.OVERDUE ? "expired" : invoice.status.toLowerCase(),
      subtotalIdr: invoice.subtotalIdr,
      taxIdr: invoice.taxIdr,
      totalIdr: invoice.totalIdr,
      provider: invoice.provider,
      paymentUrl: invoice.paymentUrl,
      qrString: invoice.qrString,
      issuedAt: invoice.issuedAt.toISOString(),
      expiresAt: invoice.expiresAt?.toISOString(),
      paidAt: invoice.paidAt?.toISOString(),
      plan: String(metadata.planCode || "").toLowerCase(),
      credits: Number(metadata.credits || 0),
      payment: invoice.payment ? { id: invoice.payment.id, status: invoice.payment.status.toLowerCase(), externalId: invoice.payment.externalId } : null,
      items: invoice.items || [],
    };
  }

  private async serializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const client = this.database.client();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        return await client.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5_000,
          timeout: 10_000,
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" && attempt < 4) continue;
        throw error;
      }
    }
    throw new ConflictException("Transaksi payment gagal setelah retry serializable.");
  }
}

import { HttpException, HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { BillingSource, PaymentStatus, PlanCode, Prisma, SubscriptionStatus } from "../generated/prisma/client.js";
import { InsufficientBalanceException } from "./credit-account.service.js";
import { microToUsd } from "./wallet-payment-settings.service.js";

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;

export interface ProQuotaWindow {
  key: string;
  startsAt: Date;
  resetsAt: Date;
}

export interface ProBillingDecision {
  source: BillingSource;
  reservationMicroUsd: bigint;
  subscriptionId?: string;
  proQuotaDayKey?: string;
  proQuotaMonthKey?: string;
  premiumTrialWeekKey?: string;
  premiumTrialSourceKey?: string;
  snapshot: Record<string, unknown>;
}

export interface FeaturePolicy {
  ok: true;
  hasSuccessfulTopup: boolean;
  showUpgradeMenu: boolean;
  walletFallbackDefault: boolean;
  subscription: {
    active: boolean;
    plan: "free" | "pro";
    status: string;
    currentPeriodEnd: string | null;
  };
  pro: {
    dailyLimit: number;
    dailyUsed: number;
    monthlyLimit: number;
    monthlyUsed: number;
    dayResetsAt: string;
    monthResetsAt: string;
    weeklyPremiumUnlimited: boolean;
    weeklyTrialLimit: number;
    weeklyTrialUsed: number;
    weekResetsAt: string;
    maxClipsPerJob: number;
    maxDevices: number;
    maxConcurrentAi: number;
  };
  wallet: {
    currency: "USD";
    availableUsd: string;
    reservedUsd: string;
    spendableUsd: string;
  };
  nextBillingSource: "subscription" | "wallet_fallback" | "wallet_standard" | "blocked";
}

export class ProQuotaInsufficientWalletException extends HttpException {
  constructor(input: {
    code: "DAILY_SUBSCRIPTION_LIMIT_AND_INSUFFICIENT_WALLET" | "MONTHLY_SUBSCRIPTION_LIMIT_AND_INSUFFICIENT_WALLET";
    availableMicroUsd: bigint;
    requiredMicroUsd: bigint;
    dayResetsAt: Date;
    monthResetsAt: Date;
    requestId?: string;
  }) {
    super({
      ok: false,
      code: input.code,
      category: "PAYMENT_REQUIRED",
      message: "Limit Pro sudah habis dan saldo cadangan tidak cukup.",
      walletCurrency: "USD",
      availableUsd: microToUsd(input.availableMicroUsd),
      requiredUsd: microToUsd(input.requiredMicroUsd),
      dayResetsAt: input.dayResetsAt.toISOString(),
      monthResetsAt: input.monthResetsAt.toISOString(),
      topupUrl: String(process.env.CLIPER_TOPUP_URL || `${String(process.env.WEB_ORIGIN || "http://localhost:3000").replace(/\/$/, "")}/billing?topup=1`),
      requestId: input.requestId,
    }, HttpStatus.PAYMENT_REQUIRED);
  }
}

export function jakartaDayWindow(now = new Date()): ProQuotaWindow {
  const shifted = new Date(now.getTime() + JAKARTA_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  const startsAt = new Date(Date.UTC(year, month, day) - JAKARTA_OFFSET_MS);
  const resetsAt = new Date(Date.UTC(year, month, day + 1) - JAKARTA_OFFSET_MS);
  return {
    key: `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    startsAt,
    resetsAt,
  };
}

export function jakartaMonthWindow(now = new Date()): ProQuotaWindow {
  const shifted = new Date(now.getTime() + JAKARTA_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const startsAt = new Date(Date.UTC(year, month, 1) - JAKARTA_OFFSET_MS);
  const resetsAt = new Date(Date.UTC(year, month + 1, 1) - JAKARTA_OFFSET_MS);
  return {
    key: `${year}-${String(month + 1).padStart(2, "0")}`,
    startsAt,
    resetsAt,
  };
}

export function jakartaWeekWindow(now = new Date()): ProQuotaWindow {
  const shifted = new Date(now.getTime() + JAKARTA_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  const dayOfWeek = shifted.getUTCDay() || 7;
  const monday = day - dayOfWeek + 1;
  const startsAt = new Date(Date.UTC(year, month, monday) - JAKARTA_OFFSET_MS);
  const resetShifted = new Date(startsAt.getTime() + JAKARTA_OFFSET_MS + 7 * 24 * 60 * 60_000);
  const resetsAt = new Date(Date.UTC(
    resetShifted.getUTCFullYear(),
    resetShifted.getUTCMonth(),
    resetShifted.getUTCDate(),
  ) - JAKARTA_OFFSET_MS);
  const keyDate = new Date(startsAt.getTime() + JAKARTA_OFFSET_MS);
  return {
    key: `${keyDate.getUTCFullYear()}-W${String(weekNumberJakarta(keyDate)).padStart(2, "0")}`,
    startsAt,
    resetsAt,
  };
}

function proDailyLimit(): number {
  const value = Number(process.env.CLIPER_PRO_DAILY_AI_LIMIT || 5);
  return Number.isSafeInteger(value) && value > 0 ? value : 5;
}

function proMonthlyLimit(): number {
  const value = Number(process.env.CLIPER_PRO_MONTHLY_AI_LIMIT || 60);
  return Number.isSafeInteger(value) && value > 0 ? value : 60;
}

function freeWeeklyTrialLimit(): number {
  const value = Number(process.env.CLIPER_FREE_PREMIUM_WEEKLY_SOURCE_LIMIT || 2);
  return Number.isSafeInteger(value) && value >= 0 ? value : 2;
}

function proMaxClipsPerJob(): number {
  const value = Number(process.env.CLIPER_PRO_MAX_CLIPS_PER_JOB || 10);
  return Number.isSafeInteger(value) && value > 0 ? value : 10;
}

function walletFallbackEnabled(): boolean {
  return String(process.env.CLIPER_PRO_WALLET_FALLBACK_DEFAULT || "true").toLowerCase() !== "false";
}

function weekNumberJakarta(date: Date): number {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil((((target.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
}

function normalizedMode(value: unknown): string {
  return String(value || "auto").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40) || "auto";
}

function freePremiumTrialEligibleMode(mode: string): boolean {
  return mode === "summary" || mode === "landscape_blur" || mode === "landscape";
}

function normalizedSourceKey(value: unknown): string {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9:_-]/g, "").slice(0, 160);
}

@Injectable()
export class ProEntitlementService {
  async resolveAnalysisJobBilling(
    tx: Prisma.TransactionClient,
    input: {
      userId: string;
      requestId: string;
      estimatedReservationMicroUsd: bigint;
      spendableWalletMicroUsd: bigint;
      contentMode?: string;
      sourceId?: string;
      now?: Date;
    },
  ): Promise<ProBillingDecision> {
    const now = input.now || new Date();
    const day = jakartaDayWindow(now);
    const month = jakartaMonthWindow(now);
    const week = jakartaWeekWindow(now);
    const contentMode = normalizedMode(input.contentMode);
    const sourceKey = normalizedSourceKey(input.sourceId);
    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: { id: true, unlimitedCredits: true },
    });
    if (!user) throw new NotFoundException("Akun analysis tidak ditemukan.");
    if (user.unlimitedCredits) {
      return {
        source: BillingSource.NO_CHARGE_LOCAL,
        reservationMicroUsd: 0n,
        proQuotaDayKey: day.key,
        proQuotaMonthKey: month.key,
        snapshot: {
          billingSource: BillingSource.NO_CHARGE_LOCAL,
          unlimitedCredits: true,
          dayKey: day.key,
          monthKey: month.key,
        },
      };
    }

    const subscription = await this.activeProSubscription(tx, input.userId, now);
    if (subscription) {
      const [dailyUsed, monthlyUsed] = await Promise.all([
        this.subscriptionUsage(tx, input.userId, day.key, "day"),
        this.subscriptionUsage(tx, input.userId, month.key, "month"),
      ]);
      const dailyLimit = proDailyLimit();
      const monthlyLimit = proMonthlyLimit();
      const quotaAvailable = dailyUsed < dailyLimit;
      const baseSnapshot = {
        billingSource: BillingSource.SUBSCRIPTION_INCLUDED,
        plan: "pro",
        subscriptionId: subscription.id,
        contentMode,
        dayKey: day.key,
        monthKey: month.key,
        dailyUsedBefore: dailyUsed,
        dailyLimit,
        monthlyUsedBefore: monthlyUsed,
        monthlyLimit,
        monthlyLimitMode: "telemetry_only",
        dayResetsAt: day.resetsAt.toISOString(),
        monthResetsAt: month.resetsAt.toISOString(),
        walletFallbackEnabled: walletFallbackEnabled(),
      };
      if (quotaAvailable) {
        return {
          source: BillingSource.SUBSCRIPTION_INCLUDED,
          reservationMicroUsd: 0n,
          subscriptionId: subscription.id,
          proQuotaDayKey: day.key,
          proQuotaMonthKey: month.key,
          snapshot: baseSnapshot,
        };
      }
      if (walletFallbackEnabled() && input.spendableWalletMicroUsd >= input.estimatedReservationMicroUsd) {
        return {
          source: BillingSource.WALLET_FALLBACK,
          reservationMicroUsd: input.estimatedReservationMicroUsd,
          subscriptionId: subscription.id,
          proQuotaDayKey: day.key,
          proQuotaMonthKey: month.key,
          snapshot: {
            ...baseSnapshot,
            billingSource: BillingSource.WALLET_FALLBACK,
            fallbackReason: "daily_limit",
          },
        };
      }
      throw new ProQuotaInsufficientWalletException({
        code: "DAILY_SUBSCRIPTION_LIMIT_AND_INSUFFICIENT_WALLET",
        availableMicroUsd: input.spendableWalletMicroUsd,
        requiredMicroUsd: input.estimatedReservationMicroUsd,
        dayResetsAt: day.resetsAt,
        monthResetsAt: month.resetsAt,
        requestId: input.requestId,
      });
    }

    if (freePremiumTrialEligibleMode(contentMode) && sourceKey) {
      const trialSources = await this.weeklyTrialSources(tx, input.userId, week.key);
      if (trialSources.has(sourceKey) || trialSources.size < freeWeeklyTrialLimit()) {
        return {
          source: BillingSource.FREE_PREMIUM_TRIAL,
          reservationMicroUsd: 0n,
          proQuotaDayKey: day.key,
          proQuotaMonthKey: month.key,
          premiumTrialWeekKey: week.key,
          premiumTrialSourceKey: sourceKey,
          snapshot: {
            billingSource: BillingSource.FREE_PREMIUM_TRIAL,
            plan: "free",
            contentMode,
            premiumTrialWeekKey: week.key,
            premiumTrialSourceKey: sourceKey,
            premiumTrialUsedBefore: trialSources.size,
            premiumTrialLimit: freeWeeklyTrialLimit(),
            weekResetsAt: week.resetsAt.toISOString(),
            sameSourceAlreadyClaimed: trialSources.has(sourceKey),
          },
        };
      }
    }

    if (input.spendableWalletMicroUsd < input.estimatedReservationMicroUsd) {
      throw new InsufficientBalanceException(
        Number(input.spendableWalletMicroUsd),
        Number(input.estimatedReservationMicroUsd),
        input.requestId,
      );
    }
    return {
      source: BillingSource.WALLET_STANDARD,
      reservationMicroUsd: input.estimatedReservationMicroUsd,
      proQuotaDayKey: day.key,
      proQuotaMonthKey: month.key,
      snapshot: {
        billingSource: BillingSource.WALLET_STANDARD,
        plan: "free",
        contentMode,
        dayKey: day.key,
        monthKey: month.key,
        premiumTrialWeekKey: week.key,
      },
    };
  }

  async featurePolicy(client: Prisma.TransactionClient, userId: string, now = new Date()): Promise<FeaturePolicy> {
    const day = jakartaDayWindow(now);
    const month = jakartaMonthWindow(now);
    const week = jakartaWeekWindow(now);
    const [subscription, hasSuccessfulTopup, account] = await Promise.all([
      this.activeProSubscription(client, userId, now),
      this.hasSuccessfulTopup(client, userId),
      client.userCreditAccount.findUnique({ where: { userId } }),
    ]);
    const [dailyUsed, monthlyUsed] = subscription
      ? await Promise.all([
        this.subscriptionUsage(client, userId, day.key, "day"),
        this.subscriptionUsage(client, userId, month.key, "month"),
      ])
      : [0, 0];
    const dailyLimit = proDailyLimit();
    const monthlyLimit = proMonthlyLimit();
    const weeklyTrialUsed = (await this.weeklyTrialSources(client, userId, week.key)).size;
    const balanceMicro = account?.balanceMicro || 0n;
    const reservedMicro = account?.reservedMicro || 0n;
    const spendableMicro = balanceMicro - reservedMicro;
    const subscriptionReady = Boolean(subscription && dailyUsed < dailyLimit);
    const walletReady = spendableMicro > 0n;
    const nextBillingSource = subscriptionReady
      ? "subscription"
      : subscription
        ? walletReady ? "wallet_fallback" : "blocked"
        : walletReady ? "wallet_standard" : "blocked";
    return {
      ok: true,
      hasSuccessfulTopup,
      showUpgradeMenu: hasSuccessfulTopup,
      walletFallbackDefault: walletFallbackEnabled(),
      subscription: {
        active: Boolean(subscription),
        plan: subscription ? "pro" : "free",
        status: subscription?.status.toLowerCase() || "none",
        currentPeriodEnd: subscription?.currentPeriodEnd?.toISOString() || null,
      },
      pro: {
        dailyLimit,
        dailyUsed,
        monthlyLimit,
        monthlyUsed,
        dayResetsAt: day.resetsAt.toISOString(),
        monthResetsAt: month.resetsAt.toISOString(),
        weeklyPremiumUnlimited: true,
        weeklyTrialLimit: freeWeeklyTrialLimit(),
        weeklyTrialUsed,
        weekResetsAt: week.resetsAt.toISOString(),
        maxClipsPerJob: proMaxClipsPerJob(),
        maxDevices: 2,
        maxConcurrentAi: 1,
      },
      wallet: {
        currency: "USD",
        availableUsd: microToUsd(balanceMicro),
        reservedUsd: microToUsd(reservedMicro),
        spendableUsd: microToUsd(spendableMicro),
      },
      nextBillingSource,
    };
  }

  private activeProSubscription(tx: Prisma.TransactionClient, userId: string, now: Date) {
    return tx.subscription.findFirst({
      where: {
        userId,
        planCode: PlanCode.PRO,
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] },
        OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { gt: now } }],
      },
      orderBy: { currentPeriodEnd: "desc" },
    });
  }

  private async subscriptionUsage(
    tx: Prisma.TransactionClient,
    userId: string,
    key: string,
    window: "day" | "month",
  ): Promise<number> {
    return tx.analysisJob.count({
      where: {
        userId,
        billingSource: BillingSource.SUBSCRIPTION_INCLUDED,
        ...(window === "day" ? { proQuotaDayKey: key } : { proQuotaMonthKey: key }),
      },
    });
  }

  private async weeklyTrialSources(
    tx: Prisma.TransactionClient,
    userId: string,
    weekKey: string,
  ): Promise<Set<string>> {
    const rows = await tx.analysisJob.findMany({
      where: {
        userId,
        billingSource: BillingSource.FREE_PREMIUM_TRIAL,
        premiumTrialWeekKey: weekKey,
        premiumTrialSourceKey: { not: null },
      },
      select: { premiumTrialSourceKey: true },
      take: 200,
    });
    return new Set(rows.flatMap((row) => row.premiumTrialSourceKey ? [row.premiumTrialSourceKey] : []));
  }

  private async hasSuccessfulTopup(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
    const payment = await tx.paymentTransaction.findFirst({
      where: {
        userId,
        status: PaymentStatus.PAID,
        OR: [
          { metadata: { path: ["kind"], equals: "topup" } },
          { invoice: { is: { metadata: { path: ["kind"], equals: "topup" } } } },
        ],
      },
      select: { id: true },
    });
    return Boolean(payment);
  }
}

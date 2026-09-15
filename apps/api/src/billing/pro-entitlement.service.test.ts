import { describe, expect, it, vi } from "vitest";
import { BillingSource, PaymentStatus, PlanCode, SubscriptionStatus } from "../generated/prisma/client.js";
import {
  jakartaDayWindow,
  ProEntitlementService,
  ProQuotaInsufficientWalletException,
  jakartaWeekWindow,
} from "./pro-entitlement.service.js";

function txMock(input: {
  unlimitedCredits?: boolean;
  subscription?: boolean;
  dailyUsed?: number;
  monthlyUsed?: number;
  walletBalance?: bigint;
  walletReserved?: bigint;
  paidTopup?: boolean;
  weeklyTrialSources?: string[];
}) {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: "user-a", unlimitedCredits: Boolean(input.unlimitedCredits) }),
    },
    subscription: {
      findFirst: vi.fn().mockResolvedValue(input.subscription ? {
        id: "sub-pro",
        userId: "user-a",
        planCode: PlanCode.PRO,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: new Date("2027-09-09T17:00:00.000Z"),
      } : null),
    },
    analysisJob: {
      count: vi.fn()
        .mockResolvedValueOnce(input.dailyUsed ?? 0)
        .mockResolvedValueOnce(input.monthlyUsed ?? 0),
      findMany: vi.fn().mockResolvedValue((input.weeklyTrialSources || []).map((source) => ({
        premiumTrialSourceKey: source,
      }))),
    },
    userCreditAccount: {
      findUnique: vi.fn().mockResolvedValue({
        balanceMicro: input.walletBalance ?? 0n,
        reservedMicro: input.walletReserved ?? 0n,
      }),
    },
    paymentTransaction: {
      findFirst: vi.fn().mockResolvedValue(input.paidTopup ? {
        id: "paid-topup",
        status: PaymentStatus.PAID,
      } : null),
    },
  };
}

describe("ProEntitlementService", () => {
  it("uses Asia/Jakarta day boundaries for daily quota reset", () => {
    const window = jakartaDayWindow(new Date("2026-09-09T18:30:00.000Z"));
    expect(window.key).toBe("2026-09-10");
    expect(window.startsAt.toISOString()).toBe("2026-09-09T17:00:00.000Z");
    expect(window.resetsAt.toISOString()).toBe("2026-09-10T17:00:00.000Z");
  });

  it("uses Monday Asia/Jakarta boundaries for the weekly premium trial", () => {
    const window = jakartaWeekWindow(new Date("2026-09-12T03:00:00.000Z"));
    expect(window.startsAt.toISOString()).toBe("2026-09-06T17:00:00.000Z");
    expect(window.resetsAt.toISOString()).toBe("2026-09-13T17:00:00.000Z");
  });

  it("uses Pro subscription quota before wallet even when wallet is empty", async () => {
    const service = new ProEntitlementService();
    const tx = txMock({ subscription: true, dailyUsed: 2, monthlyUsed: 18 });

    const decision = await service.resolveAnalysisJobBilling(tx as never, {
      userId: "user-a",
      requestId: "job-a",
      estimatedReservationMicroUsd: 50_000n,
      spendableWalletMicroUsd: 0n,
      now: new Date("2026-09-10T02:00:00.000Z"),
    });

    expect(decision.source).toBe(BillingSource.SUBSCRIPTION_INCLUDED);
    expect(decision.reservationMicroUsd).toBe(0n);
    expect(decision.subscriptionId).toBe("sub-pro");
  });

  it("does not make monthly usage a hard blocker while daily quota remains", async () => {
    const service = new ProEntitlementService();
    const tx = txMock({ subscription: true, dailyUsed: 2, monthlyUsed: 60 });

    const decision = await service.resolveAnalysisJobBilling(tx as never, {
      userId: "user-a",
      requestId: "job-month-telemetry",
      estimatedReservationMicroUsd: 50_000n,
      spendableWalletMicroUsd: 0n,
      now: new Date("2026-09-10T02:00:00.000Z"),
    });

    expect(decision.source).toBe(BillingSource.SUBSCRIPTION_INCLUDED);
    expect(decision.snapshot.monthlyLimitMode).toBe("telemetry_only");
  });

  it("falls back to spendable wallet after the daily Pro limit is exhausted", async () => {
    const service = new ProEntitlementService();
    const tx = txMock({ subscription: true, dailyUsed: 5, monthlyUsed: 18 });

    const decision = await service.resolveAnalysisJobBilling(tx as never, {
      userId: "user-a",
      requestId: "job-b",
      estimatedReservationMicroUsd: 50_000n,
      spendableWalletMicroUsd: 60_000n,
    });

    expect(decision.source).toBe(BillingSource.WALLET_FALLBACK);
    expect(decision.reservationMicroUsd).toBe(50_000n);
    expect(decision.snapshot.fallbackReason).toBe("daily_limit");
  });

  it("blocks before provider work when Pro is exhausted and wallet is insufficient", async () => {
    const service = new ProEntitlementService();
    const tx = txMock({ subscription: true, dailyUsed: 5, monthlyUsed: 18 });

    await expect(service.resolveAnalysisJobBilling(tx as never, {
      userId: "user-a",
      requestId: "job-c",
      estimatedReservationMicroUsd: 50_000n,
      spendableWalletMicroUsd: 10_000n,
    })).rejects.toBeInstanceOf(ProQuotaInsufficientWalletException);
  });

  it("shows the Upgrade menu only after a successful top-up history exists", async () => {
    const service = new ProEntitlementService();
    const policy = await service.featurePolicy(txMock({ paidTopup: true, walletBalance: 35_000_000_000n }) as never, "user-a");

    expect(policy.showUpgradeMenu).toBe(true);
    expect(policy.wallet.spendableUsd).toBe("35000.000000");
    expect(policy.nextBillingSource).toBe("wallet_standard");
  });

  it("grants the shared Summary and Landscape weekly premium trial by unique source", async () => {
    const service = new ProEntitlementService();
    const tx = txMock({ weeklyTrialSources: ["source-a"] });

    const decision = await service.resolveAnalysisJobBilling(tx as never, {
      userId: "user-a",
      requestId: "trial-landscape",
      contentMode: "landscape_blur",
      sourceId: "source-b",
      estimatedReservationMicroUsd: 50_000n,
      spendableWalletMicroUsd: 0n,
    });

    expect(decision.source).toBe(BillingSource.FREE_PREMIUM_TRIAL);
    expect(decision.premiumTrialSourceKey).toBe("source-b");
  });

  it("does not consume a new weekly trial slot for a repeated source", async () => {
    const service = new ProEntitlementService();
    const tx = txMock({ weeklyTrialSources: ["source-a", "source-b"] });

    const decision = await service.resolveAnalysisJobBilling(tx as never, {
      userId: "user-a",
      requestId: "trial-summary-repeat",
      contentMode: "summary",
      sourceId: "source-a",
      estimatedReservationMicroUsd: 50_000n,
      spendableWalletMicroUsd: 0n,
    });

    expect(decision.source).toBe(BillingSource.FREE_PREMIUM_TRIAL);
    expect(decision.snapshot.sameSourceAlreadyClaimed).toBe(true);
  });
});

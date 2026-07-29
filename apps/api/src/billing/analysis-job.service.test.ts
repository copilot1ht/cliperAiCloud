import { afterEach, describe, expect, it } from "vitest";
import type { CliperInternalChatResponse } from "@cliper/contracts";
import { AdminStoreService } from "../admin/admin-store.service.js";
import { AnalysisJobService } from "./analysis-job.service.js";
import { CreditAccountService } from "./credit-account.service.js";
import { PricingService } from "./pricing.service.js";

const originalBalance = process.env.CLIPER_DEV_CREDIT_BALANCE_MICRO;

afterEach(() => {
  if (originalBalance === undefined) delete process.env.CLIPER_DEV_CREDIT_BALANCE_MICRO;
  else process.env.CLIPER_DEV_CREDIT_BALANCE_MICRO = originalBalance;
});

function setup(balanceCredits = 5_000) {
  process.env.CLIPER_DEV_CREDIT_BALANCE_MICRO = String(balanceCredits * 1_000_000);
  const credits = new CreditAccountService();
  const pricing = new PricingService(new AdminStoreService());
  return { credits, pricing, jobs: new AnalysisJobService(pricing, credits) };
}

function providerResponse(costUsd: number): CliperInternalChatResponse {
  return {
    id: "provider-request-1",
    object: "chat.completion",
    created: 1,
    model: "deepseek-chat",
    provider: "deepseek",
    choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    billing: {
      provider_cost_usd: costUsd,
      service_cost_usd: costUsd,
      billed_cost_usd: costUsd * 2,
      gross_profit_usd: costUsd,
      credit_charge_micro: 1,
      markup_bps: 10_000,
      markup_percent: 100,
    },
  };
}

describe("AnalysisJobService", () => {
  it("reserves once, accumulates provider usage, settles once, and releases the remainder", async () => {
    const { jobs, credits } = setup();
    const started = await jobs.start("account-a", { requestId: "video-a", requestedClipCount: 5 });
    const duplicate = await jobs.start("account-a", { requestId: "video-a", requestedClipCount: 5 });
    expect(duplicate.id).toBe(started.id);
    expect(credits.balance("account-a")).toMatchObject({ reservedMicro: 2_000_000_000, availableMicro: 3_000_000_000 });

    await jobs.recordProviderUsage(started.id, "account-a", providerResponse(0.01), "highlight");
    const completed = await jobs.complete("account-a", { jobId: started.id, clipScores: [72, 82, 93], usableResult: true });
    expect(completed.status).toBe("completed");
    expect(completed.finalChargeCredits).toBeGreaterThanOrEqual(600);
    expect(completed.finalChargeCredits).toBeLessThanOrEqual(2_000);
    expect(completed.releasedCredits).toBe(2_000 - completed.finalChargeCredits);
    expect(credits.balance("account-a").reservedMicro).toBe(0);

    const completedAgain = await jobs.complete("account-a", { jobId: started.id, clipScores: [100] });
    expect(completedAgain.finalChargeCredits).toBe(completed.finalChargeCredits);
    expect(credits.transactions("account-a").filter((item) => item.type === "settle")).toHaveLength(1);
  });

  it("releases the full reservation when analysis fails", async () => {
    const { jobs, credits } = setup();
    const started = await jobs.start("account-b", { requestId: "video-b" });
    await jobs.fail("account-b", started.id, "provider unavailable");
    expect(credits.balance("account-b")).toMatchObject({ balanceMicro: 5_000_000_000, reservedMicro: 0 });
  });

  it("blocks a job before provider use when the wallet cannot cover the maximum reservation", async () => {
    const { jobs } = setup(1_500);
    await expect(jobs.start("account-c", { requestId: "video-c" })).rejects.toThrow(/tidak mencukupi/i);
  });

  it("reports wallet readiness using credits rather than raw microcredits", async () => {
    const { jobs } = setup(5_000);
    await expect(jobs.walletSummary("account-d")).resolves.toMatchObject({
      availableCredits: 5_000,
      estimatedMaxJobCredits: 2_000,
      canStartJob: true,
      balanceStatus: "low",
    });
  });

  it("accepts the all-qualified contract and settles every normal result score", async () => {
    const { jobs } = setup();
    const started = await jobs.start("account-all", { requestId: "video-all", requestedClipCount: 0 });
    const scores = Array.from({ length: 27 }, (_, index) => 70 + (index % 20));
    const completed = await jobs.complete("account-all", { jobId: started.id, clipScores: scores, usableResult: true });

    expect(completed.status).toBe("completed");
    expect(completed.acceptedClipCount + completed.rejectedClipCount).toBe(scores.length);
  });
});

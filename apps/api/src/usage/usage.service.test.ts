import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliperInternalChatResponse } from "@cliper/contracts";
import { UsageService } from "./usage.service.js";

const originalStorage = process.env.ANALYSIS_BILLING_STORAGE;
const originalRate = process.env.PLATFORM_USD_TO_IDR;

afterEach(() => {
  if (originalStorage === undefined) delete process.env.ANALYSIS_BILLING_STORAGE;
  else process.env.ANALYSIS_BILLING_STORAGE = originalStorage;
  if (originalRate === undefined) delete process.env.PLATFORM_USD_TO_IDR;
  else process.env.PLATFORM_USD_TO_IDR = originalRate;
});

function providerResponse(): CliperInternalChatResponse {
  return {
    id: "provider-request-usage-1",
    object: "chat.completion",
    created: 1,
    model: "deepseek-chat",
    provider: "deepseek",
    choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 1_000,
      cached_input_tokens: 400,
      completion_tokens: 200,
      reasoning_tokens: 50,
      total_tokens: 1_200,
      usage_source: "provider",
    },
    billing: {
      provider_cost_usd: 0.00125,
      service_cost_usd: 0.0015,
      billed_cost_usd: 0.003,
      gross_profit_usd: 0.0015,
      credit_charge_micro: 3_000,
      markup_bps: 10_000,
      markup_percent: 100,
    },
    routing: { retry_count: 1, fallback_count: 1 },
  };
}

describe("UsageService", () => {
  it("summarizes memory usage without double-counting cached or reasoning detail", async () => {
    process.env.ANALYSIS_BILLING_STORAGE = "memory";
    const usage = new UsageService();

    await usage.record(providerResponse(), "highlight", 125, "member-a");
    const summary = await usage.summary("member-a");

    expect(summary).toMatchObject({
      storage: "memory",
      requests: 1,
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 200,
      reasoningTokens: 50,
      providerCostUsd: 0.00125,
    });
  });

  it("records unlimited owner usage as real internal cost without fake revenue", async () => {
    process.env.ANALYSIS_BILLING_STORAGE = "memory";
    const usage = new UsageService();

    await usage.record(providerResponse(), "test", 80, "owner-unlimited", {
      waiveCustomerBilling: true,
    });
    const summary = await usage.summary("owner-unlimited");

    expect(summary).toMatchObject({
      requests: 1,
      providerCostUsd: 0.00125,
      serviceCostUsd: 0.0015,
      billedCostUsd: 0,
      grossMarginUsd: -0.0015,
      creditChargeMicro: 0,
    });
  });

  it("persists provider usage and job cost atomically and idempotently", async () => {
    process.env.ANALYSIS_BILLING_STORAGE = "postgres";
    process.env.PLATFORM_USD_TO_IDR = "16000";
    const createMany = vi.fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const updateJob = vi.fn().mockResolvedValue({});
    const transactionClient = {
      apiKey: {
        findUnique: vi.fn().mockResolvedValue({ id: "api-key-1", userId: "member-a" }),
      },
      aiProvider: {
        findUnique: vi.fn().mockResolvedValue({ id: "provider-1" }),
      },
      $queryRaw: vi.fn().mockResolvedValue([]),
      analysisJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: "job-1",
          apiKeyId: "api-key-1",
          providerCostMicroUsd: 0n,
          modules: {},
        }),
        update: updateJob,
      },
      aiUsage: { createMany },
    };
    const client = {
      $transaction: vi.fn(async (callback: (tx: typeof transactionClient) => Promise<boolean>) => callback(transactionClient)),
    };
    const database = {
      configured: () => true,
      client: () => client,
    };
    const usage = new UsageService(database as never);
    const options = {
      jobId: "job-1",
      apiKeyId: "api-key-1",
      deferCustomerBilling: true,
    };

    const first = await usage.record(providerResponse(), "highlight", 125, "member-a", options);
    const duplicate = await usage.record(providerResponse(), "highlight", 125, "member-a", options);

    expect(first).toEqual({ persisted: true, jobCostAggregated: true });
    expect(duplicate).toEqual({ persisted: false, jobCostAggregated: false });
    expect(createMany).toHaveBeenCalledTimes(2);
    expect(createMany.mock.calls[0]?.[0].data[0]).toMatchObject({
      requestId: "provider-request-usage-1",
      analysisJobId: "job-1",
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 200,
      reasoningTokens: 50,
      totalTokens: 1_200,
      retryCount: 1,
      fallbackCount: 1,
      usageSource: "provider",
      providerCostIdr: 20,
      billedCostMicro: 0n,
      creditChargeMicro: 0n,
    });
    expect(updateJob).toHaveBeenCalledTimes(1);
    expect(updateJob).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "job-1" },
      data: expect.objectContaining({
        providerCostMicroUsd: 1_250n,
        providerCostIdr: 20,
        requestCount: { increment: 1 },
      }),
    }));
  });
});

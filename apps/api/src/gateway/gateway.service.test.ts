import { describe, expect, it, vi } from "vitest";
import type { CliperInternalChatResponse } from "@cliper/contracts";
import { GatewayService } from "./gateway.service.js";

describe("GatewayService billing boundary", () => {
  it("does not call a provider when the atomic wallet reservation is rejected", async () => {
    const route = vi.fn();
    const usage = { record: vi.fn() };
    const store = { revision: () => 1, refreshIfStale: vi.fn() };
    const pricing = {
      estimateRequest: () => ({ creditChargeMicro: 50_000n }),
      moduleForRequest: () => "highlight",
      priceResponse: vi.fn(),
    };
    const credits = {
      reserve: vi.fn().mockRejectedValue(new Error("INSUFFICIENT_BALANCE")),
      settle: vi.fn(),
      release: vi.fn(),
    };
    const rateLimits = { assertAllowed: vi.fn(), withAiConcurrency: vi.fn((_account, _key, _plan, work) => work()) };
    const jobs = { assertProviderCallAllowed: vi.fn(), recordProviderUsage: vi.fn() };
    const service = new GatewayService(usage as never, store as never, pricing as never, credits as never, rateLimits as never, jobs as never);
    (service as unknown as { router: { route: typeof route }; routerRevision: number }).router = { route };
    (service as unknown as { routerRevision: number }).routerRevision = 1;

    await expect(service.chat({ module: "highlight", messages: [{ role: "user", content: "Find a clip" }] }, "empty-wallet")).rejects.toThrow("INSUFFICIENT_BALANCE");
    expect(route).not.toHaveBeenCalled();
    expect(usage.record).not.toHaveBeenCalled();
    expect(credits.settle).not.toHaveBeenCalled();
  });

  it("returns only Cliper credit usage and keeps internal economics server-side", async () => {
    const internal: CliperInternalChatResponse = {
      id: "request-safe", object: "chat.completion", created: 1, model: "model-a", provider: "provider-a",
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      billing: { provider_cost_usd: 0.1, service_cost_usd: 0.11, billed_cost_usd: 0.165, gross_profit_usd: 0.055, credit_charge_micro: 1650, markup_bps: 5000, markup_percent: 50 },
    };
    const usage = { record: vi.fn().mockResolvedValue({ persisted: true, jobCostAggregated: false }) };
    const store = { revision: () => 1, refreshIfStale: vi.fn() };
    const pricing = { estimateRequest: () => ({ creditChargeMicro: 2000n }), moduleForRequest: () => "test", priceResponse: () => internal };
    const credits = { reserve: () => ({ id: "reservation-a", amountMicro: 2000 }), increaseReservation: vi.fn(), settle: vi.fn(), release: vi.fn() };
    const rateLimits = { assertAllowed: vi.fn(), withAiConcurrency: vi.fn((_account, _key, _plan, work) => work()) };
    const jobs = { assertProviderCallAllowed: vi.fn(), recordProviderUsage: vi.fn() };
    const service = new GatewayService(usage as never, store as never, pricing as never, credits as never, rateLimits as never, jobs as never);
    (service as unknown as { router: { route: () => Promise<CliperInternalChatResponse> }; routerRevision: number }).router = { route: async () => internal };
    (service as unknown as { routerRevision: number }).routerRevision = 1;
    const response = await service.chat({ module: "test", messages: [{ role: "user", content: "OK" }] }, "member-a");
    expect(response.billing).toEqual({ credit_charge_micro: 1650 });
    expect(response.billing).not.toHaveProperty("provider_cost_usd");
    expect(response).toMatchObject({ provider: "cliper-cloud", model: "auto" });
    expect(usage.record).toHaveBeenCalledWith(internal, "test", expect.any(Number), "member-a", { apiKeyId: undefined });
    expect(rateLimits.assertAllowed).toHaveBeenCalledWith("member-a", "wallet");
  });

  it("forces wallet billing metadata for pricing and routing", async () => {
    const internal: CliperInternalChatResponse = {
      id: "request-plan", object: "chat.completion", created: 1, model: "language-model", provider: "openai",
      choices: [{ index: 0, message: { role: "assistant", content: "Judul" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
      billing: { provider_cost_usd: 0.001, service_cost_usd: 0.001, billed_cost_usd: 0.002, gross_profit_usd: 0.001, credit_charge_micro: 20, markup_bps: 10_000, markup_percent: 100 },
    };
    const route = vi.fn().mockResolvedValue(internal);
    const estimateRequest = vi.fn().mockReturnValue({ creditChargeMicro: 100n });
    const moduleForRequest = vi.fn().mockReturnValue("title");
    const usage = { record: vi.fn().mockResolvedValue({ persisted: true, jobCostAggregated: false }) };
    const store = { revision: () => 1, refreshIfStale: vi.fn() };
    const pricing = { estimateRequest, moduleForRequest, priceResponse: () => internal };
    const credits = {
      reserve: vi.fn().mockResolvedValue({ id: "reservation-plan", amountMicro: 100, unlimited: true }),
      settle: vi.fn(), release: vi.fn(),
    };
    const rateLimits = { assertAllowed: vi.fn(), withAiConcurrency: vi.fn((_account, _key, _plan, work) => work()) };
    const jobs = { assertProviderCallAllowed: vi.fn(), recordProviderUsage: vi.fn() };
    const service = new GatewayService(usage as never, store as never, pricing as never, credits as never, rateLimits as never, jobs as never);
    (service as unknown as { router: { route: typeof route }; routerRevision: number }).router = { route };
    (service as unknown as { routerRevision: number }).routerRevision = 1;

    await service.chat({
      module: "title",
      metadata: { plan: "starter", requestId: "desktop-request" },
      messages: [{ role: "user", content: "Buat judul" }],
    }, "member-wallet", "wallet", "key-1");

    expect(route).toHaveBeenCalledWith(expect.objectContaining({
      module: "title",
      metadata: expect.objectContaining({ plan: "wallet", billingMode: "wallet", requestId: "desktop-request" }),
    }));
    expect(estimateRequest).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ plan: "wallet", billingMode: "wallet" }) }));
    expect(moduleForRequest).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ plan: "wallet", billingMode: "wallet" }) }));
  });

  it("defers customer billing when a signed analysis job owns the reservation", async () => {
    const internal: CliperInternalChatResponse = {
      id: "request-job", object: "chat.completion", created: 1, model: "model-a", provider: "provider-a",
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      billing: { provider_cost_usd: 0.01, service_cost_usd: 0.02, billed_cost_usd: 0.04, gross_profit_usd: 0.02, credit_charge_micro: 40_000, markup_bps: 10_000, markup_percent: 100 },
    };
    const usage = { record: vi.fn().mockResolvedValue({ persisted: true, jobCostAggregated: false }) };
    const store = { revision: () => 1, refreshIfStale: vi.fn() };
    const pricing = {
      estimateRequest: () => ({ creditChargeMicro: 2_000n, providerCostMicroUsd: 500n }),
      moduleForRequest: () => "highlight",
      priceResponse: () => internal,
    };
    const credits = { reserve: vi.fn() };
    const rateLimits = { assertAllowed: vi.fn(), withAiConcurrency: vi.fn((_account, _key, _plan, work) => work()) };
    const jobs = { assertProviderCallAllowed: vi.fn(), recordProviderUsage: vi.fn() };
    const service = new GatewayService(usage as never, store as never, pricing as never, credits as never, rateLimits as never, jobs as never);
    (service as unknown as { router: { route: () => Promise<CliperInternalChatResponse> }; routerRevision: number }).router = { route: async () => internal };
    (service as unknown as { routerRevision: number }).routerRevision = 1;

    const response = await service.chat({
      module: "highlight",
      metadata: { jobId: "job-1" },
      messages: [{ role: "user", content: "OK" }],
    }, "member-a");

    expect(response.billing.credit_charge_micro).toBe(0);
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(jobs.assertProviderCallAllowed).toHaveBeenCalledWith("job-1", "member-a", expect.any(Object), 0.0005);
    expect(jobs.recordProviderUsage).toHaveBeenCalledWith("job-1", "member-a", internal, "highlight");
    expect(usage.record).toHaveBeenCalledWith(internal, "highlight", expect.any(Number), "member-a", {
      jobId: "job-1",
      apiKeyId: undefined,
      deferCustomerBilling: true,
    });
  });
});

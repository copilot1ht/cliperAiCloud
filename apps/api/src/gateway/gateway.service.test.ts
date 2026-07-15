import { describe, expect, it, vi } from "vitest";
import type { CliperInternalChatResponse } from "@cliper/contracts";
import { GatewayService } from "./gateway.service.js";

describe("GatewayService billing boundary", () => {
  it("returns only Cliper credit usage and keeps internal economics server-side", async () => {
    const internal: CliperInternalChatResponse = {
      id: "request-safe", object: "chat.completion", created: 1, model: "model-a", provider: "provider-a",
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      billing: { provider_cost_usd: 0.1, service_cost_usd: 0.11, billed_cost_usd: 0.165, gross_profit_usd: 0.055, credit_charge_micro: 1650, markup_bps: 5000, markup_percent: 50 },
    };
    const usage = { record: vi.fn() };
    const store = { revision: () => 1 };
    const pricing = { estimateRequest: () => ({ creditChargeMicro: 2000n }), moduleForRequest: () => "test", priceResponse: () => internal };
    const credits = { reserve: () => ({ id: "reservation-a", amountMicro: 2000 }), increaseReservation: vi.fn(), settle: vi.fn(), release: vi.fn() };
    const rateLimits = { assertAllowed: vi.fn() };
    const service = new GatewayService(usage as never, store as never, pricing as never, credits as never, rateLimits as never);
    (service as unknown as { router: { route: () => Promise<CliperInternalChatResponse> }; routerRevision: number }).router = { route: async () => internal };
    (service as unknown as { routerRevision: number }).routerRevision = 1;
    const response = await service.chat({ module: "test", messages: [{ role: "user", content: "OK" }] }, "member-a");
    expect(response.billing).toEqual({ credit_charge_micro: 1650 });
    expect(response.billing).not.toHaveProperty("provider_cost_usd");
    expect(response).toMatchObject({ provider: "cliper-cloud", model: "auto" });
    expect(usage.record).toHaveBeenCalledWith(internal, "test", expect.any(Number), "member-a");
    expect(rateLimits.assertAllowed).toHaveBeenCalledWith("member-a", "starter");
  });
});

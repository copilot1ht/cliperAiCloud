import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayController } from "./gateway.controller.js";

const originalPlan = process.env.CLIPER_DEV_PLAN;

afterEach(() => {
  if (originalPlan === undefined) delete process.env.CLIPER_DEV_PLAN;
  else process.env.CLIPER_DEV_PLAN = originalPlan;
});

describe("GatewayController plan enforcement", () => {
  it("replaces a client supplied plan with the server-side plan", async () => {
    process.env.CLIPER_DEV_PLAN = "starter";
    const chat = vi.fn().mockResolvedValue({ ok: true });
    const controller = new GatewayController({ chat, providers: vi.fn() } as never, { signResponse: vi.fn() } as never);
    await controller.chat(
      { module: "highlight", metadata: { plan: "enterprise" }, messages: [{ role: "user", content: "rank" }] },
      { cliperAuth: { accountId: "account-a", apiKeyId: "key-a", plan: "starter", mode: "legacy-key" } } as never,
      { setHeader: vi.fn() } as never,
    );
    expect(chat.mock.calls[0]?.[0].metadata.plan).toBe("starter");
    expect(chat.mock.calls[0]?.[2]).toBe("starter");
  });
});

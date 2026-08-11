import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdminStoreService } from "./admin-store.service.js";

const original = {
  GEMINI_API_KEYS: process.env.GEMINI_API_KEYS,
  DEEPSEEK_API_KEYS: process.env.DEEPSEEK_API_KEYS,
};

beforeEach(() => {
  process.env.GEMINI_API_KEYS = "gemini-secret-test";
  process.env.DEEPSEEK_API_KEYS = "deepseek-secret-test";
});

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("AdminStoreService", () => {
  it("never exposes raw provider keys in admin responses", () => {
    const store = new AdminStoreService();
    const provider = store.listProviders()[0]!;
    expect(provider.keyCount).toBeGreaterThan(0);
    expect(JSON.stringify(provider)).not.toContain("gemini-secret-test");
    expect(provider).not.toHaveProperty("apiKeys");
  });

  it("keeps the control plane available when a stored provider envelope is invalid", () => {
    const store = new AdminStoreService();
    const decryptKeys = (
      store as unknown as { decryptKeys: (keys: string[]) => string[] }
    ).decryptKeys.bind(store);

    expect(decryptKeys(["not-an-authenticated-envelope"])).toEqual([]);
  });

  it("applies provider and route changes to router snapshots", () => {
    const store = new AdminStoreService();
    const provider = store.saveDetectedProvider({ provider: "openai", apiKey: "custom-secret" }, {
      provider: "openai",
      displayName: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      protocol: "openai-chat",
      models: ["gpt-5-mini", "gpt-4.1-mini"],
      defaultModel: "gpt-5-mini",
      latencyMs: 320,
      health: "healthy",
      checkedAt: new Date().toISOString(),
      modelSource: "api",
    });
    expect(store.providersForRouter().find((item) => item.code === "openai")?.apiKeys).toEqual(["custom-secret"]);
    const rule = store.listRoutes().find((item) => item.plan === "pro" && item.module === "title")!;
    store.updateRoute(rule.id, { primary: "openai", fallback: "gemini" });
    expect(store.planRoutes().pro?.title).toEqual(["openai", "gemini"]);
    store.updateRoute(rule.id, { primary: rule.primary, fallback: rule.fallback });
    store.deleteProvider(provider.id);
    expect(store.listProviders().some((item) => item.code === "openai")).toBe(false);
  });

  it("uses OpenAI as the Pro/Enterprise reviewer while keeping DeepSeek for initial ranking", () => {
    const store = new AdminStoreService();
    store.saveDetectedProvider({ provider: "openai", apiKey: "reviewer-secret" }, {
      provider: "openai",
      displayName: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      protocol: "openai-chat",
      models: ["gpt-5-mini"],
      defaultModel: "gpt-5-mini",
      latencyMs: 210,
      health: "healthy",
      checkedAt: new Date().toISOString(),
      modelSource: "api",
    });

    store.repairRoutesForProviders();

    expect(store.planRoutes().enterprise?.highlight?.[0]).toBe("deepseek");
    expect(store.planRoutes().enterprise?.ranking?.[0]).toBe("openai");
    expect(store.planRoutes().pro?.ranking?.[0]).toBe("openai");
    expect(store.planRoutes().starter?.ranking?.[0]).toBe("deepseek");
  });

  it("appends validated keys and only accepts detected default models", () => {
    const store = new AdminStoreService();
    const connection = {
      provider: "openai" as const,
      displayName: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      protocol: "openai-chat" as const,
      models: ["gpt-5-mini", "gpt-4.1-mini"],
      defaultModel: "gpt-5-mini",
      latencyMs: 250,
      health: "healthy" as const,
      checkedAt: new Date().toISOString(),
      modelSource: "api" as const,
    };
    const first = store.saveDetectedProvider({ provider: "openai", apiKey: "first-secret-key" }, connection);
    const second = store.saveDetectedProvider({ provider: "openai", apiKey: "second-secret-key" }, connection);
    expect(second.id).toBe(first.id);
    expect(second.keyCount).toBe(2);
    expect(() => store.updateProvider(first.id, { defaultModel: "not-detected" })).toThrow("Model default tidak tersedia");
    expect(store.updateProvider(first.id, { defaultModel: "gpt-4.1-mini" }).model).toBe("gpt-4.1-mini");
  });

  it("calculates revenue only from paid records and subtracts refunds", () => {
    const store = new AdminStoreService();
    store.createPayment({ customerEmail: "paid@test.local", amountIdr: 100_000, status: "paid" });
    store.createPayment({ customerEmail: "pending@test.local", amountIdr: 40_000, status: "pending" });
    store.createPayment({ customerEmail: "refund@test.local", amountIdr: 25_000, status: "refunded" });
    expect(store.revenue()).toMatchObject({ grossIdr: 100_000, refundedIdr: 25_000, netIdr: 75_000, paidCount: 1, pendingCount: 1 });
  });

  it("stores markup as a target over service cost, not as a claimed margin rate", () => {
    const store = new AdminStoreService();
    const policy = store.updatePricingPolicy({ markupBps: 5000, microUsdPerCredit: 100 });
    expect(policy.markupBps).toBe(5000);
    expect(policy.microUsdPerCredit).toBe(100);
    expect(policy.minimumMarginBps).toBe(5000);
    expect(policy.minimumClipChargeMicroUsd).toBe(5000);
    expect(policy.usdToIdr).toBe(16000);
  });

  it("does not allow the business margin floor below 50 percent", () => {
    const store = new AdminStoreService();
    expect(() => store.updatePricingPolicy({ minimumMarginBps: 4_999 })).toThrow("Pricing basis points");
  });

  it("skips a database reload when this replica already has the shared config revision", async () => {
    const database = { configured: () => true };
    const redis = { get: async () => "shared-revision" };
    const store = new AdminStoreService(database as never, redis as never);
    const internal = store as unknown as { distributedRevision?: string; lastConfigCheckAt: number };
    internal.distributedRevision = "shared-revision";
    internal.lastConfigCheckAt = 0;

    await expect(store.refreshIfStale()).resolves.toBeUndefined();
  });
});

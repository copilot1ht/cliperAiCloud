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

  it("applies provider and route changes to router snapshots", () => {
    const store = new AdminStoreService();
    const provider = store.createProvider({
      code: "custom",
      displayName: "Custom AI",
      baseUrl: "https://example.test/v1",
      model: "custom-model",
      apiKeys: "custom-secret",
    });
    expect(store.providersForRouter().find((item) => item.code === "custom")?.apiKeys).toEqual(["custom-secret"]);
    const rule = store.listRoutes().find((item) => item.plan === "pro" && item.module === "title")!;
    store.updateRoute(rule.id, { primary: "custom", fallback: "gemini" });
    expect(store.planRoutes().pro?.title).toEqual(["custom", "gemini"]);
    store.updateRoute(rule.id, { primary: rule.primary, fallback: rule.fallback });
    store.deleteProvider(provider.id);
    expect(store.listProviders().some((item) => item.code === "custom")).toBe(false);
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
  });
});

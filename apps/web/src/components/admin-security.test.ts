import { describe, expect, it } from "vitest";
import { normalizeSecurityPayload } from "../lib/admin-security-payload";

describe("normalizeSecurityPayload", () => {
  it("separates nested rate-limit controls from numeric request limits", () => {
    const payload = normalizeSecurityPayload({
      mode: "postgresql",
      sessions: { total: 6, active: 4, staleHeartbeat: 1 },
      eventSummary: { total: 3, warnings: 1, critical: 1, replayBlocked: 1 },
      events: [],
      policy: {
        accessTokenMinutes: 240,
        refreshTokenDays: 30,
        offlineGraceHours: 72,
        replayWindowSeconds: 60,
        hmac: "HMAC-SHA256",
        providerEncryption: "AES-256-GCM",
        legacyApiKeyAuth: false,
        rateLimitsPerMinute: {
          wallet: 60,
          free: 30,
          starter: 60,
          pro: 120,
          enterprise: 300,
          aiConcurrency: { wallet: 2, free: 1, pro: 8 },
          provider: { requestsPerSecond: 10, concurrency: 12 },
          passwordRecovery: {
            adminResetPerHour: 5,
            passwordChangePer15Minutes: 5,
          },
          distributed: true,
        },
      },
    });

    expect(payload.policy.rateLimitsPerMinute).toEqual({
      wallet: 60,
      free: 30,
      starter: 60,
      pro: 120,
      enterprise: 300,
    });
    expect(payload.policy.aiConcurrency).toEqual({ wallet: 2, free: 1, pro: 8 });
    expect(payload.policy.provider).toEqual({ requestsPerSecond: 10, concurrency: 12 });
    expect(payload.policy.distributed).toBe(true);
    expect(Object.values(payload.policy.rateLimitsPerMinute).every((item) => typeof item === "number")).toBe(true);
  });

  it("keeps the page renderable while an older API payload is deployed", () => {
    const payload = normalizeSecurityPayload({ mode: "postgresql" });

    expect(payload.sessions).toEqual({ total: 0, active: 0, staleHeartbeat: 0 });
    expect(payload.events).toEqual([]);
    expect(payload.policy.rateLimitsPerMinute).toEqual({});
    expect(payload.policy.providerEncryption).toBe("Not reported");
  });
});

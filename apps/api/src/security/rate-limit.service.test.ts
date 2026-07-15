import { describe, expect, it } from "vitest";
import { RateLimitService } from "./rate-limit.service.js";

describe("RateLimitService", () => {
  it("enforces the Starter plan at five requests per rolling minute", () => {
    const service = new RateLimitService();
    for (let index = 0; index < 5; index += 1) service.assertAllowed("starter-account", "starter");
    expect(() => service.assertAllowed("starter-account", "starter")).toThrow(/rate limit/i);
  });

  it("uses separate windows for different accounts", () => {
    const service = new RateLimitService();
    for (let index = 0; index < 5; index += 1) service.assertAllowed("account-a", "starter");
    expect(service.assertAllowed("account-b", "starter").remaining).toBe(4);
  });
});

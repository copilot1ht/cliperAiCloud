import { afterEach, describe, expect, it } from "vitest";
import { RateLimitService } from "./rate-limit.service.js";

const previousNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});

function memoryRateLimiter() {
  process.env.NODE_ENV = "test";
  const redis = {
    configured: () => false,
    eval: async () => undefined,
  };
  return new RateLimitService(redis as never);
}

describe("RateLimitService", () => {
  it("enforces the Starter plan at five requests per rolling minute", async () => {
    const service = memoryRateLimiter();
    for (let index = 0; index < 5; index += 1) await service.assertAllowed("starter-account", "starter");
    await expect(service.assertAllowed("starter-account", "starter")).rejects.toThrow(/terlalu banyak request/i);
  });

  it("uses separate windows for different accounts", async () => {
    const service = memoryRateLimiter();
    for (let index = 0; index < 5; index += 1) await service.assertAllowed("account-a", "starter");
    await expect(service.assertAllowed("account-b", "starter")).resolves.toMatchObject({ remaining: 4 });
  });

  it("limits concurrent AI work while releasing the lease when it completes", async () => {
    const service = memoryRateLimiter();
    const first = service.withAiConcurrency("account-a", "key-a", "free", async () => "complete");
    await expect(first).resolves.toBe("complete");
    await expect(service.withAiConcurrency("account-a", "key-a", "free", async () => "again")).resolves.toBe("again");
  });
});

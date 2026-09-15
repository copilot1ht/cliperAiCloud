import { afterEach, describe, expect, it } from "vitest";
import { RateLimitService } from "./rate-limit.service.js";

const previousNodeEnv = process.env.NODE_ENV;
const previousAiConcurrencyTtl = process.env.AI_CONCURRENCY_TTL_MS;
const previousAiConcurrencyPro = process.env.AI_CONCURRENCY_PRO;

afterEach(() => {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousAiConcurrencyTtl === undefined) delete process.env.AI_CONCURRENCY_TTL_MS;
  else process.env.AI_CONCURRENCY_TTL_MS = previousAiConcurrencyTtl;
  if (previousAiConcurrencyPro === undefined) delete process.env.AI_CONCURRENCY_PRO;
  else process.env.AI_CONCURRENCY_PRO = previousAiConcurrencyPro;
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

  it("blocks a second active wallet or pro AI job by default", async () => {
    const service = memoryRateLimiter();
    let releaseFirst: (() => void) | undefined;
    const first = service.withAiConcurrency("account-a", "key-a", "pro", () => new Promise<string>((resolve) => {
      releaseFirst = () => resolve("first");
    }));

    await expect(service.withAiConcurrency("account-a", "key-a", "pro", async () => "second")).rejects.toMatchObject({
      response: expect.objectContaining({ code: "BLOCKED_BUSY" }),
    });
    releaseFirst?.();
    await expect(first).resolves.toBe("first");
  });

  it("expires stale memory leases when Redis is not used outside production", async () => {
    process.env.AI_CONCURRENCY_TTL_MS = "15000";
    process.env.AI_CONCURRENCY_PRO = "1";
    const service = memoryRateLimiter();
    let now = 1_000;
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      let releaseFirst: (() => void) | undefined;
      const first = service.withAiConcurrency("account-a", "key-a", "pro", () => new Promise<string>((resolve) => {
        releaseFirst = () => resolve("first");
      }));
      await expect(service.withAiConcurrency("account-a", "key-a", "pro", async () => "blocked")).rejects.toMatchObject({
        response: expect.objectContaining({ code: "BLOCKED_BUSY" }),
      });
      now += 16_000;
      await expect(service.withAiConcurrency("account-a", "key-a", "pro", async () => "after-ttl")).resolves.toBe("after-ttl");
      releaseFirst?.();
      await expect(first).resolves.toBe("first");
    } finally {
      Date.now = originalNow;
    }
  });

  it("caps provider work independently from per-account AI leases", async () => {
    const service = memoryRateLimiter();
    const original = process.env.AI_PROVIDER_CONCURRENCY;
    process.env.AI_PROVIDER_CONCURRENCY = "1";
    let releaseFirst: (() => void) | undefined;
    const first = service.withProviderCapacity("gemini", () => new Promise<string>((resolve) => {
      releaseFirst = () => resolve("first");
    }));
    await expect(service.withProviderCapacity("gemini", async () => "second")).rejects.toMatchObject({
      response: expect.objectContaining({ code: "PROVIDER_CONCURRENCY_LIMIT" }),
    });
    releaseFirst?.();
    await expect(first).resolves.toBe("first");
    if (original === undefined) delete process.env.AI_PROVIDER_CONCURRENCY;
    else process.env.AI_PROVIDER_CONCURRENCY = original;
  });
});

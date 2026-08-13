import { afterEach, describe, expect, it } from "vitest";
import { LicenseService } from "./license.service.js";

const originalKey = process.env.CLIPER_DEV_API_KEY;

afterEach(() => {
  if (originalKey === undefined) delete process.env.CLIPER_DEV_API_KEY;
  else process.env.CLIPER_DEV_API_KEY = originalKey;
});

describe("LicenseService development verification", () => {
  it("accepts a configured clip_sk key and returns wallet/device state", async () => {
    const key = `clip_sk_${"a".repeat(32)}`;
    process.env.CLIPER_DEV_API_KEY = key;
    const result = await new LicenseService().validate({ key, deviceFingerprint: "device-a" });
    expect(result.valid).toBe(true);
    expect(result.status).toBe("active");
    expect(result.wallet?.spendableMicroUsd).toBeGreaterThan(0);
  });

  it("rejects malformed keys before secret comparison", async () => {
    process.env.CLIPER_DEV_API_KEY = `clip_sk_${"a".repeat(32)}`;
    const result = await new LicenseService().validate({ key: "sk-provider-secret", deviceFingerprint: "device-a" });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Format");
  });

  it("isolates generated keys by owner and exposes an account context to the gateway", async () => {
    const service = new LicenseService();
    const first = await service.createKey({ ownerId: "member-a", plan: "pro", label: "Desktop A" });
    await service.createKey({ ownerId: "member-b", plan: "starter", label: "Desktop B" });
    expect(await service.listKeys("member-a")).toHaveLength(1);
    expect((await service.listKeys("member-a"))[0]?.ownerId).toBe("member-a");
    expect(await service.authenticateGatewayKey(first.rawKey)).toMatchObject({ accountId: "member-a", plan: "pro" });
    await expect(service.revokeKey(first.key.id, "member-b")).rejects.toThrow(/tidak ditemukan/i);
  });

  it("keeps the same user key connected at zero balance and marks it eligible after a top-up", async () => {
    const { CreditAccountService } = await import("../billing/credit-account.service.js");
    const wallet = new CreditAccountService();
    const service = new LicenseService(wallet);
    const generated = await service.createKey({ ownerId: "wallet-member", plan: "free" });
    wallet.initialize("wallet-member", 0);

    await expect(service.validate({ key: generated.rawKey, deviceFingerprint: "wallet-device" })).resolves.toMatchObject({
      valid: true,
      cloudConnected: true,
      keyType: "user",
      billingEligible: false,
      wallet: { availableUsd: 0, spendableUsd: 0 },
    });

    wallet.setBalance("wallet-member", 1_000_000, "verified-topup");
    await expect(service.validate({ key: generated.rawKey, deviceFingerprint: "wallet-device" })).resolves.toMatchObject({
      valid: true,
      cloudConnected: true,
      billingEligible: true,
      wallet: { availableUsd: 1, spendableUsd: 1 },
    });
  });

  it("allows a new API key for a persistent account without wallet balance", async () => {
    const database = {
      configured: () => true,
      client: () => ({
        user: {
          findUnique: async () => ({
            id: "member-empty",
            planCode: "FREE",
            deviceLimit: 1,
            unlimitedCredits: false,
          }),
        },
        apiKey: {
          create: async ({ data }: { data: { userId: string; name: string; prefix: string; plan: string; deviceLimit: number; expiresAt: Date } }) => ({
            id: "key-empty-wallet",
            userId: data.userId,
            name: data.name,
            prefix: data.prefix,
            plan: data.plan,
            deviceLimit: data.deviceLimit,
            createdAt: new Date("2026-08-11T00:00:00.000Z"),
          }),
        },
      }),
    };
    const service = new LicenseService(undefined, database as never);

    await expect(service.createKey({ ownerId: "member-empty" })).resolves.toMatchObject({
      key: { ownerId: "member-empty", status: "active" },
    });
  });
});

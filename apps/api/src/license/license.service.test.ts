import { afterEach, describe, expect, it } from "vitest";
import { LicenseService } from "./license.service.js";

const originalKey = process.env.CLIPER_DEV_API_KEY;

afterEach(() => {
  if (originalKey === undefined) delete process.env.CLIPER_DEV_API_KEY;
  else process.env.CLIPER_DEV_API_KEY = originalKey;
});

describe("LicenseService development verification", () => {
  it("accepts a configured clip_sk key and returns credits/device state", async () => {
    const key = `clip_sk_${"a".repeat(32)}`;
    process.env.CLIPER_DEV_API_KEY = key;
    const result = await new LicenseService().validate({ key, deviceFingerprint: "device-a" });
    expect(result.valid).toBe(true);
    expect(result.status).toBe("active");
    expect(result.credits?.remainingMicro).toBeGreaterThan(0);
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

  it("blocks a new API key for a persistent account without available credits", async () => {
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
        userCreditAccount: {
          findUnique: async () => ({ balanceMicro: 0n, reservedMicro: 0n }),
        },
      }),
    };
    const service = new LicenseService(undefined, database as never);

    await expect(service.createKey({ ownerId: "member-empty" })).rejects.toThrow(
      /Saldo wallet USD tidak mencukupi/i,
    );
  });
});

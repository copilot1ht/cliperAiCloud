import { afterEach, describe, expect, it } from "vitest";
import { LicenseService } from "./license.service.js";

const originalKey = process.env.CLIPER_DEV_API_KEY;

afterEach(() => {
  if (originalKey === undefined) delete process.env.CLIPER_DEV_API_KEY;
  else process.env.CLIPER_DEV_API_KEY = originalKey;
});

describe("LicenseService development verification", () => {
  it("accepts a configured clip_sk key and returns credits/device state", () => {
    const key = `clip_sk_${"a".repeat(32)}`;
    process.env.CLIPER_DEV_API_KEY = key;
    const result = new LicenseService().validate({ key, deviceFingerprint: "device-a" });
    expect(result.valid).toBe(true);
    expect(result.status).toBe("active");
    expect(result.credits?.remainingMicro).toBeGreaterThan(0);
  });

  it("rejects malformed keys before secret comparison", () => {
    process.env.CLIPER_DEV_API_KEY = `clip_sk_${"a".repeat(32)}`;
    const result = new LicenseService().validate({ key: "sk-provider-secret", deviceFingerprint: "device-a" });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Format");
  });

  it("isolates generated keys by owner and exposes an account context to the gateway", () => {
    const service = new LicenseService();
    const first = service.createKey({ ownerId: "member-a", plan: "pro", label: "Desktop A" });
    service.createKey({ ownerId: "member-b", plan: "starter", label: "Desktop B" });
    expect(service.listKeys("member-a")).toHaveLength(1);
    expect(service.listKeys("member-a")[0]?.ownerId).toBe("member-a");
    expect(service.authenticateGatewayKey(first.rawKey)).toMatchObject({ accountId: "member-a", plan: "pro" });
    expect(() => service.revokeKey(first.key.id, "member-b")).toThrow(/tidak ditemukan/i);
  });
});

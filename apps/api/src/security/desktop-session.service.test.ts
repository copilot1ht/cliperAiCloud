import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex, signDesktopRequest } from "@cliper/security";
import { CreditAccountService } from "../billing/credit-account.service.js";
import { LicenseService } from "../license/license.service.js";
import { DesktopSessionService } from "./desktop-session.service.js";
import { SecurityEventService } from "./security-event.service.js";

const previousBalance = process.env.CLIPER_DEV_CREDIT_BALANCE_MICRO;
afterEach(() => {
  if (previousBalance === undefined) delete process.env.CLIPER_DEV_CREDIT_BALANCE_MICRO;
  else process.env.CLIPER_DEV_CREDIT_BALANCE_MICRO = previousBalance;
});

async function setup() {
  process.env.CLIPER_DEV_CREDIT_BALANCE_MICRO = "100000000";
  const credits = new CreditAccountService();
  const licenses = new LicenseService(credits);
  const events = new SecurityEventService();
  const sessions = new DesktopSessionService(licenses, credits, events);
  const generated = await licenses.createKey({ ownerId: "desktop-owner", plan: "starter", deviceLimit: 1 });
  credits.initialize("desktop-owner", 100_000_000);
  const activation = await sessions.activate({ key: generated.rawKey, deviceFingerprint: "device-a", deviceName: "Desktop A" });
  return { sessions, events, activation };
}

function signedRequest(activation: Awaited<ReturnType<typeof setup>>["activation"], body: unknown, nonce: string) {
  const timestamp = String(Date.now());
  const contentSha256 = sha256Hex(JSON.stringify(body));
  return {
    method: "POST",
    path: "/v1/chat/completions",
    body,
    headers: {
      "x-cliper-timestamp": timestamp,
      "x-cliper-nonce": nonce,
      "x-cliper-content-sha256": contentSha256,
      "x-cliper-signature": signDesktopRequest(activation.signingSecret, { method: "POST", path: "/v1/chat/completions", timestamp, nonce, contentSha256 }),
    },
  };
}

describe("DesktopSessionService", () => {
  it("issues a four-hour desktop work lease for long-running renders", async () => {
    const { activation } = await setup();
    const leaseMs = new Date(activation.accessExpiresAt).getTime() - Date.now();
    expect(leaseMs).toBeGreaterThan(3.9 * 60 * 60 * 1000);
    expect(leaseMs).toBeLessThan(4.1 * 60 * 60 * 1000);
  });

  it("accepts one signed request and rejects replay of the same nonce", async () => {
    const { sessions, events, activation } = await setup();
    const body = { messages: [{ role: "user", content: "test" }] };
    const request = signedRequest(activation, body, "nonce-unique-value-001");
    expect(sessions.authenticateSigned(activation.accessToken, request)).toMatchObject({ accountId: "desktop-owner", plan: "starter" });
    expect(() => sessions.authenticateSigned(activation.accessToken, request)).toThrow(/pernah digunakan/i);
    expect(events.list().some((item) => item.event === "desktop_replay_blocked")).toBe(true);
  });

  it("rejects body tampering and rotates refresh credentials", async () => {
    const { sessions, activation } = await setup();
    const request = signedRequest(activation, { value: "original" }, "nonce-unique-value-002");
    expect(() => sessions.authenticateSigned(activation.accessToken, { ...request, body: { value: "tampered" } })).toThrow(/checksum/i);
    const refreshed = await sessions.refresh({ refreshToken: activation.refreshToken, deviceFingerprint: "device-a" });
    expect(refreshed.accessToken).not.toBe(activation.accessToken);
    await expect(sessions.refresh({ refreshToken: activation.refreshToken, deviceFingerprint: "device-a" })).rejects.toThrow(/tidak valid/i);
  });
});

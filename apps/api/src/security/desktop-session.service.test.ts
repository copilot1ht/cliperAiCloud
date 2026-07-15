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

function setup() {
  process.env.CLIPER_DEV_CREDIT_BALANCE_MICRO = "100000000";
  const credits = new CreditAccountService();
  const licenses = new LicenseService(credits);
  const events = new SecurityEventService();
  const sessions = new DesktopSessionService(licenses, credits, events);
  const generated = licenses.createKey({ ownerId: "desktop-owner", plan: "starter", deviceLimit: 1 });
  credits.initialize("desktop-owner", 100_000_000);
  const activation = sessions.activate({ key: generated.rawKey, deviceFingerprint: "device-a", deviceName: "Desktop A" });
  return { sessions, events, activation };
}

function signedRequest(activation: ReturnType<typeof setup>["activation"], body: unknown, nonce: string) {
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
  it("accepts one signed request and rejects replay of the same nonce", () => {
    const { sessions, events, activation } = setup();
    const body = { messages: [{ role: "user", content: "test" }] };
    const request = signedRequest(activation, body, "nonce-unique-value-001");
    expect(sessions.authenticateSigned(activation.accessToken, request)).toMatchObject({ accountId: "desktop-owner", plan: "starter" });
    expect(() => sessions.authenticateSigned(activation.accessToken, request)).toThrow(/pernah digunakan/i);
    expect(events.list().some((item) => item.event === "desktop_replay_blocked")).toBe(true);
  });

  it("rejects body tampering and rotates refresh credentials", () => {
    const { sessions, activation } = setup();
    const request = signedRequest(activation, { value: "original" }, "nonce-unique-value-002");
    expect(() => sessions.authenticateSigned(activation.accessToken, { ...request, body: { value: "tampered" } })).toThrow(/checksum/i);
    const refreshed = sessions.refresh({ refreshToken: activation.refreshToken, deviceFingerprint: "device-a" });
    expect(refreshed.accessToken).not.toBe(activation.accessToken);
    expect(() => sessions.refresh({ refreshToken: activation.refreshToken, deviceFingerprint: "device-a" })).toThrow(/tidak valid/i);
  });
});

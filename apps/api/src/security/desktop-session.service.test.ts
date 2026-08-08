import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex, signDesktopRequest } from "@cliper/security";
import { CreditAccountService } from "../billing/credit-account.service.js";
import { LicenseService } from "../license/license.service.js";
import { DesktopSessionService } from "./desktop-session.service.js";
import { SecurityEventService } from "./security-event.service.js";

const previousBalance = process.env.CLIPER_DEV_CREDIT_BALANCE_MICRO;
const previousSessionStorage = process.env.DESKTOP_SESSION_STORAGE;
const previousEncryptionKey = process.env.PROVIDER_ENCRYPTION_KEY;
afterEach(() => {
  if (previousBalance === undefined) delete process.env.CLIPER_DEV_CREDIT_BALANCE_MICRO;
  else process.env.CLIPER_DEV_CREDIT_BALANCE_MICRO = previousBalance;
  if (previousSessionStorage === undefined) delete process.env.DESKTOP_SESSION_STORAGE;
  else process.env.DESKTOP_SESSION_STORAGE = previousSessionStorage;
  if (previousEncryptionKey === undefined) delete process.env.PROVIDER_ENCRYPTION_KEY;
  else process.env.PROVIDER_ENCRYPTION_KEY = previousEncryptionKey;
});

function persistentDatabase() {
  const sessions = new Map<string, Record<string, unknown>>();
  const nonces = new Map<string, number>();
  return {
    configured: () => true,
    client: () => ({
      desktopSession: {
        upsert: async ({ where, create, update }: { where: { id: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
          const current = sessions.get(where.id);
          const next = current ? { ...current, ...update } : create;
          sessions.set(where.id, next);
          return next;
        },
        findUnique: async ({ where }: { where: Record<string, string> }) => {
          const current = Array.from(sessions.values()).find((item) => Object.entries(where).every(([key, value]) => item[key] === value));
          return current
            ? { ...current, apiKey: { status: "ACTIVE", expiresAt: null }, user: { isActive: true, unlimitedCredits: false } }
            : null;
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const current = sessions.get(where.id);
          if (!current) throw new Error("missing session");
          const next = { ...current, ...data };
          sessions.set(where.id, next);
          return next;
        },
        count: async () => sessions.size,
      },
      desktopRequestNonce: {
        deleteMany: async () => ({ count: 0 }),
        create: async ({ data }: { data: { sessionId: string; nonce: string; expiresAt: Date } }) => {
          const key = `${data.sessionId}:${data.nonce}`;
          if (nonces.has(key)) throw { code: "P2002" };
          nonces.set(key, data.expiresAt.getTime());
          return data;
        },
      },
      user: {
        findUnique: async () => ({ unlimitedCredits: false, creditAccount: { balanceMicro: BigInt(100_000_000), reservedMicro: BigInt(0) } }),
      },
    }),
  };
}

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
    await expect(sessions.authenticateSigned(activation.accessToken, request)).resolves.toMatchObject({ accountId: "desktop-owner", plan: "starter" });
    await expect(sessions.authenticateSigned(activation.accessToken, request)).rejects.toThrow(/pernah digunakan/i);
    expect(events.list().some((item) => item.event === "desktop_replay_blocked")).toBe(true);
  });

  it("rejects body tampering and rotates refresh credentials", async () => {
    const { sessions, activation } = await setup();
    const request = signedRequest(activation, { value: "original" }, "nonce-unique-value-002");
    await expect(sessions.authenticateSigned(activation.accessToken, { ...request, body: { value: "tampered" } })).rejects.toThrow(/checksum/i);
    const refreshed = await sessions.refresh({ refreshToken: activation.refreshToken, deviceFingerprint: "device-a" });
    expect(refreshed.accessToken).not.toBe(activation.accessToken);
    await expect(sessions.refresh({ refreshToken: activation.refreshToken, deviceFingerprint: "device-a" })).rejects.toThrow(/tidak valid/i);
  });

  it("rehydrates an encrypted desktop session after an API restart", async () => {
    process.env.DESKTOP_SESSION_STORAGE = "postgres";
    process.env.PROVIDER_ENCRYPTION_KEY = "p".repeat(32);
    process.env.CLIPER_DEV_CREDIT_BALANCE_MICRO = "100000000";
    const credits = new CreditAccountService();
    const licenses = new LicenseService(credits);
    const events = new SecurityEventService();
    const database = persistentDatabase();
    const firstProcess = new DesktopSessionService(licenses, credits, events, database as never);
    const generated = await licenses.createKey({ ownerId: "desktop-owner", plan: "starter", deviceLimit: 1 });
    credits.initialize("desktop-owner", 100_000_000);
    const activation = await firstProcess.activate({ key: generated.rawKey, deviceFingerprint: "device-a", deviceName: "Desktop A" });

    const restartedProcess = new DesktopSessionService(licenses, credits, events, database as never);
    const request = signedRequest(activation, { healthy: true }, "nonce-persistent-session-001");
    await expect(restartedProcess.authenticateSigned(activation.accessToken, request)).resolves.toMatchObject({ accountId: "desktop-owner", plan: "starter" });
  });
});

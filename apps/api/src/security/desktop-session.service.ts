import { Injectable, UnauthorizedException } from "@nestjs/common";
import type { DesktopActivateRequest, DesktopHeartbeatResponse, DesktopRefreshRequest, DesktopSessionResponse } from "@cliper/contracts";
import { sha256Hex, signDesktopRequest, verifyDesktopRequestSignature } from "@cliper/security";
import { randomBytes, randomUUID } from "node:crypto";
import { CreditAccountService } from "../billing/credit-account.service.js";
import { LicenseService } from "../license/license.service.js";
import { SecurityEventService } from "./security-event.service.js";

interface DesktopSessionRecord {
  id: string;
  apiKeyId: string;
  accountId: string;
  plan: string;
  deviceFingerprint: string;
  accessHash: string;
  refreshHash: string;
  signingSecret: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  offlineGraceUntil: number;
  lastHeartbeatAt: number;
  revokedAt?: number;
  nonces: Map<string, number>;
}

export interface DesktopSessionContext {
  sessionId: string;
  apiKeyId: string;
  accountId: string;
  plan: string;
  accessExpiresAt: number;
  offlineGraceUntil: number;
}

export interface SignedHttpRequest {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

function opaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function milliseconds(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function header(headers: SignedHttpRequest["headers"], name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

@Injectable()
export class DesktopSessionService {
  private readonly sessions = new Map<string, DesktopSessionRecord>();
  private readonly accessIndex = new Map<string, string>();
  private readonly refreshIndex = new Map<string, string>();

  constructor(
    private readonly licenses: LicenseService,
    private readonly credits: CreditAccountService,
    private readonly securityEvents: SecurityEventService,
  ) {}

  activate(request: DesktopActivateRequest): DesktopSessionResponse {
    const license = this.licenses.validate(request);
    const identity = this.licenses.sessionContext(request.key);
    if (!license.valid || !identity) {
      this.securityEvents.record({ event: "desktop_activation_failed", severity: "warning", detail: license.reason || "License tidak valid." });
      throw new UnauthorizedException(license.reason || "License tidak valid.");
    }
    const session = this.issue(identity, request.deviceFingerprint);
    this.securityEvents.record({ event: "desktop_session_activated", severity: "info", accountId: identity.accountId, sessionId: session.record.id, detail: "Desktop session diterbitkan." });
    return this.response(session.record, session.accessToken, session.refreshToken, license);
  }

  refresh(request: DesktopRefreshRequest): DesktopSessionResponse {
    const sessionId = this.refreshIndex.get(sha256Hex(request.refreshToken || ""));
    const current = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!current || current.revokedAt || current.refreshExpiresAt <= Date.now() || current.deviceFingerprint !== request.deviceFingerprint) {
      this.securityEvents.record({ event: "desktop_refresh_rejected", severity: "warning", sessionId, detail: "Refresh token tidak valid, kedaluwarsa, atau device tidak cocok." });
      throw new UnauthorizedException("Refresh token tidak valid atau sudah berakhir.");
    }
    this.accessIndex.delete(current.accessHash);
    this.refreshIndex.delete(current.refreshHash);
    const rotated = this.rotate(current);
    const balance = this.credits.balance(current.accountId);
    this.securityEvents.record({ event: "desktop_session_refreshed", severity: "info", accountId: current.accountId, sessionId: current.id, detail: "Access dan refresh token dirotasi." });
    return {
      status: "active",
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken,
      signingSecret: current.signingSecret,
      accessExpiresAt: new Date(current.accessExpiresAt).toISOString(),
      refreshExpiresAt: new Date(current.refreshExpiresAt).toISOString(),
      offlineGraceUntil: new Date(current.offlineGraceUntil).toISOString(),
      license: { plan: current.plan, creditsRemainingMicro: balance.availableMicro, deviceSlots: { used: 1, limit: 1 } },
    };
  }

  authenticateSigned(accessToken: string, request: SignedHttpRequest): DesktopSessionContext {
    const sessionId = this.accessIndex.get(sha256Hex(accessToken || ""));
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session || session.revokedAt || session.accessExpiresAt <= Date.now()) throw new UnauthorizedException("Desktop access token tidak valid atau sudah berakhir.");
    this.verifySignature(session, request);
    return this.context(session);
  }

  heartbeat(context: DesktopSessionContext): DesktopHeartbeatResponse {
    const session = this.sessions.get(context.sessionId);
    if (!session || session.revokedAt) throw new UnauthorizedException("Desktop session tidak aktif.");
    session.lastHeartbeatAt = Date.now();
    const credits = this.credits.balance(session.accountId);
    return {
      status: "active",
      serverTime: new Date().toISOString(),
      accessExpiresAt: new Date(session.accessExpiresAt).toISOString(),
      offlineGraceUntil: new Date(session.offlineGraceUntil).toISOString(),
      creditsRemainingMicro: credits.availableMicro,
    };
  }

  signResponse(sessionId: string, path: string, payload: unknown) {
    const session = this.sessions.get(sessionId);
    if (!session || session.revokedAt) return undefined;
    const timestamp = String(Date.now());
    const checksum = sha256Hex(JSON.stringify(payload));
    const signature = signDesktopRequest(session.signingSecret, { method: "RESPONSE", path, timestamp, nonce: "response", contentSha256: checksum });
    return { timestamp, checksum, signature };
  }

  summary() {
    const sessions = Array.from(this.sessions.values());
    return {
      total: sessions.length,
      active: sessions.filter((item) => !item.revokedAt && item.refreshExpiresAt > Date.now()).length,
      staleHeartbeat: sessions.filter((item) => !item.revokedAt && Date.now() - item.lastHeartbeatAt > 20 * 60_000).length,
    };
  }

  private issue(identity: { apiKeyId: string; accountId: string; plan: string }, deviceFingerprint: string) {
    const now = Date.now();
    const record: DesktopSessionRecord = {
      id: randomUUID(),
      ...identity,
      deviceFingerprint,
      accessHash: "",
      refreshHash: "",
      signingSecret: randomBytes(32).toString("base64url"),
      accessExpiresAt: now,
      refreshExpiresAt: now,
      offlineGraceUntil: now + milliseconds("DESKTOP_OFFLINE_GRACE_MS", 72 * 60 * 60_000),
      lastHeartbeatAt: now,
      nonces: new Map(),
    };
    this.sessions.set(record.id, record);
    const rotated = this.rotate(record);
    return { record, ...rotated };
  }

  private rotate(session: DesktopSessionRecord) {
    const accessToken = opaqueToken("clip_at");
    const refreshToken = opaqueToken("clip_rt");
    session.accessHash = sha256Hex(accessToken);
    session.refreshHash = sha256Hex(refreshToken);
    session.accessExpiresAt = Date.now() + milliseconds("DESKTOP_ACCESS_TOKEN_MS", 15 * 60_000);
    session.refreshExpiresAt = Date.now() + milliseconds("DESKTOP_REFRESH_TOKEN_MS", 30 * 24 * 60 * 60_000);
    this.accessIndex.set(session.accessHash, session.id);
    this.refreshIndex.set(session.refreshHash, session.id);
    return { accessToken, refreshToken };
  }

  private response(record: DesktopSessionRecord, accessToken: string, refreshToken: string, license: ReturnType<LicenseService["validate"]>): DesktopSessionResponse {
    return {
      status: "active",
      accessToken,
      refreshToken,
      signingSecret: record.signingSecret,
      accessExpiresAt: new Date(record.accessExpiresAt).toISOString(),
      refreshExpiresAt: new Date(record.refreshExpiresAt).toISOString(),
      offlineGraceUntil: new Date(record.offlineGraceUntil).toISOString(),
      license: {
        plan: record.plan,
        creditsRemainingMicro: license.credits?.remainingMicro || 0,
        deviceSlots: license.deviceSlots || { used: 1, limit: 1 },
        expiresAt: license.expiresAt,
      },
    };
  }

  private verifySignature(session: DesktopSessionRecord, request: SignedHttpRequest): void {
    const timestamp = header(request.headers, "x-cliper-timestamp");
    const nonce = header(request.headers, "x-cliper-nonce");
    const contentSha256 = header(request.headers, "x-cliper-content-sha256");
    const signature = header(request.headers, "x-cliper-signature");
    const timestampNumber = Number(timestamp);
    const now = Date.now();
    if (!Number.isFinite(timestampNumber) || Math.abs(now - timestampNumber) > 60_000) {
      this.reject(session, "desktop_signature_expired", "Timestamp request berada di luar batas 60 detik.");
    }
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) this.reject(session, "desktop_nonce_invalid", "Nonce request tidak valid.");
    for (const [value, expiresAt] of session.nonces.entries()) if (expiresAt <= now) session.nonces.delete(value);
    if (session.nonces.has(nonce)) this.reject(session, "desktop_replay_blocked", "Nonce sudah pernah digunakan.");
    const expectedContentHash = sha256Hex(JSON.stringify(request.body ?? {}));
    if (contentSha256 !== expectedContentHash) this.reject(session, "desktop_content_mismatch", "Checksum body request tidak cocok.");
    const valid = verifyDesktopRequestSignature(session.signingSecret, {
      method: request.method,
      path: request.path,
      timestamp,
      nonce,
      contentSha256,
    }, signature);
    if (!valid) this.reject(session, "desktop_signature_invalid", "HMAC signature request tidak valid.");
    session.nonces.set(nonce, now + 60_000);
  }

  private reject(session: DesktopSessionRecord, event: string, detail: string): never {
    this.securityEvents.record({ event, severity: event === "desktop_replay_blocked" ? "critical" : "warning", accountId: session.accountId, sessionId: session.id, detail });
    throw new UnauthorizedException(detail);
  }

  private context(session: DesktopSessionRecord): DesktopSessionContext {
    return { sessionId: session.id, apiKeyId: session.apiKeyId, accountId: session.accountId, plan: session.plan, accessExpiresAt: session.accessExpiresAt, offlineGraceUntil: session.offlineGraceUntil };
  }
}

import { Inject, Injectable, Optional, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import type { DesktopActivateRequest, DesktopHeartbeatResponse, DesktopRefreshRequest, DesktopSessionResponse, WalletSnapshot } from "@cliper/contracts";
import { decryptSecret, encryptSecret, sha256Hex, signDesktopRequest, verifyDesktopRequestSignature } from "@cliper/security";
import { randomBytes, randomUUID } from "node:crypto";
import { CreditAccountService } from "../billing/credit-account.service.js";
import { LicenseService } from "../license/license.service.js";
import { SecurityEventService } from "./security-event.service.js";
import { DatabaseService } from "../database/database.service.js";

interface DesktopSessionRecord {
  id: string;
  apiKeyId: string;
  accountId: string;
  plan: string;
  unlimited: boolean;
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

interface PersistedDesktopSession {
  id: string;
  apiKeyId: string;
  userId: string;
  plan: string;
  unlimited: boolean;
  deviceFingerprint: string;
  accessHash: string;
  refreshHash: string;
  encryptedSigningSecret: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  offlineGraceUntil: Date;
  lastHeartbeatAt: Date;
  revokedAt: Date | null;
  apiKey: { status: string; expiresAt: Date | null };
  user: { isActive: boolean; unlimitedCredits: boolean };
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

function planCode(plan: string): "FREE" | "STARTER" | "PRO" | "TEAM" | "ENTERPRISE" {
  switch (String(plan || "free").trim().toUpperCase()) {
    case "STARTER":
      return "STARTER";
    case "PRO":
      return "PRO";
    case "TEAM":
      return "TEAM";
    case "ENTERPRISE":
      return "ENTERPRISE";
    default:
      return "FREE";
  }
}

function walletSnapshot(
  balanceMicroUsd: number,
  reservedMicroUsd = 0,
  unlimited = false,
): WalletSnapshot {
  const availableMicroUsd = unlimited
    ? Number.MAX_SAFE_INTEGER
    : Math.max(0, Math.round(balanceMicroUsd));
  const safeReservedMicroUsd = unlimited
    ? 0
    : Math.max(0, Math.round(reservedMicroUsd));
  const spendableMicroUsd = unlimited
    ? Number.MAX_SAFE_INTEGER
    : Math.max(0, availableMicroUsd - safeReservedMicroUsd);
  return {
    currency: "USD",
    availableMicroUsd,
    reservedMicroUsd: safeReservedMicroUsd,
    spendableMicroUsd,
    availableUsd: availableMicroUsd / 1_000_000,
    reservedUsd: safeReservedMicroUsd / 1_000_000,
    spendableUsd: spendableMicroUsd / 1_000_000,
    unlimited,
  };
}

@Injectable()
export class DesktopSessionService {
  private readonly sessions = new Map<string, DesktopSessionRecord>();
  private readonly accessIndex = new Map<string, string>();
  private readonly refreshIndex = new Map<string, string>();

  constructor(
    @Inject(LicenseService) private readonly licenses: LicenseService,
    @Inject(CreditAccountService) private readonly credits: CreditAccountService,
    @Inject(SecurityEventService) private readonly securityEvents: SecurityEventService,
    @Optional() @Inject(DatabaseService) private readonly database?: DatabaseService,
  ) {}

  async activate(request: DesktopActivateRequest): Promise<DesktopSessionResponse> {
    const license = await this.licenses.validate(request);
    const identity = await this.licenses.sessionContext(request.key);
    if (!license.valid || !identity) {
      this.securityEvents.record({ event: "desktop_activation_failed", severity: "warning", detail: license.reason || "License tidak valid." });
      throw new UnauthorizedException(license.reason || "License tidak valid.");
    }
    const session = this.issue(identity, request.deviceFingerprint, Boolean(license.unlimited));
    if (this.usesPersistence()) await this.persist(session.record);
    this.securityEvents.record({ event: "desktop_session_activated", severity: "info", accountId: identity.accountId, sessionId: session.record.id, detail: "Desktop session diterbitkan." });
    return this.response(session.record, session.accessToken, session.refreshToken, license);
  }

  async refresh(request: DesktopRefreshRequest): Promise<DesktopSessionResponse> {
    const current = await this.findByRefreshHash(sha256Hex(request.refreshToken || ""));
    if (!current || current.revokedAt || current.refreshExpiresAt <= Date.now() || current.deviceFingerprint !== request.deviceFingerprint) {
      this.securityEvents.record({ event: "desktop_refresh_rejected", severity: "warning", sessionId: current?.id, detail: "Refresh token tidak valid, kedaluwarsa, atau device tidak cocok." });
      throw new UnauthorizedException("Refresh token tidak valid atau sudah berakhir.");
    }
    const rotated = this.rotate(current);
    if (this.usesPersistence()) await this.persist(current);
    const wallet = await this.currentWallet(current.accountId, current.unlimited);
    this.securityEvents.record({ event: "desktop_session_refreshed", severity: "info", accountId: current.accountId, sessionId: current.id, detail: "Access dan refresh token dirotasi." });
    return {
      status: "active",
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken,
      signingSecret: current.signingSecret,
      accessExpiresAt: new Date(current.accessExpiresAt).toISOString(),
      refreshExpiresAt: new Date(current.refreshExpiresAt).toISOString(),
      offlineGraceUntil: new Date(current.offlineGraceUntil).toISOString(),
      license: {
        wallet,
        keyType: current.unlimited ? "internal" : "user",
        billingMode: "wallet",
        cloudConnected: true,
        billingEligible: current.unlimited || wallet.spendableMicroUsd > 0,
        unlimited: current.unlimited,
        deviceSlots: { used: 1, limit: 1 },
      },
    };
  }

  async authenticateSigned(accessToken: string, request: SignedHttpRequest): Promise<DesktopSessionContext> {
    const session = await this.findByAccessHash(sha256Hex(accessToken || ""));
    if (!session || session.revokedAt || session.accessExpiresAt <= Date.now()) {
      throw new UnauthorizedException("Desktop access token tidak valid atau sudah berakhir.");
    }
    await this.verifySignature(session, request);
    return this.context(session);
  }

  async heartbeat(context: DesktopSessionContext): Promise<DesktopHeartbeatResponse> {
    const session = await this.findById(context.sessionId);
    if (!session || session.revokedAt) throw new UnauthorizedException("Desktop session tidak aktif.");
    const now = Date.now();
    const shouldPersist = now - session.lastHeartbeatAt >= milliseconds("DESKTOP_HEARTBEAT_PERSIST_MS", 10 * 60_000);
    session.lastHeartbeatAt = now;
    if (this.usesPersistence() && shouldPersist) {
      await this.databaseClient().desktopSession.update({
        where: { id: session.id },
        data: { lastHeartbeatAt: new Date(session.lastHeartbeatAt) },
      });
    }
    const wallet = await this.currentWallet(session.accountId, session.unlimited);
    return {
      status: "active",
      serverTime: new Date().toISOString(),
      accessExpiresAt: new Date(session.accessExpiresAt).toISOString(),
      offlineGraceUntil: new Date(session.offlineGraceUntil).toISOString(),
      wallet,
      keyType: session.unlimited ? "internal" : "user",
      cloudConnected: true,
      billingEligible: session.unlimited || wallet.spendableMicroUsd > 0,
      unlimited: session.unlimited,
    };
  }

  async signResponse(sessionId: string, path: string, payload: unknown) {
    const session = await this.findById(sessionId);
    if (!session || session.revokedAt) return undefined;
    const timestamp = String(Date.now());
    const checksum = sha256Hex(JSON.stringify(payload));
    const signature = signDesktopRequest(session.signingSecret, { method: "RESPONSE", path, timestamp, nonce: "response", contentSha256: checksum });
    return { timestamp, checksum, signature };
  }

  async summary() {
    if (!this.usesPersistence()) return this.memorySummary();
    const now = new Date();
    const staleBefore = new Date(Date.now() - 20 * 60_000);
    try {
      const client = this.databaseClient();
      const [total, active, staleHeartbeat] = await Promise.all([
        client.desktopSession.count(),
        client.desktopSession.count({ where: { revokedAt: null, refreshExpiresAt: { gt: now } } }),
        client.desktopSession.count({ where: { revokedAt: null, lastHeartbeatAt: { lt: staleBefore } } }),
      ]);
      return { total, active, staleHeartbeat };
    } catch {
      return { total: 0, active: 0, staleHeartbeat: 0 };
    }
  }

  private issue(identity: { apiKeyId: string; accountId: string; plan: string }, deviceFingerprint: string, unlimited: boolean) {
    const now = Date.now();
    const record: DesktopSessionRecord = {
      id: randomUUID(),
      ...identity,
      unlimited,
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
    if (!this.usesPersistence()) this.sessions.set(record.id, record);
    const rotated = this.rotate(record);
    return { record, ...rotated };
  }

  private rotate(session: DesktopSessionRecord) {
    const previousAccessHash = session.accessHash;
    const previousRefreshHash = session.refreshHash;
    const accessToken = opaqueToken("clip_at");
    const refreshToken = opaqueToken("clip_rt");
    session.accessHash = sha256Hex(accessToken);
    session.refreshHash = sha256Hex(refreshToken);
    // Video downloads, transcription, and FFmpeg renders can legitimately run
    // longer than a browser-style access window. The token remains device-bound,
    // HMAC-signed, replay-protected, and revocable.
    session.accessExpiresAt = Date.now() + milliseconds("DESKTOP_ACCESS_TOKEN_MS", 4 * 60 * 60_000);
    session.refreshExpiresAt = Date.now() + milliseconds("DESKTOP_REFRESH_TOKEN_MS", 30 * 24 * 60 * 60_000);
    if (!this.usesPersistence()) {
      if (previousAccessHash) this.accessIndex.delete(previousAccessHash);
      if (previousRefreshHash) this.refreshIndex.delete(previousRefreshHash);
      this.accessIndex.set(session.accessHash, session.id);
      this.refreshIndex.set(session.refreshHash, session.id);
    }
    return { accessToken, refreshToken };
  }

  private response(record: DesktopSessionRecord, accessToken: string, refreshToken: string, license: Awaited<ReturnType<LicenseService["validate"]>>): DesktopSessionResponse {
    return {
      status: "active",
      accessToken,
      refreshToken,
      signingSecret: record.signingSecret,
      accessExpiresAt: new Date(record.accessExpiresAt).toISOString(),
      refreshExpiresAt: new Date(record.refreshExpiresAt).toISOString(),
      offlineGraceUntil: new Date(record.offlineGraceUntil).toISOString(),
      license: {
        wallet: license.wallet || walletSnapshot(0),
        keyType: license.keyType || (record.unlimited ? "internal" : "user"),
        billingMode: "wallet",
        cloudConnected: license.cloudConnected === true,
        billingEligible: license.billingEligible === true,
        unlimited: Boolean(license.unlimited),
        deviceSlots: license.deviceSlots || { used: 1, limit: 1 },
        expiresAt: license.expiresAt,
      },
    };
  }

  private async verifySignature(session: DesktopSessionRecord, request: SignedHttpRequest): Promise<void> {
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
    await this.claimNonce(session, nonce, now + 60_000);
  }

  private async claimNonce(session: DesktopSessionRecord, nonce: string, expiresAt: number): Promise<void> {
    if (!this.usesPersistence()) {
      const now = Date.now();
      for (const [value, expiry] of session.nonces.entries()) if (expiry <= now) session.nonces.delete(value);
      if (session.nonces.has(nonce)) this.reject(session, "desktop_replay_blocked", "Nonce sudah pernah digunakan.");
      session.nonces.set(nonce, expiresAt);
      return;
    }
    try {
      const client = this.databaseClient();
      await client.desktopRequestNonce.deleteMany({ where: { sessionId: session.id, expiresAt: { lte: new Date() } } });
      await client.desktopRequestNonce.create({ data: { sessionId: session.id, nonce, expiresAt: new Date(expiresAt) } });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && String(error.code) === "P2002") {
        this.reject(session, "desktop_replay_blocked", "Nonce sudah pernah digunakan.");
      }
      throw new ServiceUnavailableException("Validasi keamanan desktop sementara tidak tersedia.");
    }
  }

  private async findByAccessHash(accessHash: string): Promise<DesktopSessionRecord | undefined> {
    if (!this.usesPersistence()) {
      const sessionId = this.accessIndex.get(accessHash);
      return sessionId ? this.sessions.get(sessionId) : undefined;
    }
    const stored = await this.databaseClient().desktopSession.findUnique({
      where: { accessHash },
      include: { apiKey: { select: { status: true, expiresAt: true } }, user: { select: { isActive: true, unlimitedCredits: true } } },
    });
    return this.hydrate(stored as PersistedDesktopSession | null);
  }

  private async findByRefreshHash(refreshHash: string): Promise<DesktopSessionRecord | undefined> {
    if (!this.usesPersistence()) {
      const sessionId = this.refreshIndex.get(refreshHash);
      return sessionId ? this.sessions.get(sessionId) : undefined;
    }
    const stored = await this.databaseClient().desktopSession.findUnique({
      where: { refreshHash },
      include: { apiKey: { select: { status: true, expiresAt: true } }, user: { select: { isActive: true, unlimitedCredits: true } } },
    });
    return this.hydrate(stored as PersistedDesktopSession | null);
  }

  private async findById(id: string): Promise<DesktopSessionRecord | undefined> {
    if (!this.usesPersistence()) return this.sessions.get(id);
    const stored = await this.databaseClient().desktopSession.findUnique({
      where: { id },
      include: { apiKey: { select: { status: true, expiresAt: true } }, user: { select: { isActive: true, unlimitedCredits: true } } },
    });
    return this.hydrate(stored as PersistedDesktopSession | null);
  }

  private async hydrate(stored: PersistedDesktopSession | null): Promise<DesktopSessionRecord | undefined> {
    if (!stored || stored.revokedAt) return undefined;
    const keyExpired = Boolean(stored.apiKey.expiresAt && stored.apiKey.expiresAt.getTime() <= Date.now());
    if (!stored.user.isActive || stored.apiKey.status !== "ACTIVE" || keyExpired) {
      await this.revokeStored(stored.id);
      return undefined;
    }
    let signingSecret: string;
    try {
      signingSecret = decryptSecret(stored.encryptedSigningSecret, this.encryptionSecret());
    } catch {
      await this.revokeStored(stored.id);
      this.securityEvents.record({ event: "desktop_session_secret_unavailable", severity: "warning", accountId: stored.userId, sessionId: stored.id, detail: "Sesi desktop perlu diaktifkan ulang setelah rotasi atau perubahan encryption secret." });
      return undefined;
    }
    return {
      id: stored.id,
      apiKeyId: stored.apiKeyId,
      accountId: stored.userId,
      plan: String(stored.plan).toLowerCase(),
      unlimited: stored.unlimited || stored.user.unlimitedCredits,
      deviceFingerprint: stored.deviceFingerprint,
      accessHash: stored.accessHash,
      refreshHash: stored.refreshHash,
      signingSecret,
      accessExpiresAt: stored.accessExpiresAt.getTime(),
      refreshExpiresAt: stored.refreshExpiresAt.getTime(),
      offlineGraceUntil: stored.offlineGraceUntil.getTime(),
      lastHeartbeatAt: stored.lastHeartbeatAt.getTime(),
      nonces: new Map(),
    };
  }

  private async persist(session: DesktopSessionRecord): Promise<void> {
    const client = this.databaseClient();
    const data = {
      apiKeyId: session.apiKeyId,
      userId: session.accountId,
      plan: planCode(session.plan),
      unlimited: session.unlimited,
      deviceFingerprint: session.deviceFingerprint,
      accessHash: session.accessHash,
      refreshHash: session.refreshHash,
      encryptedSigningSecret: encryptSecret(session.signingSecret, this.encryptionSecret()),
      accessExpiresAt: new Date(session.accessExpiresAt),
      refreshExpiresAt: new Date(session.refreshExpiresAt),
      offlineGraceUntil: new Date(session.offlineGraceUntil),
      lastHeartbeatAt: new Date(session.lastHeartbeatAt),
      revokedAt: session.revokedAt ? new Date(session.revokedAt) : null,
    };
    await client.desktopSession.upsert({ where: { id: session.id }, create: { id: session.id, ...data }, update: data });
  }

  private async revokeStored(id: string): Promise<void> {
    try {
      await this.databaseClient().desktopSession.update({ where: { id }, data: { revokedAt: new Date() } });
    } catch {
      // The original authentication failure remains the useful user-facing result.
    }
  }

  private usesPersistence(): boolean {
    const configured = String(process.env.DESKTOP_SESSION_STORAGE || "").trim().toLowerCase();
    if (configured === "memory") return false;
    if (configured === "postgres" || configured === "postgresql") return true;
    return String(process.env.NODE_ENV || "development").toLowerCase() === "production" ||
      (this.database?.configured() === true && ["postgres", "postgresql"].includes(String(process.env.LICENSE_STORAGE || "").toLowerCase()));
  }

  private databaseClient() {
    if (!this.database?.configured()) {
      throw new ServiceUnavailableException("PostgreSQL wajib tersedia untuk sesi desktop yang persisten.");
    }
    return this.database.client();
  }

  private encryptionSecret(): string {
    const secret = String(process.env.PROVIDER_ENCRYPTION_KEY || process.env.LICENSE_KEY_PEPPER || "");
    if (secret.length < 32) {
      throw new ServiceUnavailableException("Encryption secret server belum valid untuk sesi desktop persisten.");
    }
    return secret;
  }

  private memorySummary() {
    const sessions = Array.from(this.sessions.values());
    return {
      total: sessions.length,
      active: sessions.filter((item) => !item.revokedAt && item.refreshExpiresAt > Date.now()).length,
      staleHeartbeat: sessions.filter((item) => !item.revokedAt && Date.now() - item.lastHeartbeatAt > 20 * 60_000).length,
    };
  }

  private reject(session: DesktopSessionRecord, event: string, detail: string): never {
    this.securityEvents.record({ event, severity: event === "desktop_replay_blocked" ? "critical" : "warning", accountId: session.accountId, sessionId: session.id, detail });
    throw new UnauthorizedException(detail);
  }

  private context(session: DesktopSessionRecord): DesktopSessionContext {
    return { sessionId: session.id, apiKeyId: session.apiKeyId, accountId: session.accountId, plan: session.plan, accessExpiresAt: session.accessExpiresAt, offlineGraceUntil: session.offlineGraceUntil };
  }

  private async currentWallet(accountId: string, unlimited: boolean): Promise<WalletSnapshot> {
    if (this.database?.configured() && accountId !== "development-account") {
      const user = await this.database.client().user.findUnique({
        where: { id: accountId },
        select: { unlimitedCredits: true, creditAccount: { select: { balanceMicro: true, reservedMicro: true } } },
      });
      return walletSnapshot(
        Number(user?.creditAccount?.balanceMicro || 0n),
        Number(user?.creditAccount?.reservedMicro || 0n),
        Boolean(user?.unlimitedCredits || unlimited),
      );
    }
    const balance = this.credits.balance(accountId);
    return walletSnapshot(balance.balanceMicro, balance.reservedMicro, unlimited);
  }
}

import { Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import type { LicenseValidationRequest, LicenseValidationResponse } from "@cliper/contracts";
import { generateCliperApiKey, hashCliperApiKey, isCliperApiKey } from "@cliper/security";
import { CreditAccountService } from "../billing/credit-account.service.js";
import { DatabaseService } from "../database/database.service.js";
import { KeyStatus, PlanCode } from "../generated/prisma/client.js";
import { LicenseKeyStore, type LicenseKeyMetadata } from "./key-storage.js";

const DEFAULT_DEVICE_LIMIT = 2;
const DEFAULT_EXPIRE_DAYS = 365;
const UNLIMITED_CREDIT_DISPLAY_MICRO = Number.MAX_SAFE_INTEGER;

function keyPepper(): string {
  return String(process.env.LICENSE_KEY_PEPPER || process.env.PROVIDER_ENCRYPTION_KEY || "development-license-pepper-000000000000000000000");
}

function addDays(days: number): Date {
  const expires = new Date();
  expires.setDate(expires.getDate() + days);
  return expires;
}

function planForDatabase(plan: string | undefined): PlanCode {
  const value = String(plan || "free").toLowerCase();
  if (value === "starter") return PlanCode.STARTER;
  if (value === "pro") return PlanCode.PRO;
  if (value === "enterprise") return PlanCode.ENTERPRISE;
  return PlanCode.FREE;
}

function planLabel(plan: PlanCode): string {
  return String(plan).toLowerCase();
}

@Injectable()
export class LicenseService {
  private readonly store = new LicenseKeyStore();

  constructor(
    @Optional() @Inject(CreditAccountService) private readonly credits?: CreditAccountService,
    @Optional() @Inject(DatabaseService) private readonly database?: DatabaseService,
  ) {}

  async validate(request: LicenseValidationRequest): Promise<LicenseValidationResponse> {
    if (!request?.key || !request?.deviceFingerprint) {
      return { valid: false, reason: "License key dan device fingerprint wajib diisi." };
    }
    if (!isCliperApiKey(request.key)) {
      return { valid: false, status: "revoked", reason: "Format Cliper API key tidak valid." };
    }

    const cachedDevKey = String(process.env.CLIPER_DEV_API_KEY || "").trim();
    const isDevKey = cachedDevKey.length > 0 && request.key === cachedDevKey;
    if (isDevKey) {
      return {
        valid: true,
        status: "active",
        plan: "DEVELOPMENT",
        deviceSlots: { used: 1, limit: 2 },
        credits: { remainingMicro: this.credits?.balance("development-account").availableMicro ?? 10_000_000 },
      };
    }

    if (this.usesPostgres()) return this.validatePersistent(request);
    const found = this.store.findKeyByRawValue(request.key);
    if (!found) return { valid: false, status: "revoked", reason: "License key tidak valid atau sudah dicabut." };
    if (found.status !== "active") return { valid: false, status: found.status, reason: "License key ini sudah dicabut." };
    const validation = this.store.useDevice(request.key, request.deviceFingerprint);
    if (!validation.ok) return { valid: false, status: "revoked", reason: validation.reason };
    return {
      valid: true,
      status: "active",
      plan: found.plan,
      deviceSlots: { used: found.deviceFingerprints.length, limit: found.deviceLimit },
      credits: { remainingMicro: this.credits?.balance(found.ownerId).availableMicro ?? 0 },
      expiresAt: found.expiresAt,
      reason: found.reason,
    };
  }

  async listKeys(ownerId?: string): Promise<LicenseKeyMetadata[]> {
    if (!this.usesPostgres()) return this.store.listKeys(ownerId);
    const keys = await this.database!.client().apiKey.findMany({
      where: ownerId ? { userId: ownerId } : {},
      include: { devices: { where: { revokedAt: null }, select: { id: true } } },
      orderBy: { createdAt: "desc" },
    });
    return keys.map((key) => ({
      id: key.id,
      ownerId: key.userId,
      prefix: key.prefix,
      label: key.name,
      plan: planLabel(key.plan),
      status: key.status === KeyStatus.ACTIVE ? "active" : "revoked",
      deviceSlots: { used: key.devices.length, limit: key.deviceLimit },
      createdAt: key.createdAt.toISOString(),
      expiresAt: key.expiresAt?.toISOString() || "",
      lastUsedAt: key.lastUsedAt?.toISOString(),
      reason: key.status === KeyStatus.ACTIVE ? undefined : "Key dicabut oleh admin.",
    }));
  }

  async createKey(input: { ownerId?: string; label?: string; plan?: string; deviceLimit?: number }) {
    if (!this.usesPostgres()) return this.store.createKey(input);
    const ownerId = String(input.ownerId || "");
    const owner = await this.database!.client().user.findUnique({ where: { id: ownerId }, select: { id: true, planCode: true, deviceLimit: true } });
    if (!owner) throw new NotFoundException("Pemilik API key tidak ditemukan.");
    const material = generateCliperApiKey(keyPepper());
    const expiresAt = addDays(DEFAULT_EXPIRE_DAYS);
    const key = await this.database!.client().apiKey.create({
      data: {
        userId: owner.id,
        name: String(input.label || "Cliper Desktop").trim().slice(0, 80) || "Cliper Desktop",
        prefix: material.prefix,
        secretHash: material.secretHash,
        plan: input.plan ? planForDatabase(input.plan) : owner.planCode,
        deviceLimit: Math.max(1, Math.min(50, Math.round(Number(input.deviceLimit || owner.deviceLimit || DEFAULT_DEVICE_LIMIT)))),
        expiresAt,
      },
    });
    return {
      rawKey: material.rawKey,
      key: {
        id: key.id,
        ownerId: key.userId,
        prefix: key.prefix,
        label: key.name,
        plan: planLabel(key.plan),
        status: "active" as const,
        deviceSlots: { used: 0, limit: key.deviceLimit },
        createdAt: key.createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
    };
  }

  async authenticateGatewayKey(rawKey: string): Promise<{ apiKeyId: string; accountId: string; plan: string } | undefined> {
    if (!isCliperApiKey(rawKey)) return undefined;
    if (!this.usesPostgres()) {
      const found = this.store.findKeyByRawValue(rawKey);
      if (!found || found.status !== "active" || (found.expiresAt && new Date(found.expiresAt).getTime() <= Date.now())) return undefined;
      return { apiKeyId: found.id, accountId: found.ownerId, plan: found.plan };
    }
    const key = await this.database!.client().apiKey.findUnique({
      where: { secretHash: hashCliperApiKey(rawKey, keyPepper()) },
      include: { user: { select: { isActive: true } } },
    });
    if (!key || key.status !== KeyStatus.ACTIVE || !key.user.isActive || (key.expiresAt && key.expiresAt.getTime() <= Date.now())) return undefined;
    await this.database!.client().apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
    return { apiKeyId: key.id, accountId: key.userId, plan: planLabel(key.plan) };
  }

  async sessionContext(rawKey: string): Promise<{ apiKeyId: string; accountId: string; plan: string } | undefined> {
    const developmentKey = String(process.env.CLIPER_DEV_API_KEY || "").trim();
    if (developmentKey && rawKey === developmentKey) {
      return { apiKeyId: "development-key", accountId: "development-account", plan: String(process.env.CLIPER_DEV_PLAN || "starter").toLowerCase() };
    }
    return this.authenticateGatewayKey(rawKey);
  }

  async revokeKey(id: string, ownerId?: string) {
    if (!this.usesPostgres()) {
      if (ownerId && !this.store.listKeys(ownerId).some((item) => item.id === id)) throw new NotFoundException("License key tidak ditemukan.");
      return this.store.revokeKey(id, ownerId);
    }
    const key = await this.database!.client().apiKey.findFirst({ where: { id, ...(ownerId ? { userId: ownerId } : {}) } });
    if (!key) throw new NotFoundException("License key tidak ditemukan.");
    const now = new Date();
    await this.database!.client().$transaction([
      this.database!.client().apiKey.update({ where: { id }, data: { status: KeyStatus.REVOKED } }),
      this.database!.client().device.updateMany({ where: { apiKeyId: id, revokedAt: null }, data: { revokedAt: now } }),
    ]);
    return {
      id: key.id,
      ownerId: key.userId,
      prefix: key.prefix,
      label: key.name,
      plan: planLabel(key.plan),
      status: "revoked" as const,
      deviceSlots: { used: 0, limit: key.deviceLimit },
      createdAt: key.createdAt.toISOString(),
      expiresAt: key.expiresAt?.toISOString() || "",
      reason: "Key dicabut oleh admin.",
    };
  }

  private usesPostgres(): boolean {
    return String(process.env.LICENSE_STORAGE || "").toLowerCase() !== "memory" && Boolean(this.database?.configured());
  }

  private async validatePersistent(request: LicenseValidationRequest): Promise<LicenseValidationResponse> {
    const client = this.database!.client();
    const key = await client.apiKey.findUnique({
      where: { secretHash: hashCliperApiKey(request.key, keyPepper()) },
      include: {
        user: { select: { isActive: true, unlimitedCredits: true } },
        devices: { where: { revokedAt: null }, select: { id: true, fingerprint: true } },
      },
    });
    if (!key || !key.user.isActive) return { valid: false, status: "revoked", reason: "License key tidak valid atau akun sudah dinonaktifkan." };
    if (key.status !== KeyStatus.ACTIVE || (key.expiresAt && key.expiresAt.getTime() <= Date.now())) {
      return { valid: false, status: key.status === KeyStatus.EXPIRED ? "expired" : "revoked", reason: "License key sudah tidak aktif." };
    }
    const existing = key.devices.find((device) => device.fingerprint === request.deviceFingerprint);
    if (!existing && key.devices.length >= key.deviceLimit) {
      return { valid: false, status: "revoked", reason: "Batas perangkat terlampaui." };
    }
    if (!existing) {
      await client.device.upsert({
        where: { userId_fingerprint: { userId: key.userId, fingerprint: request.deviceFingerprint } },
        create: { userId: key.userId, apiKeyId: key.id, fingerprint: request.deviceFingerprint, name: "Cliper Desktop" },
        update: { apiKeyId: key.id, revokedAt: null, lastSeenAt: new Date() },
      });
    } else {
      await client.device.update({ where: { id: existing.id }, data: { lastSeenAt: new Date() } });
    }
    await client.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
    const account = await client.userCreditAccount.findUnique({ where: { userId: key.userId }, select: { balanceMicro: true, reservedMicro: true } });
    const available = account ? account.balanceMicro - account.reservedMicro : 0n;
    return {
      valid: true,
      status: "active",
      plan: planLabel(key.plan),
      deviceSlots: { used: existing ? key.devices.length : key.devices.length + 1, limit: key.deviceLimit },
      credits: { remainingMicro: key.user.unlimitedCredits ? UNLIMITED_CREDIT_DISPLAY_MICRO : Number(available) },
      unlimited: key.user.unlimitedCredits,
      expiresAt: key.expiresAt?.toISOString(),
    };
  }
}

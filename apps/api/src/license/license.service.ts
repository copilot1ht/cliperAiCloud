import { Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import type { LicenseValidationRequest, LicenseValidationResponse, WalletSnapshot } from "@cliper/contracts";
import { generateCliperApiKey, hashCliperApiKey, isCliperApiKey } from "@cliper/security";
import { CreditAccountService } from "../billing/credit-account.service.js";
import { DatabaseService } from "../database/database.service.js";
import { KeyStatus, PlanCode } from "../generated/prisma/client.js";
import { LicenseKeyStore, type LicenseDeviceMetadata, type LicenseKeyMetadata } from "./key-storage.js";

const DEFAULT_DEVICE_LIMIT = 2;
const DEFAULT_EXPIRE_DAYS = 365;
const UNLIMITED_WALLET_DISPLAY_MICRO_USD = Number.MAX_SAFE_INTEGER;

function walletSnapshot(
  balanceMicroUsd: number,
  reservedMicroUsd = 0,
  unlimited = false,
): WalletSnapshot {
  const availableMicroUsd = unlimited
    ? UNLIMITED_WALLET_DISPLAY_MICRO_USD
    : Math.max(0, Math.round(balanceMicroUsd));
  const safeReservedMicroUsd = unlimited
    ? 0
    : Math.max(0, Math.round(reservedMicroUsd));
  const spendableMicroUsd = unlimited
    ? UNLIMITED_WALLET_DISPLAY_MICRO_USD
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

function activityWriteIntervalMs(): number {
  const value = Number(process.env.KEY_ACTIVITY_WRITE_INTERVAL_MS || 10 * 60_000);
  return Number.isFinite(value) ? Math.max(60_000, Math.min(value, 24 * 60 * 60_000)) : 10 * 60_000;
}

function activityWriteDue(lastActivityAt: Date | null | undefined, now: Date): boolean {
  return !lastActivityAt || now.getTime() - lastActivityAt.getTime() >= activityWriteIntervalMs();
}

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

function deviceName(value: string | undefined): string {
  return String(value || "Cliper Desktop").trim().slice(0, 80) || "Cliper Desktop";
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
      const balance = this.credits?.balance("development-account");
      const wallet = walletSnapshot(
        balance?.balanceMicro ?? 10_000_000,
        balance?.reservedMicro ?? 0,
      );
      return {
        valid: true,
        status: "active",
        billingMode: "wallet",
        deviceSlots: { used: 1, limit: 2 },
        wallet,
        keyType: "internal",
        cloudConnected: true,
        billingEligible: wallet.spendableMicroUsd > 0,
      };
    }

    if (this.usesPostgres()) return this.validatePersistent(request);
    const found = this.store.findKeyByRawValue(request.key);
    if (!found) return { valid: false, status: "revoked", reason: "License key tidak valid atau sudah dicabut." };
    if (found.status !== "active") return { valid: false, status: found.status, reason: "License key ini sudah dicabut." };
    const validation = this.store.useDevice(request.key, request.deviceFingerprint);
    if (!validation.ok) return { valid: false, status: "revoked", reason: validation.reason };
    const balance = this.credits?.balance(found.ownerId);
    const wallet = walletSnapshot(balance?.balanceMicro ?? 0, balance?.reservedMicro ?? 0);
    return {
      valid: true,
      status: "active",
      billingMode: "wallet",
      deviceSlots: { used: found.deviceFingerprints.length, limit: found.deviceLimit },
      wallet,
      keyType: "user",
      cloudConnected: true,
      billingEligible: wallet.spendableMicroUsd > 0,
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
    const owner = await this.database!.client().user.findUnique({ where: { id: ownerId }, select: { id: true, planCode: true, deviceLimit: true, unlimitedCredits: true } });
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
        status: "active" as const,
        deviceSlots: { used: 0, limit: key.deviceLimit },
        createdAt: key.createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
    };
  }

  async rotateDesktopKey(input: { ownerId: string; label?: string; deviceLimit?: number }) {
    if (!this.usesPostgres()) {
      const previous = this.store.listKeys(input.ownerId).filter((item) => item.status === "active");
      const created = await this.createKey({ ...input, label: input.label || "Cliper Desktop" });
      for (const key of previous) this.store.revokeKey(key.id, input.ownerId);
      return created;
    }

    const client = this.database!.client();
    const owner = await client.user.findUnique({
      where: { id: input.ownerId },
      select: { id: true, planCode: true, deviceLimit: true },
    });
    if (!owner) throw new NotFoundException("Pemilik API key tidak ditemukan.");

    const material = generateCliperApiKey(keyPepper());
    const expiresAt = addDays(DEFAULT_EXPIRE_DAYS);
    const rotated = await client.$transaction(async (tx) => {
      const previous = await tx.apiKey.findMany({
        where: { userId: owner.id, status: KeyStatus.ACTIVE },
        select: { id: true },
      });
      const previousIds = previous.map((key) => key.id);
      const key = await tx.apiKey.create({
        data: {
          userId: owner.id,
          name: deviceName(input.label),
          prefix: material.prefix,
          secretHash: material.secretHash,
          plan: owner.planCode,
          deviceLimit: Math.max(1, Math.min(50, Math.round(Number(input.deviceLimit || owner.deviceLimit || DEFAULT_DEVICE_LIMIT)))),
          expiresAt,
        },
      });
      if (previousIds.length) {
        const now = new Date();
        await tx.apiKey.updateMany({ where: { id: { in: previousIds } }, data: { status: KeyStatus.REVOKED } });
        await tx.device.updateMany({ where: { apiKeyId: { in: previousIds }, revokedAt: null }, data: { revokedAt: now } });
        await tx.desktopSession.updateMany({ where: { apiKeyId: { in: previousIds }, revokedAt: null }, data: { revokedAt: now } });
      }
      return key;
    });

    return {
      rawKey: material.rawKey,
      key: {
        id: rotated.id,
        ownerId: rotated.userId,
        prefix: rotated.prefix,
        label: rotated.name,
        status: "active" as const,
        deviceSlots: { used: 0, limit: rotated.deviceLimit },
        createdAt: rotated.createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
    };
  }

  async listDevices(ownerId: string): Promise<LicenseDeviceMetadata[]> {
    if (!this.usesPostgres()) return this.store.listDevices(ownerId);
    const devices = await this.database!.client().device.findMany({
      where: { userId: ownerId },
      include: { apiKey: { select: { id: true, prefix: true } } },
      orderBy: { lastSeenAt: "desc" },
    });
    return devices.map((device) => ({
      id: device.id,
      keyId: device.apiKeyId || undefined,
      keyPrefix: device.apiKey?.prefix,
      name: device.name,
      fingerprint: device.fingerprint,
      platform: device.platform || undefined,
      status: device.revokedAt ? "revoked" : "active",
      lastSeenAt: device.lastSeenAt?.toISOString(),
      createdAt: device.createdAt.toISOString(),
      revokedAt: device.revokedAt?.toISOString(),
    }));
  }

  async renameDevice(id: string, ownerId: string, name: string): Promise<LicenseDeviceMetadata> {
    const safeName = deviceName(name);
    if (!this.usesPostgres()) return this.store.renameDevice(id, ownerId, safeName);
    const existing = await this.database!.client().device.findFirst({ where: { id, userId: ownerId } });
    if (!existing) throw new NotFoundException("Device tidak ditemukan.");
    await this.database!.client().device.update({ where: { id }, data: { name: safeName } });
    const updated = await this.listDevices(ownerId);
    return updated.find((device) => device.id === id)!;
  }

  async revokeDevice(id: string, ownerId: string): Promise<LicenseDeviceMetadata> {
    if (!this.usesPostgres()) return this.store.revokeDevice(id, ownerId);
    const existing = await this.database!.client().device.findFirst({ where: { id, userId: ownerId } });
    if (!existing) throw new NotFoundException("Device tidak ditemukan.");
    await this.database!.client().$transaction([
      this.database!.client().device.update({ where: { id }, data: { revokedAt: new Date() } }),
      this.database!.client().desktopSession.updateMany({
        where: { userId: ownerId, deviceFingerprint: existing.fingerprint, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    const updated = await this.listDevices(ownerId);
    return updated.find((device) => device.id === id)!;
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
    const now = new Date();
    if (activityWriteDue(key.lastUsedAt, now)) {
      await this.database!.client().apiKey.update({ where: { id: key.id }, data: { lastUsedAt: now } });
    }
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
        devices: { where: { revokedAt: null }, select: { id: true, fingerprint: true, lastSeenAt: true } },
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
    } else if (activityWriteDue(existing.lastSeenAt, new Date())) {
      await client.device.update({ where: { id: existing.id }, data: { lastSeenAt: new Date() } });
    }
    const now = new Date();
    if (activityWriteDue(key.lastUsedAt, now)) {
      await client.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: now } });
    }
    const account = await client.userCreditAccount.findUnique({ where: { userId: key.userId }, select: { balanceMicro: true, reservedMicro: true } });
    const wallet = walletSnapshot(
      Number(account?.balanceMicro || 0n),
      Number(account?.reservedMicro || 0n),
      key.user.unlimitedCredits,
    );
    return {
      valid: true,
      status: "active",
      billingMode: "wallet",
      deviceSlots: { used: existing ? key.devices.length : key.devices.length + 1, limit: key.deviceLimit },
      wallet,
      keyType: key.user.unlimitedCredits ? "internal" : "user",
      cloudConnected: true,
      billingEligible: key.user.unlimitedCredits || wallet.spendableMicroUsd > 0,
      unlimited: key.user.unlimitedCredits,
      expiresAt: key.expiresAt?.toISOString(),
    };
  }
}

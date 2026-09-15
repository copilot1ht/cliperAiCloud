import { randomUUID } from "node:crypto";
import { generateCliperApiKey, verifyCliperApiKey } from "@cliper/security";

export interface LicenseKeyMetadata {
  id: string;
  ownerId: string;
  prefix: string;
  label?: string;
  status: "active" | "revoked";
  deviceSlots: { used: number; limit: number };
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
  reason?: string;
}

export interface LicenseDeviceMetadata {
  id: string;
  keyId?: string;
  keyPrefix?: string;
  name: string;
  fingerprint: string;
  platform?: string;
  status: "active" | "revoked";
  lastSeenAt?: string;
  createdAt: string;
  revokedAt?: string;
}

interface LicenseKeyRecord extends LicenseKeyMetadata {
  // Legacy database compatibility only. Wallet billing never exposes or uses a
  // customer plan to decide whether a key is connected or a job may run.
  plan: string;
  secretHash: string;
  deviceLimit: number;
  deviceFingerprints: string[];
  revokedDevices: string[];
}

const KEY_PEPPER = String(process.env.LICENSE_KEY_PEPPER || process.env.PROVIDER_ENCRYPTION_KEY || "development-license-pepper-000000000000000000000");
const DEFAULT_DEVICE_LIMIT = 2;
const DEFAULT_EXPIRE_DAYS = 365;

function addDays(days: number): string {
  const expires = new Date();
  expires.setDate(expires.getDate() + days);
  return expires.toISOString();
}

export class LicenseKeyStore {
  private readonly keys: LicenseKeyRecord[] = [];

  createKey(input: { ownerId?: string; label?: string; plan?: string; deviceLimit?: number }) {
    const keyMaterial = generateCliperApiKey(KEY_PEPPER);
    const now = new Date().toISOString();
    const record: LicenseKeyRecord = {
      id: randomUUID(),
      ownerId: input.ownerId || "development-account",
      prefix: keyMaterial.prefix,
      label: input.label,
      plan: input.plan || "starter",
      status: "active",
      deviceSlots: { used: 0, limit: input.deviceLimit ?? DEFAULT_DEVICE_LIMIT },
      createdAt: now,
      expiresAt: addDays(DEFAULT_EXPIRE_DAYS),
      secretHash: keyMaterial.secretHash,
      deviceLimit: input.deviceLimit ?? DEFAULT_DEVICE_LIMIT,
      deviceFingerprints: [],
      revokedDevices: [],
    };
    this.keys.unshift(record);
    return { rawKey: keyMaterial.rawKey, key: this.toMetadata(record) };
  }

  listKeys(ownerId?: string): LicenseKeyMetadata[] {
    return this.keys.filter((item) => !ownerId || item.ownerId === ownerId).map((item) => this.toMetadata(item));
  }

  findKeyByRawValue(rawKey: string): LicenseKeyRecord | undefined {
    return this.keys.find((item) => verifyCliperApiKey(rawKey, item.secretHash, KEY_PEPPER));
  }

  revokeKey(id: string, ownerId?: string): LicenseKeyMetadata {
    const record = this.keys.find((item) => item.id === id && (!ownerId || item.ownerId === ownerId));
    if (!record) throw new Error("License key tidak ditemukan.");
    record.status = "revoked";
    record.reason = "Key dicabut oleh admin.";
    record.revokedDevices = Array.from(new Set([...record.revokedDevices, ...record.deviceFingerprints]));
    return this.toMetadata(record);
  }

  listDevices(ownerId: string): LicenseDeviceMetadata[] {
    return this.keys
      .filter((item) => item.ownerId === ownerId)
      .flatMap((item) => item.deviceFingerprints.map((fingerprint) => ({
        id: `${item.id}:${fingerprint}`,
        keyId: item.id,
        keyPrefix: item.prefix,
        name: "Cliper Desktop",
        fingerprint,
        status: item.status === "active" && !item.revokedDevices.includes(fingerprint) ? "active" as const : "revoked" as const,
        lastSeenAt: item.lastUsedAt,
        createdAt: item.createdAt,
        revokedAt: item.revokedDevices.includes(fingerprint) ? new Date().toISOString() : undefined,
      })));
  }

  revokeDevice(id: string, ownerId: string): LicenseDeviceMetadata {
    const [keyId, fingerprint] = id.split(":");
    const record = this.keys.find((item) => item.id === keyId && item.ownerId === ownerId);
    if (!record || !fingerprint || !record.deviceFingerprints.includes(fingerprint)) throw new Error("Device tidak ditemukan.");
    record.revokedDevices = Array.from(new Set([...record.revokedDevices, fingerprint]));
    return this.listDevices(ownerId).find((item) => item.id === id)!;
  }

  renameDevice(id: string, ownerId: string, _name: string): LicenseDeviceMetadata {
    const device = this.listDevices(ownerId).find((item) => item.id === id);
    if (!device) throw new Error("Device tidak ditemukan.");
    return device;
  }

  useDevice(rawKey: string, fingerprint: string): { ok: true } | { ok: false; reason: string } {
    const record = this.findKeyByRawValue(rawKey);
    if (!record) {
      return { ok: false, reason: "License key tidak valid." };
    }
    if (record.status !== "active") {
      return { ok: false, reason: "License key tidak aktif." };
    }
    if (!fingerprint) {
      return { ok: false, reason: "Device fingerprint wajib diisi." };
    }
    if (record.revokedDevices.includes(fingerprint)) {
      return { ok: false, reason: "Device ini sudah dicabut." };
    }
    const existing = record.deviceFingerprints.includes(fingerprint);
    if (!existing && record.deviceFingerprints.length >= record.deviceLimit) {
      return { ok: false, reason: "Batas perangkat terlampaui." };
    }
    if (!existing) {
      record.deviceFingerprints.push(fingerprint);
    }
    record.deviceSlots.used = record.deviceFingerprints.length;
    record.lastUsedAt = new Date().toISOString();
    return { ok: true };
  }

  private toMetadata(record: LicenseKeyRecord): LicenseKeyMetadata {
    return {
      id: record.id,
      ownerId: record.ownerId,
      prefix: record.prefix,
      label: record.label,
      status: record.status,
      deviceSlots: { used: record.deviceFingerprints.length, limit: record.deviceLimit },
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      lastUsedAt: record.lastUsedAt,
      reason: record.reason,
    };
  }
}

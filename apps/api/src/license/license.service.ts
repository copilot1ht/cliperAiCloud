import { Injectable, NotFoundException } from "@nestjs/common";
import type { LicenseValidationRequest, LicenseValidationResponse } from "@cliper/contracts";
import { isCliperApiKey, verifyCliperApiKey } from "@cliper/security";
import { LicenseKeyStore, LicenseKeyMetadata } from "./key-storage.js";
import { CreditAccountService } from "../billing/credit-account.service.js";

@Injectable()
export class LicenseService {
  private readonly store = new LicenseKeyStore();

  constructor(private readonly credits?: CreditAccountService) {}

  validate(request: LicenseValidationRequest): LicenseValidationResponse {
    if (!request?.key || !request?.deviceFingerprint) {
      return { valid: false, reason: "License key dan device fingerprint wajib diisi." };
    }
    if (!isCliperApiKey(request.key)) {
      return { valid: false, status: "revoked", reason: "Format Cliper API key tidak valid." };
    }

    const cachedDevKey = String(process.env.CLIPER_DEV_API_KEY || "").trim();
    const isDevKey = cachedDevKey.length > 0 && request.key === cachedDevKey;
    const found = isDevKey ? undefined : this.store.findKeyByRawValue(request.key);
    if (!found && !isDevKey) {
      return { valid: false, status: "revoked", reason: "License key tidak valid atau sudah dicabut." };
    }

    if (isDevKey) {
      return {
        valid: true,
        status: "active",
        plan: "DEVELOPMENT",
        deviceSlots: { used: 1, limit: 2 },
        credits: { remainingMicro: this.credits?.balance("development-account").availableMicro ?? 10_000_000 },
      };
    }

    if (!found) {
      return { valid: false, status: "revoked", reason: "License key tidak valid atau sudah dicabut." };
    }
    if (found.status !== "active") {
      return { valid: false, status: found.status, reason: "License key ini sudah dicabut." };
    }

    const validation = this.store.useDevice(request.key, request.deviceFingerprint);
    if (!validation.ok) {
      return { valid: false, status: "revoked", reason: validation.reason };
    }

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

  listKeys(ownerId?: string): Array<LicenseKeyMetadata> {
    return this.store.listKeys(ownerId);
  }

  createKey(input: { ownerId?: string; label?: string; plan?: string; deviceLimit?: number }) {
    return this.store.createKey(input);
  }

  authenticateGatewayKey(rawKey: string): { apiKeyId: string; accountId: string; plan: string } | undefined {
    const found = this.store.findKeyByRawValue(rawKey);
    if (!found || found.status !== "active" || (found.expiresAt && new Date(found.expiresAt).getTime() <= Date.now())) return undefined;
    return { apiKeyId: found.id, accountId: found.ownerId, plan: found.plan };
  }

  sessionContext(rawKey: string): { apiKeyId: string; accountId: string; plan: string } | undefined {
    const developmentKey = String(process.env.CLIPER_DEV_API_KEY || "").trim();
    if (developmentKey && rawKey === developmentKey) {
      return { apiKeyId: "development-key", accountId: "development-account", plan: String(process.env.CLIPER_DEV_PLAN || "starter").toLowerCase() };
    }
    return this.authenticateGatewayKey(rawKey);
  }

  revokeKey(id: string, ownerId?: string) {
    if (ownerId && !this.store.listKeys(ownerId).some((item) => item.id === id)) {
      throw new NotFoundException("License key tidak ditemukan.");
    }
    return this.store.revokeKey(id, ownerId);
  }
}

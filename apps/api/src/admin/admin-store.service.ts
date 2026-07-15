import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { providersFromEnv, type ProviderDefinition } from "@cliper/ai-router";
import type { AiModule } from "@cliper/contracts";
import { randomUUID } from "node:crypto";
import { decryptSecret, encryptSecret } from "@cliper/security";
import { getProviderPreset, isSupportedProvider } from "./provider-catalog.js";
import type { ProviderConnectionResult } from "./provider-connection.service.js";

export type AdminPlan = "free" | "starter" | "pro" | "enterprise";

export interface AdminProviderInput {
  provider?: string;
  apiKey?: string;
  enabled?: boolean;
  defaultModel?: string;
}

export interface RoutingRule {
  id: string;
  module: AiModule;
  plan: AdminPlan;
  primary: string;
  fallback: string;
  timeoutMs: number;
  maxTokens: number;
  enabled: boolean;
}

export interface PaymentRecord {
  id: string;
  reference: string;
  customerEmail: string;
  amountIdr: number;
  method: string;
  status: "paid" | "pending" | "failed" | "refunded";
  createdAt: string;
  updatedAt: string;
}

export interface PricingPolicyInput {
  markupBps?: number;
  minimumMarginBps?: number;
  computeCostMicroUsd?: number;
  paymentFeeBps?: number;
  reserveBps?: number;
  minimumChargeMicroUsd?: number;
  minimumClipChargeMicroUsd?: number;
  microUsdPerCredit?: number;
  usdToIdr?: number;
}

export interface PricingPolicyState {
  markupBps: number;
  minimumMarginBps: number;
  computeCostMicroUsd: number;
  paymentFeeBps: number;
  reserveBps: number;
  minimumChargeMicroUsd: number;
  minimumClipChargeMicroUsd: number;
  microUsdPerCredit: number;
  usdToIdr: number;
  updatedAt: string;
}

type ProviderHealthState = "healthy" | "offline" | "untested";
type StoredProvider = Omit<ProviderDefinition, "apiKeys"> & {
  id: string;
  encryptedApiKeys: string[];
  availableModels: string[];
  health: ProviderHealthState;
  lastHealthAt?: string;
  lastLatencyMs?: number;
  lastError?: string;
  modelSource: "api" | "preset";
  updatedAt: string;
};

const modules: AiModule[] = ["story", "ranking", "highlight", "title", "hook", "caption", "metadata"];
const moduleBudgets: Partial<Record<AiModule, number>> = {
  story: 1800,
  ranking: 1400,
  highlight: 1800,
  title: 500,
  hook: 420,
  caption: 700,
  metadata: 500,
};

function finiteNumber(value: unknown, fallback: number, minimum = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

@Injectable()
export class AdminStoreService {
  private readonly providersValue = new Map<string, StoredProvider>();
  private readonly routesValue = new Map<string, RoutingRule>();
  private readonly paymentsValue = new Map<string, PaymentRecord>();
  private pricingPolicyValue: PricingPolicyState;
  private revisionValue = 1;

  constructor() {
    const legacyMarkupPercent = finiteNumber(process.env.DEFAULT_MARKUP_PERCENT, 50);
    this.pricingPolicyValue = {
      markupBps: Math.round(finiteNumber(process.env.DEFAULT_MARKUP_BPS, legacyMarkupPercent * 100)),
      minimumMarginBps: Math.round(finiteNumber(process.env.MINIMUM_MARGIN_BPS, 5_000, 5_000)),
      computeCostMicroUsd: Math.round(finiteNumber(process.env.COMPUTE_COST_MICRO_USD, 0)),
      paymentFeeBps: Math.round(finiteNumber(process.env.PAYMENT_FEE_BPS, 0)),
      reserveBps: Math.round(finiteNumber(process.env.RISK_RESERVE_BPS, 0)),
      minimumChargeMicroUsd: Math.round(finiteNumber(process.env.MINIMUM_REQUEST_MICRO_USD, 0)),
      minimumClipChargeMicroUsd: Math.round(finiteNumber(process.env.MINIMUM_CLIP_CHARGE_MICRO_USD, 5_000)),
      microUsdPerCredit: Math.max(1, Math.round(finiteNumber(process.env.MICRO_USD_PER_CREDIT, 100))),
      usdToIdr: Math.round(finiteNumber(process.env.PLATFORM_USD_TO_IDR, 16_000, 1)),
      updatedAt: new Date().toISOString(),
    };
    for (const provider of providersFromEnv()) {
      if (!provider.apiKeys.length || !isSupportedProvider(provider.code)) continue;
      const id = `provider-${provider.code}`;
      const { apiKeys, ...definition } = provider;
      const preset = getProviderPreset(provider.code);
      this.providersValue.set(id, {
        ...definition,
        protocol: definition.protocol || preset.protocol,
        id,
        encryptedApiKeys: this.encryptKeys(apiKeys),
        availableModels: [provider.model],
        health: "untested",
        modelSource: "preset",
        updatedAt: new Date().toISOString(),
      });
    }
    this.seedRoutes();
  }

  revision(): number {
    return this.revisionValue;
  }

  pricingPolicy(): PricingPolicyState {
    return { ...this.pricingPolicyValue };
  }

  updatePricingPolicy(input: PricingPolicyInput): PricingPolicyState {
    const current = this.pricingPolicyValue;
    const markupBps = input.markupBps === undefined ? current.markupBps : Math.round(finiteNumber(input.markupBps, current.markupBps));
    const minimumMarginBps = input.minimumMarginBps === undefined ? current.minimumMarginBps : Math.round(finiteNumber(input.minimumMarginBps, current.minimumMarginBps));
    const paymentFeeBps = input.paymentFeeBps === undefined ? current.paymentFeeBps : Math.round(finiteNumber(input.paymentFeeBps, current.paymentFeeBps));
    const reserveBps = input.reserveBps === undefined ? current.reserveBps : Math.round(finiteNumber(input.reserveBps, current.reserveBps));
    if (markupBps > 100_000 || minimumMarginBps < 5_000 || minimumMarginBps > 9_500 || paymentFeeBps > 10_000 || reserveBps > 10_000) {
      throw new BadRequestException("Pricing basis points melebihi batas aman.");
    }
    this.pricingPolicyValue = {
      markupBps,
      minimumMarginBps,
      computeCostMicroUsd: input.computeCostMicroUsd === undefined ? current.computeCostMicroUsd : Math.round(finiteNumber(input.computeCostMicroUsd, current.computeCostMicroUsd)),
      paymentFeeBps,
      reserveBps,
      minimumChargeMicroUsd: input.minimumChargeMicroUsd === undefined ? current.minimumChargeMicroUsd : Math.round(finiteNumber(input.minimumChargeMicroUsd, current.minimumChargeMicroUsd)),
      minimumClipChargeMicroUsd: input.minimumClipChargeMicroUsd === undefined ? current.minimumClipChargeMicroUsd : Math.round(finiteNumber(input.minimumClipChargeMicroUsd, current.minimumClipChargeMicroUsd)),
      microUsdPerCredit: input.microUsdPerCredit === undefined ? current.microUsdPerCredit : Math.max(1, Math.round(finiteNumber(input.microUsdPerCredit, current.microUsdPerCredit, 1))),
      usdToIdr: input.usdToIdr === undefined ? current.usdToIdr : Math.max(1, Math.round(finiteNumber(input.usdToIdr, current.usdToIdr, 1))),
      updatedAt: new Date().toISOString(),
    };
    this.touch();
    return this.pricingPolicy();
  }

  providersForRouter(): ProviderDefinition[] {
    return Array.from(this.providersValue.values()).map((stored) => {
      const {
        id: _id,
        updatedAt: _updatedAt,
        encryptedApiKeys,
        availableModels: _availableModels,
        health: _health,
        lastHealthAt: _lastHealthAt,
        lastLatencyMs: _lastLatencyMs,
        lastError: _lastError,
        modelSource: _modelSource,
        ...provider
      } = stored;
      return { ...provider, apiKeys: this.decryptKeys(encryptedApiKeys) };
    });
  }

  listProviders() {
    return Array.from(this.providersValue.values()).map((provider) => this.safeProvider(provider));
  }

  saveDetectedProvider(input: AdminProviderInput, connection: ProviderConnectionResult) {
    const apiKey = String(input.apiKey || "").trim();
    if (!apiKey) throw new BadRequestException("API key wajib diisi.");
    const existing = Array.from(this.providersValue.values()).find((item) => item.code === connection.provider);
    const preset = getProviderPreset(connection.provider);
    const currentKeys = existing ? this.decryptKeys(existing.encryptedApiKeys) : [];
    const apiKeys = Array.from(new Set([...currentKeys, apiKey]));
    const requestedModel = String(input.defaultModel || "").trim();
    const defaultModel = requestedModel && connection.models.includes(requestedModel)
      ? requestedModel
      : existing && connection.models.includes(existing.model) ? existing.model : connection.defaultModel;
    const provider: StoredProvider = {
      ...(existing || {} as StoredProvider),
      id: existing?.id || randomUUID(),
      code: connection.provider,
      displayName: connection.displayName,
      baseUrl: connection.baseUrl,
      model: defaultModel,
      protocol: connection.protocol,
      encryptedApiKeys: this.encryptKeys(apiKeys),
      availableModels: connection.models,
      health: "healthy",
      lastHealthAt: connection.checkedAt,
      lastLatencyMs: connection.latencyMs,
      lastError: undefined,
      modelSource: connection.modelSource,
      enabled: input.enabled !== false,
      priority: existing?.priority || preset.priority,
      timeoutMs: existing?.timeoutMs || preset.timeoutMs,
      inputUsdPerM: existing?.inputUsdPerM || 0,
      outputUsdPerM: existing?.outputUsdPerM || 0,
      updatedAt: new Date().toISOString(),
    };
    this.providersValue.set(provider.id, provider);
    this.touch();
    return this.safeProvider(provider);
  }

  updateProvider(id: string, input: AdminProviderInput) {
    const current = this.providersValue.get(id);
    if (!current) throw new NotFoundException("Provider tidak ditemukan.");
    const requestedModel = input.defaultModel === undefined ? current.model : String(input.defaultModel).trim();
    if (!current.availableModels.includes(requestedModel)) {
      throw new BadRequestException("Model default tidak tersedia untuk provider ini.");
    }
    const provider: StoredProvider = {
      ...current,
      model: requestedModel,
      enabled: input.enabled === undefined ? current.enabled : Boolean(input.enabled),
      updatedAt: new Date().toISOString(),
    };
    this.providersValue.set(id, provider);
    this.touch();
    return this.safeProvider(provider);
  }

  providerConnectionInput(id: string) {
    const provider = this.providersValue.get(id);
    if (!provider) throw new NotFoundException("Provider tidak ditemukan.");
    const apiKey = this.decryptKeys(provider.encryptedApiKeys)[0];
    if (!apiKey) throw new BadRequestException("Provider belum memiliki API key.");
    return { provider: provider.code, apiKey };
  }

  applyConnectionResult(id: string, connection: ProviderConnectionResult) {
    const current = this.providersValue.get(id);
    if (!current) throw new NotFoundException("Provider tidak ditemukan.");
    const provider: StoredProvider = {
      ...current,
      baseUrl: connection.baseUrl,
      protocol: connection.protocol,
      model: connection.models.includes(current.model) ? current.model : connection.defaultModel,
      availableModels: connection.models,
      health: "healthy",
      lastHealthAt: connection.checkedAt,
      lastLatencyMs: connection.latencyMs,
      lastError: undefined,
      modelSource: connection.modelSource,
      updatedAt: new Date().toISOString(),
    };
    this.providersValue.set(id, provider);
    this.touch();
    return this.safeProvider(provider);
  }

  recordProviderFailure(id: string, error: unknown) {
    const current = this.providersValue.get(id);
    if (!current) return;
    this.providersValue.set(id, {
      ...current,
      health: "offline",
      lastHealthAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message.slice(0, 180) : "Test koneksi gagal.",
      updatedAt: new Date().toISOString(),
    });
    this.touch();
  }

  deleteProvider(id: string) {
    const provider = this.providersValue.get(id);
    if (!provider) throw new NotFoundException("Provider tidak ditemukan.");
    const usedBy = this.listRoutes().find((route) => route.enabled && (route.primary === provider.code || route.fallback === provider.code));
    if (usedBy) throw new BadRequestException(`Provider masih dipakai oleh route ${usedBy.plan}/${usedBy.module}. Ubah AI Router terlebih dahulu.`);
    this.providersValue.delete(id);
    this.touch();
    return { ok: true };
  }

  listRoutes(): RoutingRule[] {
    return Array.from(this.routesValue.values()).map((item) => ({ ...item }));
  }

  updateRoute(id: string, input: Partial<RoutingRule>) {
    const current = this.routesValue.get(id);
    if (!current) throw new NotFoundException("Aturan routing tidak ditemukan.");
    const providerCodes = new Set(this.providersForRouter().map((item) => item.code));
    const primary = input.primary === undefined ? current.primary : String(input.primary);
    const fallback = input.fallback === undefined ? current.fallback : String(input.fallback);
    if (primary && !providerCodes.has(primary)) throw new BadRequestException("Primary provider tidak tersedia.");
    if (fallback && !providerCodes.has(fallback)) throw new BadRequestException("Fallback provider tidak tersedia.");
    const next: RoutingRule = {
      ...current,
      primary,
      fallback,
      timeoutMs: input.timeoutMs === undefined ? current.timeoutMs : finiteNumber(input.timeoutMs, current.timeoutMs, 5_000),
      maxTokens: input.maxTokens === undefined ? current.maxTokens : finiteNumber(input.maxTokens, current.maxTokens, 32),
      enabled: input.enabled === undefined ? current.enabled : Boolean(input.enabled),
    };
    this.routesValue.set(id, next);
    this.touch();
    return { ...next };
  }

  planRoutes(): Record<string, Partial<Record<AiModule, string[]>>> {
    const result: Record<string, Partial<Record<AiModule, string[]>>> = {};
    for (const rule of this.routesValue.values()) {
      if (!rule.enabled) continue;
      result[rule.plan] ||= {};
      result[rule.plan]![rule.module] = [rule.primary, rule.fallback].filter(Boolean);
    }
    return result;
  }

  moduleMaxTokens(): Partial<Record<AiModule, number>> {
    const result: Partial<Record<AiModule, number>> = {};
    const proRules = this.listRoutes().filter((item) => item.plan === "pro" && item.enabled);
    for (const rule of proRules) result[rule.module] = rule.maxTokens;
    return result;
  }

  listPayments(): PaymentRecord[] {
    return Array.from(this.paymentsValue.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((item) => ({ ...item }));
  }

  createPayment(input: Partial<PaymentRecord>) {
    const customerEmail = String(input.customerEmail || "").trim().toLowerCase();
    const amountIdr = finiteNumber(input.amountIdr, 0, 1);
    if (!customerEmail || !customerEmail.includes("@")) throw new BadRequestException("Email customer tidak valid.");
    if (amountIdr <= 0) throw new BadRequestException("Nominal pembayaran harus lebih dari nol.");
    const now = new Date().toISOString();
    const record: PaymentRecord = {
      id: randomUUID(),
      reference: String(input.reference || `MAN-${Date.now()}`).trim(),
      customerEmail,
      amountIdr,
      method: String(input.method || "manual").trim(),
      status: input.status || "paid",
      createdAt: now,
      updatedAt: now,
    };
    this.paymentsValue.set(record.id, record);
    return { ...record };
  }

  updatePayment(id: string, input: Partial<PaymentRecord>) {
    const current = this.paymentsValue.get(id);
    if (!current) throw new NotFoundException("Pembayaran tidak ditemukan.");
    const next: PaymentRecord = {
      ...current,
      status: input.status || current.status,
      reference: input.reference === undefined ? current.reference : String(input.reference).trim(),
      method: input.method === undefined ? current.method : String(input.method).trim(),
      updatedAt: new Date().toISOString(),
    };
    this.paymentsValue.set(id, next);
    return { ...next };
  }

  deletePayment(id: string) {
    if (!this.paymentsValue.delete(id)) throw new NotFoundException("Pembayaran tidak ditemukan.");
    return { ok: true };
  }

  revenue() {
    const payments = this.listPayments();
    const paid = payments.filter((item) => item.status === "paid");
    const refunded = payments.filter((item) => item.status === "refunded");
    const grossIdr = paid.reduce((total, item) => total + item.amountIdr, 0);
    const refundedIdr = refunded.reduce((total, item) => total + item.amountIdr, 0);
    return {
      grossIdr,
      refundedIdr,
      netIdr: grossIdr - refundedIdr,
      paidCount: paid.length,
      pendingCount: payments.filter((item) => item.status === "pending").length,
      failedCount: payments.filter((item) => item.status === "failed").length,
    };
  }

  private seedRoutes(): void {
    const defaultProviders = this.providersForRouter().map((item) => item.code);
    const first = defaultProviders[0] || "gemini";
    const second = defaultProviders[1] || first;
    const planOrders: Record<AdminPlan, [string, string]> = {
      free: [second, first],
      starter: [second, first],
      pro: [first, second],
      enterprise: [first, second],
    };
    for (const plan of Object.keys(planOrders) as AdminPlan[]) {
      for (const module of modules) {
        const [primary, fallback] = planOrders[plan];
        const id = `${plan}-${module}`;
        this.routesValue.set(id, {
          id,
          module,
          plan,
          primary,
          fallback,
          timeoutMs: module === "caption" ? 20_000 : 45_000,
          maxTokens: moduleBudgets[module] || 1000,
          enabled: true,
        });
      }
    }
  }

  private safeProvider(provider: StoredProvider) {
    const { encryptedApiKeys, ...safe } = provider;
    const apiKeys = this.decryptKeys(encryptedApiKeys);
    return {
      ...safe,
      keyCount: apiKeys.length,
      configured: apiKeys.length > 0,
      keyPreview: apiKeys.length ? `${apiKeys[0]!.slice(0, 5)}...${apiKeys[0]!.slice(-4)}` : "",
      status: provider.enabled === false ? "disabled" : !apiKeys.length ? "untested" : provider.health,
    };
  }

  private touch(): void {
    this.revisionValue += 1;
  }

  private encryptKeys(apiKeys: string[]): string[] {
    const secret = String(process.env.PROVIDER_ENCRYPTION_KEY || process.env.LICENSE_KEY_PEPPER || "development-provider-encryption-secret-000000000000");
    return apiKeys.map((key) => encryptSecret(key, secret));
  }

  private decryptKeys(encryptedKeys: string[]): string[] {
    const secret = String(process.env.PROVIDER_ENCRYPTION_KEY || process.env.LICENSE_KEY_PEPPER || "development-provider-encryption-secret-000000000000");
    return encryptedKeys.map((key) => decryptSecret(key, secret));
  }
}

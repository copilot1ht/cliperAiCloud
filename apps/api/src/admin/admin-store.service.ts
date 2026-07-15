import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { providersFromEnv, type ProviderDefinition } from "@cliper/ai-router";
import type { AiModule } from "@cliper/contracts";
import { randomUUID } from "node:crypto";
import { decryptSecret, encryptSecret } from "@cliper/security";

export type AdminPlan = "free" | "starter" | "pro" | "enterprise";

export interface AdminProviderInput {
  code?: string;
  displayName?: string;
  baseUrl?: string;
  model?: string;
  apiKeys?: string | string[];
  enabled?: boolean;
  priority?: number;
  timeoutMs?: number;
  inputUsdPerM?: number;
  outputUsdPerM?: number;
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
  computeCostMicroUsd?: number;
  paymentFeeBps?: number;
  reserveBps?: number;
  minimumChargeMicroUsd?: number;
  microUsdPerCredit?: number;
}

export interface PricingPolicyState {
  markupBps: number;
  computeCostMicroUsd: number;
  paymentFeeBps: number;
  reserveBps: number;
  minimumChargeMicroUsd: number;
  microUsdPerCredit: number;
  updatedAt: string;
}

type StoredProvider = Omit<ProviderDefinition, "apiKeys"> & { id: string; encryptedApiKeys: string[]; updatedAt: string };

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

function normalizeCode(value: string): string {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function keysFromInput(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : value.split(/[\n,]+/);
  return Array.from(new Set(raw.map((item) => String(item).trim()).filter(Boolean)));
}

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
      computeCostMicroUsd: Math.round(finiteNumber(process.env.COMPUTE_COST_MICRO_USD, 0)),
      paymentFeeBps: Math.round(finiteNumber(process.env.PAYMENT_FEE_BPS, 0)),
      reserveBps: Math.round(finiteNumber(process.env.RISK_RESERVE_BPS, 0)),
      minimumChargeMicroUsd: Math.round(finiteNumber(process.env.MINIMUM_REQUEST_MICRO_USD, 0)),
      microUsdPerCredit: Math.max(1, Math.round(finiteNumber(process.env.MICRO_USD_PER_CREDIT, 100))),
      updatedAt: new Date().toISOString(),
    };
    for (const provider of providersFromEnv()) {
      const id = `provider-${provider.code}`;
      const { apiKeys, ...definition } = provider;
      this.providersValue.set(id, { ...definition, id, encryptedApiKeys: this.encryptKeys(apiKeys), updatedAt: new Date().toISOString() });
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
    const paymentFeeBps = input.paymentFeeBps === undefined ? current.paymentFeeBps : Math.round(finiteNumber(input.paymentFeeBps, current.paymentFeeBps));
    const reserveBps = input.reserveBps === undefined ? current.reserveBps : Math.round(finiteNumber(input.reserveBps, current.reserveBps));
    if (markupBps > 100_000 || paymentFeeBps > 10_000 || reserveBps > 10_000) {
      throw new BadRequestException("Pricing basis points melebihi batas aman.");
    }
    this.pricingPolicyValue = {
      markupBps,
      computeCostMicroUsd: input.computeCostMicroUsd === undefined ? current.computeCostMicroUsd : Math.round(finiteNumber(input.computeCostMicroUsd, current.computeCostMicroUsd)),
      paymentFeeBps,
      reserveBps,
      minimumChargeMicroUsd: input.minimumChargeMicroUsd === undefined ? current.minimumChargeMicroUsd : Math.round(finiteNumber(input.minimumChargeMicroUsd, current.minimumChargeMicroUsd)),
      microUsdPerCredit: input.microUsdPerCredit === undefined ? current.microUsdPerCredit : Math.max(1, Math.round(finiteNumber(input.microUsdPerCredit, current.microUsdPerCredit, 1))),
      updatedAt: new Date().toISOString(),
    };
    this.touch();
    return this.pricingPolicy();
  }

  providersForRouter(): ProviderDefinition[] {
    return Array.from(this.providersValue.values()).map(({ id: _id, updatedAt: _updatedAt, encryptedApiKeys, ...provider }) => ({
      ...provider,
      apiKeys: this.decryptKeys(encryptedApiKeys),
    }));
  }

  listProviders() {
    return Array.from(this.providersValue.values()).map((provider) => this.safeProvider(provider));
  }

  createProvider(input: AdminProviderInput) {
    const code = normalizeCode(input.code || input.displayName || "");
    const displayName = String(input.displayName || "").trim();
    const baseUrl = String(input.baseUrl || "").trim().replace(/\/+$/, "");
    const model = String(input.model || "").trim();
    const apiKeys = keysFromInput(input.apiKeys) || [];
    if (!code || !displayName || !baseUrl || !model) {
      throw new BadRequestException("Code, nama provider, base URL, dan model wajib diisi.");
    }
    if (!/^https?:\/\//i.test(baseUrl)) throw new BadRequestException("Base URL provider harus memakai http atau https.");
    if (Array.from(this.providersValue.values()).some((item) => item.code === code)) {
      throw new BadRequestException("Code provider sudah digunakan.");
    }
    const provider: StoredProvider = {
      id: randomUUID(),
      code,
      displayName,
      baseUrl,
      model,
      encryptedApiKeys: this.encryptKeys(apiKeys),
      enabled: input.enabled !== false,
      priority: finiteNumber(input.priority, 100, 1),
      timeoutMs: finiteNumber(input.timeoutMs, 45_000, 5_000),
      inputUsdPerM: finiteNumber(input.inputUsdPerM, 0),
      outputUsdPerM: finiteNumber(input.outputUsdPerM, 0),
      updatedAt: new Date().toISOString(),
    };
    this.providersValue.set(provider.id, provider);
    this.touch();
    return this.safeProvider(provider);
  }

  updateProvider(id: string, input: AdminProviderInput) {
    const current = this.providersValue.get(id);
    if (!current) throw new NotFoundException("Provider tidak ditemukan.");
    const code = input.code === undefined ? current.code : normalizeCode(input.code);
    if (!code) throw new BadRequestException("Code provider tidak valid.");
    if (Array.from(this.providersValue.values()).some((item) => item.id !== id && item.code === code)) {
      throw new BadRequestException("Code provider sudah digunakan.");
    }
    const baseUrl = input.baseUrl === undefined ? current.baseUrl : String(input.baseUrl).trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(baseUrl)) throw new BadRequestException("Base URL provider harus memakai http atau https.");
    const nextKeys = keysFromInput(input.apiKeys);
    const provider: StoredProvider = {
      ...current,
      code,
      displayName: input.displayName === undefined ? current.displayName : String(input.displayName).trim(),
      baseUrl,
      model: input.model === undefined ? current.model : String(input.model).trim(),
      encryptedApiKeys: nextKeys === undefined || nextKeys.length === 0 ? current.encryptedApiKeys : this.encryptKeys(nextKeys),
      enabled: input.enabled === undefined ? current.enabled : Boolean(input.enabled),
      priority: input.priority === undefined ? current.priority : finiteNumber(input.priority, current.priority || 100, 1),
      timeoutMs: input.timeoutMs === undefined ? current.timeoutMs : finiteNumber(input.timeoutMs, current.timeoutMs || 45_000, 5_000),
      inputUsdPerM: input.inputUsdPerM === undefined ? current.inputUsdPerM : finiteNumber(input.inputUsdPerM, current.inputUsdPerM || 0),
      outputUsdPerM: input.outputUsdPerM === undefined ? current.outputUsdPerM : finiteNumber(input.outputUsdPerM, current.outputUsdPerM || 0),
      updatedAt: new Date().toISOString(),
    };
    if (!provider.displayName || !provider.model) throw new BadRequestException("Nama provider dan model wajib diisi.");
    this.providersValue.set(id, provider);
    if (code !== current.code) {
      for (const [routeId, route] of this.routesValue.entries()) {
        this.routesValue.set(routeId, {
          ...route,
          primary: route.primary === current.code ? code : route.primary,
          fallback: route.fallback === current.code ? code : route.fallback,
        });
      }
    }
    this.touch();
    return this.safeProvider(provider);
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
      status: provider.enabled === false ? "disabled" : apiKeys.length ? "ready" : "needs-key",
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

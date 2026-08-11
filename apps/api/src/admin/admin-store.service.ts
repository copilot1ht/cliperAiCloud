import { BadRequestException, Inject, Injectable, NotFoundException, OnModuleInit, Optional } from "@nestjs/common";
import { providersFromEnv, type ProviderDefinition } from "@cliper/ai-router";
import { validateClipJobPricingPolicy, type ClipJobPricingPolicy } from "@cliper/billing";
import type { AiModule } from "@cliper/contracts";
import { randomUUID } from "node:crypto";
import { decryptSecret, encryptSecret } from "@cliper/security";
import { getProviderPreset, isSupportedProvider } from "./provider-catalog.js";
import type { ProviderConnectionResult } from "./provider-connection.service.js";
import { DatabaseService } from "../database/database.service.js";
import { RedisService } from "../security/redis.service.js";

export type AdminPlan = "free" | "starter" | "pro" | "enterprise";

export interface AdminProviderInput {
  provider?: string;
  apiKey?: string;
  enabled?: boolean;
  defaultModel?: string;
  inputUsdPerM?: number;
  cachedInputUsdPerM?: number;
  outputUsdPerM?: number;
  reasoningUsdPerM?: number;
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

export interface PricingPolicyInput extends Partial<ClipJobPricingPolicy> {
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

export interface PricingPolicyState extends ClipJobPricingPolicy {
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
const CONFIG_REVISION_KEY = "cliper:admin-config:revision";

function finiteNumber(value: unknown, fallback: number, minimum = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

@Injectable()
export class AdminStoreService implements OnModuleInit {
  private readonly providersValue = new Map<string, StoredProvider>();
  private readonly routesValue = new Map<string, RoutingRule>();
  private readonly paymentsValue = new Map<string, PaymentRecord>();
  private pricingPolicyValue: PricingPolicyState;
  private revisionValue = 1;
  private distributedRevision?: string;
  private lastConfigCheckAt = 0;
  private refreshInFlight?: Promise<void>;

  constructor(
    @Optional() @Inject(DatabaseService) private readonly database?: DatabaseService,
    @Optional() @Inject(RedisService) private readonly redis?: RedisService,
  ) {
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
      creditValueIdr: Math.max(1, Math.round(finiteNumber(process.env.CLIPER_CREDIT_VALUE_IDR, 1, 1))),
      minimumGrossMarginBps: Math.round(finiteNumber(process.env.MINIMUM_MARGIN_BPS, 5_000, 5_000)),
      targetGrossMarginBps: Math.round(finiteNumber(process.env.TARGET_GROSS_MARGIN_BPS, 6_000, 5_000)),
      baseAnalysisCredits: Math.round(finiteNumber(process.env.BASE_ANALYSIS_CREDITS, 300)),
      optionalClipCredits: Math.round(finiteNumber(process.env.OPTIONAL_CLIP_CREDITS, 50)),
      goodClipCredits: Math.round(finiteNumber(process.env.GOOD_CLIP_CREDITS, 100)),
      premiumClipCredits: Math.round(finiteNumber(process.env.PREMIUM_CLIP_CREDITS, 150)),
      optionalScoreMin: Math.round(finiteNumber(process.env.OPTIONAL_SCORE_MIN, 70)),
      goodScoreMin: Math.round(finiteNumber(process.env.GOOD_SCORE_MIN, 78)),
      premiumScoreMin: Math.round(finiteNumber(process.env.PREMIUM_SCORE_MIN, 90)),
      minimumJobCredits: Math.round(finiteNumber(process.env.MINIMUM_JOB_CREDITS, 300)),
      maximumJobCredits: Math.round(finiteNumber(process.env.MAXIMUM_JOB_CREDITS, 2_000, 1)),
      infrastructureFeeIdr: Math.round(finiteNumber(process.env.INFRASTRUCTURE_FEE_IDR, 50)),
      safetyBufferBps: Math.round(finiteNumber(process.env.SAFETY_BUFFER_BPS, 1_000)),
      retryAllowanceBps: Math.round(finiteNumber(process.env.RETRY_ALLOWANCE_BPS, 500)),
      paymentFeeAllocationBps: Math.round(finiteNumber(process.env.PAYMENT_FEE_ALLOCATION_BPS, 0)),
      targetProviderCostIdr: Math.round(finiteNumber(process.env.TARGET_PROVIDER_COST_IDR, 250)),
      warningProviderCostIdr: Math.round(finiteNumber(process.env.WARNING_PROVIDER_COST_IDR, 400)),
      hardProviderCostIdr: Math.round(finiteNumber(process.env.HARD_PROVIDER_COST_IDR, 500)),
      lowBalanceWarningCredits: Math.round(finiteNumber(process.env.LOW_BALANCE_WARNING_CREDITS, 5_000)),
      updatedAt: new Date().toISOString(),
    };
    const validation = validateClipJobPricingPolicy(this.pricingPolicyValue);
    if (!validation.valid) {
      throw new Error(`Konfigurasi pricing job tidak aman: ${validation.errors.join(" ")}`);
    }
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
    this.repairRoutesForProviders();
  }

  async onModuleInit(): Promise<void> {
    await this.reloadFromDatabase();
  }

  async reloadFromDatabase(): Promise<void> {
    if (!this.database?.configured()) return;
    const client = this.database.client();
    const [providers, routes, pricing] = await Promise.all([
      client.aiProvider.findMany({ orderBy: [{ priority: "asc" }, { createdAt: "asc" }] }),
      client.routingRule.findMany({ orderBy: [{ planCode: "asc" }, { module: "asc" }] }),
      client.pricingPolicy.findFirst({
        where: { isDefault: true, effectiveTo: null },
        orderBy: { effectiveFrom: "desc" },
      }),
    ]);

    if (providers.length) {
      this.providersValue.clear();
      for (const row of providers) {
        const encryptedApiKeys = this.parseEncryptedKeyBundle(row.encryptedKeyBundle);
        const availableModels = Array.isArray(row.availableModels)
          ? row.availableModels.map(String).filter(Boolean)
          : [];
        this.providersValue.set(row.id, {
          id: row.id,
          code: row.code,
          displayName: row.displayName,
          baseUrl: row.baseUrl,
          protocol: row.protocol === "anthropic-messages" ? "anthropic-messages" : "openai-chat",
          model: row.defaultModel,
          encryptedApiKeys,
          availableModels,
          health: row.status === "HEALTHY" ? "healthy" : row.status === "OFFLINE" ? "offline" : "untested",
          lastHealthAt: row.lastHealthAt?.toISOString(),
          lastLatencyMs: row.lastLatencyMs ?? undefined,
          lastError: row.lastHealthMessage || undefined,
          modelSource: row.modelSource === "api" ? "api" : "preset",
          enabled: row.enabled,
          priority: row.priority,
          timeoutMs: row.timeoutMs,
          inputUsdPerM: Number(row.inputUsdPerM),
          cachedInputUsdPerM: Number(row.cachedInputUsdPerM),
          outputUsdPerM: Number(row.outputUsdPerM),
          reasoningUsdPerM: Number(row.reasoningUsdPerM),
          updatedAt: row.updatedAt.toISOString(),
        });
      }
    } else {
      await Promise.all(Array.from(this.providersValue.keys()).map((id) => this.persistProvider(id)));
    }

    if (routes.length) {
      this.routesValue.clear();
      for (const row of routes) {
        const order = Array.isArray(row.providerOrder) ? row.providerOrder.map(String).filter(Boolean) : [];
        const overrides = this.objectValue(row.modelOverrides);
        const plan = row.planCode.toLowerCase() as AdminPlan;
        this.routesValue.set(`${plan}-${row.module}`, {
          id: row.id,
          module: row.module as AiModule,
          plan,
          primary: order[0] || "",
          fallback: order[1] || order[0] || "",
          timeoutMs: row.timeoutMs,
          maxTokens: finiteNumber(overrides.maxTokens, moduleBudgets[row.module as AiModule] || 1000, 32),
          enabled: row.enabled,
        });
      }
    } else {
      await Promise.all(this.listRoutes().map((route) => this.persistRoute(route.id)));
    }
    const repairedRoutes = this.repairRoutesForProviders();
    if (repairedRoutes.length) {
      await Promise.all(repairedRoutes.map((id) => this.persistRoute(id)));
    }

    if (pricing) {
      this.pricingPolicyValue = {
        ...this.pricingPolicyValue,
        markupBps: pricing.markupBps,
        minimumMarginBps: pricing.minimumMarginBps,
        computeCostMicroUsd: Number(pricing.computeCostMicroUsd),
        paymentFeeBps: pricing.paymentFeeBps,
        reserveBps: pricing.reserveBps,
        minimumChargeMicroUsd: Number(pricing.minimumChargeMicroUsd),
        minimumClipChargeMicroUsd: Number(pricing.minimumClipChargeMicroUsd),
        microUsdPerCredit: Number(pricing.microUsdPerCredit),
        creditValueIdr: pricing.creditValueIdr,
        minimumGrossMarginBps: pricing.minimumMarginBps,
        targetGrossMarginBps: pricing.targetMarginBps,
        baseAnalysisCredits: pricing.baseAnalysisCredits,
        optionalClipCredits: pricing.optionalClipCredits,
        goodClipCredits: pricing.goodClipCredits,
        premiumClipCredits: pricing.premiumClipCredits,
        optionalScoreMin: pricing.optionalScoreMin,
        goodScoreMin: pricing.goodScoreMin,
        premiumScoreMin: pricing.premiumScoreMin,
        minimumJobCredits: pricing.minimumJobCredits,
        maximumJobCredits: pricing.maximumJobCredits,
        infrastructureFeeIdr: pricing.infrastructureFeeIdr,
        safetyBufferBps: pricing.safetyBufferBps,
        retryAllowanceBps: pricing.retryAllowanceBps,
        paymentFeeAllocationBps: pricing.paymentFeeAllocationBps,
        targetProviderCostIdr: pricing.targetProviderCostIdr,
        warningProviderCostIdr: pricing.warningProviderCostIdr,
        hardProviderCostIdr: pricing.hardProviderCostIdr,
        lowBalanceWarningCredits: pricing.lowBalanceWarningCredits,
        usdToIdr: pricing.usdToIdr,
        updatedAt: pricing.updatedAt.toISOString(),
      };
    } else {
      await this.persistPricingPolicy();
    }
    this.touch();
    this.lastConfigCheckAt = Date.now();
  }

  async refreshIfStale(): Promise<void> {
    if (!this.database?.configured()) return;
    const now = Date.now();
    const intervalMs = Math.min(
      10 * 60_000,
      finiteNumber(process.env.ADMIN_CONFIG_REFRESH_MS, 60_000, 5_000),
    );
    if (now - this.lastConfigCheckAt < intervalMs) return;
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      const remoteRevision = await this.redis?.get(CONFIG_REVISION_KEY);
      if (remoteRevision && remoteRevision === this.distributedRevision) {
        this.lastConfigCheckAt = Date.now();
        return;
      }
      await this.reloadFromDatabase();
      this.distributedRevision = remoteRevision;
    })().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
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
    const next: PricingPolicyState = {
      markupBps,
      minimumMarginBps,
      computeCostMicroUsd: input.computeCostMicroUsd === undefined ? current.computeCostMicroUsd : Math.round(finiteNumber(input.computeCostMicroUsd, current.computeCostMicroUsd)),
      paymentFeeBps,
      reserveBps,
      minimumChargeMicroUsd: input.minimumChargeMicroUsd === undefined ? current.minimumChargeMicroUsd : Math.round(finiteNumber(input.minimumChargeMicroUsd, current.minimumChargeMicroUsd)),
      minimumClipChargeMicroUsd: input.minimumClipChargeMicroUsd === undefined ? current.minimumClipChargeMicroUsd : Math.round(finiteNumber(input.minimumClipChargeMicroUsd, current.minimumClipChargeMicroUsd)),
      microUsdPerCredit: input.microUsdPerCredit === undefined ? current.microUsdPerCredit : Math.max(1, Math.round(finiteNumber(input.microUsdPerCredit, current.microUsdPerCredit, 1))),
      usdToIdr: input.usdToIdr === undefined ? current.usdToIdr : Math.max(1, Math.round(finiteNumber(input.usdToIdr, current.usdToIdr, 1))),
      creditValueIdr: input.creditValueIdr === undefined ? current.creditValueIdr : Math.max(1, Math.round(finiteNumber(input.creditValueIdr, current.creditValueIdr, 1))),
      minimumGrossMarginBps: input.minimumGrossMarginBps === undefined ? current.minimumGrossMarginBps : Math.round(finiteNumber(input.minimumGrossMarginBps, current.minimumGrossMarginBps, 5_000)),
      targetGrossMarginBps: input.targetGrossMarginBps === undefined ? current.targetGrossMarginBps : Math.round(finiteNumber(input.targetGrossMarginBps, current.targetGrossMarginBps, 5_000)),
      baseAnalysisCredits: input.baseAnalysisCredits === undefined ? current.baseAnalysisCredits : Math.round(finiteNumber(input.baseAnalysisCredits, current.baseAnalysisCredits)),
      optionalClipCredits: input.optionalClipCredits === undefined ? current.optionalClipCredits : Math.round(finiteNumber(input.optionalClipCredits, current.optionalClipCredits)),
      goodClipCredits: input.goodClipCredits === undefined ? current.goodClipCredits : Math.round(finiteNumber(input.goodClipCredits, current.goodClipCredits)),
      premiumClipCredits: input.premiumClipCredits === undefined ? current.premiumClipCredits : Math.round(finiteNumber(input.premiumClipCredits, current.premiumClipCredits)),
      optionalScoreMin: input.optionalScoreMin === undefined ? current.optionalScoreMin : Math.round(finiteNumber(input.optionalScoreMin, current.optionalScoreMin)),
      goodScoreMin: input.goodScoreMin === undefined ? current.goodScoreMin : Math.round(finiteNumber(input.goodScoreMin, current.goodScoreMin)),
      premiumScoreMin: input.premiumScoreMin === undefined ? current.premiumScoreMin : Math.round(finiteNumber(input.premiumScoreMin, current.premiumScoreMin)),
      minimumJobCredits: input.minimumJobCredits === undefined ? current.minimumJobCredits : Math.round(finiteNumber(input.minimumJobCredits, current.minimumJobCredits)),
      maximumJobCredits: input.maximumJobCredits === undefined ? current.maximumJobCredits : Math.max(1, Math.round(finiteNumber(input.maximumJobCredits, current.maximumJobCredits, 1))),
      infrastructureFeeIdr: input.infrastructureFeeIdr === undefined ? current.infrastructureFeeIdr : Math.round(finiteNumber(input.infrastructureFeeIdr, current.infrastructureFeeIdr)),
      safetyBufferBps: input.safetyBufferBps === undefined ? current.safetyBufferBps : Math.round(finiteNumber(input.safetyBufferBps, current.safetyBufferBps)),
      retryAllowanceBps: input.retryAllowanceBps === undefined ? current.retryAllowanceBps : Math.round(finiteNumber(input.retryAllowanceBps, current.retryAllowanceBps)),
      paymentFeeAllocationBps: input.paymentFeeAllocationBps === undefined ? current.paymentFeeAllocationBps : Math.round(finiteNumber(input.paymentFeeAllocationBps, current.paymentFeeAllocationBps)),
      targetProviderCostIdr: input.targetProviderCostIdr === undefined ? current.targetProviderCostIdr : Math.round(finiteNumber(input.targetProviderCostIdr, current.targetProviderCostIdr)),
      warningProviderCostIdr: input.warningProviderCostIdr === undefined ? current.warningProviderCostIdr : Math.round(finiteNumber(input.warningProviderCostIdr, current.warningProviderCostIdr)),
      hardProviderCostIdr: input.hardProviderCostIdr === undefined ? current.hardProviderCostIdr : Math.round(finiteNumber(input.hardProviderCostIdr, current.hardProviderCostIdr)),
      lowBalanceWarningCredits: input.lowBalanceWarningCredits === undefined ? current.lowBalanceWarningCredits : Math.round(finiteNumber(input.lowBalanceWarningCredits, current.lowBalanceWarningCredits)),
      updatedAt: new Date().toISOString(),
    };
    const validation = validateClipJobPricingPolicy(next);
    if (!validation.valid) throw new BadRequestException(validation.errors.join(" "));
    this.pricingPolicyValue = next;
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
      const pricingConfigured = this.providerPricingConfigured(stored);
      const allowZeroPricing = String(process.env.ALLOW_ZERO_PROVIDER_PRICING || "false").toLowerCase() === "true";
      const apiKeys = this.decryptKeys(encryptedApiKeys);
      return {
        ...provider,
        enabled: provider.enabled !== false && apiKeys.length > 0 && (pricingConfigured || allowZeroPricing),
        apiKeys,
      };
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
      inputUsdPerM: this.providerRate(input.inputUsdPerM, existing?.inputUsdPerM, connection.provider, "INPUT"),
      cachedInputUsdPerM: this.providerRate(input.cachedInputUsdPerM, existing?.cachedInputUsdPerM, connection.provider, "CACHED_INPUT"),
      outputUsdPerM: this.providerRate(input.outputUsdPerM, existing?.outputUsdPerM, connection.provider, "OUTPUT"),
      reasoningUsdPerM: this.providerRate(input.reasoningUsdPerM, existing?.reasoningUsdPerM, connection.provider, "REASONING"),
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
      inputUsdPerM: input.inputUsdPerM === undefined ? current.inputUsdPerM : finiteNumber(input.inputUsdPerM, current.inputUsdPerM || 0),
      cachedInputUsdPerM: input.cachedInputUsdPerM === undefined ? current.cachedInputUsdPerM : finiteNumber(input.cachedInputUsdPerM, current.cachedInputUsdPerM || 0),
      outputUsdPerM: input.outputUsdPerM === undefined ? current.outputUsdPerM : finiteNumber(input.outputUsdPerM, current.outputUsdPerM || 0),
      reasoningUsdPerM: input.reasoningUsdPerM === undefined ? current.reasoningUsdPerM : finiteNumber(input.reasoningUsdPerM, current.reasoningUsdPerM || 0),
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

  repairRoutesForProviders(): string[] {
    const providers = Array.from(this.providersValue.values())
      .filter((provider) => provider.enabled !== false && this.decryptKeys(provider.encryptedApiKeys).length > 0)
      .sort((left, right) => (left.priority || 100) - (right.priority || 100));
    const codes = providers.map((provider) => provider.code);
    if (!codes.length) return [];
    const preferredPrimary = (module: AiModule, plan: AdminPlan) => {
      const languageTask = module === "title" || module === "hook" || module === "metadata";
      const qualityReviewTask = module === "ranking" && (plan === "pro" || plan === "enterprise");
      if (qualityReviewTask && codes.includes("openai")) return "openai";
      if (languageTask && codes.includes("openai")) return "openai";
      if (!languageTask && codes.includes("deepseek")) return "deepseek";
      return codes[0]!;
    };
    const changed: string[] = [];
    for (const route of this.routesValue.values()) {
      const preferred = preferredPrimary(route.module, route.plan);
      const currentPrimaryValid = codes.includes(route.primary);
      const deepSeekPrimaryTask = (
        route.module === "story"
        || route.module === "highlight"
        || route.module === "caption"
        || (route.module === "ranking" && (route.plan === "free" || route.plan === "starter"))
      );
      const shouldUsePreferred = codes.includes(preferred)
        && ((route.module === "title" || route.module === "hook" || route.module === "metadata"
          || (route.module === "ranking" && (route.plan === "pro" || route.plan === "enterprise"))
          || deepSeekPrimaryTask)
          ? route.primary !== preferred
          : !currentPrimaryValid);
      const primary = shouldUsePreferred ? preferred : currentPrimaryValid ? route.primary : preferred;
      const fallbackCandidates = codes.filter((code) => code !== primary);
      const fallback = codes.includes(route.fallback) && route.fallback !== primary
        ? route.fallback
        : fallbackCandidates[0] || primary;
      if (primary === route.primary && fallback === route.fallback) continue;
      this.routesValue.set(route.id, { ...route, primary, fallback });
      changed.push(route.id);
    }
    if (changed.length) this.touch();
    return changed;
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

  async persistProvider(id: string): Promise<void> {
    if (!this.database?.configured()) return;
    const provider = this.providersValue.get(id);
    if (!provider) return;
    await this.database.client().aiProvider.upsert({
      where: { code: provider.code },
      create: {
        id: provider.id,
        code: provider.code,
        displayName: provider.displayName,
        baseUrl: provider.baseUrl,
        protocol: provider.protocol || "openai-chat",
        encryptedKeyBundle: JSON.stringify(provider.encryptedApiKeys),
        defaultModel: provider.model,
        availableModels: provider.availableModels,
        modelSource: provider.modelSource,
        status: provider.enabled === false ? "DISABLED" : provider.health === "healthy" ? "HEALTHY" : provider.health === "offline" ? "OFFLINE" : "DEGRADED",
        enabled: provider.enabled !== false,
        priority: provider.priority || 100,
        timeoutMs: provider.timeoutMs || 45_000,
        inputUsdPerM: provider.inputUsdPerM || 0,
        cachedInputUsdPerM: provider.cachedInputUsdPerM || 0,
        outputUsdPerM: provider.outputUsdPerM || 0,
        reasoningUsdPerM: provider.reasoningUsdPerM || 0,
        lastHealthAt: provider.lastHealthAt ? new Date(provider.lastHealthAt) : undefined,
        lastLatencyMs: provider.lastLatencyMs,
        lastHealthMessage: provider.lastError,
        lastModelSyncAt: provider.lastHealthAt ? new Date(provider.lastHealthAt) : undefined,
      },
      update: {
        displayName: provider.displayName,
        baseUrl: provider.baseUrl,
        protocol: provider.protocol || "openai-chat",
        encryptedKeyBundle: JSON.stringify(provider.encryptedApiKeys),
        defaultModel: provider.model,
        availableModels: provider.availableModels,
        modelSource: provider.modelSource,
        status: provider.enabled === false ? "DISABLED" : provider.health === "healthy" ? "HEALTHY" : provider.health === "offline" ? "OFFLINE" : "DEGRADED",
        enabled: provider.enabled !== false,
        priority: provider.priority || 100,
        timeoutMs: provider.timeoutMs || 45_000,
        inputUsdPerM: provider.inputUsdPerM || 0,
        cachedInputUsdPerM: provider.cachedInputUsdPerM || 0,
        outputUsdPerM: provider.outputUsdPerM || 0,
        reasoningUsdPerM: provider.reasoningUsdPerM || 0,
        lastHealthAt: provider.lastHealthAt ? new Date(provider.lastHealthAt) : null,
        lastLatencyMs: provider.lastLatencyMs ?? null,
        lastHealthMessage: provider.lastError ?? null,
        lastModelSyncAt: provider.lastHealthAt ? new Date(provider.lastHealthAt) : null,
      },
    });
    await this.publishConfigRevision();
  }

  async persistProviderDeletion(id: string): Promise<void> {
    if (!this.database?.configured()) return;
    await this.database.client().aiProvider.deleteMany({ where: { id } });
    await this.publishConfigRevision();
  }

  async persistRoute(id: string): Promise<void> {
    if (!this.database?.configured()) return;
    const route = this.routesValue.get(id);
    if (!route) return;
    await this.database.client().routingRule.upsert({
      where: { module_planCode: { module: route.module, planCode: route.plan.toUpperCase() as "FREE" | "STARTER" | "PRO" | "ENTERPRISE" } },
      create: {
        module: route.module,
        planCode: route.plan.toUpperCase() as "FREE" | "STARTER" | "PRO" | "ENTERPRISE",
        providerOrder: [route.primary, route.fallback].filter(Boolean),
        modelOverrides: { maxTokens: route.maxTokens },
        timeoutMs: route.timeoutMs,
        enabled: route.enabled,
      },
      update: {
        providerOrder: [route.primary, route.fallback].filter(Boolean),
        modelOverrides: { maxTokens: route.maxTokens },
        timeoutMs: route.timeoutMs,
        enabled: route.enabled,
      },
    });
    await this.publishConfigRevision();
  }

  async persistPricingPolicy(): Promise<void> {
    if (!this.database?.configured()) return;
    const policy = this.pricingPolicyValue;
    await this.database.client().pricingPolicy.upsert({
      where: { id: "default-pricing" },
      create: {
        id: "default-pricing",
        name: "Default cost-based pricing",
        markupBps: policy.markupBps,
        computeCostMicroUsd: BigInt(policy.computeCostMicroUsd),
        paymentFeeBps: policy.paymentFeeBps,
        reserveBps: policy.reserveBps,
        minimumChargeMicroUsd: BigInt(policy.minimumChargeMicroUsd),
        minimumClipChargeMicroUsd: BigInt(policy.minimumClipChargeMicroUsd),
        microUsdPerCredit: BigInt(policy.microUsdPerCredit),
        creditValueIdr: policy.creditValueIdr,
        minimumMarginBps: policy.minimumMarginBps,
        targetMarginBps: policy.targetGrossMarginBps,
        baseAnalysisCredits: policy.baseAnalysisCredits,
        optionalClipCredits: policy.optionalClipCredits,
        goodClipCredits: policy.goodClipCredits,
        premiumClipCredits: policy.premiumClipCredits,
        optionalScoreMin: policy.optionalScoreMin,
        goodScoreMin: policy.goodScoreMin,
        premiumScoreMin: policy.premiumScoreMin,
        minimumJobCredits: policy.minimumJobCredits,
        maximumJobCredits: policy.maximumJobCredits,
        infrastructureFeeIdr: policy.infrastructureFeeIdr,
        safetyBufferBps: policy.safetyBufferBps,
        retryAllowanceBps: policy.retryAllowanceBps,
        paymentFeeAllocationBps: policy.paymentFeeAllocationBps,
        targetProviderCostIdr: policy.targetProviderCostIdr,
        warningProviderCostIdr: policy.warningProviderCostIdr,
        hardProviderCostIdr: policy.hardProviderCostIdr,
        lowBalanceWarningCredits: policy.lowBalanceWarningCredits,
        usdToIdr: policy.usdToIdr,
        isDefault: true,
      },
      update: {
        markupBps: policy.markupBps,
        computeCostMicroUsd: BigInt(policy.computeCostMicroUsd),
        paymentFeeBps: policy.paymentFeeBps,
        reserveBps: policy.reserveBps,
        minimumChargeMicroUsd: BigInt(policy.minimumChargeMicroUsd),
        minimumClipChargeMicroUsd: BigInt(policy.minimumClipChargeMicroUsd),
        microUsdPerCredit: BigInt(policy.microUsdPerCredit),
        creditValueIdr: policy.creditValueIdr,
        minimumMarginBps: policy.minimumMarginBps,
        targetMarginBps: policy.targetGrossMarginBps,
        baseAnalysisCredits: policy.baseAnalysisCredits,
        optionalClipCredits: policy.optionalClipCredits,
        goodClipCredits: policy.goodClipCredits,
        premiumClipCredits: policy.premiumClipCredits,
        optionalScoreMin: policy.optionalScoreMin,
        goodScoreMin: policy.goodScoreMin,
        premiumScoreMin: policy.premiumScoreMin,
        minimumJobCredits: policy.minimumJobCredits,
        maximumJobCredits: policy.maximumJobCredits,
        infrastructureFeeIdr: policy.infrastructureFeeIdr,
        safetyBufferBps: policy.safetyBufferBps,
        retryAllowanceBps: policy.retryAllowanceBps,
        paymentFeeAllocationBps: policy.paymentFeeAllocationBps,
        targetProviderCostIdr: policy.targetProviderCostIdr,
        warningProviderCostIdr: policy.warningProviderCostIdr,
        hardProviderCostIdr: policy.hardProviderCostIdr,
        lowBalanceWarningCredits: policy.lowBalanceWarningCredits,
        usdToIdr: policy.usdToIdr,
        isDefault: true,
      },
    });
    await this.publishConfigRevision();
  }

  private async publishConfigRevision(): Promise<void> {
    const revision = `${Date.now()}:${randomUUID()}`;
    this.distributedRevision = revision;
    this.lastConfigCheckAt = Date.now();
    await this.redis?.set(CONFIG_REVISION_KEY, revision, 24 * 60 * 60_000);
  }

  private safeProvider(provider: StoredProvider) {
    const { encryptedApiKeys, ...safe } = provider;
    const apiKeys = this.decryptKeys(encryptedApiKeys);
    return {
      ...safe,
      pricingConfigured: this.providerPricingConfigured(provider),
      keyCount: apiKeys.length,
      configured: apiKeys.length > 0,
      keyPreview: apiKeys.length ? `${apiKeys[0]!.slice(0, 5)}...${apiKeys[0]!.slice(-4)}` : "",
      status: provider.enabled === false ? "disabled" : !apiKeys.length ? "untested" : provider.health,
    };
  }

  private touch(): void {
    this.revisionValue += 1;
  }

  private providerPricingConfigured(provider: StoredProvider): boolean {
    // Input and output are the minimum complete basis for a real cost
    // calculation. Cached/reasoning rates are optional and fall back to the
    // regular input/output rate in the router when unavailable.
    return finiteNumber(provider.inputUsdPerM, 0) > 0
      && finiteNumber(provider.outputUsdPerM, 0) > 0;
  }

  private providerRate(input: unknown, existing: unknown, providerCode: string, rate: string): number {
    if (input !== undefined) return finiteNumber(input, 0);
    if (finiteNumber(existing, 0) > 0) return finiteNumber(existing, 0);
    return finiteNumber(process.env[`${providerCode.toUpperCase()}_${rate}_USD_PER_M`], 0);
  }

  private parseEncryptedKeyBundle(value: string): string[] {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch {
      return value ? [value] : [];
    }
  }

  private objectValue(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private encryptKeys(apiKeys: string[]): string[] {
    const secret = String(process.env.PROVIDER_ENCRYPTION_KEY || process.env.LICENSE_KEY_PEPPER || "development-provider-encryption-secret-000000000000");
    return apiKeys.map((key) => encryptSecret(key, secret));
  }

  private decryptKeys(encryptedKeys: string[]): string[] {
    const secret = String(process.env.PROVIDER_ENCRYPTION_KEY || process.env.LICENSE_KEY_PEPPER || "development-provider-encryption-secret-000000000000");
    const decrypted: string[] = [];
    for (const key of encryptedKeys) {
      try {
        const value = decryptSecret(key, secret);
        if (value) decrypted.push(value);
      } catch {
        // A rotated/mismatched encryption secret invalidates the old envelope.
        // Keep the control plane available and require the admin to save a new
        // provider key; never expose or reuse unauthenticated ciphertext.
      }
    }
    return decrypted;
  }
}

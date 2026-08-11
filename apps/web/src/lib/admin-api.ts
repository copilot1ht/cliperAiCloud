export type PlanCode = "free" | "starter" | "pro" | "enterprise";

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "investor" | "member";
  plan: PlanCode;
  status: "active" | "suspended";
  credits: number;
  unlimitedCredits: boolean;
  deviceLimit: number;
  createdAt: string;
  lastActiveAt: string;
  passwordRecovery?: {
    mode: "admin-assisted";
    status: "normal" | "reset_required";
    expiresAt: string | null;
  };
  protected: boolean;
}

export interface AdminPlan {
  code: PlanCode;
  name: string;
  priceIdr: number;
  credits: number;
  deviceLimit: number;
  active: boolean;
}

export interface AdminProvider {
  id: string;
  code: string;
  displayName: string;
  baseUrl: string;
  protocol: "openai-chat" | "anthropic-messages";
  model: string;
  availableModels: string[];
  health: "healthy" | "offline" | "untested";
  lastHealthAt?: string;
  lastLatencyMs?: number;
  lastError?: string;
  modelSource: "api" | "preset";
  enabled: boolean;
  priority: number;
  timeoutMs: number;
  inputUsdPerM: number;
  cachedInputUsdPerM: number;
  outputUsdPerM: number;
  reasoningUsdPerM: number;
  pricingConfigured: boolean;
  updatedAt: string;
  keyCount: number;
  configured: boolean;
  keyPreview: string;
  status: "healthy" | "offline" | "untested" | "disabled";
}

export interface ProviderCatalogItem {
  code: "deepseek" | "gemini" | "openai" | "qwen" | "claude";
  displayName: string;
}

export interface ProviderTestResult {
  provider: ProviderCatalogItem["code"];
  displayName: string;
  models: string[];
  defaultModel: string;
  latencyMs: number;
  health: "healthy";
  checkedAt: string;
}

export interface RoutingRule {
  id: string;
  module: string;
  plan: PlanCode;
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
  status: "paid" | "pending" | "failed" | "expired" | "refunded";
  environment: "test" | "production";
  createdAt: string;
  updatedAt: string;
}

export interface PricingPolicy {
  markupBps: number;
  minimumMarginBps: number;
  computeCostMicroUsd: number;
  paymentFeeBps: number;
  reserveBps: number;
  minimumChargeMicroUsd: number;
  minimumClipChargeMicroUsd: number;
  microUsdPerCredit: number;
  usdToIdr: number;
  creditValueIdr: number;
  minimumGrossMarginBps: number;
  targetGrossMarginBps: number;
  baseAnalysisCredits: number;
  optionalClipCredits: number;
  goodClipCredits: number;
  premiumClipCredits: number;
  optionalScoreMin: number;
  goodScoreMin: number;
  premiumScoreMin: number;
  minimumJobCredits: number;
  maximumJobCredits: number;
  infrastructureFeeIdr: number;
  safetyBufferBps: number;
  retryAllowanceBps: number;
  paymentFeeAllocationBps: number;
  targetProviderCostIdr: number;
  warningProviderCostIdr: number;
  hardProviderCostIdr: number;
  lowBalanceWarningCredits: number;
  updatedAt: string;
}

export async function adminFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    cache: "no-store",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = Array.isArray(payload?.message) ? payload.message.join(" ") : payload?.message;
    throw new Error(message || `Request gagal (${response.status}).`);
  }
  return payload as T;
}

export function formatIdr(value: number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(value || 0));
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(Number(value || 0));
}

export function formatDate(value: string): string {
  if (!value) return "Belum pernah";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
import { apiBase } from "./api-base";

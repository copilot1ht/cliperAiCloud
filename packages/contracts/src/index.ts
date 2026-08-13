export const AI_MODULES = ["story", "ranking", "highlight", "title", "hook", "caption", "metadata", "test", "default"] as const;
export type AiModule = (typeof AI_MODULES)[number];

export const PLAN_CODES = ["free", "starter", "pro", "team", "enterprise"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface CliperChatRequest {
  model?: string;
  module?: AiModule;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  metadata?: Record<string, string | number | boolean>;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_input_tokens?: number;
  reasoning_tokens?: number;
  usage_source?: "provider" | "estimated";
}

export interface CliperChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  provider: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: string;
  }>;
  usage: TokenUsage;
  billing: {
    credit_charge_micro: number;
  };
  integrity?: {
    timestamp: string;
    checksum: string;
    signature: string;
  };
}

export interface CliperInternalChatResponse extends Omit<CliperChatResponse, "billing"> {
  billing: {
    provider_cost_usd: number;
    service_cost_usd: number;
    billed_cost_usd: number;
    gross_profit_usd: number;
    credit_charge_micro: number;
    markup_bps: number;
    markup_percent: number;
  };
  routing?: {
    retry_count: number;
    fallback_count: number;
  };
}

export interface ProviderHealth {
  code: string;
  displayName: string;
  status: "healthy" | "degraded" | "offline" | "disabled";
  model: string;
  keyCount: number;
  latencyMs?: number;
  lastError?: string;
}

export interface LicenseValidationRequest {
  key: string;
  deviceFingerprint: string;
  deviceName?: string;
  appVersion?: string;
}

export interface WalletSnapshot {
  currency: "USD";
  availableMicroUsd: number;
  reservedMicroUsd: number;
  spendableMicroUsd: number;
  availableUsd: number;
  reservedUsd: number;
  spendableUsd: number;
  unlimited?: boolean;
}

export interface LicenseValidationResponse {
  valid: boolean;
  status?: "active" | "expired" | "suspended" | "revoked";
  plan?: string;
  expiresAt?: string;
  deviceSlots?: { used: number; limit: number };
  wallet?: WalletSnapshot;
  keyType?: "user" | "internal";
  cloudConnected?: boolean;
  billingEligible?: boolean;
  unlimited?: boolean;
  reason?: string;
}

export interface DesktopActivateRequest extends LicenseValidationRequest {}

export interface DesktopSessionResponse {
  status: "active";
  accessToken: string;
  refreshToken: string;
  signingSecret: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  offlineGraceUntil: string;
  license: {
    plan: string;
    wallet: WalletSnapshot;
    keyType: "user" | "internal";
    cloudConnected: boolean;
    billingEligible: boolean;
    unlimited?: boolean;
    deviceSlots: { used: number; limit: number };
    expiresAt?: string;
  };
}

export interface DesktopRefreshRequest {
  refreshToken: string;
  deviceFingerprint: string;
}

export interface DesktopHeartbeatResponse {
  status: "active";
  serverTime: string;
  accessExpiresAt: string;
  offlineGraceUntil: string;
  wallet: WalletSnapshot;
  keyType: "user" | "internal";
  cloudConnected: boolean;
  billingEligible: boolean;
  unlimited?: boolean;
}

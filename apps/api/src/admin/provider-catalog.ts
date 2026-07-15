import type { ProviderProtocol } from "@cliper/ai-router";

export const supportedProviderCodes = ["deepseek", "gemini", "openai", "qwen", "claude"] as const;
export type SupportedProviderCode = (typeof supportedProviderCodes)[number];

export interface ProviderPreset {
  code: SupportedProviderCode;
  displayName: string;
  baseUrls: string[];
  protocol: ProviderProtocol;
  defaultModel: string;
  preferredModels: string[];
  timeoutMs: number;
  priority: number;
}

const catalog: Record<SupportedProviderCode, ProviderPreset> = {
  deepseek: {
    code: "deepseek",
    displayName: "DeepSeek",
    baseUrls: ["https://api.deepseek.com"],
    protocol: "openai-chat",
    defaultModel: "deepseek-v4-flash",
    preferredModels: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
    timeoutMs: 45_000,
    priority: 10,
  },
  gemini: {
    code: "gemini",
    displayName: "Google Gemini",
    baseUrls: ["https://generativelanguage.googleapis.com/v1beta/openai"],
    protocol: "openai-chat",
    defaultModel: "gemini-3.5-flash",
    preferredModels: ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-3-flash-preview", "gemini-2.5-flash"],
    timeoutMs: 45_000,
    priority: 20,
  },
  openai: {
    code: "openai",
    displayName: "OpenAI",
    baseUrls: ["https://api.openai.com/v1"],
    protocol: "openai-chat",
    defaultModel: "gpt-5-mini",
    preferredModels: ["gpt-5-mini", "gpt-5.1-mini", "gpt-4.1-mini", "gpt-4o-mini"],
    timeoutMs: 45_000,
    priority: 30,
  },
  qwen: {
    code: "qwen",
    displayName: "Qwen",
    baseUrls: [
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
    ],
    protocol: "openai-chat",
    defaultModel: "qwen3.7-plus",
    preferredModels: ["qwen3.7-plus", "qwen3.7-max", "qwen3.6-flash", "qwen-plus", "qwen-flash"],
    timeoutMs: 45_000,
    priority: 40,
  },
  claude: {
    code: "claude",
    displayName: "Claude",
    baseUrls: ["https://api.anthropic.com/v1"],
    protocol: "anthropic-messages",
    defaultModel: "claude-sonnet-4-6",
    preferredModels: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"],
    timeoutMs: 45_000,
    priority: 50,
  },
};

export function isSupportedProvider(value: unknown): value is SupportedProviderCode {
  return supportedProviderCodes.includes(String(value || "").trim().toLowerCase() as SupportedProviderCode);
}

export function getProviderPreset(code: SupportedProviderCode): ProviderPreset {
  return catalog[code];
}

export function listProviderCatalog() {
  return supportedProviderCodes.map((code) => {
    const item = catalog[code];
    return { code: item.code, displayName: item.displayName };
  });
}

export function providerAcceptsModel(code: SupportedProviderCode, model: string): boolean {
  const value = model.toLowerCase();
  if (code === "deepseek") return value.startsWith("deepseek-");
  if (code === "gemini") return value.startsWith("gemini-");
  if (code === "openai") return /^(gpt-|o\d|chatgpt-)/.test(value);
  if (code === "qwen") return value.startsWith("qwen");
  return value.startsWith("claude-");
}

export function chooseDefaultModel(preset: ProviderPreset, models: string[]): string {
  for (const preferred of preset.preferredModels) {
    if (models.includes(preferred)) return preferred;
  }
  return models[0] || preset.defaultModel;
}

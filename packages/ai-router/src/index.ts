import type { AiModule, CliperChatRequest, CliperInternalChatResponse, ProviderHealth } from "@cliper/contracts";

export type ProviderProtocol = "openai-chat" | "anthropic-messages";

export interface ProviderDefinition {
  code: string;
  displayName: string;
  baseUrl: string;
  model: string;
  apiKeys: string[];
  protocol?: ProviderProtocol;
  modules?: AiModule[];
  priority?: number;
  modulePriority?: Partial<Record<AiModule, number>>;
  timeoutMs?: number;
  inputUsdPerM?: number;
  cachedInputUsdPerM?: number;
  outputUsdPerM?: number;
  reasoningUsdPerM?: number;
  enabled?: boolean;
}

export interface RouterOptions {
  providers: ProviderDefinition[];
  retriesPerProvider?: number;
  allowModelOverride?: boolean;
  moduleMaxTokens?: Partial<Record<AiModule, number>>;
  planRoutes?: Record<string, Partial<Record<AiModule, string[]>>>;
  fetchImpl?: typeof fetch;
}

type ProviderState = ProviderDefinition & {
  nextKey: number;
  failures: number;
  lastError?: string;
  latencyMs?: number;
};

function splitKeys(value?: string): string[] {
  return Array.from(new Set(String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean)));
}

function numberFromEnv(value: string | undefined, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeEndpoint(baseUrl: string, protocol: ProviderProtocol = "openai-chat"): string {
  const clean = baseUrl.replace(/\/+$/, "");
  if (protocol === "anthropic-messages") return clean.endsWith("/messages") ? clean : `${clean}/messages`;
  return clean.endsWith("/chat/completions") ? clean : `${clean}/chat/completions`;
}

function moduleFromRequest(request: CliperChatRequest): AiModule {
  if (request.module) return request.module;
  const hint = String(request.metadata?.module ?? "").toLowerCase();
  if (hint.includes("highlight") || hint.includes("moment")) return "highlight";
  if (hint.includes("title")) return "title";
  if (hint.includes("hook")) return "hook";
  if (hint.includes("caption") || hint.includes("subtitle")) return "caption";
  return "default";
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function finiteUsage(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizedUsage(
  usageRaw: Record<string, unknown>,
  estimatedInput: number,
  estimatedOutput: number,
) {
  const hasProviderUsage = Object.keys(usageRaw).length > 0;
  const promptDetails = objectValue(usageRaw.prompt_tokens_details);
  const completionDetails = objectValue(usageRaw.completion_tokens_details);
  const inputTokens = finiteUsage(
    usageRaw.prompt_tokens
    ?? usageRaw.input_tokens
    ?? usageRaw.prompt_cache_miss_tokens,
    estimatedInput,
  );
  const outputTokens = finiteUsage(
    usageRaw.completion_tokens ?? usageRaw.output_tokens,
    estimatedOutput,
  );
  const cachedInputTokens = Math.min(
    inputTokens,
    finiteUsage(
      usageRaw.cached_input_tokens
      ?? usageRaw.cached_tokens
      ?? usageRaw.prompt_cache_hit_tokens
      ?? usageRaw.cache_read_input_tokens
      ?? promptDetails.cached_tokens,
      0,
    ),
  );
  const reasoningTokens = finiteUsage(
    usageRaw.reasoning_tokens ?? completionDetails.reasoning_tokens,
    0,
  );
  const totalTokens = finiteUsage(
    usageRaw.total_tokens,
    inputTokens + outputTokens,
  );
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    source: hasProviderUsage ? "provider" as const : "estimated" as const,
  };
}

function extractContent(payload: Record<string, unknown>): string {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "object" && part ? String((part as Record<string, unknown>).text ?? "") : "").join(" ").trim();
  }
  return "";
}

function extractAnthropicContent(payload: Record<string, unknown>): string {
  const content = Array.isArray(payload.content) ? payload.content : [];
  return content
    .map((part) => typeof part === "object" && part && (part as Record<string, unknown>).type === "text"
      ? String((part as Record<string, unknown>).text ?? "")
      : "")
    .join(" ")
    .trim();
}

function parseProviderJson(raw?: string): ProviderDefinition[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as ProviderDefinition[];
    return Array.isArray(parsed) ? parsed.filter((item) => item?.code && item?.baseUrl && item?.model) : [];
  } catch {
    return [];
  }
}

export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderDefinition[] {
  const configured = parseProviderJson(env.PROVIDER_CONFIG_JSON);
  if (configured.length) return configured;
  return [
    {
      code: "gemini",
      displayName: "Google Gemini",
      baseUrl: env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai",
      model: env.GEMINI_MODEL || "gemini-3.5-flash",
      apiKeys: splitKeys(env.GEMINI_API_KEYS),
      priority: 10,
      modulePriority: { highlight: 5, title: 5, hook: 5, caption: 25, metadata: 20, default: 10 },
      inputUsdPerM: numberFromEnv(env.GEMINI_INPUT_USD_PER_M),
      cachedInputUsdPerM: numberFromEnv(env.GEMINI_CACHED_INPUT_USD_PER_M),
      outputUsdPerM: numberFromEnv(env.GEMINI_OUTPUT_USD_PER_M),
      reasoningUsdPerM: numberFromEnv(env.GEMINI_REASONING_USD_PER_M),
      enabled: true,
    },
    {
      code: "deepseek",
      displayName: "DeepSeek",
      baseUrl: env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
      model: env.DEEPSEEK_MODEL || "deepseek-v4-flash",
      apiKeys: splitKeys(env.DEEPSEEK_API_KEYS),
      priority: 20,
      modulePriority: { highlight: 20, title: 20, hook: 20, caption: 5, metadata: 5, default: 20 },
      inputUsdPerM: numberFromEnv(env.DEEPSEEK_INPUT_USD_PER_M),
      cachedInputUsdPerM: numberFromEnv(env.DEEPSEEK_CACHED_INPUT_USD_PER_M),
      outputUsdPerM: numberFromEnv(env.DEEPSEEK_OUTPUT_USD_PER_M),
      reasoningUsdPerM: numberFromEnv(env.DEEPSEEK_REASONING_USD_PER_M),
      enabled: true,
    },
    {
      code: "openai",
      displayName: "OpenAI",
      baseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      model: env.OPENAI_MODEL || "gpt-5-mini",
      apiKeys: splitKeys(env.OPENAI_API_KEYS),
      priority: 30,
      inputUsdPerM: numberFromEnv(env.OPENAI_INPUT_USD_PER_M),
      cachedInputUsdPerM: numberFromEnv(env.OPENAI_CACHED_INPUT_USD_PER_M),
      outputUsdPerM: numberFromEnv(env.OPENAI_OUTPUT_USD_PER_M),
      reasoningUsdPerM: numberFromEnv(env.OPENAI_REASONING_USD_PER_M),
      enabled: true,
    },
    {
      code: "qwen",
      displayName: "Qwen",
      baseUrl: env.QWEN_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      model: env.QWEN_MODEL || "qwen3.7-plus",
      apiKeys: splitKeys(env.QWEN_API_KEYS),
      priority: 40,
      inputUsdPerM: numberFromEnv(env.QWEN_INPUT_USD_PER_M),
      cachedInputUsdPerM: numberFromEnv(env.QWEN_CACHED_INPUT_USD_PER_M),
      outputUsdPerM: numberFromEnv(env.QWEN_OUTPUT_USD_PER_M),
      reasoningUsdPerM: numberFromEnv(env.QWEN_REASONING_USD_PER_M),
      enabled: true,
    },
    {
      code: "claude",
      displayName: "Claude",
      baseUrl: env.CLAUDE_BASE_URL || "https://api.anthropic.com/v1",
      model: env.CLAUDE_MODEL || "claude-sonnet-4-6",
      apiKeys: splitKeys(env.CLAUDE_API_KEYS),
      protocol: "anthropic-messages",
      priority: 50,
      inputUsdPerM: numberFromEnv(env.CLAUDE_INPUT_USD_PER_M),
      cachedInputUsdPerM: numberFromEnv(env.CLAUDE_CACHED_INPUT_USD_PER_M),
      outputUsdPerM: numberFromEnv(env.CLAUDE_OUTPUT_USD_PER_M),
      reasoningUsdPerM: numberFromEnv(env.CLAUDE_REASONING_USD_PER_M),
      enabled: true,
    },
  ];
}

export class AiRouter {
  private readonly providers: ProviderState[];
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly allowModelOverride: boolean;
  private readonly moduleMaxTokens: Record<AiModule, number>;
  private readonly planRoutes: Record<string, Partial<Record<AiModule, string[]>>>;

  constructor(options: RouterOptions) {
    this.providers = options.providers.map((provider) => ({ ...provider, nextKey: 0, failures: 0 }));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retries = Math.max(1, options.retriesPerProvider ?? 2);
    this.allowModelOverride = options.allowModelOverride === true;
    this.moduleMaxTokens = {
      highlight: 1800,
      story: 1800,
      ranking: 1400,
      title: 500,
      hook: 420,
      caption: 700,
      metadata: 500,
      test: 320,
      default: 1000,
      ...(options.moduleMaxTokens ?? {}),
    };
    this.planRoutes = options.planRoutes ?? {
      free: {
        story: ["deepseek", "gemini"], ranking: ["deepseek", "gemini"], highlight: ["deepseek", "gemini"],
        title: ["deepseek", "gemini"], hook: ["deepseek", "gemini"], caption: ["deepseek", "gemini"], metadata: ["deepseek", "gemini"],
      },
      starter: {
        story: ["deepseek", "gemini"], ranking: ["deepseek", "gemini"], highlight: ["deepseek", "gemini"],
        title: ["deepseek", "gemini"], hook: ["deepseek", "gemini"], caption: ["deepseek", "gemini"], metadata: ["deepseek", "gemini"],
      },
      pro: {
        story: ["gemini", "deepseek"], ranking: ["deepseek", "gemini"], highlight: ["gemini", "deepseek"],
        title: ["openai", "gemini", "deepseek"], hook: ["gemini", "deepseek"], caption: ["deepseek", "gemini"], metadata: ["gemini", "deepseek"],
      },
      enterprise: {
        story: ["gemini", "openai", "deepseek"], ranking: ["deepseek", "gemini", "openai"], highlight: ["gemini", "openai", "deepseek"],
        title: ["openai", "gemini", "deepseek"], hook: ["gemini", "openai", "deepseek"], caption: ["deepseek", "gemini"], metadata: ["gemini", "openai", "deepseek"],
      },
    };
  }

  health(): ProviderHealth[] {
    return this.providers.map((provider) => ({
      code: provider.code,
      displayName: provider.displayName,
      status: provider.enabled === false || provider.apiKeys.length === 0 ? "disabled" : provider.failures >= 3 ? "degraded" : "healthy",
      model: provider.model,
      keyCount: provider.apiKeys.length,
      latencyMs: provider.latencyMs,
      lastError: provider.lastError,
    }));
  }

  async route(request: CliperChatRequest): Promise<CliperInternalChatResponse> {
    if (request.stream) throw new Error("Streaming belum diaktifkan pada gateway fase ini.");
    const module = moduleFromRequest(request);
    const plan = String(request.metadata?.plan || "free").toLowerCase();
    const preferredOrder = this.planRoutes[plan]?.[module] ?? this.planRoutes.free?.[module] ?? [];
    const candidates = this.providers
      .filter((provider) => provider.enabled !== false && provider.apiKeys.length > 0 && (!provider.modules || provider.modules.includes(module)))
      .sort((a, b) => {
        const aPlanRank = preferredOrder.indexOf(a.code);
        const bPlanRank = preferredOrder.indexOf(b.code);
        const aRank = aPlanRank >= 0 ? aPlanRank : 1000 + (a.modulePriority?.[module] ?? a.priority ?? 100);
        const bRank = bPlanRank >= 0 ? bPlanRank : 1000 + (b.modulePriority?.[module] ?? b.priority ?? 100);
        return aRank - bRank || a.failures - b.failures;
      });
    if (!candidates.length) throw new Error("Tidak ada AI provider aktif. Tambahkan dan uji API key melalui Provider Manager.");

    const errors: string[] = [];
    let failedAttempts = 0;
    for (let providerIndex = 0; providerIndex < candidates.length; providerIndex += 1) {
      const provider = candidates[providerIndex]!;
      for (let attempt = 0; attempt < this.retries; attempt += 1) {
        try {
          const response = await this.callProvider(provider, request, module);
          response.routing = {
            retry_count: failedAttempts,
            fallback_count: providerIndex,
          };
          return response;
        } catch (error) {
          failedAttempts += 1;
          provider.failures += 1;
          provider.lastError = error instanceof Error ? error.message : String(error);
          errors.push(`${provider.code}: ${provider.lastError}`);
        }
      }
    }
    throw new Error(`Semua AI provider gagal. ${errors.join(" | ")}`);
  }

  private async callProvider(provider: ProviderState, request: CliperChatRequest, module: AiModule): Promise<CliperInternalChatResponse> {
    const key = provider.apiKeys[provider.nextKey % provider.apiKeys.length]!;
    provider.nextKey = (provider.nextKey + 1) % provider.apiKeys.length;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), provider.timeoutMs ?? 45000);
    const started = Date.now();
    try {
      const protocol = provider.protocol ?? "openai-chat";
      const maxTokens = Math.max(32, Math.min(this.moduleMaxTokens[module], Number(request.max_tokens ?? this.moduleMaxTokens[module])));
      const model = this.allowModelOverride && request.model && request.model !== "auto" ? request.model : provider.model;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      let body: Record<string, unknown>;
      if (protocol === "anthropic-messages") {
        headers["x-api-key"] = key;
        headers["anthropic-version"] = "2023-06-01";
        const system = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
        body = {
          model,
          max_tokens: maxTokens,
          messages: request.messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role, content: message.content })),
          temperature: request.temperature ?? 0.25,
          stream: false,
          ...(system ? { system } : {}),
        };
      } else {
        headers.Authorization = `Bearer ${key}`;
        const openAiReasoningModel = provider.code === "openai"
          && (/^gpt-5(?:[.-]|$)/i.test(model) || /^o\d/i.test(model));
        body = {
          model,
          messages: request.messages,
          stream: false,
          ...(!openAiReasoningModel ? { temperature: request.temperature ?? 0.25 } : {}),
          ...(provider.code === "openai" && /^gpt-5(?:[.-]|$)/i.test(model) ? { reasoning_effort: "minimal" } : {}),
          ...(provider.code === "openai" && /^o\d/i.test(model) ? { reasoning_effort: "low" } : {}),
        };
        // New OpenAI reasoning models reject legacy token parameters and
        // non-default temperature values.
        if (openAiReasoningModel) {
          body.max_completion_tokens = maxTokens;
        } else {
          body.max_tokens = maxTokens;
        }
        // DeepSeek V4 may spend a short request entirely in thinking mode,
        // leaving assistant.content empty. Cliper modules need the answer,
        // so use the provider-supported non-thinking mode for these calls.
        if (provider.code === "deepseek" && (/^deepseek-v4/i.test(model) || model === "deepseek-reasoner")) {
          body.thinking = { type: "disabled" };
        }
      }
      const response = await this.fetchImpl(normalizeEndpoint(provider.baseUrl, protocol), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const rawText = await response.text();
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(rawText) as Record<string, unknown>;
      } catch {
        throw new Error(`HTTP ${response.status}: respons provider bukan JSON.`);
      }
      if (!response.ok) {
        const error = payload.error as Record<string, unknown> | string | undefined;
        const message = typeof error === "object" && error ? error.message : error;
        throw new Error(`HTTP ${response.status}: ${String(message ?? "request gagal")}`);
      }
      const content = protocol === "anthropic-messages" ? extractAnthropicContent(payload) : extractContent(payload);
      if (!content) throw new Error("Provider mengembalikan content kosong.");
      provider.failures = Math.max(0, provider.failures - 1);
      provider.latencyMs = Date.now() - started;
      provider.lastError = undefined;

      const usageRaw = objectValue(payload.usage);
      const inputText = request.messages.map((message) => message.content).join(" ");
      const usage = normalizedUsage(
        usageRaw,
        estimateTokens(inputText),
        estimateTokens(content),
      );
      const uncachedInputTokens = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
      const inputRate = provider.inputUsdPerM ?? 0;
      const cachedInputRate = provider.cachedInputUsdPerM && provider.cachedInputUsdPerM > 0
        ? provider.cachedInputUsdPerM
        : inputRate;
      const outputRate = provider.outputUsdPerM ?? 0;
      const reasoningRate = provider.reasoningUsdPerM && provider.reasoningUsdPerM > 0
        ? provider.reasoningUsdPerM
        : outputRate;
      const providerCost = (
        uncachedInputTokens / 1_000_000 * inputRate
        + usage.cachedInputTokens / 1_000_000 * cachedInputRate
        + usage.outputTokens / 1_000_000 * outputRate
        + usage.reasoningTokens / 1_000_000 * reasoningRate
      );
      return {
        id: String(payload.id ?? `cliper-${crypto.randomUUID()}`),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: String(payload.model ?? provider.model),
        provider: provider.code,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: usage.inputTokens,
          completion_tokens: usage.outputTokens,
          total_tokens: usage.totalTokens,
          cached_input_tokens: usage.cachedInputTokens,
          reasoning_tokens: usage.reasoningTokens,
          usage_source: usage.source,
        },
        billing: {
          provider_cost_usd: Number(providerCost.toFixed(8)),
          service_cost_usd: Number(providerCost.toFixed(8)),
          billed_cost_usd: Number(providerCost.toFixed(8)),
          gross_profit_usd: 0,
          credit_charge_micro: 0,
          markup_bps: 0,
          markup_percent: 0,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createRouterFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): AiRouter {
  return new AiRouter({
    providers: providersFromEnv(env),
    retriesPerProvider: numberFromEnv(env.PROVIDER_RETRIES, 2),
    allowModelOverride: String(env.ALLOW_CLIENT_MODEL_OVERRIDE || "").toLowerCase() === "true",
    fetchImpl,
  });
}

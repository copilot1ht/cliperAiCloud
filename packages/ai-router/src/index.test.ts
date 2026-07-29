import { describe, expect, it, vi } from "vitest";
import { AiRouter } from "./index.js";

describe("AiRouter", () => {
  it("falls back to the next provider when the first returns empty content", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "ok", model: "second", choices: [{ message: { content: "hasil valid" } }], usage: { prompt_tokens: 10, completion_tokens: 4 } }), { status: 200 }));
    const router = new AiRouter({
      retriesPerProvider: 1,
      fetchImpl,
      providers: [
        { code: "first", displayName: "First", baseUrl: "https://first.test/v1", model: "first", apiKeys: ["a"], priority: 1 },
        { code: "second", displayName: "Second", baseUrl: "https://second.test/v1", model: "second", apiKeys: ["b"], priority: 2 },
      ],
    });
    const result = await router.route({ messages: [{ role: "user", content: "buat judul" }] });
    expect(result.provider).toBe("second");
    expect(result.choices[0]?.message.content).toBe("hasil valid");
  });

  it("reports providers without keys as disabled", () => {
    const router = new AiRouter({ providers: [{ code: "x", displayName: "X", baseUrl: "https://x.test", model: "x", apiKeys: [] }] });
    expect(router.health()[0]?.status).toBe("disabled");
  });

  it("uses module-specific provider priority", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }));
    const router = new AiRouter({
      retriesPerProvider: 1,
      fetchImpl,
      providers: [
        { code: "quality", displayName: "Quality", baseUrl: "https://quality.test/v1", model: "quality", apiKeys: ["a"], priority: 1, modulePriority: { caption: 50 } },
        { code: "economy", displayName: "Economy", baseUrl: "https://economy.test/v1", model: "economy", apiKeys: ["b"], priority: 20, modulePriority: { caption: 2 } },
      ],
    });
    const result = await router.route({ module: "caption", messages: [{ role: "user", content: "rapikan" }] });
    expect(result.provider).toBe("economy");
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("economy.test");
  });

  it("enforces server model and module token budget by default", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }));
    const router = new AiRouter({
      fetchImpl,
      providers: [{ code: "safe", displayName: "Safe", baseUrl: "https://safe.test/v1", model: "server-model", apiKeys: ["a"] }],
      moduleMaxTokens: { title: 300 },
    });
    await router.route({ module: "title", model: "expensive-client-model", max_tokens: 999999, messages: [{ role: "user", content: "judul" }] });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("server-model");
    expect(body.max_tokens).toBe(300);
  });

  it("uses modern OpenAI token parameters and disables DeepSeek V4 thinking", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        choices: [{ message: { content: body.thinking ? "deepseek result" : "openai result" } }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      }), { status: 200 });
    });
    const router = new AiRouter({
      retriesPerProvider: 1,
      fetchImpl,
      providers: [
        { code: "openai", displayName: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-5-mini", apiKeys: ["openai-secret"] },
      ],
    });

    await router.route({ messages: [{ role: "user", content: "test" }] });
    const openAiBody = JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body));
    expect(openAiBody.max_completion_tokens).toBeGreaterThan(0);
    expect(openAiBody.max_tokens).toBeUndefined();
    expect(openAiBody.temperature).toBeUndefined();
    expect(openAiBody.reasoning_effort).toBe("minimal");

    const deepseekRouter = new AiRouter({
      retriesPerProvider: 1,
      fetchImpl,
      providers: [
        { code: "deepseek", displayName: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", apiKeys: ["deepseek-secret"] },
      ],
    });
    await deepseekRouter.route({ messages: [{ role: "user", content: "test" }] });
    const deepseekBody = JSON.parse(String((fetchImpl.mock.calls[1]?.[1] as RequestInit).body));
    expect(deepseekBody.thinking).toEqual({ type: "disabled" });
  });

  it("routes Starter and Pro through different provider priorities", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }));
    const router = new AiRouter({
      retriesPerProvider: 1,
      fetchImpl,
      providers: [
        { code: "gemini", displayName: "Gemini", baseUrl: "https://gemini.test/v1", model: "gemini", apiKeys: ["a"] },
        { code: "deepseek", displayName: "DeepSeek", baseUrl: "https://deepseek.test/v1", model: "deepseek", apiKeys: ["b"] },
      ],
    });
    const starter = await router.route({ module: "highlight", metadata: { plan: "starter" }, messages: [{ role: "user", content: "rank" }] });
    const pro = await router.route({ module: "highlight", metadata: { plan: "pro" }, messages: [{ role: "user", content: "rank" }] });
    expect(starter.provider).toBe("deepseek");
    expect(pro.provider).toBe("gemini");
  });

  it("uses the native Anthropic Messages protocol for Claude", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "msg_test",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "judul yang natural" }],
      usage: { input_tokens: 12, output_tokens: 4 },
    }), { status: 200 }));
    const router = new AiRouter({
      fetchImpl,
      providers: [{
        code: "claude",
        displayName: "Claude",
        baseUrl: "https://api.anthropic.com/v1",
        model: "claude-sonnet-4-6",
        apiKeys: ["anthropic-secret"],
        protocol: "anthropic-messages",
      }],
    });
    const result = await router.route({
      module: "title",
      messages: [{ role: "system", content: "Buat judul." }, { role: "user", content: "Transcript" }],
    });
    expect(result.choices[0]?.message.content).toBe("judul yang natural");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("anthropic-secret");
    const body = JSON.parse(String(init.body));
    expect(body.system).toBe("Buat judul.");
    expect(body.messages).toEqual([{ role: "user", content: "Transcript" }]);
  });

  it("preserves detailed provider usage and prices cached/reasoning tokens separately", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "usage_test",
      model: "priced-model",
      choices: [{ message: { content: "hasil" } }],
      usage: {
        prompt_tokens: 1_000,
        completion_tokens: 200,
        total_tokens: 1_200,
        prompt_tokens_details: { cached_tokens: 400 },
        completion_tokens_details: { reasoning_tokens: 50 },
      },
    }), { status: 200 }));
    const router = new AiRouter({
      fetchImpl,
      providers: [{
        code: "priced",
        displayName: "Priced",
        baseUrl: "https://priced.test/v1",
        model: "priced-model",
        apiKeys: ["secret"],
        inputUsdPerM: 1,
        cachedInputUsdPerM: 0.25,
        outputUsdPerM: 2,
        reasoningUsdPerM: 3,
      }],
    });

    const result = await router.route({ messages: [{ role: "user", content: "uji usage" }] });

    expect(result.usage).toMatchObject({
      prompt_tokens: 1_000,
      cached_input_tokens: 400,
      completion_tokens: 200,
      reasoning_tokens: 50,
      total_tokens: 1_200,
      usage_source: "provider",
    });
    expect(result.billing.provider_cost_usd).toBe(0.00125);
    expect(result.routing).toEqual({ retry_count: 0, fallback_count: 0 });
  });

  it("marks estimated token usage when a provider omits usage", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "hasil estimasi" } }],
    }), { status: 200 }));
    const router = new AiRouter({
      fetchImpl,
      providers: [{
        code: "estimated",
        displayName: "Estimated",
        baseUrl: "https://estimated.test/v1",
        model: "estimated-model",
        apiKeys: ["secret"],
        inputUsdPerM: 1,
        outputUsdPerM: 2,
      }],
    });

    const result = await router.route({ messages: [{ role: "user", content: "uji" }] });

    expect(result.usage.usage_source).toBe("estimated");
    expect(result.usage.prompt_tokens).toBeGreaterThan(0);
    expect(result.usage.completion_tokens).toBeGreaterThan(0);
  });
});

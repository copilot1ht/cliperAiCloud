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
});

import { describe, expect, it, vi } from "vitest";
import { testProviderConnection } from "./provider-connection.service.js";

describe("ProviderConnectionService", () => {
  it("validates DeepSeek and discovers the preferred model", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      object: "list",
      data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-v4-flash" }],
    }), { status: 200 }));
    const result = await testProviderConnection({ provider: "deepseek", apiKey: "deepseek-secret-test" }, fetchImpl);
    expect(result).toMatchObject({ provider: "deepseek", defaultModel: "deepseek-v4-flash", health: "healthy", modelSource: "api" });
    expect(result.models).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer deepseek-secret-test");
  });

  it("uses Anthropic authentication when testing Claude", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-6" }] }), { status: 200 }));
    const result = await testProviderConnection({ provider: "claude", apiKey: "claude-secret-test" }, fetchImpl);
    expect(result.protocol).toBe("anthropic-messages");
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("claude-secret-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers).not.toHaveProperty("Authorization");
  });

  it("returns a safe error for an invalid key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "raw upstream detail" } }), { status: 401 }));
    await expect(testProviderConnection({ provider: "openai", apiKey: "invalid-secret-key" }, fetchImpl))
      .rejects.toThrow("API key tidak valid");
  });
});

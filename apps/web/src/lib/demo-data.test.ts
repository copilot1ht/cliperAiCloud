import { describe, expect, it } from "vitest";
import { providerData, routingRules } from "./demo-data";

describe("operations data", () => {
  it("keeps routing modules unique", () => {
    expect(new Set(routingRules.map((rule) => rule.module)).size).toBe(routingRules.length);
  });

  it("exposes at least two provider choices", () => {
    expect(providerData.length).toBeGreaterThanOrEqual(2);
  });
});

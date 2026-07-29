import { describe, expect, it } from "vitest";
import { checkTcpUrl, validateRuntimeConfig } from "./runtime-config.js";

const safeProduction = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://db/cliper",
  REDIS_URL: "redis://cache:6379",
  WEB_ORIGIN: "https://app.cliper.cloud",
  JWT_SECRET: "j".repeat(40),
  REFRESH_TOKEN_SECRET: "r".repeat(40),
  ADMIN_API_KEY: "a".repeat(32),
  PROVIDER_ENCRYPTION_KEY: "e".repeat(32),
  BOOTSTRAP_ADMIN_EMAIL: "admin@cliper.test",
  BOOTSTRAP_ADMIN_PASSWORD_HASH: "argon-hash-placeholder",
  GEMINI_API_KEYS: "gemini-key",
  GEMINI_INPUT_USD_PER_M: "0.1",
  GEMINI_OUTPUT_USD_PER_M: "0.4",
  ANALYSIS_BILLING_STORAGE: "postgres",
};

describe("validateRuntimeConfig", () => {
  it("accepts a complete production configuration", () => {
    const report = validateRuntimeConfig(safeProduction);
    expect(report.ready).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("fails closed when production uses the development API key", () => {
    const report = validateRuntimeConfig({ ...safeProduction, CLIPER_DEV_API_KEY: "development" });
    expect(report.ready).toBe(false);
    expect(report.errors.join(" ")).toContain("CLIPER_DEV_API_KEY");
  });

  it("can start the control plane before the first provider is configured", () => {
    const { GEMINI_API_KEYS: _provider, ...withoutProvider } = safeProduction;
    const report = validateRuntimeConfig(withoutProvider);
    expect(report.errors).toEqual([]);
    expect(report.ready).toBe(false);
    expect(report.warnings.join(" ")).toContain("provider AI");
  });

  it("does not expose provider key values in its report", () => {
    const reportText = JSON.stringify(validateRuntimeConfig(safeProduction));
    expect(reportText).not.toContain("gemini-key");
  });

  it("reports an unconfigured dependency as unreachable", async () => {
    await expect(checkTcpUrl(undefined, 5432)).resolves.toBe(false);
  });
});

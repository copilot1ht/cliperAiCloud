import { describe, expect, it } from "vitest";
import { checkTcpUrl, validateRuntimeConfig } from "./runtime-config.js";

const safeProduction = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://db/cliper",
  REDIS_URL: "redis://cache:6379",
  WEB_ORIGIN: "https://app.cliper.cloud",
  JWT_SECRET: "jwt-production-secret-1e91ea7d5e243aa456",
  REFRESH_TOKEN_SECRET: "refresh-production-secret-57d19f8c4b3e229aa",
  ADMIN_API_KEY: "admin-api-production-test-7f49e051a8f23241",
  PROVIDER_ENCRYPTION_KEY: "provider-encryption-production-test-9d60b1ce34",
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

  it("requires persistent desktop sessions in production", () => {
    const report = validateRuntimeConfig({ ...safeProduction, DESKTOP_SESSION_STORAGE: "memory" });
    expect(report.ready).toBe(false);
    expect(report.errors.join(" ")).toContain("DESKTOP_SESSION_STORAGE");
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

  it("fails closed for a placeholder payment encryption secret in production", () => {
    const report = validateRuntimeConfig({
      ...safeProduction,
      PAYMENT_CONFIG_ENCRYPTION_KEY: "ISI_RANDOM_SECRET_MINIMAL_32_KARAKTER",
    });
    expect(report.ready).toBe(false);
    expect(report.errors.join(" ")).toContain("PAYMENT_CONFIG_ENCRYPTION_KEY");
  });

  it("requires a complete Production Midtrans QRIS contract", () => {
    const incomplete = validateRuntimeConfig({
      ...safeProduction,
      PAYMENT_PROVIDER: "midtrans",
      MIDTRANS_IS_PRODUCTION: "true",
      MIDTRANS_MERCHANT_ID: "G123",
      MIDTRANS_CLIENT_KEY: "",
      MIDTRANS_SERVER_KEY: "Mid-server-production-test-key-7f91b2",
      MIDTRANS_QRIS_ACQUIRER: "invalid",
    });
    expect(incomplete.ready).toBe(false);
    expect(incomplete.errors.join(" ")).toContain("MIDTRANS_CLIENT_KEY");
    expect(incomplete.errors.join(" ")).toContain("MIDTRANS_QRIS_ACQUIRER");

    const valid = validateRuntimeConfig({
      ...safeProduction,
      PAYMENT_PROVIDER: "midtrans",
      MIDTRANS_IS_PRODUCTION: "true",
      MIDTRANS_MERCHANT_ID: "G123",
      MIDTRANS_CLIENT_KEY: "Mid-client-production-test-key-6d21",
      MIDTRANS_SERVER_KEY: "Mid-server-production-test-key-7f91b2",
      MIDTRANS_QRIS_ACQUIRER: "gopay",
    });
    expect(valid.errors).toEqual([]);
  });

  it("rejects a Midtrans sandbox mode in production", () => {
    const report = validateRuntimeConfig({
      ...safeProduction,
      PAYMENT_PROVIDER: "midtrans",
      MIDTRANS_IS_PRODUCTION: "false",
      MIDTRANS_MERCHANT_ID: "G123",
      MIDTRANS_CLIENT_KEY: "SB-Mid-client-test-key-6d21",
      MIDTRANS_SERVER_KEY: "SB-Mid-server-test-key-7f91b2",
    });
    expect(report.ready).toBe(false);
    expect(report.errors.join(" ")).toContain("MIDTRANS_IS_PRODUCTION");
  });

  it("rejects automatic payment fallback so every invoice has one provider", () => {
    const report = validateRuntimeConfig({
      ...safeProduction,
      PAYMENT_PRIMARY_PROVIDER: "xendit",
      XENDIT_ENABLED: "true",
      XENDIT_MODE: "test",
      XENDIT_SECRET_KEY: "xendit-test-secret-key-with-at-least-32-characters",
      XENDIT_WEBHOOK_TOKEN: "xendit-test-webhook-token-with-at-least-32-characters",
      PAYMENT_FALLBACK_ENABLED: "true",
    });
    expect(report.ready).toBe(false);
    expect(report.errors.join(" ")).toContain("PAYMENT_FALLBACK_ENABLED");
  });

  it("rejects a Xendit public key where a server secret is required", () => {
    const report = validateRuntimeConfig({
      ...safeProduction,
      PAYMENT_PRIMARY_PROVIDER: "xendit",
      XENDIT_ENABLED: "true",
      XENDIT_MODE: "test",
      XENDIT_SECRET_KEY: "xnd_public_development_example_public_key_only",
      XENDIT_WEBHOOK_TOKEN: "xendit-webhook-token-with-at-least-32-characters",
    });
    expect(report.ready).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings.join(" ")).toContain("Public API Key");
  });

  it("reports an unconfigured dependency as unreachable", async () => {
    await expect(checkTcpUrl(undefined, 5432)).resolves.toBe(false);
  });
});

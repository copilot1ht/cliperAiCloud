import { encryptSecret } from "@cliper/security";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseService } from "../database/database.service.js";
import { PaymentConfigurationService } from "./payment-configuration.service.js";

const paymentEnv = [
  "PAYMENT_CONFIG_ENCRYPTION_KEY",
  "PAYMENT_PROVIDER",
  "PAYMENT_PRIMARY_PROVIDER",
  "MIDTRANS_MERCHANT_ID",
  "MIDTRANS_CLIENT_KEY",
  "MIDTRANS_SERVER_KEY",
  "MIDTRANS_IS_PRODUCTION",
  "MIDTRANS_NOTIFICATION_URL",
  "MIDTRANS_FINISH_REDIRECT_URL",
  "XENDIT_ENABLED",
  "XENDIT_MODE",
  "XENDIT_SECRET_KEY",
  "XENDIT_WEBHOOK_TOKEN",
  "XENDIT_API_VERSION",
  "XENDIT_NOTIFICATION_URL",
  "API_PUBLIC_URL",
  "WEB_ORIGIN",
];

function configureRailwayMidtrans(): void {
  process.env.PAYMENT_CONFIG_ENCRYPTION_KEY = "payment-config-test-secret-with-at-least-32-characters";
  process.env.PAYMENT_PROVIDER = "midtrans";
  process.env.MIDTRANS_MERCHANT_ID = "railway-merchant";
  process.env.MIDTRANS_CLIENT_KEY = "Mid-client-railway";
  process.env.MIDTRANS_SERVER_KEY = "Mid-server-railway";
  process.env.MIDTRANS_IS_PRODUCTION = "true";
  process.env.MIDTRANS_NOTIFICATION_URL = "https://api.example.com/api/payments/webhook/midtrans";
  process.env.MIDTRANS_FINISH_REDIRECT_URL = "https://app.example.com/billing";
}

function storedRecord(enabled: boolean) {
  const secret = process.env.PAYMENT_CONFIG_ENCRYPTION_KEY || "";
  return {
    enabled,
    encryptedMerchantId: encryptSecret("admin-merchant", secret),
    encryptedClientKey: encryptSecret("Mid-client-admin", secret),
    encryptedServerKey: encryptSecret("Mid-server-admin", secret),
    isProduction: true,
    notificationUrl: "https://api.example.com/api/payments/webhook/midtrans",
    finishRedirectUrl: "https://app.example.com/billing",
  };
}

function serviceWithStoredRecord(enabled: boolean): PaymentConfigurationService {
  const record = storedRecord(enabled);
  const database = {
    configured: () => true,
    client: () => ({
      paymentGatewaySetting: {
        findUnique: vi.fn().mockResolvedValue(record),
      },
    }),
  };
  return new PaymentConfigurationService(database as unknown as DatabaseService);
}

describe("PaymentConfigurationService operation resolver", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of paymentEnv) delete process.env[key];
  });

  it("uses active Railway credentials when stale admin settings are disabled", async () => {
    configureRailwayMidtrans();
    const service = serviceWithStoredRecord(false);

    await expect(service.resolveMidtransForOperations()).resolves.toMatchObject({
      source: "railway-env",
      credentials: {
        merchantId: "railway-merchant",
        serverKey: "Mid-server-railway",
      },
    });
    await expect(service.status()).resolves.toMatchObject({
      source: "railway-env",
      enabled: true,
      configured: true,
    });
  });

  it("keeps explicitly enabled encrypted admin settings as the active source", async () => {
    configureRailwayMidtrans();
    const service = serviceWithStoredRecord(true);

    await expect(service.resolveMidtransForOperations()).resolves.toMatchObject({
      source: "admin-settings",
      credentials: {
        merchantId: "admin-merchant",
        serverKey: "Mid-server-admin",
      },
    });
  });

  it("uses Xendit Railway configuration when it is the primary provider", async () => {
    process.env.PAYMENT_PRIMARY_PROVIDER = "xendit";
    process.env.XENDIT_ENABLED = "true";
    process.env.XENDIT_MODE = "test";
    process.env.XENDIT_SECRET_KEY = "xendit-secret-key-with-at-least-32-characters";
    process.env.XENDIT_WEBHOOK_TOKEN = "xendit-webhook-token-with-at-least-32-characters";
    process.env.XENDIT_API_VERSION = "2024-11-11";
    process.env.XENDIT_NOTIFICATION_URL = "https://api.example.com/api/payments/webhook/xendit";
    const database = { configured: () => false, client: vi.fn() };
    const service = new PaymentConfigurationService(database as unknown as DatabaseService);

    await expect(service.resolveXenditForOperations()).resolves.toMatchObject({
      source: "railway-env",
      credentials: { mode: "test", apiVersion: "2024-11-11" },
    });
    await expect(service.status()).resolves.toMatchObject({
      provider: "xendit",
      enabled: true,
      configured: true,
      webhookTokenConfigured: true,
    });
  });
});

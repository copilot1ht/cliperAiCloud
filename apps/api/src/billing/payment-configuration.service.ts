import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { decryptSecret, encryptSecret } from "@cliper/security";
import { DatabaseService } from "../database/database.service.js";

const MIDTRANS_PROVIDER = "midtrans";
const XENDIT_PROVIDER = "xendit";
const SANDBOX_PROVIDER = "sandbox";

export type PaymentConfigurationSource =
  | "admin-settings"
  | "railway-env"
  | "not-configured";

export interface MidtransCredentials {
  merchantId: string;
  clientKey: string;
  serverKey: string;
  isProduction: boolean;
  notificationUrl: string;
  finishRedirectUrl: string;
}

export interface XenditCredentials {
  secretKey: string;
  webhookToken: string;
  mode: "test" | "live";
  apiVersion: string;
  notificationUrl: string;
}

export interface PaymentRuntimeConfiguration {
  provider: "xendit" | "midtrans" | "sandbox";
  source: PaymentConfigurationSource;
  enabled: boolean;
  midtrans?: MidtransCredentials;
  xendit?: XenditCredentials;
}

export interface PaymentSettingsInput {
  enabled?: unknown;
  environment?: unknown;
  merchantId?: unknown;
  clientKey?: unknown;
  serverKey?: unknown;
  notificationUrl?: unknown;
  finishRedirectUrl?: unknown;
}

function text(value: unknown): string {
  return String(value || "").trim();
}

function optionalText(value: unknown): string | undefined {
  const normalized = text(value);
  return normalized || undefined;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  const normalized = text(value).toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function productionFlag(value: unknown): boolean {
  return text(value).toLowerCase() === "production";
}

function sameOriginUrl(value: string, name: string): string {
  const normalized = text(value);
  if (!normalized) return "";
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new BadRequestException(`${name} harus berupa URL valid.`);
  }
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !isLocal) {
    throw new BadRequestException(`${name} wajib memakai HTTPS.`);
  }
  return url.toString().replace(/\/$/, "");
}

function mask(value: string, visible = 4): string | null {
  const normalized = text(value);
  if (!normalized) return null;
  const suffix = normalized.slice(-visible);
  return `${"•".repeat(Math.max(8, normalized.length - visible))}${suffix}`;
}

function configuredCredentials(value: Partial<MidtransCredentials>): value is MidtransCredentials {
  return Boolean(
    text(value.merchantId) &&
      text(value.clientKey) &&
      text(value.serverKey) &&
      typeof value.isProduction === "boolean",
  );
}

function defaultNotificationUrl(): string {
  const origin = text(process.env.API_PUBLIC_URL).replace(/\/$/, "");
  return origin ? `${origin}/api/payments/webhook/midtrans` : "";
}

function defaultFinishRedirectUrl(): string {
  const origin = text(process.env.WEB_ORIGIN).replace(/\/$/, "");
  return origin ? `${origin}/billing` : "";
}

function defaultXenditNotificationUrl(): string {
  const origin = text(process.env.API_PUBLIC_URL).replace(/\/$/, "");
  return origin ? `${origin}/api/payments/webhook/xendit` : "";
}

function xenditMode(value: unknown): "test" | "live" {
  return text(value).toLowerCase() === "live" ? "live" : "test";
}

@Injectable()
export class PaymentConfigurationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  private encryptionSecret(): string {
    const secret = text(
      process.env.PAYMENT_CONFIG_ENCRYPTION_KEY ||
        process.env.PROVIDER_ENCRYPTION_KEY ||
        process.env.LICENSE_KEY_PEPPER,
    );
    if (secret.length < 32) {
      throw new ServiceUnavailableException(
        "Konfigurasi pembayaran membutuhkan PAYMENT_CONFIG_ENCRYPTION_KEY atau PROVIDER_ENCRYPTION_KEY minimal 32 karakter.",
      );
    }
    return secret;
  }

  private environmentCredentials(): MidtransCredentials | undefined {
    const credentials: Partial<MidtransCredentials> = {
      merchantId: text(process.env.MIDTRANS_MERCHANT_ID),
      clientKey: text(process.env.MIDTRANS_CLIENT_KEY),
      serverKey: text(process.env.MIDTRANS_SERVER_KEY),
      isProduction: bool(process.env.MIDTRANS_IS_PRODUCTION, false),
      notificationUrl:
        text(process.env.MIDTRANS_NOTIFICATION_URL) || defaultNotificationUrl(),
      finishRedirectUrl:
        text(process.env.MIDTRANS_FINISH_REDIRECT_URL) ||
        defaultFinishRedirectUrl(),
    };
    return configuredCredentials(credentials) ? credentials : undefined;
  }

  private environmentXenditCredentials(): XenditCredentials | undefined {
    const secretKey = text(process.env.XENDIT_SECRET_KEY);
    const webhookToken = text(process.env.XENDIT_WEBHOOK_TOKEN);
    if (!secretKey || !webhookToken) return undefined;
    return {
      secretKey,
      webhookToken,
      mode: xenditMode(process.env.XENDIT_MODE),
      apiVersion: text(process.env.XENDIT_API_VERSION) || "2024-11-11",
      notificationUrl:
        text(process.env.XENDIT_NOTIFICATION_URL) ||
        defaultXenditNotificationUrl(),
    };
  }

  private async storedCredentials(): Promise<
    | { enabled: boolean; credentials?: MidtransCredentials }
    | undefined
  > {
    if (!this.database.configured()) return undefined;
    const record = await this.database.client().paymentGatewaySetting.findUnique({
      where: { provider: MIDTRANS_PROVIDER },
    });
    if (!record) return undefined;
    try {
      const secret = this.encryptionSecret();
      const credentials: Partial<MidtransCredentials> = {
        merchantId: record.encryptedMerchantId
          ? decryptSecret(record.encryptedMerchantId, secret)
          : "",
        clientKey: record.encryptedClientKey
          ? decryptSecret(record.encryptedClientKey, secret)
          : "",
        serverKey: record.encryptedServerKey
          ? decryptSecret(record.encryptedServerKey, secret)
          : "",
        isProduction: record.isProduction,
        notificationUrl: text(record.notificationUrl) || defaultNotificationUrl(),
        finishRedirectUrl:
          text(record.finishRedirectUrl) || defaultFinishRedirectUrl(),
      };
      return {
        enabled: record.enabled,
        credentials: configuredCredentials(credentials) ? credentials : undefined,
      };
    } catch {
      // A stale ciphertext must not crash checkout. It simply requires the
      // administrator to save a fresh encrypted configuration.
      return { enabled: record.enabled };
    }
  }

  async resolveActive(): Promise<PaymentRuntimeConfiguration> {
    const configuredProvider = text(
      process.env.PAYMENT_PRIMARY_PROVIDER || process.env.PAYMENT_PROVIDER || SANDBOX_PROVIDER,
    ).toLowerCase();
    if (configuredProvider === XENDIT_PROVIDER) {
      const xendit = this.environmentXenditCredentials();
      const enabled = bool(process.env.XENDIT_ENABLED, true) && Boolean(xendit);
      return {
        provider: XENDIT_PROVIDER,
        source: xendit ? "railway-env" : "not-configured",
        enabled,
        xendit,
      };
    }
    const midtransEnabled = bool(process.env.MIDTRANS_ENABLED, true);
    const stored = await this.storedCredentials();
    if (midtransEnabled && stored?.enabled && stored.credentials) {
      return {
        provider: MIDTRANS_PROVIDER,
        source: "admin-settings",
        enabled: true,
        midtrans: stored.credentials,
      };
    }

    const paymentProvider = configuredProvider;
    if (paymentProvider === MIDTRANS_PROVIDER) {
      const midtrans = this.environmentCredentials();
      return {
        provider: MIDTRANS_PROVIDER,
        source: midtrans ? "railway-env" : "not-configured",
        enabled: midtransEnabled && Boolean(midtrans),
        midtrans,
      };
    }

    return {
      provider: SANDBOX_PROVIDER,
      source: "not-configured",
      enabled: true,
    };
  }

  async resolveXenditForOperations(): Promise<
    | {
        source: Exclude<PaymentConfigurationSource, "not-configured">;
        credentials: XenditCredentials;
      }
    | undefined
  > {
    const active = await this.resolveActive();
    if (
      active.provider !== XENDIT_PROVIDER ||
      !active.enabled ||
      !active.xendit ||
      active.source === "not-configured"
    ) {
      return undefined;
    }
    return { source: active.source, credentials: active.xendit };
  }

  async resolveMidtransForOperations(): Promise<
    | { source: Exclude<PaymentConfigurationSource, "not-configured">; credentials: MidtransCredentials }
    | undefined
  > {
    const active = await this.resolveActive();
    if (
      active.provider !== MIDTRANS_PROVIDER ||
      !active.enabled ||
      !active.midtrans ||
      active.source === "not-configured"
    ) {
      return undefined;
    }
    return { source: active.source, credentials: active.midtrans };
  }

  async status() {
    const active = await this.resolveActive();
    const midtrans = active.provider === MIDTRANS_PROVIDER ? active.midtrans : undefined;
    const xendit = active.provider === XENDIT_PROVIDER ? active.xendit : undefined;
    const source = active.provider === SANDBOX_PROVIDER ? "not-configured" : active.source;
    const sourceLabel =
      source === "admin-settings"
        ? "Encrypted Admin Settings"
        : source === "railway-env"
          ? "Railway ENV"
          : "Not configured";
    return {
      provider: active.provider,
      enabled: active.enabled,
      environment:
        active.provider === XENDIT_PROVIDER
          ? xendit?.mode || "test"
          : midtrans?.isProduction
            ? "production"
            : "sandbox",
      source,
      sourceLabel,
      configured: Boolean(midtrans || xendit),
      databaseSupported: this.database.configured(),
      merchantIdMasked: midtrans ? mask(midtrans.merchantId) : null,
      clientKeyConfigured: Boolean(midtrans?.clientKey),
      serverKeyConfigured: Boolean(midtrans?.serverKey),
      secretKeyConfigured: Boolean(xendit?.secretKey),
      webhookTokenConfigured: Boolean(xendit?.webhookToken),
      apiVersion: xendit?.apiVersion || null,
      notificationUrl:
        xendit?.notificationUrl ||
        midtrans?.notificationUrl ||
        (active.provider === XENDIT_PROVIDER
          ? defaultXenditNotificationUrl()
          : defaultNotificationUrl()),
      finishRedirectUrl: midtrans?.finishRedirectUrl || defaultFinishRedirectUrl(),
    };
  }

  private validateKeyMode(
    credentials: MidtransCredentials,
  ): void {
    if (credentials.isProduction) {
      if (/^SB-Mid-(server|client)-/i.test(credentials.serverKey) || /^SB-Mid-client-/i.test(credentials.clientKey)) {
        throw new BadRequestException(
          "Mode Production membutuhkan Client Key dan Server Key Production, bukan Sandbox.",
        );
      }
      if (!/^Mid-server-/i.test(credentials.serverKey)) {
        throw new BadRequestException("Server Key Production Midtrans tidak valid.");
      }
    } else {
      if (/^Mid-server-/i.test(credentials.serverKey) && !/^SB-Mid-server-/i.test(credentials.serverKey)) {
        throw new BadRequestException(
          "Mode Sandbox membutuhkan Server Key Sandbox.",
        );
      }
      if (!/^SB-Mid-server-/i.test(credentials.serverKey)) {
        throw new BadRequestException("Server Key Sandbox Midtrans tidak valid.");
      }
    }
  }

  async save(input: PaymentSettingsInput, actorId?: string) {
    if (!this.database.configured()) {
      throw new ServiceUnavailableException(
        "Admin Payment Settings membutuhkan PostgreSQL. Untuk aktivasi sementara gunakan Railway Variables pada @cliper/api.",
      );
    }
    const client = this.database.client();
    const existing = await this.storedCredentials();
    const previous = existing?.credentials;
    const isProduction = productionFlag(input.environment)
      ? true
      : text(input.environment).toLowerCase() === "sandbox"
        ? false
        : previous?.isProduction ?? bool(process.env.MIDTRANS_IS_PRODUCTION, false);
    if (isProduction && String(process.env.NODE_ENV || "development").toLowerCase() !== "production") {
      throw new BadRequestException(
        "Credential Production hanya boleh disimpan melalui deployment API Production, bukan localhost.",
      );
    }
    const credentials: MidtransCredentials = {
      merchantId: optionalText(input.merchantId) || previous?.merchantId || "",
      clientKey: optionalText(input.clientKey) || previous?.clientKey || "",
      serverKey: optionalText(input.serverKey) || previous?.serverKey || "",
      isProduction,
      notificationUrl: sameOriginUrl(
        optionalText(input.notificationUrl) ||
          previous?.notificationUrl ||
          defaultNotificationUrl(),
        "Payment Notification URL",
      ),
      finishRedirectUrl: sameOriginUrl(
        optionalText(input.finishRedirectUrl) ||
          previous?.finishRedirectUrl ||
          defaultFinishRedirectUrl(),
        "Finish Redirect URL",
      ),
    };
    const enabled = bool(input.enabled, existing?.enabled ?? false);
    if (enabled && !configuredCredentials(credentials)) {
      throw new BadRequestException(
        "Aktivasi Midtrans membutuhkan Merchant ID, Client Key, dan Server Key lengkap.",
      );
    }
    if (configuredCredentials(credentials)) this.validateKeyMode(credentials);

    const secret = this.encryptionSecret();
    await client.paymentGatewaySetting.upsert({
      where: { provider: MIDTRANS_PROVIDER },
      create: {
        provider: MIDTRANS_PROVIDER,
        enabled,
        isProduction,
        encryptedMerchantId: credentials.merchantId
          ? encryptSecret(credentials.merchantId, secret)
          : null,
        encryptedClientKey: credentials.clientKey
          ? encryptSecret(credentials.clientKey, secret)
          : null,
        encryptedServerKey: credentials.serverKey
          ? encryptSecret(credentials.serverKey, secret)
          : null,
        notificationUrl: credentials.notificationUrl || null,
        finishRedirectUrl: credentials.finishRedirectUrl || null,
        updatedById: actorId || null,
      },
      update: {
        enabled,
        isProduction,
        encryptedMerchantId: credentials.merchantId
          ? encryptSecret(credentials.merchantId, secret)
          : undefined,
        encryptedClientKey: credentials.clientKey
          ? encryptSecret(credentials.clientKey, secret)
          : undefined,
        encryptedServerKey: credentials.serverKey
          ? encryptSecret(credentials.serverKey, secret)
          : undefined,
        notificationUrl: credentials.notificationUrl || null,
        finishRedirectUrl: credentials.finishRedirectUrl || null,
        updatedById: actorId || null,
      },
    });
    if (actorId) {
      await client.auditLog
        .create({
          data: {
            actorId,
            action: "payment.settings.saved",
            entityType: "payment_gateway_settings",
            entityId: MIDTRANS_PROVIDER,
            metadata: {
              provider: MIDTRANS_PROVIDER,
              enabled,
              environment: isProduction ? "production" : "sandbox",
              credentialFieldsPresent: {
                merchantId: Boolean(credentials.merchantId),
                clientKey: Boolean(credentials.clientKey),
                serverKey: Boolean(credentials.serverKey),
              },
              notificationUrl: credentials.notificationUrl,
              finishRedirectUrl: credentials.finishRedirectUrl,
            },
          },
        })
        .catch(() => undefined);
    }
    return this.status();
  }
}

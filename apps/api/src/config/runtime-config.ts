import { Injectable } from "@nestjs/common";
import { providersFromEnv } from "@cliper/ai-router";
import { validateClipJobPricingPolicy } from "@cliper/billing";
import { Socket } from "node:net";

export interface RuntimeConfigReport {
  mode: string;
  ready: boolean;
  errors: string[];
  warnings: string[];
  providers: Array<{
    code: string;
    model: string;
    keyCount: number;
    enabled: boolean;
  }>;
  infrastructure: {
    database: boolean;
    redis: boolean;
    secureOrigins: boolean;
    analysisBillingStorage: "memory" | "postgres";
    desktopSessionStorage: "memory" | "postgres";
  };
}

function secretLength(value?: string): number {
  return String(value || "").trim().length;
}

function looksLikePlaceholderSecret(value?: string): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("change-me") ||
    normalized.includes("replace-me") ||
    normalized.includes("placeholder") ||
    normalized.includes("isi_random") ||
    normalized.includes("your-secret") ||
    /^(.)\1{31,}$/.test(normalized)
  );
}

export async function checkTcpUrl(
  value: string | undefined,
  fallbackPort: number,
  timeoutMs = 700,
): Promise<boolean> {
  if (!value) return false;
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    return false;
  }
  const port = Number(target.port || fallbackPort);
  if (!target.hostname || !Number.isFinite(port)) return false;
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, target.hostname);
  });
}

export function validateRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfigReport {
  const mode = String(env.NODE_ENV || "development").toLowerCase();
  const production = mode === "production";
  const errors: string[] = [];
  const warnings: string[] = [];
  const providerDefinitions = providersFromEnv(env);
  const providers = providerDefinitions.map((provider) => ({
    code: provider.code,
    model: provider.model,
    keyCount: provider.apiKeys.length,
    enabled: provider.enabled !== false && provider.apiKeys.length > 0,
  }));
  const activeProviders = providers.filter((provider) => provider.enabled);
  if (!activeProviders.length) {
    const message =
      "Tidak ada provider AI aktif. Konfigurasikan minimal satu provider key.";
    warnings.push(message);
  }

  const requiredSecrets: Array<[string, number]> = [
    ["JWT_SECRET", 32],
    ["REFRESH_TOKEN_SECRET", 32],
    ["ADMIN_API_KEY", 24],
    ["PROVIDER_ENCRYPTION_KEY", 32],
  ];
  for (const [name, minimum] of requiredSecrets) {
    const value = env[name];
    if (secretLength(value) < minimum) {
      const message = `${name} wajib memiliki minimal ${minimum} karakter.`;
      production ? errors.push(message) : warnings.push(message);
    } else if (production && looksLikePlaceholderSecret(value)) {
      errors.push(`${name} production tidak boleh memakai nilai contoh atau placeholder.`);
    }
  }
  if (env.JWT_SECRET && env.JWT_SECRET === env.REFRESH_TOKEN_SECRET) {
    errors.push("JWT_SECRET dan REFRESH_TOKEN_SECRET harus berbeda.");
  }
  const paymentConfigEncryptionKey = String(env.PAYMENT_CONFIG_ENCRYPTION_KEY || "").trim();
  if (paymentConfigEncryptionKey) {
    if (secretLength(paymentConfigEncryptionKey) < 32) {
      const message = "PAYMENT_CONFIG_ENCRYPTION_KEY wajib minimal 32 karakter bila disetel.";
      production ? errors.push(message) : warnings.push(message);
    } else if (production && looksLikePlaceholderSecret(paymentConfigEncryptionKey)) {
      errors.push("PAYMENT_CONFIG_ENCRYPTION_KEY production tidak boleh memakai nilai contoh atau placeholder.");
    }
  }
  if (production && env.CLIPER_DEV_API_KEY) {
    errors.push(
      "CLIPER_DEV_API_KEY tidak boleh dipakai pada production; gunakan database-backed API key.",
    );
  }
  if (
    production &&
    (!env.BOOTSTRAP_ADMIN_EMAIL || !env.BOOTSTRAP_ADMIN_PASSWORD_HASH)
  ) {
    errors.push(
      "BOOTSTRAP_ADMIN_EMAIL dan BOOTSTRAP_ADMIN_PASSWORD_HASH wajib untuk control-plane MVP.",
    );
  }
  if (production && (env.DEV_ADMIN_EMAIL || env.DEV_ADMIN_PASSWORD_HASH)) {
    warnings.push(
      "DEV_ADMIN_* diabaikan pada production; gunakan BOOTSTRAP_ADMIN_*.",
    );
  }
  if (
    !production &&
    (!env.DEV_ADMIN_EMAIL || !env.DEV_ADMIN_PASSWORD_HASH) &&
    (!env.BOOTSTRAP_ADMIN_EMAIL || !env.BOOTSTRAP_ADMIN_PASSWORD_HASH)
  ) {
    warnings.push("Fixed development admin belum dikonfigurasi.");
  }
  if (!env.DATABASE_URL) {
    const message =
      "DATABASE_URL belum dikonfigurasi; Payment Engine dan persistence database tidak dapat berjalan.";
    production ? errors.push(message) : warnings.push(message);
  }
  if (!env.REDIS_URL) {
    warnings.push(
      "REDIS_URL belum dikonfigurasi; distributed cache belum aktif.",
    );
  }
  const analysisBillingStorage =
    String(
      env.ANALYSIS_BILLING_STORAGE || (production ? "postgres" : "memory"),
    ).toLowerCase() === "postgres"
      ? "postgres"
      : "memory";
  if (production && analysisBillingStorage !== "postgres") {
    errors.push(
      "ANALYSIS_BILLING_STORAGE production wajib 'postgres'; memory hanya untuk uji lokal.",
    );
  }
  if (analysisBillingStorage === "postgres" && !env.DATABASE_URL) {
    errors.push("ANALYSIS_BILLING_STORAGE=postgres membutuhkan DATABASE_URL.");
  }
  const desktopSessionDefault =
    production || (Boolean(env.DATABASE_URL) && ["postgres", "postgresql"].includes(String(env.LICENSE_STORAGE || "").toLowerCase()))
      ? "postgres"
      : "memory";
  const desktopSessionStorage =
    String(env.DESKTOP_SESSION_STORAGE || desktopSessionDefault).toLowerCase() === "postgresql" ||
    String(env.DESKTOP_SESSION_STORAGE || desktopSessionDefault).toLowerCase() === "postgres"
      ? "postgres"
      : "memory";
  if (production && desktopSessionStorage !== "postgres") {
    errors.push("DESKTOP_SESSION_STORAGE production wajib 'postgres'; sesi Electron tidak boleh hilang saat API restart.");
  }
  if (desktopSessionStorage === "postgres" && !env.DATABASE_URL) {
    errors.push("DESKTOP_SESSION_STORAGE=postgres membutuhkan DATABASE_URL.");
  }
  for (const provider of providerDefinitions.filter(
    (item) => item.enabled !== false && item.apiKeys.length > 0,
  )) {
    if (
      Number(provider.inputUsdPerM || 0) <= 0 ||
      Number(provider.outputUsdPerM || 0) <= 0
    ) {
      const message = `Rate token provider ${provider.code}/${provider.model} belum valid; input dan output USD per 1M wajib > 0.`;
      production ? errors.push(message) : warnings.push(message);
    }
  }
  const origins = String(env.WEB_ORIGIN || "");
  const secureOrigins = Boolean(origins) && origins !== "*";
  if (production && !secureOrigins)
    errors.push("WEB_ORIGIN production wajib eksplisit dan tidak boleh '*'.");
  if (!env.RESEND_API_KEY || !env.PASSWORD_RESET_FROM) {
    warnings.push("Pemulihan password email belum dikonfigurasi. Set RESEND_API_KEY dan PASSWORD_RESET_FROM untuk mengaktifkannya.");
  }
  const paymentProvider = String(
    env.PAYMENT_PRIMARY_PROVIDER || env.PAYMENT_PROVIDER || "sandbox",
  ).toLowerCase();
  if (!["sandbox", "midtrans", "xendit"].includes(paymentProvider)) {
    errors.push("PAYMENT_PRIMARY_PROVIDER/PAYMENT_PROVIDER harus bernilai xendit, midtrans, atau sandbox.");
  }
  if (String(env.PAYMENT_FALLBACK_ENABLED || "false").toLowerCase() === "true") {
    errors.push(
      "PAYMENT_FALLBACK_ENABLED tidak didukung. Gunakan satu provider payment aktif agar invoice, webhook, dan ledger tetap konsisten.",
    );
  }
  const sandboxAllowed =
    String(env.ALLOW_SANDBOX_PAYMENTS || "false").toLowerCase() === "true";
  if (production && paymentProvider === "sandbox" && !sandboxAllowed) {
    warnings.push(
      "Checkout ENV sandbox dinonaktifkan di production. Aktifkan Midtrans melalui Railway Variables atau Encrypted Admin Settings sebelum menerima pembayaran nyata.",
    );
  }
  if (
    production &&
    paymentProvider === "sandbox" &&
    sandboxAllowed &&
    secretLength(env.PAYMENT_SANDBOX_WEBHOOK_SECRET) < 32
  ) {
    errors.push(
      "PAYMENT_SANDBOX_WEBHOOK_SECRET wajib minimal 32 karakter ketika sandbox diizinkan pada production.",
    );
  }
  if (paymentProvider === "midtrans") {
    const requiredMidtransFields: Array<[string, number]> = [
      ["MIDTRANS_MERCHANT_ID", 1],
      ["MIDTRANS_CLIENT_KEY", 12],
      ["MIDTRANS_SERVER_KEY", 20],
    ];
    for (const [name, minimum] of requiredMidtransFields) {
      if (secretLength(env[name]) < minimum) {
        const message = `${name} wajib dikonfigurasi ketika PAYMENT_PROVIDER=midtrans.`;
        production ? errors.push(message) : warnings.push(message);
      }
    }
  }
  if (paymentProvider === "xendit") {
    const requiredXenditFields: Array<[string, number]> = [
      ["XENDIT_SECRET_KEY", 20],
      ["XENDIT_WEBHOOK_TOKEN", 16],
    ];
    for (const [name, minimum] of requiredXenditFields) {
      if (secretLength(env[name]) < minimum) {
        const message = `${name} wajib dikonfigurasi ketika provider utama adalah xendit.`;
        production ? errors.push(message) : warnings.push(message);
      }
    }
    if (/^xnd_public_/i.test(String(env.XENDIT_SECRET_KEY || "").trim())) {
      warnings.push(
        "XENDIT_SECRET_KEY berisi Public API Key. Buat Secret API Key dengan izin Money-In Write di Xendit Dashboard lalu simpan hanya pada Railway @cliper/api.",
      );
    }
    const xenditMode = String(env.XENDIT_MODE || "test").trim().toLowerCase();
    if (!["test", "live"].includes(xenditMode)) {
      errors.push("XENDIT_MODE harus bernilai test atau live.");
    }
    if (String(env.XENDIT_ENABLED || "true").toLowerCase() === "false") {
      errors.push("XENDIT_ENABLED tidak boleh false ketika provider utama adalah xendit.");
    }
    if (production && xenditMode !== "live") {
      warnings.push("Xendit masih TEST mode. Pembayaran nyata belum boleh diumumkan sebelum XENDIT_MODE=live dan QRIS live telah aktif.");
    }
  }
  if (paymentProvider === "midtrans" && !env.WEB_ORIGIN) {
    warnings.push(
      "WEB_ORIGIN diperlukan agar redirect selesai Midtrans kembali ke invoice user.",
    );
  }
  const midtransProduction =
    String(env.MIDTRANS_IS_PRODUCTION || "false").toLowerCase() === "true";
  const midtransClientKey = String(env.MIDTRANS_CLIENT_KEY || "").trim();
  const midtransServerKey = String(env.MIDTRANS_SERVER_KEY || "").trim();
  if (paymentProvider === "midtrans" && !production && midtransProduction) {
    errors.push(
      "MIDTRANS_IS_PRODUCTION tidak boleh true di localhost. Gunakan Sandbox Access Key untuk pengujian lokal.",
    );
  }
  if (production && paymentProvider === "midtrans" && !midtransProduction) {
    errors.push("PAYMENT_PROVIDER=midtrans di production membutuhkan MIDTRANS_IS_PRODUCTION=true.");
  }
  if (
    paymentProvider === "midtrans" &&
    midtransProduction &&
    midtransServerKey &&
    !/^Mid-server-/i.test(midtransServerKey)
  ) {
    errors.push(
      "MIDTRANS_IS_PRODUCTION=true membutuhkan Server Key Production, bukan Sandbox.",
    );
  }
  if (
    paymentProvider === "midtrans" &&
    !midtransProduction &&
    midtransServerKey &&
    !/^SB-Mid-server-/i.test(midtransServerKey)
  ) {
    errors.push(
      "MIDTRANS_IS_PRODUCTION=false membutuhkan Server Key Sandbox. Jangan gunakan key Production di localhost.",
    );
  }
  if (
    paymentProvider === "midtrans" &&
    midtransProduction &&
    midtransClientKey &&
    !/^Mid-client-/i.test(midtransClientKey)
  ) {
    errors.push("MIDTRANS_IS_PRODUCTION=true membutuhkan Client Key Production.");
  }
  if (
    paymentProvider === "midtrans" &&
    !midtransProduction &&
    midtransClientKey &&
    !/^SB-Mid-client-/i.test(midtransClientKey)
  ) {
    errors.push("MIDTRANS_IS_PRODUCTION=false membutuhkan Client Key Sandbox.");
  }
  const midtransQrisAcquirer = String(env.MIDTRANS_QRIS_ACQUIRER || "gopay").trim().toLowerCase();
  if (
    paymentProvider === "midtrans" &&
    !["gopay", "airpay_shopee"].includes(midtransQrisAcquirer)
  ) {
    errors.push("MIDTRANS_QRIS_ACQUIRER harus bernilai gopay atau airpay_shopee.");
  }
  const minimumTopupIdr = Number(env.PAYMENT_MIN_TOPUP_IDR || 17_000);
  const minTopupUsd = Number(env.PAYMENT_MIN_TOPUP_USD || 1);
  const usdToIdrTopupRate = Number(
    env.PAYMENT_USD_TO_IDR_DISPLAY_RATE || env.PLATFORM_USD_TO_IDR || 17_700,
  );
  const maxTopup = Number(env.PAYMENT_MAX_TOPUP_IDR || 10_000_000);
  if (
    !Number.isSafeInteger(minimumTopupIdr) ||
    !Number.isFinite(minTopupUsd) ||
    minTopupUsd <= 0 ||
    !Number.isSafeInteger(usdToIdrTopupRate) ||
    usdToIdrTopupRate <= 0 ||
    !Number.isSafeInteger(maxTopup) ||
    minimumTopupIdr < 17_000 ||
    maxTopup < minimumTopupIdr
  ) {
    errors.push(
      "Konfigurasi top-up tidak valid. PAYMENT_MIN_TOPUP_IDR minimal 17000; USD hanya dipakai sebagai referensi tampilan.",
    );
  }
  const creditsPerIdr = Number(env.PAYMENT_CREDITS_PER_IDR || 1);
  if (!Number.isFinite(creditsPerIdr) || creditsPerIdr <= 0)
    errors.push(
      "PAYMENT_CREDITS_PER_IDR harus berupa angka lebih besar dari nol.",
    );
  const minimumMarginBps = Number(env.MINIMUM_MARGIN_BPS || 5_000);
  if (
    !Number.isInteger(minimumMarginBps) ||
    minimumMarginBps < 5_000 ||
    minimumMarginBps > 9_500
  ) {
    errors.push(
      "MINIMUM_MARGIN_BPS harus integer antara 5000 dan 9500 agar margin gross minimal 50% tetap terjaga.",
    );
  }
  const minimumClipCharge = Number(env.MINIMUM_CLIP_CHARGE_MICRO_USD || 5_000);
  if (!Number.isSafeInteger(minimumClipCharge) || minimumClipCharge < 0)
    errors.push("MINIMUM_CLIP_CHARGE_MICRO_USD harus integer nol atau lebih.");
  const usdToIdr = Number(env.PLATFORM_USD_TO_IDR || 16_000);
  if (!Number.isFinite(usdToIdr) || usdToIdr <= 0)
    errors.push("PLATFORM_USD_TO_IDR harus lebih besar dari nol.");
  const jobPricingValidation = validateClipJobPricingPolicy({
    creditValueIdr: Number(env.CLIPER_CREDIT_VALUE_IDR || 1),
    minimumGrossMarginBps: Number(env.MINIMUM_MARGIN_BPS || 5_000),
    targetGrossMarginBps: Number(env.TARGET_GROSS_MARGIN_BPS || 6_000),
    baseAnalysisCredits: Number(env.BASE_ANALYSIS_CREDITS || 300),
    optionalClipCredits: Number(env.OPTIONAL_CLIP_CREDITS || 50),
    goodClipCredits: Number(env.GOOD_CLIP_CREDITS || 100),
    premiumClipCredits: Number(env.PREMIUM_CLIP_CREDITS || 150),
    optionalScoreMin: Number(env.OPTIONAL_SCORE_MIN || 70),
    goodScoreMin: Number(env.GOOD_SCORE_MIN || 78),
    premiumScoreMin: Number(env.PREMIUM_SCORE_MIN || 90),
    minimumJobCredits: Number(env.MINIMUM_JOB_CREDITS || 300),
    maximumJobCredits: Number(env.MAXIMUM_JOB_CREDITS || 2_000),
    infrastructureFeeIdr: Number(env.INFRASTRUCTURE_FEE_IDR || 50),
    safetyBufferBps: Number(env.SAFETY_BUFFER_BPS || 1_000),
    retryAllowanceBps: Number(env.RETRY_ALLOWANCE_BPS || 500),
    paymentFeeAllocationBps: Number(env.PAYMENT_FEE_ALLOCATION_BPS || 0),
    targetProviderCostIdr: Number(env.TARGET_PROVIDER_COST_IDR || 250),
    warningProviderCostIdr: Number(env.WARNING_PROVIDER_COST_IDR || 400),
    hardProviderCostIdr: Number(env.HARD_PROVIDER_COST_IDR || 500),
    lowBalanceWarningCredits: Number(env.LOW_BALANCE_WARNING_CREDITS || 5_000),
  });
  errors.push(
    ...jobPricingValidation.errors.map((message) => `Pricing job: ${message}`),
  );
  warnings.push(
    ...jobPricingValidation.warnings.map(
      (message) => `Pricing job: ${message}`,
    ),
  );

  return {
    mode,
    ready: errors.length === 0 && activeProviders.length > 0,
    errors,
    warnings,
    providers,
    infrastructure: {
      database: Boolean(env.DATABASE_URL),
      redis: Boolean(env.REDIS_URL),
      secureOrigins,
      analysisBillingStorage,
      desktopSessionStorage,
    },
  };
}

@Injectable()
export class RuntimeConfigService {
  private readonly reportValue = validateRuntimeConfig();

  report(): RuntimeConfigReport {
    return this.reportValue;
  }

  async dependencies(): Promise<{ database: boolean; redis: boolean }> {
    const [database, redis] = await Promise.all([
      checkTcpUrl(process.env.DATABASE_URL, 5432),
      checkTcpUrl(process.env.REDIS_URL, 6379),
    ]);
    return { database, redis };
  }

  assertProductionSafe(): void {
    if (
      this.reportValue.mode === "production" &&
      this.reportValue.errors.length
    ) {
      throw new Error(
        `Konfigurasi production tidak aman: ${this.reportValue.errors.join(" | ")}`,
      );
    }
  }
}

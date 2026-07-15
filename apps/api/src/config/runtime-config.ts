import { Injectable } from "@nestjs/common";
import { providersFromEnv } from "@cliper/ai-router";
import { Socket } from "node:net";

export interface RuntimeConfigReport {
  mode: string;
  ready: boolean;
  errors: string[];
  warnings: string[];
  providers: Array<{ code: string; model: string; keyCount: number; enabled: boolean }>;
  infrastructure: {
    database: boolean;
    redis: boolean;
    secureOrigins: boolean;
  };
}

function secretLength(value?: string): number {
  return String(value || "").trim().length;
}

export async function checkTcpUrl(value: string | undefined, fallbackPort: number, timeoutMs = 700): Promise<boolean> {
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

export function validateRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfigReport {
  const mode = String(env.NODE_ENV || "development").toLowerCase();
  const production = mode === "production";
  const errors: string[] = [];
  const warnings: string[] = [];
  const providers = providersFromEnv(env).map((provider) => ({
    code: provider.code,
    model: provider.model,
    keyCount: provider.apiKeys.length,
    enabled: provider.enabled !== false && provider.apiKeys.length > 0,
  }));
  const activeProviders = providers.filter((provider) => provider.enabled);
  if (!activeProviders.length) {
    const message = "Tidak ada provider AI aktif. Konfigurasikan minimal satu provider key.";
    warnings.push(message);
  }

  const requiredSecrets: Array<[string, number]> = [
    ["JWT_SECRET", 32],
    ["REFRESH_TOKEN_SECRET", 32],
    ["ADMIN_API_KEY", 24],
    ["PROVIDER_ENCRYPTION_KEY", 32],
  ];
  for (const [name, minimum] of requiredSecrets) {
    if (secretLength(env[name]) < minimum) {
      const message = `${name} wajib memiliki minimal ${minimum} karakter.`;
      production ? errors.push(message) : warnings.push(message);
    }
  }
  if (env.JWT_SECRET && env.JWT_SECRET === env.REFRESH_TOKEN_SECRET) {
    errors.push("JWT_SECRET dan REFRESH_TOKEN_SECRET harus berbeda.");
  }
  if (production && env.CLIPER_DEV_API_KEY) {
    errors.push("CLIPER_DEV_API_KEY tidak boleh dipakai pada production; gunakan database-backed API key.");
  }
  if (production && (!env.BOOTSTRAP_ADMIN_EMAIL || !env.BOOTSTRAP_ADMIN_PASSWORD_HASH)) {
    errors.push("BOOTSTRAP_ADMIN_EMAIL dan BOOTSTRAP_ADMIN_PASSWORD_HASH wajib untuk control-plane MVP.");
  }
  if (production && (env.DEV_ADMIN_EMAIL || env.DEV_ADMIN_PASSWORD_HASH)) {
    warnings.push("DEV_ADMIN_* diabaikan pada production; gunakan BOOTSTRAP_ADMIN_*.");
  }
  if (!production && (!env.DEV_ADMIN_EMAIL || !env.DEV_ADMIN_PASSWORD_HASH) && (!env.BOOTSTRAP_ADMIN_EMAIL || !env.BOOTSTRAP_ADMIN_PASSWORD_HASH)) {
    warnings.push("Fixed development admin belum dikonfigurasi.");
  }
  if (!env.DATABASE_URL) {
    const message = "DATABASE_URL belum dikonfigurasi; Payment Engine dan persistence database tidak dapat berjalan.";
    production ? errors.push(message) : warnings.push(message);
  }
  if (!env.REDIS_URL) {
    warnings.push("REDIS_URL belum dikonfigurasi; distributed cache belum aktif.");
  }
  const origins = String(env.WEB_ORIGIN || "");
  const secureOrigins = Boolean(origins) && origins !== "*";
  if (production && !secureOrigins) errors.push("WEB_ORIGIN production wajib eksplisit dan tidak boleh '*'.");
  const paymentProvider = String(env.PAYMENT_PROVIDER || "sandbox").toLowerCase();
  const sandboxAllowed = String(env.ALLOW_SANDBOX_PAYMENTS || "false").toLowerCase() === "true";
  if (production && paymentProvider === "sandbox" && !sandboxAllowed) {
    warnings.push("Sandbox payment dinonaktifkan di production; pilih PAYMENT_PROVIDER=midtrans untuk checkout nyata.");
  }
  if (production && paymentProvider === "sandbox" && sandboxAllowed && secretLength(env.PAYMENT_SANDBOX_WEBHOOK_SECRET) < 32) {
    errors.push("PAYMENT_SANDBOX_WEBHOOK_SECRET wajib minimal 32 karakter ketika sandbox diizinkan pada production.");
  }
  if (paymentProvider === "midtrans" && secretLength(env.MIDTRANS_SERVER_KEY) < 20) {
    const message = "MIDTRANS_SERVER_KEY wajib dikonfigurasi ketika PAYMENT_PROVIDER=midtrans.";
    production ? errors.push(message) : warnings.push(message);
  }
  if (paymentProvider === "midtrans" && !env.WEB_ORIGIN) {
    warnings.push("WEB_ORIGIN diperlukan agar redirect selesai Midtrans kembali ke invoice user.");
  }
  const minTopup = Number(env.PAYMENT_MIN_TOPUP_IDR || 25_000);
  const maxTopup = Number(env.PAYMENT_MAX_TOPUP_IDR || 10_000_000);
  if (!Number.isSafeInteger(minTopup) || !Number.isSafeInteger(maxTopup) || minTopup < 25_000 || maxTopup < minTopup) {
    errors.push("PAYMENT_MIN_TOPUP_IDR/PAYMENT_MAX_TOPUP_IDR tidak valid; minimum wajib >= 25000 dan max harus >= minimum.");
  }
  const creditsPerIdr = Number(env.PAYMENT_CREDITS_PER_IDR || 1);
  if (!Number.isFinite(creditsPerIdr) || creditsPerIdr <= 0) errors.push("PAYMENT_CREDITS_PER_IDR harus berupa angka lebih besar dari nol.");
  const minimumMarginBps = Number(env.MINIMUM_MARGIN_BPS || 5_000);
  if (!Number.isInteger(minimumMarginBps) || minimumMarginBps < 5_000 || minimumMarginBps > 9_500) {
    errors.push("MINIMUM_MARGIN_BPS harus integer antara 5000 dan 9500 agar margin gross minimal 50% tetap terjaga.");
  }
  const minimumClipCharge = Number(env.MINIMUM_CLIP_CHARGE_MICRO_USD || 5_000);
  if (!Number.isSafeInteger(minimumClipCharge) || minimumClipCharge < 0) errors.push("MINIMUM_CLIP_CHARGE_MICRO_USD harus integer nol atau lebih.");
  const usdToIdr = Number(env.PLATFORM_USD_TO_IDR || 16_000);
  if (!Number.isFinite(usdToIdr) || usdToIdr <= 0) errors.push("PLATFORM_USD_TO_IDR harus lebih besar dari nol.");

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
    if (this.reportValue.mode === "production" && this.reportValue.errors.length) {
      throw new Error(`Konfigurasi production tidak aman: ${this.reportValue.errors.join(" | ")}`);
    }
  }
}

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
    production ? errors.push(message) : warnings.push(message);
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
  if (production && (env.DEV_ADMIN_EMAIL || env.DEV_ADMIN_PASSWORD_HASH)) {
    errors.push("DEV_ADMIN_* tidak boleh dipakai pada production; gunakan database-backed admin account.");
  }
  if (!production && (!env.DEV_ADMIN_EMAIL || !env.DEV_ADMIN_PASSWORD_HASH)) {
    warnings.push("Fixed development admin belum dikonfigurasi.");
  }
  if (!env.DATABASE_URL) {
    const message = "DATABASE_URL belum dikonfigurasi.";
    production ? errors.push(message) : warnings.push(message);
  }
  if (!env.REDIS_URL) {
    const message = "REDIS_URL belum dikonfigurasi.";
    production ? errors.push(message) : warnings.push(message);
  }
  const origins = String(env.WEB_ORIGIN || "");
  const secureOrigins = Boolean(origins) && origins !== "*";
  if (production && !secureOrigins) errors.push("WEB_ORIGIN production wajib eksplisit dan tidak boleh '*'.");

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

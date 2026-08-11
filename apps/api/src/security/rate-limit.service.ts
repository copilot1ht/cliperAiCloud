import { HttpException, HttpStatus, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { RedisService } from "./redis.service.js";

interface RateWindow {
  timestamps: number[];
}

interface LimitResult {
  limit: number;
  remaining: number;
  resetAt: string;
}

const CONSUME_WINDOW = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
  local ttl = redis.call('PTTL', KEYS[1])
  return { count, ttl }
`;

const ACQUIRE_LEASE = `
  local current = tonumber(redis.call('GET', KEYS[1]) or '0')
  if current >= tonumber(ARGV[1]) then return { 0, current } end
  local next = redis.call('INCR', KEYS[1])
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return { 1, next }
`;

const RELEASE_LEASE = `
  local current = tonumber(redis.call('GET', KEYS[1]) or '0')
  if current <= 1 then redis.call('DEL', KEYS[1]) else redis.call('DECR', KEYS[1]) end
  return current
`;

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.round(parsed))) : fallback;
}

function production(): boolean {
  return String(process.env.NODE_ENV || "development").toLowerCase() === "production";
}

@Injectable()
export class RateLimitService {
  private readonly windows = new Map<string, RateWindow>();
  private readonly leases = new Map<string, number>();

  constructor(private readonly redis: RedisService) {}

  async assertAllowed(accountId: string, plan: string): Promise<LimitResult> {
    return this.assertScope(`ai-rate:${plan}`, accountId, this.planLimit(plan), 60_000);
  }

  async assertAuthLogin(ip: string, email?: string): Promise<LimitResult> {
    return this.assertScope("auth-login", `${ip}:${email || "anonymous"}`, this.configuredLimit("RATE_LIMIT_AUTH_LOGIN_PER_MINUTE", 5), 60_000);
  }

  async assertPasswordReset(ip: string, email?: string): Promise<LimitResult> {
    return this.assertScope("password-reset", `${ip}:${email || "anonymous"}`, this.configuredLimit("RATE_LIMIT_PASSWORD_RESET_PER_15_MINUTES", 3), 15 * 60_000);
  }

  async assertKeyCreate(userId: string): Promise<LimitResult> {
    return this.assertScope("key-create", userId, this.configuredLimit("RATE_LIMIT_KEY_CREATE_PER_HOUR", 5), 60 * 60_000);
  }

  async assertPaymentCreate(userId: string): Promise<LimitResult> {
    return this.assertScope("payment-create", userId, this.configuredLimit("RATE_LIMIT_PAYMENT_CREATE_PER_10_MINUTES", 5), 10 * 60_000);
  }

  async assertPaymentSync(userId: string, invoice: string): Promise<LimitResult> {
    return this.assertScope("payment-sync", `${userId}:${invoice}`, this.configuredLimit("RATE_LIMIT_PAYMENT_SYNC_PER_MINUTE", 20), 60_000);
  }

  async withAiConcurrency<T>(accountId: string, apiKeyId: string | undefined, plan: string, work: () => Promise<T>): Promise<T> {
    const limit = this.aiConcurrencyLimit(plan);
    const scope = apiKeyId || accountId;
    const key = this.redisKey(`ai-concurrency:${scope}`);
    const acquired = await this.acquireLease(key, limit);
    if (!acquired) {
      throw new HttpException(
        { statusCode: 429, code: "AI_CONCURRENCY_LIMIT", message: "Terlalu banyak request AI aktif. Tunggu request sebelumnya selesai.", retryAfter: 5 },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    try {
      return await work();
    } finally {
      await this.releaseLease(key);
    }
  }

  async withProviderCapacity<T>(providerCode: string, work: () => Promise<T>): Promise<T> {
    const provider = String(providerCode || "unknown").trim().toLowerCase();
    const rateLimit = this.providerRateLimit(provider);
    const rate = await this.consume(this.redisKey(`ai-provider-rate:${provider}`), rateLimit, 1_000);
    if (rate.count > rateLimit) {
      throw new HttpException(
        {
          statusCode: 429,
          code: "PROVIDER_RATE_LIMITED",
          message: "Provider AI sedang mencapai batas throughput. Coba lagi sesaat.",
          retryAfter: Math.max(1, Math.ceil(rate.ttlMs / 1_000)),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const key = this.redisKey(`ai-provider-concurrency:${provider}`);
    const acquired = await this.acquireLease(key, this.providerConcurrencyLimit(provider));
    if (!acquired) {
      throw new HttpException(
        {
          statusCode: 429,
          code: "PROVIDER_CONCURRENCY_LIMIT",
          message: "Provider AI sedang penuh. Coba lagi sesaat.",
          retryAfter: 3,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    try {
      return await work();
    } finally {
      await this.releaseLease(key);
    }
  }

  limits() {
    return {
      free: this.planLimit("free"),
      starter: this.planLimit("starter"),
      pro: this.planLimit("pro"),
      enterprise: this.planLimit("enterprise"),
      aiConcurrency: {
        free: this.aiConcurrencyLimit("free"),
        starter: this.aiConcurrencyLimit("starter"),
        pro: this.aiConcurrencyLimit("pro"),
        enterprise: this.aiConcurrencyLimit("enterprise"),
      },
      provider: {
        requestsPerSecond: this.providerRateLimit("default"),
        concurrency: this.providerConcurrencyLimit("default"),
      },
      distributed: this.redis.configured(),
    };
  }

  private async assertScope(scope: string, identity: string, limit: number, windowMs: number): Promise<LimitResult> {
    const key = this.redisKey(`${scope}:${identity}`);
    const result = await this.consume(key, limit, windowMs);
    if (result.count > limit) {
      const retryAfter = Math.max(1, Math.ceil(result.ttlMs / 1_000));
      throw new HttpException(
        { statusCode: 429, code: "RATE_LIMITED", message: "Terlalu banyak request. Coba lagi setelah batas waktu berakhir.", retryAfter },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return {
      limit,
      remaining: Math.max(0, limit - result.count),
      resetAt: new Date(Date.now() + Math.max(0, result.ttlMs)).toISOString(),
    };
  }

  private async consume(key: string, limit: number, windowMs: number): Promise<{ count: number; ttlMs: number }> {
    const distributed = await this.redis.eval(CONSUME_WINDOW, [key], [String(windowMs)]);
    if (Array.isArray(distributed) && distributed.length >= 2) {
      return { count: Number(distributed[0]) || 0, ttlMs: Math.max(0, Number(distributed[1]) || windowMs) };
    }
    if (production()) throw new ServiceUnavailableException("Redis rate limiter tidak tersedia.");
    const now = Date.now();
    const window = this.windows.get(key) || { timestamps: [] };
    window.timestamps = window.timestamps.filter((value) => value > now - windowMs);
    window.timestamps.push(now);
    this.windows.set(key, window);
    return { count: window.timestamps.length, ttlMs: Math.max(0, (window.timestamps[0] || now) + windowMs - now) };
  }

  private async acquireLease(key: string, limit: number): Promise<boolean> {
    const ttlMs = boundedInteger(process.env.AI_CONCURRENCY_TTL_MS, 90_000, 15_000, 300_000);
    const distributed = await this.redis.eval(ACQUIRE_LEASE, [key], [String(limit), String(ttlMs)]);
    if (Array.isArray(distributed)) return Number(distributed[0]) === 1;
    if (production()) throw new ServiceUnavailableException("Redis concurrency guard tidak tersedia.");
    const current = this.leases.get(key) || 0;
    if (current >= limit) return false;
    this.leases.set(key, current + 1);
    return true;
  }

  private async releaseLease(key: string): Promise<void> {
    const distributed = await this.redis.eval(RELEASE_LEASE, [key], []);
    if (distributed !== undefined) return;
    if (!production()) {
      const current = this.leases.get(key) || 0;
      if (current <= 1) this.leases.delete(key);
      else this.leases.set(key, current - 1);
    }
  }

  private planLimit(plan: string): number {
    const normalized = String(plan || "free").toLowerCase();
    const defaults: Record<string, number> = { free: 3, starter: 5, pro: 30, team: 60, enterprise: 120 };
    return this.configuredLimit(`RATE_LIMIT_${normalized.toUpperCase()}_PER_MINUTE`, defaults[normalized] || defaults.free!);
  }

  private aiConcurrencyLimit(plan: string): number {
    const normalized = String(plan || "free").toUpperCase();
    const defaults: Record<string, number> = { FREE: 1, STARTER: 2, PRO: 4, TEAM: 6, ENTERPRISE: 10 };
    return this.configuredLimit(`AI_CONCURRENCY_${normalized}`, defaults[normalized] || defaults.FREE!);
  }

  private providerRateLimit(provider: string): number {
    const normalized = provider.replace(/[^A-Z0-9]/gi, "_").toUpperCase();
    return this.configuredLimit(
      `AI_PROVIDER_RPS_${normalized}`,
      this.configuredLimit("AI_PROVIDER_RPS", 30),
    );
  }

  private providerConcurrencyLimit(provider: string): number {
    const normalized = provider.replace(/[^A-Z0-9]/gi, "_").toUpperCase();
    return this.configuredLimit(
      `AI_PROVIDER_CONCURRENCY_${normalized}`,
      this.configuredLimit("AI_PROVIDER_CONCURRENCY", 20),
    );
  }

  private configuredLimit(name: string, fallback: number): number {
    return boundedInteger(process.env[name], fallback, 1, 10_000);
  }

  private redisKey(value: string): string {
    return `cliper:guard:${createHash("sha256").update(value).digest("hex")}`;
  }
}

import { HttpException, HttpStatus, Injectable } from "@nestjs/common";

interface RateWindow {
  timestamps: number[];
}

@Injectable()
export class RateLimitService {
  private readonly windows = new Map<string, RateWindow>();

  assertAllowed(accountId: string, plan: string): { limit: number; remaining: number; resetAt: string } {
    const now = Date.now();
    const limit = this.limit(plan);
    const key = `${accountId}:${String(plan).toLowerCase()}`;
    const window = this.windows.get(key) || { timestamps: [] };
    window.timestamps = window.timestamps.filter((value) => value > now - 60_000);
    if (window.timestamps.length >= limit) {
      const resetAt = new Date((window.timestamps[0] || now) + 60_000).toISOString();
      throw new HttpException({ statusCode: 429, message: `Rate limit plan ${plan} tercapai.`, resetAt }, HttpStatus.TOO_MANY_REQUESTS);
    }
    window.timestamps.push(now);
    this.windows.set(key, window);
    return { limit, remaining: Math.max(0, limit - window.timestamps.length), resetAt: new Date((window.timestamps[0] || now) + 60_000).toISOString() };
  }

  limits() {
    return { free: this.limit("free"), starter: this.limit("starter"), pro: this.limit("pro"), enterprise: this.limit("enterprise") };
  }

  private limit(plan: string): number {
    const normalized = String(plan || "free").toLowerCase();
    const defaults: Record<string, number> = { free: 3, starter: 5, pro: 30, team: 60, enterprise: 120 };
    const envName = `RATE_LIMIT_${normalized.toUpperCase()}_PER_MINUTE`;
    const parsed = Number(process.env[envName]);
    return Math.max(1, Math.round(Number.isFinite(parsed) && parsed > 0 ? parsed : defaults[normalized] || defaults.free!));
  }
}

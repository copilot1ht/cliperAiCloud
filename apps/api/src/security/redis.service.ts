import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { createClient } from "redis";

type RedisClient = ReturnType<typeof createClient>;

/**
 * One lazy Redis connection per API process. Redis holds only ephemeral shared
 * state such as rate limits and leases; PostgreSQL remains the financial source
 * of truth.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private client?: RedisClient;
  private connecting?: Promise<RedisClient | undefined>;

  configured(): boolean {
    return Boolean(String(process.env.REDIS_URL || "").trim());
  }

  async eval(script: string, keys: string[], args: string[]): Promise<unknown | undefined> {
    const client = await this.getClient();
    if (!client) return undefined;
    try {
      return await client.eval(script, { keys, arguments: args });
    } catch {
      return undefined;
    }
  }

  async get(key: string): Promise<string | undefined> {
    const client = await this.getClient();
    if (!client) return undefined;
    try {
      return (await client.get(key)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: string, ttlMs: number): Promise<boolean> {
    const client = await this.getClient();
    if (!client) return false;
    try {
      await client.set(key, value, { PX: ttlMs });
      return true;
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client?.isOpen) await this.client.quit().catch(() => undefined);
  }

  private async getClient(): Promise<RedisClient | undefined> {
    if (!this.configured()) return undefined;
    if (this.client?.isOpen) return this.client;
    if (this.connecting) return this.connecting;
    const url = String(process.env.REDIS_URL || "").trim();
    const client = createClient({
      url,
      socket: {
        connectTimeout: 1_500,
        reconnectStrategy: (attempt) => Math.min(2_000, 100 * attempt),
      },
    });
    client.on("error", () => undefined);
    this.client = client;
    this.connecting = client.connect()
      .then(() => client)
      .catch(() => {
        this.client = undefined;
        return undefined;
      })
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }
}

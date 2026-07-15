import { Injectable, OnModuleDestroy, ServiceUnavailableException } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(parsed)));
}

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly prismaValue?: PrismaClient;

  constructor() {
    const connectionString = String(process.env.DATABASE_URL || "").trim();
    if (!connectionString) return;
    const connectionTimeoutMillis = boundedInteger(process.env.DB_CONNECTION_TIMEOUT_MS, 5_000, 1_000, 30_000);
    const max = boundedInteger(process.env.DB_POOL_MAX, 10, 1, 50);
    const adapter = new PrismaPg({ connectionString, connectionTimeoutMillis, idleTimeoutMillis: 30_000, max }, { schema: process.env.DATABASE_SCHEMA || "public" });
    this.prismaValue = new PrismaClient({ adapter });
  }

  configured(): boolean {
    return Boolean(this.prismaValue);
  }

  client(): PrismaClient {
    if (!this.prismaValue) {
      throw new ServiceUnavailableException("PostgreSQL belum dikonfigurasi. Payment Engine tidak memakai penyimpanan sementara.");
    }
    return this.prismaValue;
  }

  async ping(): Promise<boolean> {
    if (!this.prismaValue) return false;
    try {
      await this.prismaValue.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.prismaValue?.$disconnect();
  }
}

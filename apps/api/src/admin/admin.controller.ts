import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { AuthService, authStorageMode, type MemberPlan, type MemberStatus } from "../auth/auth.service.js";
import { GatewayService } from "../gateway/gateway.service.js";
import { AdminSessionGuard } from "../security/admin-session.guard.js";
import { UsageService } from "../usage/usage.service.js";
import { AdminStoreService, type AdminProviderInput, type PricingPolicyInput, type RoutingRule } from "./admin-store.service.js";
import { RuntimeConfigService } from "../config/runtime-config.js";
import { DesktopSessionService } from "../security/desktop-session.service.js";
import { RateLimitService } from "../security/rate-limit.service.js";
import { SecurityEventService } from "../security/security-event.service.js";
import { listProviderCatalog } from "./provider-catalog.js";
import { ProviderConnectionService, type ProviderConnectionInput } from "./provider-connection.service.js";
import { PaymentService } from "../billing/payment.service.js";
import { DatabaseService } from "../database/database.service.js";

const plans = [
  { code: "free", name: "Free", priceIdr: 0, credits: 100, deviceLimit: 1, active: true },
  { code: "starter", name: "Starter", priceIdr: 99_000, credits: 50_000, deviceLimit: 1, active: true },
  { code: "pro", name: "Pro", priceIdr: 299_000, credits: 500_000, deviceLimit: 3, active: true },
  { code: "enterprise", name: "Enterprise", priceIdr: 0, credits: 0, deviceLimit: 10, active: true },
];

@Controller("api/admin")
@UseGuards(AdminSessionGuard)
export class AdminController {
  constructor(
    private readonly gateway: GatewayService,
    private readonly usage: UsageService,
    private readonly auth: AuthService,
    private readonly store: AdminStoreService,
    private readonly runtimeConfig: RuntimeConfigService,
    private readonly desktopSessions: DesktopSessionService,
    private readonly rateLimits: RateLimitService,
    private readonly securityEvents: SecurityEventService,
    private readonly providerConnections: ProviderConnectionService,
    private readonly paymentsService: PaymentService,
    private readonly database: DatabaseService,
  ) {}

  @Get("overview")
  async overview() {
    const users = this.auth.listUsers();
    const providers = this.store.listProviders();
    const payments = await this.paymentsService.adminPayments();
    const usage = this.usage.summary();
    return {
      mode: authStorageMode(),
      users: {
        total: users.length,
        members: users.filter((item) => item.role === "member").length,
        active: users.filter((item) => item.status === "active").length,
        suspended: users.filter((item) => item.status === "suspended").length,
      },
      providers: {
        total: providers.length,
        ready: providers.filter((item) => item.status === "healthy").length,
        needsKey: providers.filter((item) => item.status === "untested" || item.status === "offline").length,
        items: this.gateway.providers(),
      },
      routing: { rules: this.store.listRoutes().length, enabled: this.store.listRoutes().filter((item) => item.enabled).length },
      revenue: payments.summary,
      usage,
      pricing: this.store.pricingPolicy(),
      infrastructure: {
        databaseConfigured: Boolean(process.env.DATABASE_URL),
        redisConfigured: Boolean(process.env.REDIS_URL),
        persistence: this.database.configured(),
      },
    };
  }

  @Get("users")
  users() {
    return { mode: authStorageMode(), users: this.auth.listUsers(), plans };
  }

  @Get("system-health")
  async systemHealth() {
    const report = this.runtimeConfig.report();
    const dependencies = await this.runtimeConfig.dependencies();
    const providers = this.gateway.providers();
    const memory = process.memoryUsage();
    return {
      mode: authStorageMode(),
      checkedAt: new Date().toISOString(),
      process: {
        uptimeSeconds: Math.round(process.uptime()),
        rssMb: Number((memory.rss / 1024 / 1024).toFixed(1)),
        heapUsedMb: Number((memory.heapUsed / 1024 / 1024).toFixed(1)),
        node: process.version,
      },
      components: [
        { code: "gateway", label: "API Gateway", status: "healthy", detail: "NestJS process accepting requests" },
        { code: "database", label: "PostgreSQL", status: dependencies.database ? "healthy" : report.infrastructure.database ? "offline" : "not-configured", detail: dependencies.database ? "TCP connection reachable" : "Database persistence is not active" },
        { code: "redis", label: "Redis", status: dependencies.redis ? "healthy" : report.infrastructure.redis ? "offline" : "not-configured", detail: dependencies.redis ? "TCP connection reachable" : "Distributed cache/rate limit is not active" },
        { code: "providers", label: "AI Providers", status: providers.some((item) => item.status === "healthy") ? "healthy" : "not-configured", detail: `${providers.filter((item) => item.status === "healthy").length}/${providers.length} provider healthy` },
        { code: "queue", label: "Queue", status: "not-configured", detail: "BullMQ worker has not been deployed" },
        { code: "storage", label: "Object Storage", status: "not-configured", detail: "Signed download storage has not been configured" },
        { code: "license", label: "Desktop Sessions", status: "healthy", detail: `${this.desktopSessions.summary().active} active signed sessions` },
      ],
      providers,
      warnings: report.warnings,
      errors: report.errors,
    };
  }

  @Get("security")
  security() {
    return {
      mode: authStorageMode(),
      sessions: this.desktopSessions.summary(),
      events: this.securityEvents.list(100),
      eventSummary: this.securityEvents.summary(),
      policy: {
        accessTokenMinutes: Number(process.env.DESKTOP_ACCESS_TOKEN_MS || 15 * 60_000) / 60_000,
        refreshTokenDays: Number(process.env.DESKTOP_REFRESH_TOKEN_MS || 30 * 24 * 60 * 60_000) / (24 * 60 * 60_000),
        offlineGraceHours: Number(process.env.DESKTOP_OFFLINE_GRACE_MS || 72 * 60 * 60_000) / (60 * 60_000),
        replayWindowSeconds: 60,
        hmac: "HMAC-SHA256",
        providerEncryption: "AES-256-GCM",
        legacyApiKeyAuth: String(process.env.ALLOW_LEGACY_API_KEY_AUTH || (process.env.NODE_ENV === "production" ? "false" : "true")).toLowerCase() === "true",
        rateLimitsPerMinute: this.rateLimits.limits(),
      },
    };
  }

  @Post("users")
  createUser(@Body() input: { email?: string; password?: string; displayName?: string; plan?: MemberPlan; credits?: number; deviceLimit?: number }) {
    return this.auth.createMember(input);
  }

  @Patch("users/:id")
  updateUser(@Param("id") id: string, @Body() input: { displayName?: string; plan?: MemberPlan; status?: MemberStatus; credits?: number; deviceLimit?: number }) {
    return this.auth.updateMember(id, input);
  }

  @Delete("users/:id")
  deleteUser(@Param("id") id: string) {
    return this.auth.deleteMember(id);
  }

  @Get("providers")
  providers() {
    return { mode: authStorageMode(), catalog: listProviderCatalog(), providers: this.store.listProviders() };
  }

  @Post("providers/test")
  testProvider(@Body() input: ProviderConnectionInput) {
    return this.providerConnections.test(input);
  }

  @Post("providers")
  async createProvider(@Body() input: AdminProviderInput) {
    const connection = await this.providerConnections.test({ provider: input.provider, apiKey: input.apiKey });
    return this.store.saveDetectedProvider(input, connection);
  }

  @Patch("providers/:id")
  updateProvider(@Param("id") id: string, @Body() input: AdminProviderInput) {
    return this.store.updateProvider(id, input);
  }

  @Post("providers/:id/test")
  async testStoredProvider(@Param("id") id: string) {
    try {
      const connection = await this.providerConnections.test(this.store.providerConnectionInput(id));
      return this.store.applyConnectionResult(id, connection);
    } catch (error) {
      this.store.recordProviderFailure(id, error);
      throw error;
    }
  }

  @Delete("providers/:id")
  deleteProvider(@Param("id") id: string) {
    return this.store.deleteProvider(id);
  }

  @Get("router")
  router() {
    return { mode: authStorageMode(), providers: this.store.listProviders(), rules: this.store.listRoutes() };
  }

  @Patch("router/:id")
  updateRouter(@Param("id") id: string, @Body() input: Partial<RoutingRule>) {
    return this.store.updateRoute(id, input);
  }

  @Get("revenue")
  async revenue() {
    const payment = (await this.paymentsService.adminPayments()).summary;
    const usage = this.usage.summary();
    return {
      mode: authStorageMode(),
      payment,
      usage,
      pricing: this.store.pricingPolicy(),
      grossMarginUsd: usage.grossMarginUsd,
      marginRate: usage.billedCostUsd > 0 ? Number((usage.grossMarginUsd / usage.billedCostUsd * 100).toFixed(2)) : 0,
    };
  }

  @Get("pricing")
  pricing() {
    return { mode: authStorageMode(), policy: this.store.pricingPolicy() };
  }

  @Patch("pricing")
  updatePricing(@Body() input: PricingPolicyInput) {
    return { mode: authStorageMode(), policy: this.store.updatePricingPolicy(input) };
  }

  @Get("payments")
  payments() {
    return this.paymentsService.adminPayments();
  }

  @Post("payments/:id/refund")
  refundPayment(@Param("id") id: string) {
    return this.paymentsService.refund(id);
  }
}

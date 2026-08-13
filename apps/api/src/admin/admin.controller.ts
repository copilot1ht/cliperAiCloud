import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Req, UseGuards } from "@nestjs/common";
import { AuthService, authStorageMode, type AuthRole, type MemberPlan, type MemberStatus } from "../auth/auth.service.js";
import { GatewayService } from "../gateway/gateway.service.js";
import { AdminSessionGuard, type AdminAuthenticatedRequest } from "../security/admin-session.guard.js";
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
import { AnalysisJobService } from "../billing/analysis-job.service.js";
import { PricingService } from "../billing/pricing.service.js";
import { BackupService } from "./backup.service.js";
import { ReleaseCatalogService, type DesktopReleaseInput } from "./release-catalog.service.js";
import { PaymentConfigurationService, type PaymentSettingsInput } from "../billing/payment-configuration.service.js";
import { PaymentProviderService } from "../billing/payment-provider.service.js";
import { WalletPaymentSettingsService, type WalletPaymentSettingsInput } from "../billing/wallet-payment-settings.service.js";

const plans = [
  { code: "free", name: "Free", priceIdr: 0, credits: 0, deviceLimit: 1, active: true },
  { code: "starter", name: "Starter", priceIdr: 99_000, credits: 50_000, deviceLimit: 1, active: true },
  { code: "pro", name: "Pro", priceIdr: 299_000, credits: 500_000, deviceLimit: 3, active: true },
  { code: "enterprise", name: "Enterprise", priceIdr: 0, credits: 0, deviceLimit: 10, active: true },
];

@Controller("api/admin")
@UseGuards(AdminSessionGuard)
export class AdminController {
  constructor(
    @Inject(GatewayService) private readonly gateway: GatewayService,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AdminStoreService) private readonly store: AdminStoreService,
    @Inject(RuntimeConfigService) private readonly runtimeConfig: RuntimeConfigService,
    @Inject(DesktopSessionService) private readonly desktopSessions: DesktopSessionService,
    @Inject(RateLimitService) private readonly rateLimits: RateLimitService,
    @Inject(SecurityEventService) private readonly securityEvents: SecurityEventService,
    @Inject(ProviderConnectionService) private readonly providerConnections: ProviderConnectionService,
    @Inject(PaymentService) private readonly paymentsService: PaymentService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AnalysisJobService) private readonly analysisJobs: AnalysisJobService,
    @Inject(PricingService) private readonly pricingService: PricingService,
    @Inject(BackupService) private readonly backups: BackupService,
    @Inject(ReleaseCatalogService) private readonly releases: ReleaseCatalogService,
    @Inject(PaymentConfigurationService) private readonly paymentConfiguration: PaymentConfigurationService,
    @Inject(PaymentProviderService) private readonly paymentProviders: PaymentProviderService,
    @Inject(WalletPaymentSettingsService) private readonly walletPaymentConfig: WalletPaymentSettingsService,
  ) {}

  @Get("overview")
  async overview() {
    const users = await this.auth.listUsers();
    const providers = this.store.listProviders();
    const payments = await this.paymentsService.adminPayments();
    const usage = await this.usage.summary();
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
  async users() {
    return { mode: authStorageMode(), users: await this.auth.listUsers(), plans };
  }

  @Get("system-health")
  async systemHealth() {
    const report = this.runtimeConfig.report();
    const dependencies = await this.runtimeConfig.dependencies();
    const providers = this.gateway.providers();
    const desktopSessionSummary = await this.desktopSessions.summary();
    const memory = process.memoryUsage();
    const paymentSettings = await this.paymentConfiguration.status();
    const paymentConnection = await this.paymentProviders.activeConnectionStatus();
    const paymentConfigured = paymentSettings.enabled && paymentSettings.configured;
    let hasVerifiedPaymentActivity = false;
    const payment = {
      provider: paymentSettings.provider,
      label: paymentSettings.provider === "xendit" ? "Xendit" : paymentSettings.provider === "midtrans" ? "Midtrans" : "Sandbox",
      mode:
        paymentSettings.environment === "production" || paymentSettings.environment === "live"
          ? "Production"
          : "Sandbox/Test",
      configuration: paymentConfigured ? "Ready" : "Missing",
      source: paymentSettings.sourceLabel,
      webhookUrl: paymentSettings.notificationUrl || "Not configured",
      finishRedirectUrl: paymentSettings.finishRedirectUrl || "Not configured",
      apiReachability: !paymentConfigured
        ? "Not configured"
        : paymentConnection.state === "healthy"
          ? `Reachable (${paymentConnection.latencyMs} ms)`
          : paymentConnection.state === "failed"
            ? "Last connection test failed"
            : "Not tested since API start",
      connectionState: paymentConnection.state,
      connectionCheckedAt: paymentConnection.checkedAt,
      lastWebhookAt: null as string | null,
      lastSuccessfulPaymentAt: null as string | null,
      failedWebhookCount: 0,
      signatureVerification: "No webhook received",
      operationalState: "not-tested" as "healthy" | "failed" | "not-tested",
    };
    if (paymentSettings.configured && this.database.configured()) {
      try {
        const client = this.database.client();
        const [lastWebhook, lastPayment, failedWebhookCount] = await Promise.all([
          client.paymentLog.findFirst({ where: { provider: paymentSettings.provider }, orderBy: { createdAt: "desc" }, select: { createdAt: true, verified: true } }),
          client.paymentLog.findFirst({ where: { provider: paymentSettings.provider, eventType: "payment.paid", accepted: true }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
          client.paymentLog.count({ where: { provider: paymentSettings.provider, verified: false } }),
        ]);
        payment.lastWebhookAt = lastWebhook?.createdAt.toISOString() || null;
        payment.lastSuccessfulPaymentAt = lastPayment?.createdAt.toISOString() || null;
        payment.failedWebhookCount = failedWebhookCount;
        payment.signatureVerification = lastWebhook ? (lastWebhook.verified ? "Valid" : "Rejected") : "No webhook received";
        hasVerifiedPaymentActivity = Boolean(lastPayment || lastWebhook?.verified);
      } catch {
        payment.apiReachability = "Database check unavailable";
      }
    }
    payment.operationalState = !paymentConfigured
      ? "not-tested"
      : paymentConnection.state === "healthy" || hasVerifiedPaymentActivity
        ? "healthy"
        : paymentConnection.state === "failed"
          ? "failed"
          : "not-tested";
    if (payment.operationalState === "healthy" && paymentConnection.state !== "healthy") {
      payment.apiReachability = "Verified by successful payment or webhook";
    }
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
        {
          code: "payment",
          label: `${payment.label} payment`,
          status: !paymentConfigured
            ? "not-configured"
            : payment.operationalState === "healthy"
              ? "healthy"
              : payment.operationalState === "failed"
                ? "offline"
                : "not-configured",
          detail: `${payment.mode} · ${payment.configuration} · ${payment.apiReachability}`,
        },
        {
          code: "password-recovery",
          label: "Password Recovery",
          status: "healthy",
          detail: report.passwordRecovery.mode === "admin_assisted"
            ? "Admin-assisted · email delivery not required"
            : "Email-link recovery configured separately",
        },
        { code: "license", label: "Desktop Sessions", status: "healthy", detail: `${desktopSessionSummary.active} active signed sessions` },
      ],
      payment,
      // Kept temporarily for older Web clients during the Xendit rollout.
      midtrans: payment,
      providers,
      passwordRecovery: report.passwordRecovery,
      warnings: report.warnings,
      errors: report.errors,
    };
  }

  @Get("security")
  async security() {
    return {
      mode: authStorageMode(),
      sessions: await this.desktopSessions.summary(),
      events: this.securityEvents.list(100),
      eventSummary: this.securityEvents.summary(),
      policy: {
        accessTokenMinutes: Number(process.env.DESKTOP_ACCESS_TOKEN_MS || 4 * 60 * 60_000) / 60_000,
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

  @Get("backups/status")
  backupStatus() {
    return this.backups.status();
  }

  @Post("backups/export")
  exportBackup(@Body() input: { passphrase?: string }, @Req() request: AdminAuthenticatedRequest) {
    return this.backups.exportEncrypted(input.passphrase, request.cliperAdminSession?.userId);
  }

  @Post("backups/inspect")
  inspectBackup(@Body() input: { archive?: unknown; passphrase?: string }) {
    return this.backups.inspect(input);
  }

  @Post("backups/restore")
  restoreBackup(
    @Body() input: { archive?: unknown; passphrase?: string; confirmation?: string },
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return this.backups.restore(input, request.cliperAdminSession?.userId);
  }

  @Post("users")
  createUser(@Body() input: { email?: string; password?: string; displayName?: string; role?: AuthRole; plan?: MemberPlan; walletUsd?: number; unlimitedWallet?: boolean; deviceLimit?: number }) {
    return this.auth.createManagedAccount(input);
  }

  @Patch("users/:id")
  updateUser(@Param("id") id: string, @Body() input: { displayName?: string; plan?: MemberPlan; status?: MemberStatus; walletUsd?: number; unlimitedWallet?: boolean; deviceLimit?: number }) {
    return this.auth.updateMember(id, input);
  }

  @Post("users/:id/password-reset")
  async resetUserPassword(
    @Param("id") id: string,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    const actorId = request.cliperAdminSession?.userId || "admin-session";
    await this.rateLimits.assertAdminPasswordReset(actorId, id);
    return this.auth.issueAdminTemporaryPassword(id, request.cliperAdminSession?.userId);
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
    const provider = this.store.saveDetectedProvider(input, connection);
    await this.store.persistProvider(provider.id);
    const repairedRoutes = this.store.repairRoutesForProviders();
    await Promise.all(repairedRoutes.map((id) => this.store.persistRoute(id)));
    return provider;
  }

  @Patch("providers/:id")
  async updateProvider(@Param("id") id: string, @Body() input: AdminProviderInput) {
    const provider = this.store.updateProvider(id, input);
    await this.store.persistProvider(id);
    return provider;
  }

  @Post("providers/:id/test")
  async testStoredProvider(@Param("id") id: string) {
    try {
      const connection = await this.providerConnections.test(this.store.providerConnectionInput(id));
      const provider = this.store.applyConnectionResult(id, connection);
      await this.store.persistProvider(id);
      return provider;
    } catch (error) {
      this.store.recordProviderFailure(id, error);
      await this.store.persistProvider(id);
      throw error;
    }
  }

  @Delete("providers/:id")
  async deleteProvider(@Param("id") id: string) {
    const result = this.store.deleteProvider(id);
    await this.store.persistProviderDeletion(id);
    return result;
  }

  @Get("router")
  router() {
    return { mode: authStorageMode(), providers: this.store.listProviders(), rules: this.store.listRoutes() };
  }

  @Post("router/test")
  async testRouter() {
    const owner = await this.database.client().user.findFirst({
      where: { isActive: true, unlimitedCredits: true, apiKeys: { some: { status: "ACTIVE" } } },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        planCode: true,
        apiKeys: { where: { status: "ACTIVE" }, orderBy: { createdAt: "asc" }, take: 1, select: { id: true } },
      },
    });
    const apiKeyId = owner?.apiKeys[0]?.id;
    if (!owner || !apiKeyId) {
      throw new BadRequestException("Buat satu Cliper key pada akun unlimited sebelum menjalankan test AI Router.");
    }
    const started = Date.now();
    const response = await this.gateway.chat({
      model: "auto",
      module: "test",
      messages: [
        { role: "system", content: "Connection check. Follow the requested output exactly." },
        { role: "user", content: "Reply only with: OK" },
      ],
      temperature: 0,
      max_tokens: 32,
      metadata: { requestId: `admin-router-test-${Date.now()}`, module: "test" },
    }, owner.id, owner.planCode.toLowerCase(), apiKeyId);
    return {
      ok: true,
      response: response.choices[0]?.message.content || "",
      route: "Cliper Cloud Auto",
      latencyMs: Date.now() - started,
      usage: response.usage,
      billing: response.billing,
    };
  }

  @Patch("router/:id")
  async updateRouter(@Param("id") id: string, @Body() input: Partial<RoutingRule>) {
    const route = this.store.updateRoute(id, input);
    await this.store.persistRoute(id);
    return route;
  }

  @Get("revenue")
  async revenue() {
    const payment = (await this.paymentsService.adminPayments()).summary;
    const usage = await this.usage.summary();
    const jobBilling = await this.analysisJobs.summary();
    return {
      mode: authStorageMode(),
      payment,
      usage,
      pricing: this.store.pricingPolicy(),
      pricingValidation: this.pricingService.serializeAnalysisJobValidation(this.pricingService.validateAnalysisJobPolicy()),
      jobBilling,
      simulation: this.pricingService.serializeAnalysisJobQuote(this.pricingService.quoteAnalysisJob({
        providerCostMicroUsd: BigInt(this.store.pricingPolicy().targetProviderCostMicroUsd),
        usableResult: true,
      })),
      grossMarginUsd: usage.grossMarginUsd,
      marginRate: usage.billedCostUsd > 0 ? Number((usage.grossMarginUsd / usage.billedCostUsd * 100).toFixed(2)) : 0,
    };
  }

  @Get("pricing")
  pricing() {
    return {
      mode: authStorageMode(),
      policy: this.store.pricingPolicy(),
      validation: this.pricingService.serializeAnalysisJobValidation(this.pricingService.validateAnalysisJobPolicy()),
    };
  }

  @Patch("pricing")
  async updatePricing(@Body() input: PricingPolicyInput) {
    const policy = this.store.updatePricingPolicy(input);
    await this.store.persistPricingPolicy();
    return { mode: authStorageMode(), policy, validation: this.pricingService.serializeAnalysisJobValidation(this.pricingService.validateAnalysisJobPolicy()) };
  }

  @Post("pricing/simulate")
  simulatePricing(@Body() input: { providerCostIdr?: number; providerCostMicroUsd?: number; usableResult?: boolean; policy?: Record<string, unknown> }) {
    return {
      mode: authStorageMode(),
      ...this.pricingService.simulateAnalysisJob({
        providerCostIdr: Number(input.providerCostIdr || 0),
        providerCostMicroUsd: input.providerCostMicroUsd,
        usableResult: input.usableResult !== false,
      }, input.policy),
    };
  }

  @Get("payments")
  payments() {
    return this.paymentsService.adminPayments();
  }

  @Get("settings/payment")
  paymentSettings() {
    return this.paymentConfiguration.status();
  }

  @Put("settings/payment")
  async savePaymentSettings(
    @Body() input: PaymentSettingsInput,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return this.paymentConfiguration.save(
      input,
      request.cliperAdminSession?.userId,
    );
  }

  @Post("settings/payment/test")
  async testPaymentSettings() {
    const [configuration, connection] = await Promise.all([
      this.paymentConfiguration.status(),
      this.paymentProviders.testActiveConnection(),
    ]);
    return { configuration, connection };
  }

  @Get("settings/wallet-payment")
  walletPaymentSettings() {
    return this.walletPaymentConfig.get();
  }

  @Patch("settings/wallet-payment")
  updateWalletPaymentSettings(@Body() input: WalletPaymentSettingsInput) {
    return this.walletPaymentConfig.update(input);
  }

  @Post("settings/payment/test-qris")
  async createXenditTestQris(@Req() request: AdminAuthenticatedRequest) {
    const userId = request.cliperAdminSession?.userId || "";
    const user = await this.auth.userById(userId);
    return this.paymentsService.createXenditTestTopup({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
    });
  }

  @Post("settings/payment/test-qris/:number/simulate")
  simulateXenditTestQris(
    @Param("number") number: string,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return this.paymentsService.simulateXenditTestInvoice(
      request.cliperAdminSession?.userId || "",
      number,
    );
  }

  @Post("settings/payment/test-qris/:number/sync")
  syncXenditTestQris(
    @Param("number") number: string,
    @Req() request: AdminAuthenticatedRequest,
  ) {
    return this.paymentsService.syncInvoiceStatus(
      request.cliperAdminSession?.userId || "",
      number,
    );
  }

  @Post("payments/:id/refund")
  refundPayment(@Param("id") id: string) {
    return this.paymentsService.refund(id);
  }

  @Post("payments/:id/sync")
  syncPayment(@Param("id") id: string) {
    return this.paymentsService.syncPaymentStatus(id);
  }

  @Get("releases")
  releasesList() {
    return this.releases.listAdmin();
  }

  @Post("releases")
  createRelease(@Body() input: DesktopReleaseInput, @Req() request: AdminAuthenticatedRequest) {
    return this.releases.create(input, request.cliperAdminSession?.userId);
  }

  @Patch("releases/:id")
  updateRelease(@Param("id") id: string, @Body() input: DesktopReleaseInput, @Req() request: AdminAuthenticatedRequest) {
    return this.releases.update(id, input, request.cliperAdminSession?.userId);
  }
}

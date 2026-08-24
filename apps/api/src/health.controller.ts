import { Controller, Get, Inject } from "@nestjs/common";
import { AdminStoreService } from "./admin/admin-store.service.js";
import { RuntimeConfigService } from "./config/runtime-config.js";

@Controller("health")
export class HealthController {
  constructor(
    @Inject(RuntimeConfigService) private readonly config: RuntimeConfigService,
    @Inject(AdminStoreService) private readonly adminStore: AdminStoreService,
  ) {}

  @Get()
  getHealth() {
    return {
      ok: true,
      service: "cliper-ai-cloud",
      version: "0.1.0",
      time: new Date().toISOString(),
    };
  }

  @Get("live")
  live() {
    return { ok: true, service: "cliper-ai-cloud", time: new Date().toISOString() };
  }

  @Get("ready")
  async ready() {
    const report = this.config.report();
    const dependencies = await this.config.dependencies();
    const storedProviders = this.adminStore.listProviders();
    const healthyStoredProviders = storedProviders.filter(
      (provider) => provider.enabled && provider.status === "healthy" && provider.pricingConfigured,
    );
    const providerReady = healthyStoredProviders.length > 0 || report.providers.some((provider) => provider.enabled);
    const effectiveProviders = storedProviders.length
      ? storedProviders.map((provider) => ({
          code: provider.code,
          model: provider.model,
          keyCount: provider.keyCount,
          enabled: Boolean(
            provider.enabled
            && provider.keyCount > 0
            && provider.pricingConfigured,
          ),
          status: provider.status,
          pricingConfigured: provider.pricingConfigured,
          source: "database" as const,
        }))
      : report.providers.map((provider) => ({
          ...provider,
          source: "environment" as const,
        }));
    const warnings = providerReady
      ? report.warnings.filter((warning) => !warning.startsWith("Tidak ada provider AI aktif."))
      : report.warnings;
    const redisRequired = report.mode === "production";
    return {
      // Redis is optional for the local single-process trial, but remains a
      // production dependency. Provider readiness comes from the admin store
      // because admin-managed keys are persisted in PostgreSQL, not .env.
      ok: report.errors.length === 0
        && dependencies.database
        && providerReady
        && (!redisRequired || dependencies.redis),
      mode: report.mode,
      providers: effectiveProviders,
      providerReadiness: {
        ready: providerReady,
        stored: storedProviders.length,
        healthy: healthyStoredProviders.length,
      },
      infrastructure: {
        database: { configured: report.infrastructure.database, reachable: dependencies.database },
        redis: { configured: report.infrastructure.redis, reachable: dependencies.redis, required: redisRequired },
        secureOrigins: report.infrastructure.secureOrigins,
      },
      warnings,
      errors: report.errors,
      time: new Date().toISOString(),
    };
  }
}

import { Controller, Get } from "@nestjs/common";
import { RuntimeConfigService } from "./config/runtime-config.js";

@Controller("health")
export class HealthController {
  constructor(private readonly config: RuntimeConfigService) {}

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
    return {
      ok: report.ready && dependencies.database && dependencies.redis,
      mode: report.mode,
      providers: report.providers,
      infrastructure: {
        database: { configured: report.infrastructure.database, reachable: dependencies.database },
        redis: { configured: report.infrastructure.redis, reachable: dependencies.redis },
        secureOrigins: report.infrastructure.secureOrigins,
      },
      warnings: report.warnings,
      errors: report.errors,
      time: new Date().toISOString(),
    };
  }
}

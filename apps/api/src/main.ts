import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { AppModule } from "./app.module.js";
import { RuntimeConfigService } from "./config/runtime-config.js";
import { loadWorkspaceEnv } from "./config/load-env.js";
import { productionBootstrapAdminSyncRequested, syncProductionBootstrapAdmin } from "./config/sync-production-bootstrap-admin.js";
import { DatabaseService } from "./database/database.service.js";
import { PrismaExceptionFilter } from "./database/prisma-exception.filter.js";

loadWorkspaceEnv();

function successLogSampleRate(): number {
  const fallback = String(process.env.NODE_ENV).toLowerCase() === "production" ? 0.05 : 1;
  const parsed = Number(process.env.HTTP_SUCCESS_LOG_SAMPLE_RATE || fallback);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, rawBody: true });
  // Encrypted admin backups are intentionally bounded again in BackupService.
  // The wider parser limit only allows their JSON archive to reach that guard.
  const bodySizeLimit = process.env.MAX_BODY_SIZE || "12mb";
  app.useBodyParser("json", { limit: bodySizeLimit });
  app.useBodyParser("urlencoded", { limit: bodySizeLimit, extended: true });
  const runtimeConfig = app.get(RuntimeConfigService);
  const requestLogSampleRate = successLogSampleRate();
  app.useGlobalFilters(new PrismaExceptionFilter());
  runtimeConfig.assertProductionSafe();
  for (const warning of runtimeConfig.report().warnings) console.warn(`[config] ${warning}`);
  if (productionBootstrapAdminSyncRequested()) {
    const result = await syncProductionBootstrapAdmin(app.get(DatabaseService));
    console.warn(`[bootstrap] production admin synchronized for ${result.email}; existing sessions were revoked.`);
  }
  const production = process.env.NODE_ENV === "production";
  const allowedOrigins = new Set((process.env.WEB_ORIGIN || "http://localhost:3000").split(",").map((item) => item.trim()));
  if (!production) {
    for (const origin of Array.from(allowedOrigins)) {
      try {
        const parsed = new URL(origin);
        if (parsed.hostname === "localhost") parsed.hostname = "127.0.0.1";
        else if (parsed.hostname === "127.0.0.1") parsed.hostname = "localhost";
        else continue;
        allowedOrigins.add(parsed.origin);
      } catch {
        // Runtime validation reports malformed configured origins.
      }
    }
  }
  if (production) app.set("trust proxy", 1);
  app.use((request: Request, response: Response, next: NextFunction) => {
    const requestId = String(request.headers["x-request-id"] || randomUUID()).slice(0, 128);
    const startedAt = Date.now();
    response.setHeader("X-Request-ID", requestId);
    response.on("finish", () => {
      // Keep failures fully observable, but do not turn successful burst traffic
      // into a CPU and log-volume bottleneck.
      if (response.statusCode < 400 && Math.random() >= requestLogSampleRate) return;
      console.log(JSON.stringify({
        type: "http_request",
        requestId,
        method: request.method,
        path: request.path,
        status: response.statusCode,
        latencyMs: Date.now() - startedAt,
      }));
    });
    next();
  });
  app.use((request: Request, response: Response, next: NextFunction) => {
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase());
    const cookieAuthenticated = /(?:^|;\s*)cliper_(?:session|password_reset)=/.test(String(request.headers.cookie || "")) && !request.headers.authorization;
    if (unsafe && cookieAuthenticated && !allowedOrigins.has(String(request.headers.origin || ""))) {
      response.status(403).json({ statusCode: 403, message: "Origin request tidak diizinkan." });
      return;
    }
    next();
  });
  app.use(helmet({
    crossOriginResourcePolicy: false,
    hsts: production ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  }));
  app.enableCors({
    origin: Array.from(allowedOrigins),
    credentials: true,
  });
  app.enableShutdownHooks();
  const port = Number(process.env.PORT || 4100);
  await app.listen(port, "0.0.0.0");
  console.log(`Cliper Cloud API ready at http://localhost:${port}`);
}

void bootstrap();

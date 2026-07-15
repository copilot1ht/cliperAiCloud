import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { AppModule } from "./app.module.js";
import { RuntimeConfigService } from "./config/runtime-config.js";
import { loadWorkspaceEnv } from "./config/load-env.js";
import { PrismaExceptionFilter } from "./database/prisma-exception.filter.js";

loadWorkspaceEnv();

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, rawBody: true });
  app.useBodyParser("json", { limit: process.env.MAX_BODY_SIZE || "256kb" });
  app.useBodyParser("urlencoded", { limit: process.env.MAX_BODY_SIZE || "256kb", extended: true });
  const runtimeConfig = app.get(RuntimeConfigService);
  app.useGlobalFilters(new PrismaExceptionFilter());
  runtimeConfig.assertProductionSafe();
  for (const warning of runtimeConfig.report().warnings) console.warn(`[config] ${warning}`);
  const production = process.env.NODE_ENV === "production";
  const allowedOrigins = new Set((process.env.WEB_ORIGIN || "http://localhost:3000").split(",").map((item) => item.trim()));
  if (production) app.set("trust proxy", 1);
  app.use((request: Request, response: Response, next: NextFunction) => {
    const requestId = String(request.headers["x-request-id"] || randomUUID()).slice(0, 128);
    const startedAt = Date.now();
    response.setHeader("X-Request-ID", requestId);
    response.on("finish", () => {
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
    const cookieAuthenticated = /(?:^|;\s*)cliper_session=/.test(String(request.headers.cookie || "")) && !request.headers.authorization;
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

import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { LicenseService } from "../license/license.service.js";
import { DesktopSessionService } from "./desktop-session.service.js";

export function bearerToken(header?: string): string {
  const match = String(header || "").match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

export interface CliperAuthContext {
  apiKeyId: string;
  accountId: string;
  plan: string;
  mode: "desktop-session" | "legacy-key";
  sessionId?: string;
}

export type CliperAuthenticatedRequest = Request & { cliperAuth?: CliperAuthContext };

function safeEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly licenses: LicenseService, private readonly desktopSessions: DesktopSessionService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<CliperAuthenticatedRequest>();
    const token = bearerToken(request.headers.authorization);
    const configured = String(process.env.CLIPER_DEV_API_KEY || "").trim();
    if (!token) throw new UnauthorizedException("Cliper API key tidak valid.");
    if (token.startsWith("clip_at_")) {
      const session = this.desktopSessions.authenticateSigned(token, {
        method: request.method,
        path: request.originalUrl.split("?", 1)[0] || request.path,
        body: request.body,
        headers: request.headers,
      });
      request.cliperAuth = { apiKeyId: session.apiKeyId, accountId: session.accountId, plan: session.plan, mode: "desktop-session", sessionId: session.sessionId };
      return true;
    }
    const legacyAllowed = String(process.env.ALLOW_LEGACY_API_KEY_AUTH || (process.env.NODE_ENV === "production" ? "false" : "true")).toLowerCase() === "true";
    if (!legacyAllowed) throw new UnauthorizedException("Aktifkan desktop session terlebih dahulu; direct API key auth dinonaktifkan.");
    if (configured && safeEqual(token, configured)) {
      request.cliperAuth = {
        apiKeyId: "development-key",
        accountId: "development-account",
        plan: String(process.env.CLIPER_DEV_PLAN || "starter").toLowerCase(),
        mode: "legacy-key",
      };
      return true;
    }
    const generated = this.licenses.authenticateGatewayKey(token);
    if (!generated) throw new UnauthorizedException("Cliper API key tidak valid, kedaluwarsa, atau sudah dicabut.");
    request.cliperAuth = { ...generated, mode: "legacy-key" };
    return true;
  }
}

import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { bearerToken } from "./api-key.guard.js";
import { DesktopSessionService, type DesktopSessionContext } from "./desktop-session.service.js";

export type DesktopAuthenticatedRequest = Request & { desktopSession?: DesktopSessionContext };

@Injectable()
export class DesktopSessionGuard implements CanActivate {
  constructor(@Inject(DesktopSessionService) private readonly sessions: DesktopSessionService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<DesktopAuthenticatedRequest>();
    const token = bearerToken(request.headers.authorization);
    if (!token.startsWith("clip_at_")) throw new UnauthorizedException("Desktop session token wajib digunakan.");
    request.desktopSession = this.sessions.authenticateSigned(token, {
      method: request.method,
      path: request.originalUrl.split("?", 1)[0] || request.path,
      body: request.body,
      headers: request.headers,
    });
    return true;
  }
}

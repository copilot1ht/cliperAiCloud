import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { AuthService, type MemorySession } from "../auth/auth.service.js";
import { sessionToken } from "./session-cookie.js";

export type SessionAuthenticatedRequest = Request & { cliperSession?: Omit<MemorySession, "token"> };

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<SessionAuthenticatedRequest>();
    const token = sessionToken(request.headers.authorization, request.headers.cookie);
    if (!token) {
      throw new UnauthorizedException("Authorization header tidak valid atau tidak diberikan.");
    }
    const session = this.authService.session(token);
    if (!session || !session.role) {
      throw new UnauthorizedException("Session tidak valid.");
    }
    request.cliperSession = session;
    return true;
  }
}

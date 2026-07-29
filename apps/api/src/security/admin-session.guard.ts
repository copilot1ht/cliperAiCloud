import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { AuthService, type MemorySession } from "../auth/auth.service.js";
import { sessionToken } from "./session-cookie.js";

export type AdminAuthenticatedRequest = Request & { cliperAdminSession?: Omit<MemorySession, "token"> };

@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminAuthenticatedRequest>();
    const session = await this.authService.session(sessionToken(request.headers.authorization, request.headers.cookie));
    if (session.role !== "admin" && session.role !== "investor") throw new UnauthorizedException("Akses admin diperlukan.");
    if (session.role === "investor" && !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) {
      throw new ForbiddenException("Akun investor hanya memiliki akses baca.");
    }
    request.cliperAdminSession = session;
    return true;
  }
}

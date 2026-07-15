import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { AuthService } from "../auth/auth.service.js";
import { sessionToken } from "./session-cookie.js";

@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const session = this.authService.session(sessionToken(request.headers.authorization, request.headers.cookie));
    if (session.role !== "admin") throw new UnauthorizedException("Akses admin diperlukan.");
    return true;
  }
}

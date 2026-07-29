import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import type { SessionAuthenticatedRequest } from "./session.guard.js";

@Injectable()
export class AccountWriteGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<SessionAuthenticatedRequest>();
    if (request.cliperSession?.role === "investor") {
      throw new ForbiddenException("Akun investor hanya memiliki akses baca.");
    }
    return true;
  }
}

import { Body, Controller, Post, Req, UseGuards } from "@nestjs/common";
import type { DesktopActivateRequest, DesktopRefreshRequest, LicenseValidationRequest } from "@cliper/contracts";
import { LicenseService } from "./license.service.js";
import { DesktopSessionService } from "../security/desktop-session.service.js";
import { DesktopSessionGuard, type DesktopAuthenticatedRequest } from "../security/desktop-session.guard.js";

@Controller("api/auth")
export class DesktopAuthController {
  constructor(private readonly licenses: LicenseService, private readonly sessions: DesktopSessionService) {}

  @Post("verify")
  verify(@Body() request: LicenseValidationRequest) {
    const result = this.licenses.validate(request);
    return {
      status: result.valid ? "active" : result.status || "revoked",
      valid: result.valid,
      plan: result.plan,
      credits: result.credits?.remainingMicro ?? 0,
      creditUnit: "microcredits",
      expiresAt: result.expiresAt,
      deviceSlots: result.deviceSlots,
      reason: result.reason,
    };
  }

  @Post("desktop/activate")
  activate(@Body() request: DesktopActivateRequest) {
    return this.sessions.activate(request);
  }

  @Post("desktop/refresh")
  refresh(@Body() request: DesktopRefreshRequest) {
    return this.sessions.refresh(request);
  }

  @Post("desktop/heartbeat")
  @UseGuards(DesktopSessionGuard)
  heartbeat(@Req() request: DesktopAuthenticatedRequest) {
    return this.sessions.heartbeat(request.desktopSession!);
  }
}

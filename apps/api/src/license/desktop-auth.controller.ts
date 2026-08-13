import { Body, Controller, Inject, Post, Req, UseGuards } from "@nestjs/common";
import type { DesktopActivateRequest, DesktopRefreshRequest, LicenseValidationRequest } from "@cliper/contracts";
import { LicenseService } from "./license.service.js";
import { DesktopSessionService } from "../security/desktop-session.service.js";
import { DesktopSessionGuard, type DesktopAuthenticatedRequest } from "../security/desktop-session.guard.js";

@Controller("api/auth")
export class DesktopAuthController {
  constructor(
    @Inject(LicenseService) private readonly licenses: LicenseService,
    @Inject(DesktopSessionService) private readonly sessions: DesktopSessionService,
  ) {}

  @Post("verify")
  async verify(@Body() request: LicenseValidationRequest) {
    const result = await this.licenses.validate(request);
    return {
      status: result.valid ? "active" : result.status || "revoked",
      valid: result.valid,
      plan: result.plan,
      wallet: result.wallet,
      keyType: result.keyType,
      cloudConnected: result.cloudConnected === true,
      billingEligible: result.billingEligible === true,
      expiresAt: result.expiresAt,
      deviceSlots: result.deviceSlots,
      reason: result.reason,
    };
  }

  @Post("desktop/activate")
  async activate(@Body() request: DesktopActivateRequest) {
    return this.sessions.activate(request);
  }

  @Post("desktop/refresh")
  async refresh(@Body() request: DesktopRefreshRequest) {
    return this.sessions.refresh(request);
  }

  @Post("desktop/heartbeat")
  @UseGuards(DesktopSessionGuard)
  async heartbeat(@Req() request: DesktopAuthenticatedRequest) {
    return this.sessions.heartbeat(request.desktopSession!);
  }
}

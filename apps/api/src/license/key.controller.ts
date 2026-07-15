import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { SessionGuard, type SessionAuthenticatedRequest } from "../security/session.guard.js";
import { AuthService } from "../auth/auth.service.js";
import { LicenseService } from "./license.service.js";

@Controller("v1/keys")
@UseGuards(SessionGuard)
export class KeyController {
  constructor(private readonly licenses: LicenseService, private readonly auth: AuthService) {}

  @Get()
  list(@Req() request: SessionAuthenticatedRequest) {
    return { keys: this.licenses.listKeys(request.cliperSession?.userId) };
  }

  @Post()
  create(@Body() input: { label?: string }, @Req() request: SessionAuthenticatedRequest) {
    const ownerId = request.cliperSession?.userId || "";
    const user = this.auth.userById(ownerId);
    return this.licenses.createKey({ label: input.label, ownerId, plan: user.plan, deviceLimit: user.deviceLimit });
  }

  @Post(":id/revoke")
  revoke(@Param("id") id: string, @Req() request: SessionAuthenticatedRequest) {
    return this.licenses.revokeKey(id, request.cliperSession?.userId);
  }
}

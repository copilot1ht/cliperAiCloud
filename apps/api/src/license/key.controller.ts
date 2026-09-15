import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from "@nestjs/common";
import { SessionGuard, type SessionAuthenticatedRequest } from "../security/session.guard.js";
import { AuthService } from "../auth/auth.service.js";
import { LicenseService } from "./license.service.js";
import { AccountWriteGuard } from "../security/account-write.guard.js";
import { RateLimitService } from "../security/rate-limit.service.js";

@Controller("v1/keys")
@UseGuards(SessionGuard)
export class KeyController {
  constructor(
    @Inject(LicenseService) private readonly licenses: LicenseService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(RateLimitService) private readonly rateLimits: RateLimitService,
  ) {}

  @Get()
  async list(@Req() request: SessionAuthenticatedRequest) {
    return { keys: await this.licenses.listKeys(request.cliperSession?.userId) };
  }

  @Post()
  @UseGuards(AccountWriteGuard)
  async create(@Body() input: { label?: string }, @Req() request: SessionAuthenticatedRequest) {
    const ownerId = request.cliperSession?.userId || "";
    await this.rateLimits.assertKeyCreate(ownerId);
    const user = await this.auth.userById(ownerId);
    return this.licenses.createKey({ label: input.label, ownerId, deviceLimit: user.deviceLimit });
  }

  @Post("rotate")
  @UseGuards(AccountWriteGuard)
  async rotate(@Body() input: { label?: string }, @Req() request: SessionAuthenticatedRequest) {
    const ownerId = request.cliperSession?.userId || "";
    await this.rateLimits.assertKeyCreate(ownerId);
    const user = await this.auth.userById(ownerId);
    return this.licenses.rotateDesktopKey({ label: input.label, ownerId, deviceLimit: user.deviceLimit });
  }

  @Get("devices")
  async devices(@Req() request: SessionAuthenticatedRequest) {
    return { devices: await this.licenses.listDevices(request.cliperSession?.userId || "") };
  }

  @Post("devices/:id/rename")
  @UseGuards(AccountWriteGuard)
  async renameDevice(@Param("id") id: string, @Body() input: { name?: string }, @Req() request: SessionAuthenticatedRequest) {
    return this.licenses.renameDevice(id, request.cliperSession?.userId || "", input.name || "");
  }

  @Post("devices/:id/revoke")
  @UseGuards(AccountWriteGuard)
  async revokeDevice(@Param("id") id: string, @Req() request: SessionAuthenticatedRequest) {
    return this.licenses.revokeDevice(id, request.cliperSession?.userId || "");
  }

  @Post(":id/revoke")
  @UseGuards(AccountWriteGuard)
  async revoke(@Param("id") id: string, @Req() request: SessionAuthenticatedRequest) {
    return this.licenses.revokeKey(id, request.cliperSession?.userId);
  }
}

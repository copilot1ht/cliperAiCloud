import { Body, Controller, Get, Inject, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { ApiKeyGuard, type CliperAuthenticatedRequest } from "../security/api-key.guard.js";
import { DesktopSessionService } from "../security/desktop-session.service.js";
import { AnalysisJobService, type CompleteAnalysisJobInput, type StartAnalysisJobInput } from "./analysis-job.service.js";

@Controller("v1")
@UseGuards(ApiKeyGuard)
export class AnalysisJobController {
  constructor(
    @Inject(AnalysisJobService) private readonly jobs: AnalysisJobService,
    @Inject(DesktopSessionService) private readonly desktopSessions: DesktopSessionService,
  ) {}

  @Get("wallet/summary")
  async walletSummary(@Req() request: CliperAuthenticatedRequest, @Res({ passthrough: true }) response: Response) {
    const payload = await this.jobs.walletSummary(this.accountId(request));
    return this.signed("/v1/wallet/summary", payload, request, response);
  }

  @Post("jobs/start")
  async start(@Body() input: StartAnalysisJobInput, @Req() request: CliperAuthenticatedRequest, @Res({ passthrough: true }) response: Response) {
    const payload = await this.jobs.start(this.accountId(request), input, request.cliperAuth?.apiKeyId);
    return this.signed("/v1/jobs/start", payload, request, response);
  }

  @Post("jobs/complete")
  async complete(@Body() input: CompleteAnalysisJobInput, @Req() request: CliperAuthenticatedRequest, @Res({ passthrough: true }) response: Response) {
    const payload = await this.jobs.complete(this.accountId(request), input);
    return this.signed("/v1/jobs/complete", payload, request, response);
  }

  @Post("jobs/:id/fail")
  async fail(@Param("id") id: string, @Body() input: { reason?: string }, @Req() request: CliperAuthenticatedRequest, @Res({ passthrough: true }) response: Response) {
    const payload = await this.jobs.fail(this.accountId(request), id, input.reason);
    return this.signed(`/v1/jobs/${id}/fail`, payload, request, response);
  }

  private accountId(request: CliperAuthenticatedRequest): string {
    return request.cliperAuth?.accountId || "development-account";
  }

  private signed(path: string, payload: Record<string, unknown>, request: CliperAuthenticatedRequest, response: Response) {
    if (request.cliperAuth?.mode !== "desktop-session" || !request.cliperAuth.sessionId) return payload;
    const integrity = this.desktopSessions.signResponse(request.cliperAuth.sessionId, path, payload);
    response.setHeader("X-Cliper-Response-Signed", "1");
    return { ...payload, integrity };
  }
}

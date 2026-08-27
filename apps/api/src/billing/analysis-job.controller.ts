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

  @Post("pricing/estimate")
  async estimatePricingPost(
    @Body() input: { sourceDurationSeconds?: number; requestedClipCount?: number },
    @Req() request: CliperAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const payload = await this.jobs.estimatePricing(this.accountId(request), input || {});
    return this.signed("/v1/pricing/estimate", payload, request, response);
  }

  @Get("pricing/estimate")
  async estimatePricingGet(
    @Req() request: CliperAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const duration = Number((request.query as Record<string, unknown>)?.sourceDurationSeconds || 0);
    const clipCount = Number((request.query as Record<string, unknown>)?.requestedClipCount || 4);
    const payload = await this.jobs.estimatePricing(this.accountId(request), {
      sourceDurationSeconds: duration,
      requestedClipCount: clipCount,
    });
    return this.signed("/v1/pricing/estimate", payload, request, response);
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

  private async signed(path: string, payload: Record<string, unknown>, request: CliperAuthenticatedRequest, response: Response) {
    if (request.cliperAuth?.mode !== "desktop-session" || !request.cliperAuth.sessionId) return payload;
    const integrity = await this.desktopSessions.signResponse(request.cliperAuth.sessionId, path, payload);
    response.setHeader("X-Cliper-Response-Signed", "1");
    return { ...payload, integrity };
  }
}

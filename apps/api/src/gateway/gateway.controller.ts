import { BadRequestException, Body, Controller, Get, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { CliperChatRequest } from "@cliper/contracts";
import type { Response } from "express";
import { ApiKeyGuard, type CliperAuthenticatedRequest } from "../security/api-key.guard.js";
import { GatewayService } from "./gateway.service.js";
import { DesktopSessionService } from "../security/desktop-session.service.js";

@Controller("v1")
@UseGuards(ApiKeyGuard)
export class GatewayController {
  constructor(private readonly gateway: GatewayService, private readonly desktopSessions: DesktopSessionService) {}

  @Get("providers")
  providers() {
    return { providers: this.gateway.providers() };
  }

  @Get("models")
  models() {
    const models = this.gateway.providers()
      .filter((provider) => provider.status !== "disabled")
      .map((provider) => ({ id: provider.model, object: "model", owned_by: provider.code }));
    return { object: "list", data: [{ id: "auto", object: "model", owned_by: "cliper" }, ...models] };
  }

  @Post("chat/completions")
  async chat(@Body() request: CliperChatRequest, @Req() httpRequest: CliperAuthenticatedRequest, @Res({ passthrough: true }) httpResponse: Response) {
    if (!Array.isArray(request?.messages) || !request.messages.length) {
      throw new BadRequestException("messages wajib berupa array yang tidak kosong.");
    }
    if (request.messages.some((message) => !message?.role || typeof message.content !== "string")) {
      throw new BadRequestException("Setiap message wajib memiliki role dan content string.");
    }
    const promptChars = request.messages.reduce((total, message) => total + message.content.length, 0);
    const maxPromptChars = Math.max(1000, Number(process.env.MAX_PROMPT_CHARS || 120000));
    if (promptChars > maxPromptChars) {
      throw new BadRequestException(`Prompt terlalu besar (${promptChars} karakter). Batas server ${maxPromptChars} karakter.`);
    }
    const serverPlan = httpRequest?.cliperAuth?.plan || String(process.env.CLIPER_DEV_PLAN || "starter").toLowerCase();
    const result = await this.gateway.chat({
      ...request,
      metadata: { ...(request.metadata ?? {}), plan: serverPlan },
    }, httpRequest?.cliperAuth?.accountId || "development-account", serverPlan);
    if (httpRequest?.cliperAuth?.mode === "desktop-session" && httpRequest.cliperAuth.sessionId) {
      result.integrity = this.desktopSessions.signResponse(httpRequest.cliperAuth.sessionId, "/v1/chat/completions", result);
      httpResponse.setHeader("X-Cliper-Response-Signed", "1");
    }
    return result;
  }
}

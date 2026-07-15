import { BadRequestException, Body, Controller, Get, Headers, Inject, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthService } from "../auth/auth.service.js";
import { SessionGuard, type SessionAuthenticatedRequest } from "../security/session.guard.js";
import { PaymentService } from "./payment.service.js";

type WebhookRequest = Request & { rawBody?: Buffer };

@Controller("api/payments")
export class PaymentController {
  constructor(
    @Inject(PaymentService) private readonly payments: PaymentService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Get("plans")
  plans() {
    return { plans: this.payments.planCatalog() };
  }

  @Get()
  @UseGuards(SessionGuard)
  billing(@Req() request: SessionAuthenticatedRequest) {
    return this.payments.memberBilling(request.cliperSession?.userId || "");
  }

  @Post("invoices")
  @UseGuards(SessionGuard)
  createInvoice(@Req() request: SessionAuthenticatedRequest, @Body() input: { plan?: string }) {
    const userId = request.cliperSession?.userId || "";
    const user = this.auth.userById(userId);
    return this.payments.createInvoice({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
    }, input.plan);
  }

  @Post("topups")
  @UseGuards(SessionGuard)
  createTopup(@Req() request: SessionAuthenticatedRequest, @Body() input: { amountIdr?: number }) {
    const userId = request.cliperSession?.userId || "";
    const user = this.auth.userById(userId);
    return this.payments.createTopupInvoice({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
    }, input.amountIdr);
  }

  @Get("invoices/:number")
  @UseGuards(SessionGuard)
  invoice(@Req() request: SessionAuthenticatedRequest, @Param("number") number: string) {
    return this.payments.invoiceStatus(request.cliperSession?.userId || "", number);
  }

  @Post("sandbox/:number/complete")
  @UseGuards(SessionGuard)
  completeSandbox(@Req() request: SessionAuthenticatedRequest, @Param("number") number: string) {
    return this.payments.completeSandboxInvoice(request.cliperSession?.userId || "", number);
  }

  @Post("webhook/:provider")
  webhook(
    @Param("provider") provider: string,
    @Req() request: WebhookRequest,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    if (!request.rawBody) throw new BadRequestException("Raw webhook body tidak tersedia.");
    return this.payments.processWebhook(provider, request.rawBody, headers);
  }
}

import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { AiRouter } from "@cliper/ai-router";
import type { CliperChatRequest, CliperChatResponse } from "@cliper/contracts";
import { randomUUID } from "node:crypto";
import { AdminStoreService } from "../admin/admin-store.service.js";
import { PricingService } from "../billing/pricing.service.js";
import { CreditAccountService } from "../billing/credit-account.service.js";
import { UsageService } from "../usage/usage.service.js";
import { RateLimitService } from "../security/rate-limit.service.js";

@Injectable()
export class GatewayService {
  private router?: AiRouter;
  private routerRevision = -1;

  constructor(
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(AdminStoreService) private readonly adminStore: AdminStoreService,
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(CreditAccountService) private readonly credits: CreditAccountService,
    @Inject(RateLimitService) private readonly rateLimits: RateLimitService,
  ) {}

  providers() {
    return this.currentRouter().health();
  }

  async chat(request: CliperChatRequest, accountId = "development-account", plan = "starter"): Promise<CliperChatResponse> {
    const started = Date.now();
    this.rateLimits.assertAllowed(accountId, plan);
    const requestId = String(request.metadata?.requestId || `request-${randomUUID()}`);
    const clipCount = Number(request.metadata?.clipCount || 0);
    const maxClips = Math.max(1, Math.floor(Number(process.env.MAX_CLIPS_PER_JOB || 20)));
    if (Number.isFinite(clipCount) && clipCount > maxClips) {
      throw new BadRequestException(`Job meminta ${clipCount} clip; batas satu job adalah ${maxClips}. Gunakan batch berikutnya agar biaya tetap terkendali.`);
    }
    const estimated = this.pricing.estimateRequest(request);
    const reservation = this.credits.reserve(accountId, requestId, Number(estimated.creditChargeMicro));
    try {
      const routedResponse = await this.currentRouter().route(request);
      const module = this.pricing.moduleForRequest(request);
      const response = this.pricing.priceResponse(routedResponse, module);
      const actualCharge = Number(response.billing.credit_charge_micro);
      const reservedCharge = Number(reservation.amountMicro || estimated.creditChargeMicro);
      if (actualCharge > reservedCharge) {
        this.credits.increaseReservation(reservation.id, actualCharge - reservedCharge);
      }
      this.credits.settle(reservation.id, actualCharge);
      this.usage.record(response, module, Date.now() - started, accountId);
      const { billing, ...publicResponse } = response;
      return {
        ...publicResponse,
        provider: "cliper-cloud",
        model: "auto",
        billing: { credit_charge_micro: billing.credit_charge_micro },
      };
    } catch (error) {
      this.credits.release(reservation.id);
      throw new ServiceUnavailableException(error instanceof Error ? error.message : "AI gateway gagal.");
    }
  }

  private currentRouter(): AiRouter {
    const revision = this.adminStore.revision();
    if (!this.router || revision !== this.routerRevision) {
      this.router = new AiRouter({
        providers: this.adminStore.providersForRouter(),
        retriesPerProvider: Number(process.env.PROVIDER_RETRIES || 2),
        allowModelOverride: String(process.env.ALLOW_CLIENT_MODEL_OVERRIDE || "").toLowerCase() === "true",
        planRoutes: this.adminStore.planRoutes(),
        moduleMaxTokens: this.adminStore.moduleMaxTokens(),
      });
      this.routerRevision = revision;
    }
    return this.router;
  }
}

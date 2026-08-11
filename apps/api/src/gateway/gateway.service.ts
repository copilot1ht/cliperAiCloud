import { BadRequestException, HttpException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { AiRouter } from "@cliper/ai-router";
import type { CliperChatRequest, CliperChatResponse } from "@cliper/contracts";
import { randomUUID } from "node:crypto";
import { AdminStoreService } from "../admin/admin-store.service.js";
import { PricingService } from "../billing/pricing.service.js";
import { DirectCreditService } from "../billing/direct-credit.service.js";
import { UsageService } from "../usage/usage.service.js";
import { RateLimitService } from "../security/rate-limit.service.js";
import { AnalysisJobService } from "../billing/analysis-job.service.js";

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.round(parsed))) : fallback;
}

@Injectable()
export class GatewayService {
  private router?: AiRouter;
  private routerRevision = -1;

  constructor(
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(AdminStoreService) private readonly adminStore: AdminStoreService,
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(DirectCreditService) private readonly credits: DirectCreditService,
    @Inject(RateLimitService) private readonly rateLimits: RateLimitService,
    @Inject(AnalysisJobService) private readonly jobs: AnalysisJobService,
  ) {}

  providers() {
    return this.currentRouter().health();
  }

  async chat(request: CliperChatRequest, accountId = "development-account", plan = "starter", apiKeyId?: string): Promise<CliperChatResponse> {
    await this.rateLimits.assertAllowed(accountId, plan);
    return this.rateLimits.withAiConcurrency(accountId, apiKeyId, plan, () =>
      this.executeChat(request, accountId, plan, apiKeyId),
    );
  }

  private async executeChat(request: CliperChatRequest, accountId: string, plan: string, apiKeyId?: string): Promise<CliperChatResponse> {
    await this.adminStore.refreshIfStale();
    const started = Date.now();
    // The authenticated plan is server-owned. Forward it to the router and all
    // pricing/job checks instead of trusting (or omitting) client metadata.
    // Without this normalization every desktop request silently used the
    // router's starter/default route, even for enterprise accounts.
    const routedRequest: CliperChatRequest = {
      ...request,
      metadata: {
        ...(request.metadata || {}),
        plan,
      },
    };
    const requestId = String(routedRequest.metadata?.requestId || `request-${randomUUID()}`);
    const clipCount = Number(routedRequest.metadata?.clipCount || 0);
    const maxClips = Math.max(0, Math.floor(Number(process.env.MAX_CLIPS_PER_JOB || 0)));
    if (maxClips > 0 && Number.isFinite(clipCount) && clipCount > maxClips) {
      throw new BadRequestException(`Job meminta ${clipCount} clip; batas operasional server adalah ${maxClips}.`);
    }
    const estimated = this.pricing.estimateRequest(routedRequest);
    const jobId = String(routedRequest.metadata?.jobId || "").trim();
    if (jobId) {
      await this.jobs.assertProviderCallAllowed(jobId, accountId, routedRequest, Number(estimated.providerCostMicroUsd) / 1_000_000);
      try {
        const routedResponse = await this.currentRouter().route(routedRequest);
        const module = this.pricing.moduleForRequest(routedRequest);
        const response = this.pricing.priceResponse(routedResponse, module);
        const usageRecord = await this.usage.record(response, module, Date.now() - started, accountId, {
          jobId,
          apiKeyId,
          deferCustomerBilling: true,
        });
        if (!usageRecord.jobCostAggregated) {
          await this.jobs.recordProviderUsage(jobId, accountId, response, module);
        }
        const { billing: _billing, ...publicResponse } = response;
        return {
          ...publicResponse,
          provider: "cliper-cloud",
          model: "auto",
          billing: { credit_charge_micro: 0 },
        };
      } catch (error) {
        if (error instanceof HttpException) throw error;
        throw new ServiceUnavailableException(error instanceof Error ? error.message : "AI gateway gagal.");
      }
    }
    const reservation = await this.credits.reserve(accountId, apiKeyId, requestId, Number(estimated.creditChargeMicro));
    try {
      const routedResponse = await this.currentRouter().route(routedRequest);
      const module = this.pricing.moduleForRequest(routedRequest);
      const response = this.pricing.priceResponse(routedResponse, module);
      const actualCharge = Number(response.billing.credit_charge_micro);
      await this.usage.record(response, module, Date.now() - started, accountId, {
        apiKeyId,
        waiveCustomerBilling: reservation.unlimited,
      });
      await this.credits.settle(reservation, actualCharge);
      const { billing, ...publicResponse } = response;
      return {
        ...publicResponse,
        provider: "cliper-cloud",
        model: "auto",
        billing: { credit_charge_micro: reservation.unlimited ? 0 : billing.credit_charge_micro },
      };
    } catch (error) {
      await this.credits.release(reservation);
      throw new ServiceUnavailableException(error instanceof Error ? error.message : "AI gateway gagal.");
    }
  }

  private currentRouter(): AiRouter {
    const revision = this.adminStore.revision();
    if (!this.router || revision !== this.routerRevision) {
      this.router = new AiRouter({
        providers: this.adminStore.providersForRouter(),
        retriesPerProvider: boundedInteger(process.env.PROVIDER_RETRIES, 2, 1, 4),
        circuitFailureThreshold: boundedInteger(process.env.PROVIDER_CIRCUIT_FAILURE_THRESHOLD, 3, 1, 10),
        circuitCooldownMs: boundedInteger(process.env.PROVIDER_CIRCUIT_COOLDOWN_MS, 30_000, 1_000, 5 * 60_000),
        allowModelOverride: String(process.env.ALLOW_CLIENT_MODEL_OVERRIDE || "").toLowerCase() === "true",
        planRoutes: this.adminStore.planRoutes(),
        moduleMaxTokens: this.adminStore.moduleMaxTokens(),
      });
      this.routerRevision = revision;
    }
    return this.router;
  }
}

import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { AuthService } from "../auth/auth.service.js";
import { CreditAccountService } from "../billing/credit-account.service.js";
import { LicenseService } from "../license/license.service.js";
import { SessionGuard, type SessionAuthenticatedRequest } from "../security/session.guard.js";
import { UsageService } from "../usage/usage.service.js";

@Controller("api/member")
@UseGuards(SessionGuard)
export class MemberController {
  constructor(
    private readonly auth: AuthService,
    private readonly credits: CreditAccountService,
    private readonly licenses: LicenseService,
    private readonly usage: UsageService,
  ) {}

  @Get("overview")
  overview(@Req() request: SessionAuthenticatedRequest) {
    const accountId = request.cliperSession?.userId || "";
    const user = this.auth.userById(accountId);
    const credit = this.credits.balance(accountId);
    const keys = this.licenses.listKeys(accountId);
    const usage = this.usage.summary(accountId);
    return {
      mode: "development-memory",
      user: { id: user.id, displayName: user.displayName, email: user.email, plan: user.plan, deviceLimit: user.deviceLimit },
      credits: {
        balanceMicro: credit.balanceMicro,
        reservedMicro: credit.reservedMicro,
        availableMicro: credit.availableMicro,
        spentMicro: usage.creditChargeMicro,
      },
      keys: {
        total: keys.length,
        active: keys.filter((item) => item.status === "active").length,
        devicesUsed: keys.reduce((total, item) => total + item.deviceSlots.used, 0),
      },
      usage: {
        requests: usage.requests,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        creditChargeMicro: usage.creditChargeMicro,
        averageLatencyMs: usage.averageLatencyMs,
        p95LatencyMs: usage.p95LatencyMs,
        recent: usage.recent.map((item) => ({
          id: item.id,
          module: item.module,
          tokens: item.inputTokens + item.outputTokens,
          latencyMs: item.latencyMs,
          creditChargeMicro: item.creditChargeMicro,
          createdAt: item.createdAt,
        })),
      },
    };
  }
}

import { Controller, Get, Inject, Req, UseGuards } from "@nestjs/common";
import { AuthService, authStorageMode } from "../auth/auth.service.js";
import { CreditAccountService } from "../billing/credit-account.service.js";
import { DatabaseService } from "../database/database.service.js";
import { LicenseService } from "../license/license.service.js";
import { SessionGuard, type SessionAuthenticatedRequest } from "../security/session.guard.js";
import { UsageService } from "../usage/usage.service.js";
import { microToUsd } from "../billing/wallet-payment-settings.service.js";

@Controller("api/member")
@UseGuards(SessionGuard)
export class MemberController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CreditAccountService) private readonly credits: CreditAccountService,
    @Inject(LicenseService) private readonly licenses: LicenseService,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  @Get("overview")
  async overview(@Req() request: SessionAuthenticatedRequest) {
    const accountId = request.cliperSession?.userId || "";
    const user = await this.auth.userById(accountId);
    const memoryCredit = this.credits.balance(accountId);
    const persistentCredit = this.database.configured()
      ? await this.database.client().userCreditAccount.findUnique({ where: { userId: accountId } })
      : null;
    const balanceMicro = persistentCredit ? Number(persistentCredit.balanceMicro) : memoryCredit.balanceMicro;
    const reservedMicro = persistentCredit ? Number(persistentCredit.reservedMicro) : memoryCredit.reservedMicro;
    const unlimitedWallet = user.unlimitedWallet;
    const availableMicro = unlimitedWallet ? Number.MAX_SAFE_INTEGER : balanceMicro - reservedMicro;
    const keys = await this.licenses.listKeys(accountId);
    const usage = await this.usage.summary(accountId);
    return {
      mode: authStorageMode(),
      user: {
        id: user.id,
        displayName: user.displayName,
        email: user.email,
        deviceLimit: user.deviceLimit,
        unlimitedWallet,
      },
      billingMode: "wallet" as const,
      wallet: {
        currency: "USD",
        availableUsd: unlimitedWallet ? null : microToUsd(balanceMicro),
        reservedUsd: unlimitedWallet ? null : microToUsd(reservedMicro),
        spendableUsd: unlimitedWallet ? null : microToUsd(availableMicro),
        spentUsd: unlimitedWallet ? null : microToUsd(usage.creditChargeMicro),
        availableMicroUsd: unlimitedWallet ? Number.MAX_SAFE_INTEGER : balanceMicro,
        reservedMicroUsd: reservedMicro,
        spendableMicroUsd: availableMicro,
        unlimited: unlimitedWallet,
        spentMicroUsd: usage.creditChargeMicro,
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
        chargedMicroUsd: usage.creditChargeMicro,
        chargedUsd: microToUsd(usage.creditChargeMicro),
        averageLatencyMs: usage.averageLatencyMs,
        p95LatencyMs: usage.p95LatencyMs,
        recent: usage.recent.map((item) => ({
          id: item.id,
          module: item.module,
          tokens: item.inputTokens + item.outputTokens,
          latencyMs: item.latencyMs,
          chargedMicroUsd: item.creditChargeMicro,
          chargedUsd: microToUsd(item.creditChargeMicro),
          createdAt: item.createdAt,
        })),
      },
    };
  }
}

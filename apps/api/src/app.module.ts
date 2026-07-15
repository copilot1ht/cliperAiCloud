import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { GatewayController } from "./gateway/gateway.controller.js";
import { GatewayService } from "./gateway/gateway.service.js";
import { ApiKeyGuard } from "./security/api-key.guard.js";
import { SessionGuard } from "./security/session.guard.js";
import { LicenseController } from "./license/license.controller.js";
import { LicenseService } from "./license/license.service.js";
import { DesktopAuthController } from "./license/desktop-auth.controller.js";
import { KeyController } from "./license/key.controller.js";
import { AdminController } from "./admin/admin.controller.js";
import { UsageService } from "./usage/usage.service.js";
import { RuntimeConfigService } from "./config/runtime-config.js";
import { AuthController } from "./auth/auth.controller.js";
import { AuthService } from "./auth/auth.service.js";
import { AdminStoreService } from "./admin/admin-store.service.js";
import { AdminSessionGuard } from "./security/admin-session.guard.js";
import { PricingService } from "./billing/pricing.service.js";
import { CreditAccountService } from "./billing/credit-account.service.js";
import { MemberController } from "./member/member.controller.js";
import { DesktopSessionService } from "./security/desktop-session.service.js";
import { DesktopSessionGuard } from "./security/desktop-session.guard.js";
import { RateLimitService } from "./security/rate-limit.service.js";
import { SecurityEventService } from "./security/security-event.service.js";
import { ProviderConnectionService } from "./admin/provider-connection.service.js";

@Module({
  controllers: [HealthController, GatewayController, LicenseController, DesktopAuthController, KeyController, AuthController, AdminController, MemberController],
  providers: [AdminStoreService, ProviderConnectionService, PricingService, CreditAccountService, GatewayService, ApiKeyGuard, SessionGuard, AdminSessionGuard, LicenseService, UsageService, RuntimeConfigService, AuthService, DesktopSessionService, DesktopSessionGuard, RateLimitService, SecurityEventService],
})
export class AppModule {}

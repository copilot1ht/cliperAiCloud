import { describe, expect, it, vi } from "vitest";
import { HealthController } from "./health.controller.js";

function runtimeReport() {
  return {
    mode: "development",
    ready: false,
    errors: [],
    warnings: ["Tidak ada provider AI aktif. Konfigurasikan minimal satu provider key."],
    providers: [],
    infrastructure: {
      database: true,
      redis: true,
      secureOrigins: true,
      analysisBillingStorage: "postgres" as const,
    },
  };
}

describe("HealthController readiness", () => {
  it("uses healthy database-managed providers as the effective readiness source", async () => {
    const config = {
      report: vi.fn().mockReturnValue(runtimeReport()),
      dependencies: vi.fn().mockResolvedValue({ database: true, redis: false }),
    };
    const adminStore = {
      listProviders: vi.fn().mockReturnValue([
        { enabled: true, status: "healthy", pricingConfigured: true },
      ]),
    };

    const result = await new HealthController(config as never, adminStore as never).ready();

    expect(result.ok).toBe(true);
    expect(result.providerReadiness).toEqual({ ready: true, stored: 1, healthy: 1 });
    expect(result.warnings).toEqual([]);
  });

  it("remains not ready when neither environment nor database providers can route", async () => {
    const config = {
      report: vi.fn().mockReturnValue(runtimeReport()),
      dependencies: vi.fn().mockResolvedValue({ database: true, redis: false }),
    };
    const adminStore = { listProviders: vi.fn().mockReturnValue([]) };

    const result = await new HealthController(config as never, adminStore as never).ready();

    expect(result.ok).toBe(false);
    expect(result.warnings).toHaveLength(1);
  });
});

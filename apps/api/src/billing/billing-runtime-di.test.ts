import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { AppModule } from "../app.module.js";
import { AnalysisJobService } from "./analysis-job.service.js";
import { PricingService } from "./pricing.service.js";

const originalStorage = process.env.ANALYSIS_BILLING_STORAGE;

afterEach(() => {
  if (originalStorage === undefined) delete process.env.ANALYSIS_BILLING_STORAGE;
  else process.env.ANALYSIS_BILLING_STORAGE = originalStorage;
});

describe("billing runtime dependency injection", () => {
  it("boots the Nest container with a usable pricing and analysis job service", async () => {
    process.env.ANALYSIS_BILLING_STORAGE = "memory";
    const application = await NestFactory.createApplicationContext(AppModule, { logger: false });
    try {
      expect(application.get(PricingService).validateAnalysisJobPolicy().valid).toBe(true);
      await expect(application.get(AnalysisJobService).summary()).resolves.toMatchObject({ storage: "memory" });
    } finally {
      await application.close();
    }
  });
});

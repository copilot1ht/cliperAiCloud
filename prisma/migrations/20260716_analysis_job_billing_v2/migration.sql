ALTER TYPE "LedgerType" ADD VALUE IF NOT EXISTS 'AI_RESERVATION';
ALTER TYPE "LedgerType" ADD VALUE IF NOT EXISTS 'AI_SETTLEMENT';
ALTER TYPE "LedgerType" ADD VALUE IF NOT EXISTS 'AI_RESERVATION_RELEASE';
ALTER TYPE "LedgerType" ADD VALUE IF NOT EXISTS 'AI_REFUND';

CREATE TYPE "AnalysisJobStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'FAILED', 'CANCELLED');

ALTER TABLE "providers"
ADD COLUMN "cachedInputUsdPerM" DECIMAL(12, 6) NOT NULL DEFAULT 0,
ADD COLUMN "reasoningUsdPerM" DECIMAL(12, 6) NOT NULL DEFAULT 0;

ALTER TABLE "provider_prices"
ADD COLUMN "cachedInputUsdPerM" DECIMAL(12, 6) NOT NULL DEFAULT 0,
ADD COLUMN "reasoningUsdPerM" DECIMAL(12, 6) NOT NULL DEFAULT 0;

ALTER TABLE "pricing_policies"
ADD COLUMN "creditValueIdr" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "minimumMarginBps" INTEGER NOT NULL DEFAULT 5000,
ADD COLUMN "targetMarginBps" INTEGER NOT NULL DEFAULT 6000,
ADD COLUMN "maximumMarginBps" INTEGER NOT NULL DEFAULT 8000,
ADD COLUMN "baseAnalysisCredits" INTEGER NOT NULL DEFAULT 300,
ADD COLUMN "optionalClipCredits" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN "goodClipCredits" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN "premiumClipCredits" INTEGER NOT NULL DEFAULT 150,
ADD COLUMN "optionalScoreMin" INTEGER NOT NULL DEFAULT 70,
ADD COLUMN "goodScoreMin" INTEGER NOT NULL DEFAULT 78,
ADD COLUMN "premiumScoreMin" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN "minimumJobCredits" INTEGER NOT NULL DEFAULT 300,
ADD COLUMN "maximumJobCredits" INTEGER NOT NULL DEFAULT 2000,
ADD COLUMN "infrastructureFeeIdr" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN "safetyBufferBps" INTEGER NOT NULL DEFAULT 1000,
ADD COLUMN "retryAllowanceBps" INTEGER NOT NULL DEFAULT 500,
ADD COLUMN "paymentFeeAllocationBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "targetProviderCostIdr" INTEGER NOT NULL DEFAULT 250,
ADD COLUMN "warningProviderCostIdr" INTEGER NOT NULL DEFAULT 400,
ADD COLUMN "hardProviderCostIdr" INTEGER NOT NULL DEFAULT 500,
ADD COLUMN "lowBalanceWarningCredits" INTEGER NOT NULL DEFAULT 5000,
ADD COLUMN "usdToIdr" INTEGER NOT NULL DEFAULT 16000;

CREATE TABLE "analysis_jobs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "requestId" TEXT NOT NULL,
    "sourceId" TEXT,
    "sourceDurationSeconds" INTEGER NOT NULL DEFAULT 0,
    "requestedClipCount" INTEGER NOT NULL DEFAULT 0,
    "reservedCreditMicro" BIGINT NOT NULL,
    "providerCostMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "providerCostIdr" INTEGER NOT NULL DEFAULT 0,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "modules" JSONB NOT NULL DEFAULT '{}',
    "status" "AnalysisJobStatus" NOT NULL DEFAULT 'ACTIVE',
    "clipScores" JSONB,
    "finalChargeMicro" BIGINT NOT NULL DEFAULT 0,
    "releasedMicro" BIGINT NOT NULL DEFAULT 0,
    "pricingSnapshot" JSONB,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "analysis_jobs_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "provider_usage"
ADD COLUMN "analysisJobId" TEXT,
ADD COLUMN "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "totalTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "fallbackCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "usageSource" TEXT NOT NULL DEFAULT 'provider',
ADD COLUMN "providerCostIdr" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "credit_transactions"
ADD COLUMN "analysisJobId" TEXT;

CREATE UNIQUE INDEX "analysis_jobs_userId_requestId_key"
ON "analysis_jobs"("userId", "requestId");

CREATE INDEX "analysis_jobs_accountId_status_createdAt_idx"
ON "analysis_jobs"("accountId", "status", "createdAt");

CREATE INDEX "analysis_jobs_apiKeyId_createdAt_idx"
ON "analysis_jobs"("apiKeyId", "createdAt");

CREATE INDEX "provider_usage_analysisJobId_createdAt_idx"
ON "provider_usage"("analysisJobId", "createdAt");

CREATE INDEX "credit_transactions_analysisJobId_createdAt_idx"
ON "credit_transactions"("analysisJobId", "createdAt");

ALTER TABLE "analysis_jobs"
ADD CONSTRAINT "analysis_jobs_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "analysis_jobs"
ADD CONSTRAINT "analysis_jobs_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "user_credits"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "analysis_jobs"
ADD CONSTRAINT "analysis_jobs_apiKeyId_fkey"
FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "provider_usage"
ADD CONSTRAINT "provider_usage_analysisJobId_fkey"
FOREIGN KEY ("analysisJobId") REFERENCES "analysis_jobs"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "credit_transactions"
ADD CONSTRAINT "credit_transactions_analysisJobId_fkey"
FOREIGN KEY ("analysisJobId") REFERENCES "analysis_jobs"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TYPE "BillingSource" AS ENUM (
  'NO_CHARGE_LOCAL',
  'FREE_PREMIUM_TRIAL',
  'SUBSCRIPTION_INCLUDED',
  'WALLET_FALLBACK',
  'WALLET_STANDARD'
);

ALTER TABLE "analysis_jobs"
  ADD COLUMN "subscriptionId" TEXT,
  ADD COLUMN "contentMode" TEXT,
  ADD COLUMN "billingSource" "BillingSource" NOT NULL DEFAULT 'WALLET_STANDARD',
  ADD COLUMN "proQuotaDayKey" TEXT,
  ADD COLUMN "proQuotaMonthKey" TEXT,
  ADD COLUMN "premiumTrialWeekKey" TEXT,
  ADD COLUMN "premiumTrialSourceKey" TEXT;

ALTER TABLE "analysis_jobs"
  ADD CONSTRAINT "analysis_jobs_subscriptionId_fkey"
  FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "analysis_jobs_subscriptionId_createdAt_idx"
  ON "analysis_jobs"("subscriptionId", "createdAt");

CREATE INDEX "analysis_jobs_userId_billingSource_createdAt_idx"
  ON "analysis_jobs"("userId", "billingSource", "createdAt");

CREATE INDEX "analysis_jobs_userId_proQuotaDayKey_billingSource_idx"
  ON "analysis_jobs"("userId", "proQuotaDayKey", "billingSource");

CREATE INDEX "analysis_jobs_userId_proQuotaMonthKey_billingSource_idx"
  ON "analysis_jobs"("userId", "proQuotaMonthKey", "billingSource");

CREATE INDEX "analysis_jobs_userId_premiumTrialWeekKey_billingSource_idx"
  ON "analysis_jobs"("userId", "premiumTrialWeekKey", "billingSource");

CREATE INDEX "analysis_jobs_userId_premiumTrialSourceKey_premiumTrialWeekKey_idx"
  ON "analysis_jobs"("userId", "premiumTrialSourceKey", "premiumTrialWeekKey");

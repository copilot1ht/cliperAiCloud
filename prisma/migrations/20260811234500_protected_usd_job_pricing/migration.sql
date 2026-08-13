-- Additive only: existing wallet balances and financial ledger rows stay untouched.
ALTER TABLE "pricing_policies"
  ADD COLUMN "infrastructureCostMicroUsd" BIGINT NOT NULL DEFAULT 2000,
  ADD COLUMN "minimumJobChargeMicroUsd" BIGINT NOT NULL DEFAULT 20000,
  ADD COLUMN "maximumJobChargeMicroUsd" BIGINT NOT NULL DEFAULT 500000,
  ADD COLUMN "targetProviderCostMicroUsd" BIGINT NOT NULL DEFAULT 15000,
  ADD COLUMN "warningProviderCostMicroUsd" BIGINT NOT NULL DEFAULT 25000,
  ADD COLUMN "hardProviderCostMicroUsd" BIGINT NOT NULL DEFAULT 50000,
  ADD COLUMN "lowBalanceWarningMicroUsd" BIGINT NOT NULL DEFAULT 1000000;

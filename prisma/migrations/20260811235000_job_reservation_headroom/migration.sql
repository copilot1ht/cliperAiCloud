-- Additive only: a reservation headroom is a pricing-policy setting.
-- Existing wallet balances, jobs, and ledger rows are intentionally untouched.
ALTER TABLE "pricing_policies"
  ADD COLUMN "reservationHeadroomBps" INTEGER NOT NULL DEFAULT 2000;

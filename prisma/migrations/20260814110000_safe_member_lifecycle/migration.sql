-- Safe account deletion keeps payment, wallet, invoice, usage, and audit
-- history intact. It only records that access and personal profile data were
-- retired, so relational financial records never need a destructive cascade.
ALTER TABLE "users"
  ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "users_deletedAt_idx" ON "users"("deletedAt");

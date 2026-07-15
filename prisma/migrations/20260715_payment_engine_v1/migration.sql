ALTER TABLE "plans"
ADD COLUMN "durationDays" INTEGER NOT NULL DEFAULT 30;

ALTER TABLE "subscriptions"
ADD COLUMN "autoRenew" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "credit_transactions"
ADD COLUMN "invoiceId" TEXT;

ALTER TABLE "invoices"
ADD COLUMN "provider" TEXT,
ADD COLUMN "providerReference" TEXT,
ADD COLUMN "paymentUrl" TEXT,
ADD COLUMN "qrString" TEXT,
ADD COLUMN "expiresAt" TIMESTAMP(3);

CREATE TABLE "payment_logs" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "eventType" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "signature" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "accepted" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "safePayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "credit_transactions_invoiceId_createdAt_idx"
ON "credit_transactions"("invoiceId", "createdAt");

CREATE UNIQUE INDEX "invoices_provider_providerReference_key"
ON "invoices"("provider", "providerReference");

CREATE UNIQUE INDEX "payment_logs_provider_eventId_key"
ON "payment_logs"("provider", "eventId");

CREATE INDEX "payment_logs_invoiceId_createdAt_idx"
ON "payment_logs"("invoiceId", "createdAt");

CREATE INDEX "payment_logs_verified_accepted_createdAt_idx"
ON "payment_logs"("verified", "accepted", "createdAt");

ALTER TABLE "credit_transactions"
ADD CONSTRAINT "credit_transactions_invoiceId_fkey"
FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payment_logs"
ADD CONSTRAINT "payment_logs_invoiceId_fkey"
FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

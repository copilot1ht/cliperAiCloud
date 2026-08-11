CREATE TABLE "wallet_payment_settings" (
    "id" TEXT NOT NULL,
    "walletCurrency" TEXT NOT NULL DEFAULT 'USD',
    "paymentCurrency" TEXT NOT NULL DEFAULT 'IDR',
    "minPurchaseMicroUsd" BIGINT NOT NULL DEFAULT 1000000,
    "maxPurchaseMicroUsd" BIGINT NOT NULL DEFAULT 500000000,
    "usdToIdrRate" INTEGER NOT NULL DEFAULT 17700,
    "serviceFeeIdr" INTEGER NOT NULL DEFAULT 1000,
    "uniqueCodeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "uniqueCodeMin" INTEGER NOT NULL DEFAULT 99,
    "uniqueCodeMax" INTEGER NOT NULL DEFAULT 299,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "wallet_payment_settings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "wallet_payment_settings" (
    "id", "walletCurrency", "paymentCurrency", "minPurchaseMicroUsd",
    "maxPurchaseMicroUsd", "usdToIdrRate", "serviceFeeIdr",
    "uniqueCodeEnabled", "uniqueCodeMin", "uniqueCodeMax", "updatedAt"
) VALUES (
    'default-wallet-payment', 'USD', 'IDR', 1000000,
    500000000, 17700, 1000, true, 99, 299, CURRENT_TIMESTAMP
) ON CONFLICT ("id") DO NOTHING;

-- Legacy top-ups credited one wallet unit per IDR. This one-time reconciliation
-- maps verified legacy top-ups to their documented USD value: Rp17.000 = US$1.
-- It never alters provider amounts, invoices, payment status, or AI usage.
WITH legacy_topups AS (
    SELECT
        ledger."accountId",
        invoice."id" AS "invoiceId",
        ledger."amountMicro" AS "oldCreditMicro",
        GREATEST(
            1000000::BIGINT,
            ROUND((invoice."totalIdr"::NUMERIC / 17000::NUMERIC) * 1000000::NUMERIC)::BIGINT
        ) AS "newCreditMicro"
    FROM "credit_transactions" AS ledger
    INNER JOIN "invoices" AS invoice ON invoice."id" = ledger."invoiceId"
    INNER JOIN "payments" AS payment ON payment."id" = invoice."paymentId"
    WHERE ledger."type" = 'GRANT'
      AND payment."status" = 'PAID'
      AND COALESCE(invoice."metadata", '{}'::jsonb)->>'kind' = 'topup'
      AND NOT (COALESCE(invoice."metadata", '{}'::jsonb) ? 'purchaseMicroUsd')
), account_deltas AS (
    SELECT
        "accountId",
        SUM("newCreditMicro" - "oldCreditMicro") AS "deltaMicro",
        COUNT(*)::INTEGER AS "invoiceCount"
    FROM legacy_topups
    GROUP BY "accountId"
), reconciled_accounts AS (
    UPDATE "user_credits" AS account
    SET
        "balanceMicro" = GREATEST(account."reservedMicro", account."balanceMicro" + deltas."deltaMicro"),
        "lifetimeGrantedMicro" = GREATEST(0, account."lifetimeGrantedMicro" + deltas."deltaMicro"),
        "updatedAt" = CURRENT_TIMESTAMP
    FROM account_deltas AS deltas
    WHERE account."id" = deltas."accountId"
    RETURNING account."id", account."balanceMicro", deltas."deltaMicro", deltas."invoiceCount"
)
INSERT INTO "credit_transactions" (
    "id", "accountId", "type", "amountMicro", "balanceAfterMicro",
    "idempotencyKey", "description", "costSnapshot"
)
SELECT
    'wallet-usd-' || "id",
    "id",
    'ADJUSTMENT',
    "deltaMicro",
    "balanceMicro",
    'wallet-usd-migration:' || "id",
    'Legacy IDR wallet reconciled to USD wallet units',
    jsonb_build_object(
        'reason', 'legacy_idr_wallet_to_usd',
        'legacyMinimumIdrPerUsd', 17000,
        'reconciledInvoices', "invoiceCount"
    )
FROM reconciled_accounts
ON CONFLICT ("idempotencyKey") DO NOTHING;

WITH legacy_topups AS (
    SELECT
        invoice."id" AS "invoiceId",
        GREATEST(
            1000000::BIGINT,
            ROUND((invoice."totalIdr"::NUMERIC / 17000::NUMERIC) * 1000000::NUMERIC)::BIGINT
        ) AS "purchaseMicroUsd"
    FROM "invoices" AS invoice
    INNER JOIN "payments" AS payment ON payment."id" = invoice."paymentId"
    WHERE payment."status" = 'PAID'
      AND COALESCE(invoice."metadata", '{}'::jsonb)->>'kind' = 'topup'
      AND NOT (COALESCE(invoice."metadata", '{}'::jsonb) ? 'purchaseMicroUsd')
)
UPDATE "invoices" AS invoice
SET "metadata" = COALESCE(invoice."metadata", '{}'::jsonb) || jsonb_build_object(
    'walletCurrency', 'USD',
    'paymentCurrency', 'IDR',
    'purchaseMicroUsd', legacy_topups."purchaseMicroUsd"::TEXT,
    'purchaseUsd', to_char(legacy_topups."purchaseMicroUsd"::NUMERIC / 1000000::NUMERIC, 'FM999999990.000000'),
    'legacyWalletConversion', 'idr_17000_per_usd'
)
FROM legacy_topups
WHERE invoice."id" = legacy_topups."invoiceId";

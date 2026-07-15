# Payment Engine V2

## Implemented

- PostgreSQL invoices, payment transactions, subscriptions, credit ledger, and sanitized webhook logs.
- Provider adapter contract with HMAC verification over the exact raw request body.
- Idempotency by provider event ID, provider payment reference, invoice key, and ledger key.
- Serializable activation/refund transactions with Prisma `P2034` retry.
- Fifteen-minute invoice expiry and amount/reference validation.
- Member checkout, invoice history, wallet balance, subscription status, and admin reconciliation UI.
- Refund guard: refund is rejected when purchased credits have been spent or reserved.
- Runtime credit/plan synchronization for the current desktop session after a verified payment.
- Midtrans Snap adapter for flexible IDR top-ups and hosted checkout.
- Top-up range validation (default Rp25.000 to Rp10.000.000) and configurable credit conversion.
- Midtrans signature validation using `SHA512(order_id + status_code + gross_amount + ServerKey)`.
- Idempotent Midtrans callback handling; paid callbacks grant credits exactly once.

## Midtrans flow

Member selects a nominal top-up in IDR, the API creates a Midtrans Snap transaction, and the browser is redirected to Midtrans. The checkout can show QRIS and any payment method enabled for the merchant account. The browser redirect is only a navigation aid; credits are granted only after the verified Midtrans notification reaches:

```text
POST https://<API_DOMAIN>/api/payments/webhook/midtrans
```

Configure that URL in Midtrans MAP under Settings > Configuration > Payment Notification URL. Use HTTPS in production. Midtrans documents the notification signature and recommends idempotent handling; this API stores a verified payment log and uses the invoice/payment/ledger keys to prevent duplicate grants.

## Sandbox boundary

The bundled `sandbox` adapter is only a deterministic local QA provider. Its `CLIPER-SANDBOX:` code is not a bank QR and is never presented as QRIS. Production checkout rejects sandbox unless `ALLOW_SANDBOX_PAYMENTS=true` is explicitly set.

For sandbox QA, set `PAYMENT_PROVIDER=midtrans`, `MIDTRANS_IS_PRODUCTION=false`, and use Sandbox Access Keys. The hosted checkout is a real Midtrans Sandbox flow, not a fake QR string. For production, switch `MIDTRANS_IS_PRODUCTION=true`, replace the keys with Production Access Keys, and test a complete notification round trip before enabling user deposits.

## Required production variables

```text
DATABASE_URL
PAYMENT_PROVIDER
WEB_ORIGIN
MIDTRANS_MERCHANT_ID
MIDTRANS_CLIENT_KEY
MIDTRANS_SERVER_KEY
MIDTRANS_IS_PRODUCTION
PAYMENT_MIN_TOPUP_IDR
PAYMENT_MAX_TOPUP_IDR
PAYMENT_CREDITS_PER_IDR
```

Adapter-specific credentials must remain server-side. Provider secrets and raw webhook bodies must never be returned to the browser or written to normal application logs.

## Deployment

Railway and the API Docker image run `prisma migrate deploy` before starting NestJS. A deployment without PostgreSQL intentionally fails closed because the payment ledger must not fall back to memory.

## Security note

Never commit `MIDTRANS_SERVER_KEY` or put it in the web bundle. The Server Key pasted during setup should be rotated in Midtrans MAP before production use. Store the replacement only as a Railway/server environment variable. `MIDTRANS_CLIENT_KEY` is not used to authorize server API calls in this redirect flow.

## Known control-plane limitation

Web registration/session persistence and parts of desktop license management still use the existing in-memory MVP services. Payment records themselves are durable, and a paid webhook synchronizes the active runtime account. Migrating authentication, sessions, and license ownership fully to Prisma is the next required hardening milestone before public paid launch.

# Payment Engine V1

## Implemented

- PostgreSQL invoices, payment transactions, subscriptions, credit ledger, and sanitized webhook logs.
- Provider adapter contract with HMAC verification over the exact raw request body.
- Idempotency by provider event ID, provider payment reference, invoice key, and ledger key.
- Serializable activation/refund transactions with Prisma `P2034` retry.
- Fifteen-minute invoice expiry and amount/reference validation.
- Member checkout, invoice history, wallet balance, subscription status, and admin reconciliation UI.
- Refund guard: refund is rejected when purchased credits have been spent or reserved.
- Runtime credit/plan synchronization for the current desktop session after a verified payment.

## Sandbox boundary

The bundled `sandbox` adapter is only a deterministic local QA provider. Its `CLIPER-SANDBOX:` code is not a bank QR and is never presented as QRIS. Production checkout rejects sandbox unless `ALLOW_SANDBOX_PAYMENTS=true` is explicitly set.

Before accepting real money, implement and certify an adapter for a supported Indonesian payment provider. That adapter must create the provider's dynamic QRIS charge, validate its official webhook signature, map provider status values to the shared contract, and implement provider-side refunds.

## Required production variables

```text
DATABASE_URL
PAYMENT_PROVIDER
WEB_ORIGIN
```

Adapter-specific credentials must remain server-side. Provider secrets and raw webhook bodies must never be returned to the browser or written to normal application logs.

## Deployment

Railway and the API Docker image run `prisma migrate deploy` before starting NestJS. A deployment without PostgreSQL intentionally fails closed because the payment ledger must not fall back to memory.

## Known control-plane limitation

Web registration/session persistence and parts of desktop license management still use the existing in-memory MVP services. Payment records themselves are durable, and a paid webhook synchronizes the active runtime account. Migrating authentication, sessions, and license ownership fully to Prisma is the next required hardening milestone before public paid launch.

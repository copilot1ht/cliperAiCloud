# Midtrans Setup

## 1. Configure the API service

Set these variables in Railway (or the API process environment). Do not put them in GitHub, Vercel client variables, or the web bundle.

```text
PAYMENT_PROVIDER=midtrans
MIDTRANS_MERCHANT_ID=<sandbox-or-production-merchant-id>
MIDTRANS_CLIENT_KEY=<matching-client-key>
MIDTRANS_SERVER_KEY=<matching-server-key>
MIDTRANS_IS_PRODUCTION=false
PAYMENT_MIN_TOPUP_IDR=25000
PAYMENT_MAX_TOPUP_IDR=10000000
PAYMENT_CREDITS_PER_IDR=1
WEB_ORIGIN=https://your-web-domain
```

Use `MIDTRANS_IS_PRODUCTION=false` with Sandbox Access Keys first. Use `true` only with Production Access Keys. The API selects the correct Midtrans endpoint from this flag.

## 2. Configure the callback

In Midtrans MAP, open Settings > Configuration and set Payment Notification URL to:

```text
https://your-api-domain/api/payments/webhook/midtrans
```

The endpoint must be publicly reachable over HTTPS. Keep the API service awake and make sure Railway routes `/api/*` to NestJS.

## 3. What the user experiences

1. User opens Billing and clicks `Top-up saldo`.
2. User enters an amount between Rp25.000 and the configured maximum.
3. API creates a Midtrans Snap transaction.
4. User is redirected to the Midtrans hosted checkout.
5. QRIS and other enabled methods are shown by Midtrans.
6. Midtrans posts a notification to the callback URL.
7. API verifies the signature, amount, invoice, and replay window.
8. Credits are granted once in PostgreSQL.

The finish redirect is not proof of payment. Only a verified notification can grant credits.

## 4. Test checklist

- Create a top-up with a Sandbox key.
- Complete it using a Midtrans Sandbox payment method.
- Confirm the callback appears in the API logs without exposing the Server Key.
- Refresh Billing and confirm invoice status becomes `paid` and credits increase once.
- Send the same notification twice and confirm the credit balance increases only once.
- Send a modified signature and confirm the API returns an authorization error.
- Test an expired or failed transaction.

## 5. Before accepting real money

Rotate any Server Key that has been pasted into chat, screenshots, tickets, logs, or source control. Then configure the replacement only in the server environment, switch to Production Access Keys, verify the HTTPS callback, and run one small real transaction before opening deposits to users.

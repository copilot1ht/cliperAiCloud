# Midtrans Setup

## Production configuration source

Use one active configuration source at a time:

1. **Railway Variables** on service `@cliper/api` for the first Production activation.
2. **Admin > Settings > Payment Settings** after PostgreSQL and
   `PAYMENT_CONFIG_ENCRYPTION_KEY` are configured. The admin form stores the
   credentials encrypted and never returns their plaintext to the browser.

Never place Midtrans server credentials in `@cliper/web`, Vercel variables,
Electron, `.env.example`, or Git. Rotate any key that has been shared outside
Midtrans before Production use.

### Railway Variables (`@cliper/api` only)

```text
PAYMENT_PROVIDER=midtrans
MIDTRANS_IS_PRODUCTION=true
MIDTRANS_MERCHANT_ID=<rotated-production-merchant-id>
MIDTRANS_CLIENT_KEY=<rotated-production-client-key>
MIDTRANS_SERVER_KEY=<rotated-production-server-key>
API_PUBLIC_URL=https://api.cliperaicloud.online
WEB_ORIGIN=https://www.cliperaicloud.online
MIDTRANS_NOTIFICATION_URL=https://api.cliperaicloud.online/api/payments/webhook/midtrans
MIDTRANS_FINISH_REDIRECT_URL=https://www.cliperaicloud.online/billing
```

Adding or changing a Railway variable requires an API redeploy. The Midtrans
dashboard URLs are:

```text
Notification URL: https://api.cliperaicloud.online/api/payments/webhook/midtrans
Finish Redirect URL: https://www.cliperaicloud.online/billing
```

The notification URL is authoritative for wallet crediting. A browser redirect
or a QR image being displayed never marks an invoice as paid.

## 1. Configure the API service

Set these variables in Railway (or the API process environment). Do not put them in GitHub, Vercel client variables, or the web bundle.

```text
PAYMENT_PROVIDER=midtrans
MIDTRANS_MERCHANT_ID=<sandbox-or-production-merchant-id>
MIDTRANS_CLIENT_KEY=<matching-client-key>
MIDTRANS_SERVER_KEY=<matching-server-key>
MIDTRANS_IS_PRODUCTION=false
PAYMENT_MIN_TOPUP_USD=1
PAYMENT_USD_TO_IDR_DISPLAY_RATE=17700
# IDR is authoritative; USD is display/reference only.
PAYMENT_MIN_TOPUP_IDR=17000
PAYMENT_MAX_TOPUP_IDR=10000000
PAYMENT_CREDITS_PER_IDR=1
WEB_ORIGIN=https://your-web-domain
API_PUBLIC_URL=https://your-api-domain
MIDTRANS_NOTIFICATION_URL=https://your-api-domain/api/payments/webhook/midtrans
```

Use `MIDTRANS_IS_PRODUCTION=false` with Sandbox Access Keys first. Use `true` only with Production Access Keys. The API selects the correct Midtrans endpoint from this flag.

## 2. Configure the callback

In Midtrans MAP, open Settings > Configuration and set Payment Notification URL to:

```text
https://your-api-domain/api/payments/webhook/midtrans
```

The endpoint must be publicly reachable over HTTPS. Keep the API service awake and make sure Railway routes `/api/*` to NestJS.

### Local Sandbox URLs

For local testing, keep the web app on `http://localhost:3000` and expose API port `4100` through an HTTPS tunnel:

```text
Notification URL:
https://<current-tunnel-domain>/api/payments/webhook/midtrans

Finish Redirect URL:
http://localhost:3000/invoices

Pending Redirect URL:
http://localhost:3000/invoices

Error Redirect URL:
http://localhost:3000/invoices
```

The tunnel domain is temporary and must be replaced whenever it changes. Do not use `http://localhost:4100` as the Notification URL because Midtrans cannot reach a private computer directly. Redirects only return the browser to the invoice screen; they never grant credits.

## 3. What the user experiences

1. User opens Billing and clicks `Top-up saldo`.
2. User enters an amount in IDR from the server-enforced minimum. The default is the Rp equivalent of US$3 (Rp53.100 at the default display rate of Rp17.700/USD) through to the configured maximum.
3. API creates a QRIS transaction through Midtrans Core API.
4. API downloads the provider QR image server-side and returns it as a base64 data URL.
5. The member scans the QRIS image shown inside Cliper AI Cloud.
6. Midtrans posts a notification to the callback URL.
7. API verifies the signature, amount, invoice, and replay window.
8. Credits are granted once in PostgreSQL.

If a notification is delayed, the member Billing page and admin Payments page can call the Midtrans Status API (`GET /v2/{order_id}/status`). The response is still checked against the stored order ID and gross amount, then passed through the same idempotent settlement path as a webhook. A browser finish redirect never grants credit.

The finish redirect is not proof of payment. Only a verified notification can grant credits.

## 4.1 QRIS-only payment

The member does not choose a channel. The API always sends `payment_type=qris` to Midtrans Core API. This keeps checkout simple and prevents a browser from overriding the payment method.

For QRIS Sandbox, do not scan the code with a real banking wallet. Use the Midtrans Sandbox QRIS Simulator. The simulator changes the transaction status to `settlement`, Midtrans sends the notification to the configured callback, and the API then credits the wallet once. Alternatively, use `Check Midtrans status` after the simulator reports settlement. No real money is moved in Sandbox.

### Localhost-safe payment test

For the fastest local UI and ledger test, set `PAYMENT_PROVIDER=sandbox` and `ALLOW_SANDBOX_PAYMENTS=true`. Create a top-up, then select **Complete sandbox payment**. This exercises invoice creation, the signed webhook path, idempotent settlement, and wallet credit without contacting Midtrans or moving money.

You can verify the same flow from the terminal without exposing a password in history:

```powershell
pnpm qa:payment-local
```

The script prompts for the test account password, creates a minimum top-up, settles it through the internal sandbox webhook twice, and verifies that the wallet changes exactly once.

For a real Midtrans Sandbox QRIS transaction, use only `SB-Mid-*` Sandbox keys with `MIDTRANS_IS_PRODUCTION=false`, keep `PAYMENT_PROVIDER=midtrans`, and expose port 4100 through an HTTPS tunnel. Midtrans cannot send notifications to `localhost`; set the Notification URL to `https://<tunnel-domain>/api/payments/webhook/midtrans`. Do not place Production keys in a local `.env`.

## 5. Test checklist

- Create a top-up with a Sandbox key.
- Complete it using a Midtrans Sandbox payment method.
- Confirm the callback appears in the API logs without exposing the Server Key.
- Refresh Billing and confirm invoice status becomes `paid` and credits increase once.
- Use `Check Midtrans status` if the notification is delayed; confirm it can settle the invoice only when Midtrans reports a matching status and amount.
- From Admin > Payments, use `Sync status` for a pending transaction and verify the result is safe to repeat.
- Send the same notification twice and confirm the credit balance increases only once.
- Send a modified signature and confirm the API returns an authorization error.
- Test an expired or failed transaction.

## 6. Before accepting real money

Rotate any Server Key that has been pasted into chat, screenshots, tickets, logs, or source control. Then configure the replacement only in the server environment, switch to Production Access Keys, verify the HTTPS callback, and run one small real transaction before opening deposits to users.

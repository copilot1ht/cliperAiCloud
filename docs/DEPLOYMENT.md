# Deployment Cliper AI Cloud

Arsitektur production memakai dua deployment dari satu monorepo:

- `apps/web` ke Vercel.
- `apps/api` beserta workspace package ke Railway.

API tidak dideploy ke Vercel dan web tidak dideploy sebagai service Railway.

## 1. Railway API

Gunakan repository root (`/`) agar Docker build dapat membaca `apps/api`, `packages`, dan lockfile workspace.

Konfigurasi yang dibaca otomatis:

- `railway.json`
- `Dockerfile.api`
- Healthcheck `/health/live`
- Start command `prisma migrate deploy` lalu `node apps/api/dist/main.js`

Pada Railway service settings, set **Root Directory** ke `/` dan **Config File Path** ke `/railway.json`. Jangan memakai `apps/api` sebagai root karena Docker membutuhkan seluruh workspace. Pastikan watch paths mencakup `apps/api/**`, `packages/**`, `prisma/**`, `Dockerfile.api`, `package.json`, dan `pnpm-lock.yaml`.

### Environment wajib

```text
NODE_ENV=production
WEB_ORIGIN=https://DOMAIN-WEB-VERCEL
JWT_SECRET=MINIMAL_32_KARAKTER_RANDOM
REFRESH_TOKEN_SECRET=MINIMAL_32_KARAKTER_RANDOM_BERBEDA
ADMIN_API_KEY=MINIMAL_24_KARAKTER_RANDOM
PROVIDER_ENCRYPTION_KEY=MINIMAL_32_KARAKTER_RANDOM
# Optional, but recommended when Admin Payment Settings stores a Midtrans key.
PAYMENT_CONFIG_ENCRYPTION_KEY=MINIMAL_32_KARAKTER_RANDOM_BERBEDA
LICENSE_KEY_PEPPER=MINIMAL_32_KARAKTER_RANDOM
BOOTSTRAP_ADMIN_EMAIL=EMAIL_ADMIN
BOOTSTRAP_ADMIN_PASSWORD_HASH=HASH_ARGON2ID
ALLOW_LEGACY_API_KEY_AUTH=false
DATABASE_URL=${{Postgres.DATABASE_URL}}
PAYMENT_PROVIDER=midtrans
ALLOW_SANDBOX_PAYMENTS=false
MIDTRANS_MERCHANT_ID=your-production-merchant-id
MIDTRANS_CLIENT_KEY=your-production-client-key
MIDTRANS_SERVER_KEY=your-production-server-key
MIDTRANS_IS_PRODUCTION=true
MIDTRANS_QRIS_ACQUIRER=gopay
MIDTRANS_NOTIFICATION_URL=https://api.cliperaicloud.online/api/payments/webhook/midtrans
MIDTRANS_FINISH_REDIRECT_URL=https://www.cliperaicloud.online/billing
PAYMENT_MIN_TOPUP_IDR=17000
PAYMENT_MAX_TOPUP_IDR=10000000
PAYMENT_CREDITS_PER_IDR=1
MINIMUM_MARGIN_BPS=5000
MINIMUM_CLIP_CHARGE_MICRO_USD=5000
PLATFORM_USD_TO_IDR=16000
# 0 lets the desktop return every qualified, non-overlapping recommendation.
# Use a positive value only as a temporary operator capacity guard.
MAX_CLIPS_PER_JOB=0
MAX_SETTLEMENT_CLIP_SCORES=1000
```

Jangan set `CLIPER_DEV_API_KEY` atau `DEV_ADMIN_*` pada production.

Provider key tidak wajib saat boot. Login ke Admin > Providers setelah deploy, lalu tambahkan DeepSeek, Gemini, OpenAI, Qwen, atau Claude. Readiness akan berstatus setup sampai provider sehat tersedia.

PostgreSQL wajib untuk Payment Engine. Redis direkomendasikan dan dapat direferensikan dari service Railway:

```text
REDIS_URL=${{Redis.REDIS_URL}}
```

### Capacity baseline

Untuk tahap 100 sampai 1.000 pengguna terdaftar, gunakan API stateless dengan
PostgreSQL dan Redis managed. Media tetap diproses di Electron pengguna; jangan
menambahkan worker render ke Railway.

```text
# Start with two API replicas. Set DB_POOL_MAX per replica, not globally.
DB_POOL_MAX=5
DB_CONNECTION_TIMEOUT_MS=5000

# Distributed abuse and AI work protection.
RATE_LIMIT_AUTH_LOGIN_PER_MINUTE=5
RATE_LIMIT_PASSWORD_RESET_PER_15_MINUTES=3
RATE_LIMIT_KEY_CREATE_PER_HOUR=5
RATE_LIMIT_PAYMENT_CREATE_PER_10_MINUTES=5
RATE_LIMIT_PAYMENT_SYNC_PER_MINUTE=20
AI_CONCURRENCY_FREE=1
AI_CONCURRENCY_STARTER=2
AI_CONCURRENCY_PRO=4
AI_CONCURRENCY_TEAM=6
AI_CONCURRENCY_ENTERPRISE=10
AI_CONCURRENCY_TTL_MS=90000
# Global guard per provider across all API replicas. Override individual
# providers only after their documented quota has been verified.
AI_PROVIDER_RPS=30
AI_PROVIDER_CONCURRENCY=20
PROVIDER_RETRIES=2
PROVIDER_CIRCUIT_FAILURE_THRESHOLD=3
PROVIDER_CIRCUIT_COOLDOWN_MS=30000
ADMIN_CONFIG_REFRESH_MS=60000
# Errors are always logged. Sample routine success logs to keep burst traffic
# from consuming CPU and Railway log volume.
HTTP_SUCCESS_LOG_SAMPLE_RATE=0.05

# Reduce PostgreSQL write amplification from normal desktop activity.
KEY_ACTIVITY_WRITE_INTERVAL_MS=600000
DESKTOP_HEARTBEAT_PERSIST_MS=600000
```

Keep the API at two replicas before adding more. Monitor CPU, memory, HTTP 5xx,
PostgreSQL connections, Redis availability, provider latency, and payment
webhook results. Add a third replica only after a staging load test shows that
the traffic is sustained and `DB_POOL_MAX` has been reviewed against the
PostgreSQL connection limit. Never enable Railway sleeping for the payment API:
Xendit callbacks must remain low-latency and reliable.

Run non-financial local or staging smoke load only with:

```powershell
$env:LOAD_TEST_URL="http://127.0.0.1:4100/health/live"
$env:LOAD_TEST_DURATION_SECONDS="15"
$env:LOAD_TEST_CONCURRENCY="20"
pnpm test:load
```

The command rejects the Cliper production domain unless an operator explicitly
sets `ALLOW_PRODUCTION_LOAD_TEST=true` during an approved capacity window.
For a staged non-financial test, use 50, 100, 250, 500, then 1,000 concurrent
workers against localhost or staging and stop at the first error-rate or p95
regression. This tool is not for payment, wallet, or provider endpoints.

Untuk uji lokal gunakan Sandbox Access Keys. API membuat QRIS melalui Midtrans Core API dan menampilkan gambar QR di web. Set `MIDTRANS_IS_PRODUCTION=true` hanya setelah Production Access Keys dan notification URL HTTPS siap. Jangan menaruh Server Key di GitHub, browser, atau log.

## Xendit QRIS (Payments API V3)

Xendit dapat menjadi provider utama tanpa mengubah invoice, wallet, atau ledger. Masukkan credential hanya pada Railway service `@cliper/api`:

```text
PAYMENT_PRIMARY_PROVIDER=xendit
PAYMENT_PROVIDER=xendit
XENDIT_ENABLED=true
XENDIT_MODE=test
XENDIT_SECRET_KEY=<Xendit Secret API Key with Money-In Write permission; never a xnd_public_* key>
XENDIT_WEBHOOK_TOKEN=<Xendit callback token>
XENDIT_API_VERSION=2024-11-11
XENDIT_NOTIFICATION_URL=https://api.cliperaicloud.online/api/payments/webhook/xendit
MIDTRANS_ENABLED=false
PAYMENT_FALLBACK_ENABLED=false
```

Set **Payment Status** dan **Payment Request Status** in the Xendit dashboard to the Xendit notification URL above. The API validates `x-callback-token`; a browser redirect never grants balance. `XENDIT_WEBHOOK_TOKEN` must be the exact current webhook verification token from the same Xendit environment. A `401 Xendit callback token tidak valid` means the Railway variable and dashboard token differ; replace the Railway value with the dashboard token, redeploy, then use **Test and save** again. Xendit dashboard probes can contain historic example timestamps: when their callback token is valid, Cliper acknowledges them with HTTP 200 without creating an invoice or crediting a wallet. A known Cliper invoice outside the replay window remains ineligible for wallet mutation. Keep `XENDIT_MODE=test` for a complete controlled test, then change only `XENDIT_MODE=live` and rotate/set the live key and live callback token after the Xendit QRIS live channel is enabled. Do not switch to live until a test QR, verified webhook, and exactly-once wallet credit have passed.

Atur Payment Notification URL di Midtrans MAP ke `https://api.cliperaicloud.online/api/payments/webhook/midtrans` dan Finish Redirect URL ke `https://www.cliperaicloud.online/billing`. Endpoint notification harus dapat diakses publik melalui HTTPS. Redirect user tidak menggantikan notification URL: saldo hanya diberikan dari callback yang signature-nya valid.

Untuk aktivasi pertama, simpan credential hanya pada Railway service `@cliper/api`. Sesudah database Production sehat, admin dapat memasukkan rotasi key melalui **Admin > Settings > Payment Settings**; nilai akan dienkripsi dan UI hanya menampilkan status/mask. Jangan menaruh Midtrans key pada Vercel atau `@cliper/web`.

Konfigurasi routing/admin memakai cache proses yang direkonsiliasi melalui
PostgreSQL dan revision Redis; wallet, payment, API key, license, dan session
tetap memiliki source of truth di PostgreSQL. Karena itu API siap dijalankan
lebih dari satu replica. Tetap mulai dari satu replica pada trafik rendah;
naikkan ke dua hanya setelah staging/load test dan batas koneksi PostgreSQL
ditinjau.

Pricing gateway memakai provider token cost aktual. `MINIMUM_MARGIN_BPS=5000` berarti gross margin minimum 50% (markup efektif minimum 100%); `MINIMUM_CLIP_CHARGE_MICRO_USD=5000` hanya lantai estimasi job highlight, bukan harga palsu per kartu. Sesuaikan rate provider di environment API sebelum membuka akses user.

### Membuat hash password admin

PowerShell:

```powershell
$env:ADMIN_PASSWORD="password-yang-kuat"
pnpm admin:hash
Remove-Item Env:ADMIN_PASSWORD
```

Masukkan output sebagai `BOOTSTRAP_ADMIN_PASSWORD_HASH`. Jangan memasukkan password asli ke Railway atau Git.

## 2. Vercel Web

Pengaturan yang direkomendasikan:

```text
Root Directory: apps/web
Framework: Next.js
Install Command: cd ../.. && corepack enable && pnpm install --frozen-lockfile
Build Command: cd ../.. && pnpm --filter @cliper/web build
Output Directory: default Next.js
Node.js: 22
```

Project Vercel harus menjadi project **web**, bukan `cliper-ai-cloud-api`. Jika halaman deployment menunjuk project API, disconnect repository dari project tersebut lalu import ulang sebagai web dengan Root Directory `apps/web`.

`apps/web/vercel.json` mengunci install/build monorepo dari repository root sambil
tetap memakai output framework default. Build Web memakai Webpack secara eksplisit
agar trace production Next.js tersedia untuk packaging Vercel. `vercel.json` di
root menjadi fallback bila project terlanjur diimpor dengan Root Directory `/`.

Environment Vercel:

```text
CLIPER_API_URL=https://DOMAIN-API.up.railway.app
```

Hapus `NEXT_PUBLIC_API_URL` pada production. Browser akan memakai `/cloud-api`; Next.js meneruskan request ke Railway sehingga cookie login tetap first-party dan API provider tidak diekspos sebagai konfigurasi browser.

### Password recovery

Pemulihan password berjalan melalui API Railway, bukan browser. Tambahkan ke
service `@cliper/api` setelah domain pengirim email sudah tervalidasi di Resend:

```text
APP_URL=https://www.cliperaicloud.online
RESEND_API_KEY=<server-side-only>
PASSWORD_RESET_FROM=Cliper AI Cloud <no-reply@your-verified-domain>
PASSWORD_RESET_REPLY_TO=support@your-domain
```

Jangan set `PASSWORD_RESET_EXPOSE_TOKEN_FOR_TESTS=true` pada production. Tanpa
`RESEND_API_KEY` dan alamat pengirim tervalidasi, endpoint akan menolak reset
secara jelas daripada berpura-pura mengirim email.

## 3. Urutan Deploy

1. Push branch `main` ke GitHub.
2. Deploy Railway API dan buat public domain.
3. Set semua environment Railway, khususnya `WEB_ORIGIN` memakai domain Vercel.
4. Set `CLIPER_API_URL` di Vercel memakai domain Railway.
5. Deploy ulang kedua service.
6. Verifikasi `/health/live`, login admin, Provider Test, dan `/health/ready`.

## 4. Diagnostik

```powershell
railway logs --build --latest --lines 200
railway logs --deployment --latest --lines 200
railway logs --http --status ">=400" --lines 100
```

Jalankan perintah Railway di atas hanya setelah CLI login ke workspace yang memiliki project target dan `railway link` berhasil. Login ke workspace lain tidak dapat membaca deployment log meskipun repository GitHub sama.

Jika Railway gagal sebelum start, cek Docker build. Jika `/health/live` berhasil tetapi UI menampilkan setup, konfigurasi provider belum sehat atau dependency operasional belum tersambung.

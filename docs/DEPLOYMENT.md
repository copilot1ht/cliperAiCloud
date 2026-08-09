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

Untuk uji lokal gunakan Sandbox Access Keys. API membuat QRIS melalui Midtrans Core API dan menampilkan gambar QR di web. Set `MIDTRANS_IS_PRODUCTION=true` hanya setelah Production Access Keys dan notification URL HTTPS siap. Jangan menaruh Server Key di GitHub, browser, atau log.

Atur Payment Notification URL di Midtrans MAP ke `https://api.cliperaicloud.online/api/payments/webhook/midtrans` dan Finish Redirect URL ke `https://www.cliperaicloud.online/billing`. Endpoint notification harus dapat diakses publik melalui HTTPS. Redirect user tidak menggantikan notification URL: saldo hanya diberikan dari callback yang signature-nya valid.

Untuk aktivasi pertama, simpan credential hanya pada Railway service `@cliper/api`. Sesudah database Production sehat, admin dapat memasukkan rotasi key melalui **Admin > Settings > Payment Settings**; nilai akan dienkripsi dan UI hanya menampilkan status/mask. Jangan menaruh Midtrans key pada Vercel atau `@cliper/web`.

Implementasi control-plane MVP saat ini masih memakai store proses untuk beberapa data. Jangan menaikkan replica lebih dari satu sebelum repository persistence Prisma selesai diintegrasikan.

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

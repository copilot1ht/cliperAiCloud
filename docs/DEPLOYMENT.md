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
LICENSE_KEY_PEPPER=MINIMAL_32_KARAKTER_RANDOM
BOOTSTRAP_ADMIN_EMAIL=EMAIL_ADMIN
BOOTSTRAP_ADMIN_PASSWORD_HASH=HASH_ARGON2ID
ALLOW_LEGACY_API_KEY_AUTH=false
DATABASE_URL=${{Postgres.DATABASE_URL}}
PAYMENT_PROVIDER=sandbox
ALLOW_SANDBOX_PAYMENTS=false
```

Jangan set `CLIPER_DEV_API_KEY` atau `DEV_ADMIN_*` pada production.

Provider key tidak wajib saat boot. Login ke Admin > Providers setelah deploy, lalu tambahkan DeepSeek, Gemini, OpenAI, Qwen, atau Claude. Readiness akan berstatus setup sampai provider sehat tersedia.

PostgreSQL wajib untuk Payment Engine. Redis direkomendasikan dan dapat direferensikan dari service Railway:

```text
REDIS_URL=${{Redis.REDIS_URL}}
```

Dengan `ALLOW_SANDBOX_PAYMENTS=false`, checkout production sengaja ditolak sampai adapter QRIS resmi dipasang. Jangan mengaktifkan sandbox untuk menerima uang nyata.

Implementasi control-plane MVP saat ini masih memakai store proses untuk beberapa data. Jangan menaikkan replica lebih dari satu sebelum repository persistence Prisma selesai diintegrasikan.

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

`apps/web/vercel.json` menyediakan pengaturan yang sama. `vercel.json` di root menjadi fallback bila project terlanjur diimpor dengan Root Directory `/`.

Environment Vercel:

```text
CLIPER_API_URL=https://DOMAIN-API.up.railway.app
```

Hapus `NEXT_PUBLIC_API_URL` pada production. Browser akan memakai `/cloud-api`; Next.js meneruskan request ke Railway sehingga cookie login tetap first-party dan API provider tidak diekspos sebagai konfigurasi browser.

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

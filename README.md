<<<<<<< HEAD
# Cliper AI Cloud

Cloud control plane untuk Cliper Studio Plus: satu Cliper API key untuk desktop, routing multi-provider, lisensi, usage, biaya, dan margin.

Status: **private alpha / local pre-beta**. Lihat [development plan](docs/DEVELOPMENT_PLAN.md) dan [pre-beta hardening audit](docs/V1_PRE_BETA_HARDENING.md) sebelum menyiapkan public deployment.

Panduan Windows lengkap: [Local Setup](docs/LOCAL_SETUP_WINDOWS.md).

Model billing dan database: [Billing and Data Model](docs/BILLING_AND_DATA_MODEL.md).

Keamanan desktop dan operasi: [Security Hardening](docs/SECURITY_HARDENING.md).

Hasil validasi terbaru: [Validation Report 2026-07-12](docs/VALIDATION_REPORT_2026-07-12.md).

## Arsitektur aman

- Aplikasi Electron stabil tetap berada di root repository selama masa transisi.
- Workspace ini berdiri sendiri dan tidak ikut ke paket Electron/ASAR.
- Desktop dapat memakai endpoint OpenAI-compatible `POST /v1/chat/completions` melalui mode Custom AI yang sudah ada.
- Provider key hanya disimpan di server. Jangan pernah memasukkannya ke Electron atau `NEXT_PUBLIC_*`.

## Menjalankan lokal

Prasyarat: Node.js 20.19+ LTS, pnpm 11+, Docker Desktop.

```powershell
Copy-Item .env.example .env
docker compose up -d
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm config:check
pnpm dev
```

- Web: `http://localhost:3000`
- Login dan pendaftaran: `http://localhost:3000/login`
- API: `http://localhost:4100/health`

### Halaman admin lokal

Gunakan satu halaman login yang sama. Account dengan role `admin` otomatis diarahkan ke control plane; member otomatis diarahkan ke dashboard user.

- Overview: `http://localhost:3000/admin/overview`
- Users & Plans: `http://localhost:3000/admin/users`
- Providers dan server-side key pool: `http://localhost:3000/admin/providers`
- AI Router primary/fallback: `http://localhost:3000/admin/ai-router`
- Revenue dan AI margin: `http://localhost:3000/admin/revenue`
- Incoming payments dan reconciliation: `http://localhost:3000/admin/payments`
- System Health: `http://localhost:3000/admin/system-health`
- Security events dan desktop sessions: `http://localhost:3000/admin/security`

Menu admin memakai route nyata, bukan anchor pada halaman overview. Link lama seperti `/admin/overview#providers` otomatis dialihkan ke route baru.

Pada mode lokal, CRUD user, provider, routing, payment, credit ledger, license, dan usage masih disimpan di memory API. Perubahan aktif langsung pada gateway, tetapi akan reset saat API restart. Provider secret dan provider cost tidak pernah dikirim ke browser member atau desktop. Aktifkan PostgreSQL, secret encryption, Redis, dan persistent audit log sebelum deployment production.

Portal lokal tidak memerlukan database untuk uji alur. Request AI nyata memerlukan minimal satu provider yang aktif. Key yang dibuat member di halaman API Keys sudah diterima oleh License API dan AI Gateway, terikat pada account pemilik, serta tidak dapat dibaca atau dicabut oleh member lain.

## Integrasi desktop sekarang

Di Settings pilih **Cliper Cloud Gateway**:

- Base URL: `http://localhost:4100/v1`
- API key: key `clip_sk_*` yang dibuat dari halaman member **API Keys**
- Model: `auto`

Desktop menukar key menjadi access token 15 menit dan rotating refresh token. Request worker memakai timestamp, nonce, SHA-256 body, dan HMAC-SHA256; response gateway juga diverifikasi checksum/signature. Key desktop disimpan melalui Electron `safeStorage`, bukan plaintext di `localStorage` atau `config.json`.

Gateway menentukan provider/model sesuai modul, kesehatan, biaya, dan fallback. Respons tetap mengikuti format OpenAI Chat Completions, tetapi identitas provider/model internal dinormalisasi menjadi `cliper-cloud`/`auto`; desktop hanya menerima jumlah Cliper Credits yang dipotong.

Admin dapat menambah provider OpenAI-compatible dari halaman Providers, memasukkan satu atau banyak API key, lalu menentukan primary dan fallback per modul/plan di halaman AI Router. Desktop tetap hanya menerima satu key `clip_sk_*` dan tidak pernah menerima key Gemini, DeepSeek, atau provider lain.

## Billing cost-based

Admin mengatur target markup, bukan gross margin. Gateway menghitung biaya aktual per request:

```text
provider cost + compute + payment fee + reserve = service cost
service cost × (1 + target markup)             = user charge
user charge / credit value                     = Cliper Credits
```

Contoh service cost Rp100 dengan markup 50% menghasilkan harga user Rp150, profit Rp50, dan gross margin 33,33%. Semua nilai internal hanya tersedia pada admin Revenue.

## Status database

`prisma/schema.prisma` dan migration awal `prisma/migrations/20260714_initial_cloud` sudah mencakup users, plans, subscriptions, user credits, credit transactions, API keys, licenses, devices, providers, routes, usage, payments, invoices, audit logs, dan system logs. Schema dan Prisma Client sudah tervalidasi. Migration belum diaplikasikan ke PostgreSQL pada workstation ini karena Docker/PostgreSQL belum tersedia.

## Batas fase ini

Fondasi dan vertical slice sudah dibuat untuk web, gateway, router, kontrak, SDK, signed desktop sessions, secure browser cookie, billing runtime, credit reservation/settlement, dan schema data. Sebelum public launch tetap diperlukan database-backed repository, Redis distributed controls, email/payment provider, deployment TLS, signed object storage, desktop updater, backup restore drill, serta load/security test.

## QA lokal

Dengan mock provider lokal pada port 4300:

```powershell
pnpm qa
.\scripts\qa-signed-session.ps1
```

Skrip kedua menguji register, key issuance, device activation, refresh rotation, heartbeat, HMAC request, signed AI response, worker Python, anti-replay, member usage, dan seluruh route utama. Password admin bersifat opsional dan harus diberikan sebagai parameter runtime, tidak disimpan di skrip.
=======
# cliperAiCloud
>>>>>>> 874c747770b5c3134b7fe0b3d632fd47efe978ad

# Cliper AI Cloud

Panduan uji Cloud lokal dengan Electron: [docs/LOCAL_CLOUD_ELECTRON_TRIAL.md](docs/LOCAL_CLOUD_ELECTRON_TRIAL.md)

Cloud control plane untuk Cliper Studio Plus: satu Cliper API key untuk desktop, routing multi-provider, lisensi, usage, biaya, dan margin.

Status: **private alpha / local pre-beta**. Lihat [development plan](docs/DEVELOPMENT_PLAN.md) dan [pre-beta hardening audit](docs/V1_PRE_BETA_HARDENING.md) sebelum menyiapkan public deployment.

Panduan Windows lengkap: [Local Setup](docs/LOCAL_SETUP_WINDOWS.md).

Model billing dan database: [Billing and Data Model](docs/BILLING_AND_DATA_MODEL.md).

Invoice, webhook, subscription, dan refund: [Payment Engine V1](docs/PAYMENT_ENGINE.md).

Keamanan desktop dan operasi: [Security Hardening](docs/SECURITY_HARDENING.md).

Hasil validasi terbaru: [Validation Report 2026-07-12](docs/VALIDATION_REPORT_2026-07-12.md).

## Arsitektur aman

- Aplikasi Electron stabil tetap berada di root repository selama masa transisi.
- Workspace ini berdiri sendiri dan tidak ikut ke paket Electron/ASAR.
- Desktop dapat memakai endpoint OpenAI-compatible `POST /v1/chat/completions` melalui mode Custom AI yang sudah ada.
- Provider key hanya disimpan di server. Jangan pernah memasukkannya ke Electron atau `NEXT_PUBLIC_*`.

## Menjalankan lokal

Prasyarat: Node.js 20.19+ LTS, pnpm 10.34.5, Docker Desktop.

```powershell
Copy-Item .env.example .env
docker compose up -d
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm config:check
pnpm dev
```

Untuk uji lokal tanpa PostgreSQL billing, gunakan:

```env
ANALYSIS_BILLING_STORAGE=memory
```

Untuk staging/production, wajib gunakan:

```env
ANALYSIS_BILLING_STORAGE=postgres
```

Lalu jalankan migration sebelum API dinyalakan:

```powershell
pnpm db:generate
pnpm exec prisma migrate deploy
pnpm config:check
```

Production akan menolak konfigurasi billing memory, provider rate nol, atau pricing job yang tidak menutup protected cost.

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

Pada mode lokal, CRUD user, provider, routing, dan license masih memakai service memory MVP. Analysis job dan AI usage dapat memakai memory untuk uji lokal atau PostgreSQL untuk staging. Payment, invoice, payment log, dan credit grant sudah wajib memakai PostgreSQL dan tidak memiliki fallback memory. Provider secret dan provider cost tidak pernah dikirim ke browser member atau desktop. Migrasikan identity, license, dan provider store sepenuhnya ke PostgreSQL/Redis sebelum public paid launch.

Login dan provider QA lokal masih dapat dibuka tanpa database, tetapi halaman checkout sengaja menolak operasi tanpa PostgreSQL. Request AI nyata memerlukan minimal satu provider yang aktif. Key yang dibuat member di halaman API Keys sudah diterima oleh License API dan AI Gateway, terikat pada account pemilik, serta tidak dapat dibaca atau dicabut oleh member lain.

## Integrasi desktop sekarang

Di Settings pilih **Cliper Cloud Gateway**:

- Base URL: `http://localhost:4100/v1`
- API key: key `clip_sk_*` yang dibuat dari halaman member **API Keys**
- Model: `auto`

Desktop menukar key menjadi access token 15 menit dan rotating refresh token. Request worker memakai timestamp, nonce, SHA-256 body, dan HMAC-SHA256; response gateway juga diverifikasi checksum/signature. Key desktop disimpan melalui Electron `safeStorage`, bukan plaintext di `localStorage` atau `config.json`.

Gateway menentukan provider/model sesuai modul, kesehatan, biaya, dan fallback. Respons tetap mengikuti format OpenAI Chat Completions, tetapi identitas provider/model internal dinormalisasi menjadi `cliper-cloud`/`auto`; desktop hanya menerima jumlah Cliper Credits yang dipotong.

Admin menambahkan DeepSeek, Gemini, OpenAI, Qwen, atau Claude melalui **Provider Manager V2**. Form hanya meminta jenis provider, API key, dan status aktif. Server menguji key, mengambil daftar model, mengukur latency, memilih default model, lalu menyimpan key dalam encrypted pool. Menambahkan provider yang sama dengan key berbeda akan memperbesar key pool tanpa menimpa key lama. Primary dan fallback per modul/plan tetap diatur melalui AI Router. Desktop hanya menerima satu key `clip_sk_*` dan tidak pernah menerima key provider.

Claude dirutekan menggunakan Anthropic Messages API native. Provider lain memakai endpoint OpenAI-compatible yang sudah ditetapkan dalam katalog backend. Base URL, timeout, priority, dan model tidak dapat diisi bebas dari browser. Untuk keamanan, raw provider key tidak pernah dikirim kembali setelah disimpan.

## Billing per analysis job

Desktop membuat satu reservation untuk satu link/video. Semua AI request di dalam job
mencatat usage dan provider cost aktual, tetapi wallet user hanya diselesaikan sekali
setelah clip final dinilai.

```text
reserve maksimum job
→ akumulasi provider cost aktual
→ nilai clip final berdasarkan quality tier
→ protected price = internal cost / (1 - target gross margin)
→ satu settlement
→ release sisa reservation
```

Default trial: 1 credit = Rp1, gross margin minimum 50%, target 60%, dan
reservation maksimum 2.000 credits. Request duplikat memakai provider request ID
sebagai idempotency key sehingga usage dan job cost tidak tercatat dua kali.
Semua nilai internal hanya tersedia pada Admin Revenue.

## Status database

`prisma/schema.prisma` beserta empat migration mencakup users, plans, subscriptions,
user credits, immutable credit ledger, API keys, licenses, devices, providers,
routes, provider usage, analysis jobs, payments, invoices, sanitized payment logs,
audit logs, dan system logs. Seluruh migration sudah diterapkan pada PostgreSQL 17
terisolasi dan trial reservation, settlement, usage persistence, serta idempotency
berhasil. Lihat [Phase 1 Billing Trial](docs/V2_PHASE1_BILLING_TRIAL.md).

## Batas fase ini

Fondasi dan vertical slice sudah dibuat untuk web, gateway, router, kontrak, SDK,
signed desktop sessions, secure browser cookie, job billing, credit
reservation/settlement, provider usage, dan schema data. Sebelum public launch tetap
diperlukan identity/license/provider repository berbasis database, Redis distributed
controls, satu provider AI nyata dengan rate resmi, concurrency test, deployment TLS,
desktop updater, backup restore drill, serta load/security test.

## QA lokal

Dengan mock provider lokal pada port 4300:

```powershell
pnpm qa
.\scripts\qa-signed-session.ps1
```

Skrip kedua menguji register, key issuance, device activation, refresh rotation, heartbeat, HMAC request, signed AI response, worker Python, anti-replay, member usage, dan seluruh route utama. Password admin bersifat opsional dan harus diberikan sebagai parameter runtime, tidak disimpan di skrip.

## Deployment

Panduan deployment production untuk web Vercel dan API Railway tersedia di [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

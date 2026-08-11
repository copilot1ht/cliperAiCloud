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

- Aplikasi Electron berada di `C:\Users\USER\Desktop\Cliper Ai Studio`; workspace ini adalah control plane Cloud yang terpisah.
- Workspace ini tidak ikut ke paket Electron/ASAR.
- Desktop dapat memakai endpoint OpenAI-compatible `POST /v1/chat/completions` melalui mode Custom AI yang sudah ada.
- Provider key hanya disimpan di server. Jangan pernah memasukkannya ke Electron atau `NEXT_PUBLIC_*`.

## Ownership production

- Web production dilayani oleh Vercel pada `https://www.cliperaicloud.online`.
- API production dilayani oleh Railway; Vercel meneruskan request browser melalui
  route same-origin `/cloud-api` menggunakan `CLIPER_API_URL` server-side.
- Railway hanya menjalankan API dan PostgreSQL. Video, transkripsi, dan render
  tetap berjalan lokal di aplikasi Electron.
- Jangan menaruh kredensial database, payment, maupun provider AI pada variable
  `NEXT_PUBLIC_*` atau bundle browser.

## Menjalankan lokal

Prasyarat inti: Node.js 20.19+ LTS dan pnpm 10.34.5. Docker Desktop sangat
disarankan untuk PostgreSQL/Redis lokal, tetapi bootstrap tetap selesai dengan
peringatan ketika Docker belum terpasang atau daemon belum berjalan. Desktop
tetap memproses video/render lokal; Cloud hanya melayani akun, lisensi, billing,
dan AI gateway.

Persiapan pertama kali dari folder ini:

```powershell
pnpm install
if (-not (Test-Path .env)) { pnpm env:local }
# Jalankan bila Docker Desktop tersedia dan sedang hidup.
docker compose up -d postgres redis
pnpm db:generate
pnpm exec prisma migrate deploy
pnpm config:check
```

Starter Desktop juga menjalankan `pnpm accounts:sync-bootstrap` setelah migration
di local development. Perintah ini membuat atau memperbarui satu super admin dari
`DEV_ADMIN_EMAIL` dan hash Argon2id di `.env`, tanpa menyimpan password plaintext
di database log atau source code.

Secara default bootstrap lokal membuat admin `admin@cliperaicloud.com`. Masukkan
password baru minimal 12 karakter saat `pnpm env:local` meminta input; password
lama atau password yang pernah dibagikan tidak digunakan ulang.

Untuk pemakaian harian, jalankan seluruh stack dari root Electron:

```powershell
cd "C:\Users\USER\Desktop\Cliper Ai Studio"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm run start:local-cloud
```

Tanpa membuka Electron:

```powershell
npm run start:local-cloud -- -NoElectron
```

Hentikan API, web, dan Electron yang dibuat starter:

```powershell
cd "C:\Users\USER\Desktop\Cliper Ai Studio"
npm run stop:local-cloud
```

Jika Docker belum tersedia, `pnpm env:local` tetap membuat `.env`, memeriksa
Node/pnpm/Prisma, dan menandai database/Redis sebagai `WARNING` atau `SKIPPED`.
Pasang atau hidupkan Docker Desktop kemudian jalankan kembali
`docker compose up -d postgres redis`, lalu `pnpm exec prisma migrate deploy`
sebelum menyalakan API dengan persistence PostgreSQL.

Untuk debugging manual, jalankan `pnpm dev:api` dan `pnpm dev:web` pada dua
terminal berbeda. Endpoint desktop lokal selalu
`http://127.0.0.1:4100/v1`, bukan URL provider AI langsung.

Mode berikut hanya untuk eksperimen singkat. Data billing tersimpan di memori dan
hilang ketika API direstart:

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

- Web: `http://127.0.0.1:3000`
- Login dan pendaftaran: `http://127.0.0.1:3000/login`
- API live health: `http://127.0.0.1:4100/health/live`
- API readiness: `http://127.0.0.1:4100/health/ready`
- Electron endpoint: `http://127.0.0.1:4100/v1`

### Halaman admin lokal

Gunakan satu halaman login yang sama. Account dengan role `admin` otomatis diarahkan ke control plane; member otomatis diarahkan ke dashboard user.

- Overview: `http://127.0.0.1:3000/admin/overview`
- Users & Plans: `http://127.0.0.1:3000/admin/users`
- Providers dan server-side key pool: `http://127.0.0.1:3000/admin/providers`
- AI Router primary/fallback: `http://127.0.0.1:3000/admin/ai-router`
- Revenue dan AI margin: `http://127.0.0.1:3000/admin/revenue`
- Incoming payments dan reconciliation: `http://127.0.0.1:3000/admin/payments`
- System Health: `http://127.0.0.1:3000/admin/system-health`
- Security events dan desktop sessions: `http://127.0.0.1:3000/admin/security`

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

Wallet user memakai USD mikro; QRIS hanya menagih snapshot IDR setiap invoice.
Nilai wallet, kurs, biaya layanan, dan kode unik dicatat terpisah agar rekonsiliasi
payment tetap tepat. Akun baru memulai dengan saldo $0.00; pemrosesan dan key baru aktif
setelah top-up tervalidasi. Request duplikat memakai provider request ID
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

## Distribusi aplikasi desktop

Jangan membuat repository source menjadi public hanya agar file EXE dapat diunduh.
Gunakan repository public khusus binary, misalnya
`copilot1ht/cliper-studio-releases`, atau bucket Cloudflare R2. Upload hanya:

```text
Cliper-Studio-Plus-Setup.exe
Cliper-Studio-Plus-Portable.exe
SHA256SUMS.txt
```

Setelah asset release tersedia pada tag seperti `v1.11.0-beta.1`, buka
`Admin > App releases` di Cliper AI Cloud. Tambahkan versi, URL HTTPS publik
untuk Setup/Portable/checksum, lalu ubah status menjadi `Published`.

Katalog release disimpan di PostgreSQL. Hanya release `Published` dengan minimal
satu URL asset yang muncul pada halaman `Download app` untuk semua user. Dengan
begitu binary dapat diperbarui per versi tanpa mengubah environment Vercel atau
mengarahkan user ke URL 404.
# Cliper AI Cloud

## Operations

- [Encrypted backup and Railway migration](docs/BACKUP_AND_RAILWAY_MIGRATION.md)

# Cliper Studio Plus

Desktop app untuk menganalisa link YouTube, mencari moment terbaik, lalu merender clip pendek.

## Arsitektur Local-First

Cliper Studio Plus memproses download, transkripsi, analisis visual, subtitle,
camera plan, dan render MP4 di PC pengguna. Cliper AI Cloud hanya menangani
akun, lisensi, billing, serta keputusan AI berbasis shortlist teks. Batas
lengkap Desktop dan Cloud dijelaskan di `docs/LOCAL_FIRST_ARCHITECTURE.md`.

## Panduan Pengguna

Panduan instalasi, spesifikasi PC, Custom AI, cookies, subtitle, render, dan troubleshooting tersedia di:

```text
docs/PANDUAN_PENGGUNA.md
```

Persiapan runtime cepat:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-runtime.ps1 -InstallPython -InstallFFmpeg -InstallNode
```

Atau buka aplikasi dan klik `Settings > System > Siapkan sistem`.
Installer akan melewati dependency yang sudah tersedia, memasang Python, FFmpeg,
Node.js, dan library worker yang belum ada, lalu memvalidasi runtime.

## Rilis Desktop

Setiap `npm run build` menghasilkan Setup, Portable, checksum, dan folder rilis yang siap diunggah. Jalankan rilis terbaru dari folder `dist/release`:

```powershell
cd "C:\Users\USER\Desktop\Cliper Ai Studio\dist\release\Cliper-Studio-Plus-<version>"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& ".\Cliper-Studio-Plus-Portable-<version>.exe"
```

```text
dist/release/Cliper-Studio-Plus-<version>/
  Cliper-Studio-Plus-Portable-<version>.exe
  Cliper-Studio-Plus-Setup-<version>.exe
  SHA256SUMS.txt
  RELEASE.txt
```

Unggah Setup, Portable, dan `SHA256SUMS.txt` dari folder tersebut ke Google Drive tanpa mengganti nama file.

## Pengembangan Lokal Lengkap

Struktur development terdiri dari empat service:

```text
PostgreSQL + Redis  -> Docker, port 5432 dan 6379
Cloud API           -> NestJS, http://127.0.0.1:4100
Cloud Web           -> Next.js, http://127.0.0.1:3000
Desktop             -> Electron, endpoint http://127.0.0.1:4100/v1
```

### Persiapan pertama kali

Gunakan Node.js `20.19+` (Node.js 22 LTS direkomendasikan), pnpm
`10.34.5`, Docker Desktop, Python, dan FFmpeg. Dari PowerShell:

```powershell
cd "C:\Users\USER\Desktop\Cliper Ai Studio"

npm install
corepack enable
corepack prepare pnpm@10.34.5 --activate

$cloudRoot = "C:\Users\USER\Desktop\Cliper Ai Cloud"
Push-Location $cloudRoot
pnpm install
if (-not (Test-Path ".env")) { pnpm env:local }
docker compose up -d postgres redis
Pop-Location
```

Jangan memasukkan provider key ke Electron atau variable `NEXT_PUBLIC_*`.
Provider DeepSeek/OpenAI/Gemini ditambahkan dari halaman admin setelah Cloud
berjalan. `pnpm env:local` meminta password admin lokal dan membuat secret acak;
file `.env` lokal tidak boleh di-commit. Saat starter menjalankan migration, ia
menyinkronkan akun admin lokal ke PostgreSQL memakai hash tersebut, sehingga
login tidak lagi gagal karena akun hanya ada di `.env`.

### Mulai semua service dengan satu perintah

Jalankan dari root project:

```powershell
cd "C:\Users\USER\Desktop\Cliper Ai Studio"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm run start:local-cloud
```

Starter akan memeriksa PostgreSQL, menjalankan Prisma generate/migration,
menyalakan API, menunggu health check, menyalakan frontend, lalu membuka
Electron. Untuk menjalankan web dan API tanpa Electron:

```powershell
npm run start:local-cloud -- -NoElectron
```

Jika Anda sebelumnya menjalankan Cloud dari folder legacy `WEB PRODUCTION SAAS`,
buat konfigurasi Cloud kanonis lebih dulu lalu gunakan opsi berikut. Opsi ini
hanya menghentikan process `node.exe` yang command line-nya berasal dari folder
legacy, bukan process Node lain di PC:

```powershell
npm run start:local-cloud -- -StopLegacy
```

URL development:

| Komponen | URL |
| --- | --- |
| Frontend dan login | `http://127.0.0.1:3000` |
| API live health | `http://127.0.0.1:4100/health/live` |
| API readiness | `http://127.0.0.1:4100/health/ready` |
| Endpoint Electron | `http://127.0.0.1:4100/v1` |

### Menjalankan service secara terpisah

Gunakan cara ini saat perlu melihat error frontend/backend secara terpisah.

Terminal 1 - API:

```powershell
cd "C:\Users\USER\Desktop\Cliper Ai Cloud"
pnpm db:generate
pnpm exec prisma migrate deploy
pnpm dev:api
```

Terminal 2 - frontend:

```powershell
cd "C:\Users\USER\Desktop\Cliper Ai Cloud"
pnpm dev:web
```

Terminal 3 - Electron:

```powershell
cd "C:\Users\USER\Desktop\Cliper Ai Studio"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:CLIPER_CLOUD_URL = "http://127.0.0.1:4100/v1"
npm start
```

### Menghubungkan Electron ke Cloud lokal

1. Buka `http://127.0.0.1:3000/login` dan masuk sebagai admin.
2. Di `Admin > Providers`, tambahkan provider key, klik Test API, lalu Simpan.
3. Atur primary/fallback di `Admin > AI Router` bila diperlukan.
4. Masuk sebagai user dan buat key `clip_sk_*` di menu API Keys.
5. Buka `Settings > API` pada Electron.
6. Isi endpoint `http://127.0.0.1:4100/v1`, API key `clip_sk_*`, dan model `auto`.
7. Klik `Hubungkan & Test Cloud` sampai status Cloud dan AI Router aktif.

Pada `AUTH_STORAGE=memory` atau `LICENSE_STORAGE=memory`, restart API akan
menghapus session dan key lokal. Login lalu buat `clip_sk_*` baru. Untuk data
yang bertahan setelah restart, gunakan storage PostgreSQL sesuai dokumentasi
Cloud.

### Log, pemeriksaan, dan menghentikan service

Log starter tersedia di:

```text
C:\Users\USER\Desktop\Cliper Ai Cloud\.runtime-logs\api.log
C:\Users\USER\Desktop\Cliper Ai Cloud\.runtime-logs\web.log
C:\Users\USER\Desktop\Cliper Ai Cloud\.runtime-logs\electron.log
```

Periksa port dan health:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3000,4100,5432,6379
Invoke-RestMethod http://127.0.0.1:4100/health/live
(Invoke-WebRequest http://127.0.0.1:3000 -UseBasicParsing).StatusCode
```

Hentikan proses API, web, dan Electron yang dibuat starter:

```powershell
npm run stop:local-cloud
```

Hentikan PostgreSQL dan Redis Docker tanpa menghapus volume data:

```powershell
docker compose -f "C:\Users\USER\Desktop\Cliper Ai Cloud\docker-compose.yml" stop
```

Jika port sudah dipakai proses lain, lihat PID dengan perintah pemeriksaan port
di atas. Jangan memakai `https://api.deepseek.com` sebagai endpoint Electron;
Electron hanya memakai Cliper Cloud lokal `http://127.0.0.1:4100/v1`.

### QA dan build ulang

```powershell
npm run qa
npm run build -- --publish never
```

Release build:

```bash
npm run build
```

Artifact rilis tersedia di `dist\release\Cliper-Studio-Plus-<version>\`.
Folder tersebut berisi Portable, installer Windows, checksum SHA-256, dan catatan upload.

Build release memakai ASAR packaging. Source UI dan brand asset utama masuk ke `app.asar`; worker Python tetap di-unpack agar bisa dieksekusi lokal. Logo render dibuat sebagai runtime copy dari brand asset di ASAR ke folder userData saat aplikasi berjalan.

QA render tidak lagi memakai video subtitle sintetis lama sebagai acuan. Jalankan
benchmark pada source nyata yang sudah memiliki cache analisis:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\qa-real-render.ps1 `
  -SourceCacheDir "$env:LOCALAPPDATA\Cliper Studio Plus\cache\sources\<video-id>"
```

Runner memilih kandidat berdurasi wajar, membuat ulang subtitle dari audio clip,
menjalankan Camera Director, lalu memvalidasi stream, durasi, dan resolusi MP4
dengan `ffprobe`.

## Release Notes

- Build candidate terbaru: `v1.11.1` (jalankan validasi render lokal sebelum dipublikasikan sebagai stable)
- Fixed: AI selection no longer stops at one clip, long camera shots are split into short director decisions, and long subtitles are no longer capped at 32 events.
- Added: evidence-gated score calibration, cached audio activity evidence, compact Moment AI grid with review drawer, and subtitle timeline validation before FFmpeg render.
- Removed: Quick Editor offline page and its Electron file-picker IPC.
- Tested: dependency scan nyata, 173 automated tests, render lokal 60 detik dengan subtitle terbakar, camera director, H.264/AAC, dan validasi MP4.

## Status Real Pipeline

Yang sudah nyata:

- Electron desktop app dengan Python worker lokal
- Cek dependency runtime dari aplikasi
- Ambil metadata YouTube memakai `yt-dlp`
- Ambil subtitle/automatic caption jika tersedia
- Cari moment terbaik dari subtitle/chapter dengan scoring heuristic
- Cookies Manager produksi di Settings
- Validasi `cookies.txt` format Netscape, domain YouTube/Google, dan cookie login penting
- Auto detect: video publik dicoba tanpa cookies, lalu retry otomatis memakai cookies jika login/age/private/region meminta autentikasi
- Pilih folder output lewat dialog desktop
- Render clip terpilih lewat FFmpeg jika FFmpeg tersedia
- Output utama user hanya MP4
- File internal seperti SRT/JSON/session disimpan di `.cliper-internal`

## Arsitektur Local Opus-Like

Dokumen ekosistem local-first ada di:

```text
docs/OPUS_LIKE_LOCAL_ECOSYSTEM.md
```

Fokus utama V1.10.0 beta:

- Moment AI anti-overlap
- Story complete scoring
- Local-first render
- AI provider optional
- Conversation-aware face crop untuk 2-4 orang
- GPU auto detect dengan CPU fallback

Dependency runtime pengguna:

- Python x64 dan paket pada `requirements-runtime.txt`
- FFmpeg/FFprobe full build di PATH
- Node.js 22+ direkomendasikan untuk challenge YouTube
- OpenAI SDK ikut dipasang untuk kompatibilitas, sedangkan Custom AI request utama menggunakan adapter HTTP internal

## Cara Pakai

1. Buka `.exe`.
2. Masukkan link YouTube.
3. Atur jumlah rekomendasi dan durasi target. Nilai `0` berarti tampilkan semua rekomendasi yang lolos quality gate, anti-overlap, dan diversity filter; masukkan angka positif untuk membatasi hasil.
4. Jika video butuh login/age/restricted, pilih `cookies.txt`.
5. Klik `Cari moment terbaik`.
6. Pilih moment yang ingin dirender.
7. Pilih folder output di Settings.
8. Klik `Render pilihan`.

## Cookies Manager

Buka `Settings -> Cookies Manager` untuk import, ganti, hapus, dan test `cookies.txt`.

Cookies hanya dibutuhkan untuk video yang login required, age restricted, member only, region locked, private playlist yang bisa diakses akun, atau video yang butuh autentikasi. Video publik biasa diproses tanpa cookies.

Aplikasi hanya menyimpan lokasi file cookies di config lokal, bukan isi cookies:

```json
{
  "cookies_path": "C:\\path\\cookies.txt",
  "cookies_last_import": "2026-06-25T00:00:00.000Z",
  "cookies_last_test": "2026-06-25T00:00:00.000Z",
  "cookies_status": "Cookies Loaded"
}
```

Disarankan export ulang cookies setiap sekitar 1 minggu atau setelah logout/login ulang, browser update, atau Google refresh session.

## Output

Setiap render membuat folder session berisi output utama:

- clip hasil render `.mp4`

File pendukung internal disimpan di:

```text
.cliper-internal/
```

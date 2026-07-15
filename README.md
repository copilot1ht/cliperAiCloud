# Cliper Studio Plus

Desktop app untuk menganalisa link YouTube, mencari moment terbaik, lalu merender clip pendek.

## Panduan Pengguna

Panduan instalasi, spesifikasi PC, Custom AI, cookies, subtitle, render, dan troubleshooting tersedia di:

```text
docs/PANDUAN_PENGGUNA.md
```

Persiapan runtime cepat:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-runtime.ps1 -InstallFFmpeg
```

Setelah selesai, buka aplikasi dan jalankan `Settings > Runtime > Check ulang`.

## Test App

Jalankan beta terbaru:

```powershell
cd "C:\Users\USER\Desktop\Cliper Ai Studio\dist-beta3"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& ".\Cliper-Studio-Plus-Portable.exe"
```

```text
dist-beta3/Cliper-Studio-Plus-Portable.exe
dist-beta3/Cliper-Studio-Plus-Setup.exe
```

Development:

```bash
npm start
```

Build ulang:

```bash
npm run build
```

Release build:

```bash
npm run build
```

Artifact beta.3 tervalidasi tersedia di `dist-beta3\Cliper-Studio-Plus-Portable.exe`.
Installer Windows beta.3 tersedia di `dist-beta3\Cliper-Studio-Plus-Setup.exe`.

Build release memakai ASAR packaging. Source UI dan brand asset utama masuk ke `app.asar`; worker Python tetap di-unpack agar bisa dieksekusi lokal. Logo render dibuat sebagai runtime copy dari brand asset di ASAR ke folder userData saat aplikasi berjalan.

## Release Notes

- Versi pre-release: `v1.10.0-beta.3`
- Fixed: AI selection no longer stops at one clip, long camera shots are split into short director decisions, and long subtitles are no longer capped at 32 events.
- Added: evidence-gated score calibration, cached audio activity evidence, compact Moment AI grid with review drawer, and subtitle timeline validation before FFmpeg render.
- Removed: Quick Editor offline page and its Electron file-picker IPC.
- Tested: 51-minute highlight cache, real three-face camera analysis, 120-second subtitle coverage, local audio-first render, MP4 validation, and automated QA manifest.

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
3. Pilih jumlah clip dan durasi target.
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

# Cliper YouTube AI Studio

Desktop app untuk menganalisa link YouTube, mencari moment terbaik, lalu merender clip pendek.

## Test App

Jalankan:


cd "C:\Users\USER\Desktop\Cliper Ai Studio\dist"
& ".\Cliper YouTube AI Studio.exe"

```text
dist/Cliper YouTube AI Studio.exe
```

Development:

```bash
npm start
```

Build ulang:

```bash
npm run build
```

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

Dependency saat ini:

- Python: tersedia
- `yt-dlp`: tersedia
- OpenAI SDK: tersedia
- FFmpeg/FFprobe: harus dipasang/ditambahkan ke PATH agar render MP4 berjalan

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

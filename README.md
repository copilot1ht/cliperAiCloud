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
- Pilih cookies.txt lewat dialog desktop
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

## Output

Setiap render membuat folder session berisi output utama:

- clip hasil render `.mp4`

File pendukung internal disimpan di:

```text
.cliper-internal/
```

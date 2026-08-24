# Panduan Pengguna Cliper Studio Plus

Versi panduan: 1.11.0
Platform: Windows 10/11 64-bit

Panduan ini menjelaskan persiapan PC, instalasi dependency, konfigurasi Custom AI, pencarian highlight, subtitle, render, cookies, dan troubleshooting.

## 1. Fungsi Aplikasi

Cliper Studio Plus menerima URL YouTube lalu menjalankan pipeline berikut:

1. Membaca metadata dan subtitle YouTube.
2. Mengunduh serta menyimpan source video di cache lokal.
3. Membuat story candidate dan ranking highlight.
4. Meminta Custom AI memilih kandidat jika API dikonfigurasi.
5. Menampilkan Moment AI untuk review.
6. Membuat crop speaker, subtitle word highlight, dan video enhancement.
7. Mengekspor MP4, caption, metadata, thumbnail, dan log validasi.

Custom AI bersifat opsional. Tanpa API, aplikasi tetap berjalan memakai local heuristic, tetapi judul dan pemahaman transcript campuran biasanya lebih terbatas.

## 2. Spesifikasi PC

### Minimum untuk video pendek/720p

| Komponen | Minimum |
| --- | --- |
| OS | Windows 10 64-bit |
| CPU | 4 core / 8 thread, Intel Core i5 generasi 8 atau Ryzen 5 2600 setara |
| RAM | 8 GB |
| GPU | Opsional; render memakai CPU jika GPU encoder tidak tersedia |
| Storage | SSD dengan ruang kosong minimal 15 GB |
| Internet | Stabil, minimal 10 Mbps |
| Display | 1366x768 |

Pada spesifikasi minimum, gunakan 720p, 30 FPS, jumlah clip sedikit, dan tutup aplikasi berat lain.

### Rekomendasi untuk 1080p/2K dan podcast panjang

| Komponen | Rekomendasi |
| --- | --- |
| OS | Windows 11 64-bit terbaru |
| CPU | 6-8 core / 12-16 thread, Core i5/i7 modern atau Ryzen 5/7 modern |
| RAM | 16 GB; 32 GB untuk video 60 menit atau lebih |
| GPU | NVIDIA GTX 1650/RTX, AMD RX, atau Intel Arc dengan encoder H.264 |
| VRAM | 4 GB minimum, 6-8 GB lebih nyaman |
| Storage | NVMe/SSD dengan 30-50 GB ruang kosong |
| Internet | 25 Mbps atau lebih |
| Display | 1920x1080 |

GPU tidak wajib. GPU membantu encoding NVENC/AMF/QSV, sedangkan subtitle faster-whisper saat ini default ke CPU INT8 agar kompatibel luas.

## 3. Yang Harus Dipasang

Aplikasi EXE sudah membawa UI Electron dan worker project, tetapi runtime berikut harus tersedia di Windows:

1. Python x64.
2. Paket Python dalam `requirements-runtime.txt`.
3. FFmpeg dan FFprobe di PATH.
4. Node.js 22 atau lebih baru direkomendasikan untuk challenge JavaScript YouTube terbaru.
5. Driver GPU terbaru jika ingin memakai NVENC, AMF, atau QSV.
6. Microsoft Visual C++ Redistributable 2015-2022 x64 jika library Python gagal dimuat.

Versi yang diuji pada mesin pengembangan:

```text
Python 3.14.4
yt-dlp 2026.3.17
faster-whisper 1.2.1
OpenCV 4.10.0.84
MediaPipe 0.10.35
OpenAI SDK 2.41.1
FFmpeg/FFprobe 8.1.1 full build
Node.js 24
```

Python 3.11 atau 3.12 x64 tetap menjadi pilihan konservatif untuk kompatibilitas wheel pihak ketiga. Jangan memakai Python 32-bit.

## 4. Instalasi Runtime Windows

### A. Python

1. Unduh Python/Windows Install Manager dari `https://www.python.org/downloads/windows/`.
2. Install runtime Python x64.
3. Pastikan perintah `python` tersedia di terminal.

Verifikasi:

```powershell
python --version
python -m pip --version
```

### B. Paket Python

Buka PowerShell pada folder aplikasi, lalu jalankan:

```powershell
python -m pip install --upgrade pip
python -m pip install --user -r requirements-runtime.txt
```

Atau gunakan helper:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-runtime.ps1 -InstallPython -InstallFFmpeg -InstallNode
```

Cara paling mudah pada PC baru adalah membuka `Settings > Plugin & Runtime`,
lalu klik `Install otomatis`. Aplikasi memasang Python, FFmpeg, Node.js, dan
library worker yang belum tersedia. Setelah selesai, klik `Check ulang`.

### C. FFmpeg dan FFprobe

Cara praktis melalui WinGet:

```powershell
winget install --id Gyan.FFmpeg --exact
```

Setelah instalasi, tutup dan buka kembali terminal. Verifikasi:

```powershell
ffmpeg -version
ffprobe -version
```

Jika instalasi manual, tambahkan folder yang berisi `ffmpeg.exe` dan `ffprobe.exe` ke environment variable `PATH`.

### D. Node.js

Install Node.js 22 LTS atau lebih baru dan pastikan tersedia di PATH:

```powershell
node --version
```

Node tidak dipakai untuk memproses video, tetapi membantu yt-dlp menyelesaikan challenge JavaScript YouTube tertentu.

### E. Verifikasi dari Aplikasi

1. Buka Cliper Studio Plus.
2. Masuk ke `Settings`.
3. Pilih tab `Runtime`.
4. Klik `Check ulang`.
5. Pastikan Python, yt-dlp, FFmpeg, FFprobe, faster-whisper, dan OpenCV terbaca.

## 5. Menjalankan Aplikasi

Portable:

```text
Cliper-Studio-Plus-Portable.exe
```

Installer:

```text
Cliper-Studio-Plus-Setup.exe
```

Windows SmartScreen dapat memberi peringatan karena build beta belum memiliki sertifikat Authenticode. Pastikan checksum EXE cocok dengan `SHA256SUMS.txt` sebelum menjalankan.

## 6. Konfigurasi Pertama yang Direkomendasikan

Di halaman Studio:

```text
Jumlah rekomendasi: 0 untuk semua rekomendasi layak, atau 3-6 untuk proses cepat
Durasi minimum    : 30 detik
Durasi target     : 60-75 detik
Durasi maksimum   : 120 detik
Format            : 9:16 YouTube Shorts
Resolusi          : 1080p
FPS               : 30 FPS
Quality           : Balanced 1080p
Subtitle          : Aktif
Word Highlight    : Aktif
Smart Crop        : Aktif
GPU Acceleration  : Aktif jika encoder terdeteksi
```

Untuk PC minimum, gunakan 720p dan 30 FPS. Jangan memilih 2K/60 FPS untuk batch besar pada RAM 8 GB.

## 7. Custom AI

Custom AI menerima provider yang kompatibel dengan OpenAI Chat Completions atau Responses API.

1. Buka `Settings > API`.
2. Pilih `Custom / OpenAI Compatible`.
3. Isi Base URL, API key, dan nama model.
4. Klik `Load Models`. Jika provider tidak menyediakan endpoint model, ketik model manual.
5. Klik `Test API` hingga status `Connected`.

Contoh bentuk Base URL:

```text
https://provider.example/v1
https://provider.example/v1/chat/completions
https://provider.example/v1/responses
```

Highlight memakai timeout lebih panjang dan beberapa batch story. Jika provider timeout, rate limited, atau mengembalikan JSON rusak, aplikasi melakukan retry lalu memakai fallback lokal bila perlu.

Sesudah analisis, periksa log:

```text
[ai diagnostics] used=true/false
[ai debug] lokasi ai-debug-log.json
```

`used=false` berarti kandidat terutama berasal dari local heuristic. Ganti model/provider atau periksa endpoint jika kualitas semantik kurang baik.

Jangan membagikan API key. Key disimpan pada konfigurasi lokal komputer pengguna.

## 8. Cookies YouTube

Video publik biasanya tidak membutuhkan cookies. Gunakan cookies hanya untuk video yang memang dapat diakses akun Anda tetapi meminta login, age verification, region, playlist private, atau membership.

1. Export cookies dalam format Netscape `cookies.txt` memakai metode tepercaya.
2. Buka `Settings > Cookies Manager`.
3. Import file.
4. Klik `Test Cookies`.

Jangan mengirim `cookies.txt` kepada orang lain. File tersebut dapat berisi sesi login akun.

## 9. Alur Kerja Render

1. Salin URL YouTube.
2. Tempel URL pada halaman Studio.
3. Atur jumlah dan durasi clip.
4. Klik `Cari moment terbaik`.
5. Tunggu metadata, source cache, story detection, ranking, dan AI selesai.
6. Buka halaman Moment AI.
7. Gunakan search, quality filter, transcript, evidence, dan preview untuk review.
8. Centang hanya moment yang relevan.
9. Klik `Render pilihan`.
10. Tunggu validasi subtitle dan MP4 selesai.
11. Buka halaman Output atau folder session.

Score bukan jaminan viral. Gunakan score sebagai alat ranking, lalu cek transcript, hook, payoff, dan batas awal/akhir clip sebelum render massal.

## 10. Subtitle

Subtitle default dibuat ulang dari audio clip menggunakan faster-whisper model `small`, word timestamps, dan ASS word highlight.

Pada pemakaian pertama, model akan diunduh ke cache Hugging Face. Proses pertama bisa lebih lama dan membutuhkan internet serta ruang disk tambahan.

Style produksi:

```text
Maksimum 2 baris
Word highlight aktif
Warna dasar putih
Kata aktif hijau
Outline hitam
Shadow ringan
Letter spacing ringan dan adaptif terhadap resolusi
```

Renderer memvalidasi coverage dan timestamp ASS sebelum MP4 diterima. Jika validasi gagal, subtitle diregenerasi sekali; render dihentikan dengan pesan jelas jika mismatch tetap terjadi.

## 11. Output dan Cache

Folder output session berisi:

```text
Video Original\
Clip\
Caption\
Metadata\
XML\
Thumbnail\
.cliper-internal\
```

Cache source berada di:

```text
%LOCALAPPDATA%\Cliper Studio Plus\cache
```

Konfigurasi aplikasi berada di:

```text
%APPDATA%\Cliper Studio Plus\config.json
```

Jangan menghapus cache ketika render sedang berjalan. Cache boleh dibersihkan saat aplikasi tertutup jika ruang disk diperlukan; source akan diunduh ulang.

## 12. Troubleshooting

### FFmpeg belum tersedia

Pastikan `ffmpeg -version` dan `ffprobe -version` berhasil dari PowerShell. Restart aplikasi setelah mengubah PATH.

### yt-dlp error atau metadata gagal

Update runtime:

```powershell
python -m pip install --user --upgrade "yt-dlp[default]"
```

Pastikan Node.js tersedia. Gunakan cookies hanya jika YouTube memang meminta autentikasi.

### faster-whisper belum tersedia

```powershell
python -m pip install --user --upgrade faster-whisper
```

Jika model pertama kali sedang diunduh, tunggu sampai selesai dan pastikan antivirus/firewall tidak memblokir Python.

### AI Connected tetapi hasil fallback lokal

Periksa `ai-debug-log.json`. Penyebab umum: SSL timeout, rate limit, model salah, response kosong, endpoint bukan OpenAI-compatible, atau JSON provider tidak valid.

### Moment AI kosong

Pastikan transcript ditemukan. Kandidat dengan score rendah dapat tampil sebagai Optional; jika benar-benar kosong, periksa log story detection dan subtitle.

### Render lambat

Gunakan 720p/30 FPS, kurangi jumlah clip, aktifkan GPU encoder, gunakan SSD, dan tutup aplikasi lain. Heavy 4K Look otomatis dilewati bila overhead melebihi batas.

### Preview tampak biru tetapi MP4 normal

Ekstrak atau buka MP4 pada player lain. Output ditandai YUV420P BT.709. Update driver GPU dan matikan overlay/Instant Replay untuk membandingkan hasil capture.

### Subtitle tidak muncul

Pastikan `addCaptions` aktif, faster-whisper tersedia, audio source valid, dan log `Subtitle Validation` menunjukkan PASS.

## 13. Keamanan dan Hak Cipta

Gunakan hanya video yang Anda miliki atau boleh Anda olah. Aplikasi tidak memberikan hak atas video sumber. Review hasil, attribution, konteks, dan kebijakan platform sebelum upload.

API key, cookies, transcript, source cache, serta output disimpan lokal. Jangan membagikan folder konfigurasi atau `.cliper-internal` jika berisi data sensitif.

## 14. Checklist Siap Pakai

Sebelum project pertama:

- Python dan pip terdeteksi.
- Paket `requirements-runtime.txt` terpasang.
- FFmpeg dan FFprobe terdeteksi.
- Node.js tersedia.
- Output folder memiliki ruang cukup.
- Driver GPU terbaru jika memakai GPU.
- Custom AI berstatus Connected, atau sengaja memakai local mode.
- Cookies hanya dimuat jika diperlukan.
- Test satu clip 720p/1080p berhasil sebelum batch besar.
- MP4, audio, subtitle, crop, warna, judul, dan hook diperiksa manual.

## 15. Referensi Resmi

- Python Windows: https://www.python.org/downloads/windows/
- FFmpeg download: https://ffmpeg.org/download.html
- yt-dlp installation: https://github.com/yt-dlp/yt-dlp/wiki/Installation
- yt-dlp EJS: https://github.com/yt-dlp/yt-dlp/wiki/EJS
- faster-whisper: https://github.com/SYSTRAN/faster-whisper

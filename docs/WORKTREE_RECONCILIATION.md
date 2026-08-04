# Cloud Worktree Reconciliation

## Canonical source

Gunakan satu Cloud source tree berikut untuk development, QA, deployment, dan
release berikutnya:

```text
C:\Users\USER\Desktop\Cliper Ai Cloud
```

Desktop tetap berada terpisah di:

```text
C:\Users\USER\Desktop\Cliper Ai Studio
```

## Legacy worktree

Folder berikut adalah worktree legacy dari periode ketika Cloud masih berada di
dalam folder Desktop:

```text
C:\Users\USER\Desktop\Cliper Ai Studio\WEB PRODUCTION SAAS
```

Jangan menjalankan API, web, migration, atau deployment dari worktree legacy.
Folder tersebut dipertahankan sementara sebagai rollback/reference sampai patch
yang dipindahkan ke Cloud kanonis telah melewati QA dan di-commit secara terpisah.

## Batas produk

- **Cliper Ai Studio:** download/cache, transcript, visual evidence, subtitle,
  camera plan, dan render FFmpeg di perangkat pengguna.
- **Cliper Ai Cloud:** akun, `clip_sk_*`, wallet, payment webhook, usage, dan
  AI gateway berbasis shortlist teks.

Cloud tidak menerima video mentah, tidak menjalankan Whisper/FFmpeg, dan tidak
menjadi render farm.

## Local endpoints

```text
Web:      http://127.0.0.1:3000
API:      http://127.0.0.1:4100
Electron: http://127.0.0.1:4100/v1
```

Untuk membuat konfigurasi development aman, jalankan `pnpm env:local` dari
Cloud kanonis sebelum menyalakan stack.

## Transisi dari service legacy

Jika port `3000` atau `4100` masih dipakai oleh process dari folder legacy,
starter Desktop akan berhenti dengan pesan yang jelas. Tutup terminal legacy
atau hentikan hanya process yang command line-nya memuat
`WEB PRODUCTION SAAS`, lalu mulai ulang dari Cloud kanonis. Jangan menjalankan
dua Cloud workspace pada port yang sama.

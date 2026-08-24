# Struktur Cliper AI Studio

```text
C:\Users\USER\Desktop\
|-- Cliper Ai Studio/                    Electron desktop + Python worker + render lokal
|   |-- app.js, index.html, styles.css   UI Electron desktop
|   |-- electron/                        Main process dan preload IPC
|   |-- worker/                          AI, subtitle, camera, highlight, dan render
|   |-- assets/, scripts/, tests/, docs/ Aset, runtime, regression, dan panduan
|   `-- dist/, PC-LAIN-TEST/             Build desktop terbaru dan paket portable
`-- Cliper Ai Cloud/                     Cloud kanonis: Web + API + Prisma
```

## Artefak lokal

Folder berikut merupakan artefak lokal dan tidak menjadi source code:

```text
Local Test Builds/                       Bukti QA terbaru yang dipertahankan
qa-render-output-camera/                 Bukti camera QA yang dirujuk audit V4
```

Output QA/render lama, payload eksperimen, cache Python, log smoke, dan build beta
lama dibersihkan secara berkala. Artefak tersebut sudah tercakup dalam `.gitignore`.

## Aturan batas project

1. Root tetap menjadi aplikasi desktop sampai migrasi ke `apps/desktop` lulus build parity dan smoke test.
2. Cloud tidak boleh diikutkan ke `build.files` Electron.
3. Provider API key hanya berada di Cloud API.
4. Desktop berbicara ke Cloud memakai satu Cliper key dan protokol OpenAI-compatible.
5. Folder `tests/`, `docs/`, `dist/`, dan `PC-LAIN-TEST/` bukan artefak QA lama dan tidak boleh dihapus sebagai bagian cleanup rutin.
6. `WEB PRODUCTION SAAS` adalah worktree legacy sementara; jangan dijalankan atau dihapus sampai rekonsiliasi Git dan QA Cloud kanonis lulus.

Pendekatan ini menjaga release desktop yang sudah berjalan, audit tetap terlacak, dan batas ownership antar aplikasi tetap jelas.

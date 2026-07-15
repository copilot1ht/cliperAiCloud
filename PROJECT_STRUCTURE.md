# Struktur Cliper AI Studio

```text
Cliper Ai Studio/
|-- app.js, index.html, electron/, worker/   Desktop Electron stabil
|-- WEB PRODUCTION SAAS/                    Cliper AI Cloud workspace
|-- docs/                                   Dokumentasi desktop dan audit
|   `-- archive/legacy-blueprints/          Blueprint JSX lama (arsip)
`-- dist*/                                  Artefak build lokal
```

## Aturan batas project

1. Root tetap menjadi aplikasi desktop sampai migrasi ke `apps/desktop` lulus build parity dan smoke test.
2. Cloud tidak boleh diikutkan ke `build.files` Electron.
3. Provider API key hanya berada di Cloud API.
4. Desktop berbicara ke Cloud memakai satu Cliper key dan protokol OpenAI-compatible.
5. Pemindahan desktop ke monorepo dilakukan belakangan, bukan bersamaan dengan pembangunan gateway.

Pendekatan ini menjaga release desktop yang sudah berjalan, tetapi tetap menghasilkan satu repository yang rapi dan memiliki batas ownership jelas.

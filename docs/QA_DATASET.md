# Cliper Studio Plus QA Dataset

Gunakan daftar ini untuk uji manual sebelum commit/release. Targetnya memastikan highlight, caption, crop, audio, dan render stabil pada variasi video nyata.

## Video Test Wajib

1. Podcast 2 orang
   - Validasi: crop mengikuti pembicara aktif, caption sinkron, moment tidak overlap.
2. Podcast 4 orang
   - Validasi: face tracking tidak lompat kasar, center fallback aman saat wajah banyak.
3. Video berita
   - Validasi: highlight memilih konteks utuh, hook tidak clickbait berlebihan.
4. Tutorial
   - Validasi: moment punya setup dan payoff, caption phrase-based mudah dibaca.
5. Komedi/reaksi
   - Validasi: punchline tidak terpotong, ending natural.
6. Musik/live
   - Validasi: audio tetap ikut, caption tidak dipaksa jika subtitle buruk.
7. Video tanpa subtitle
   - Validasi: fallback local render tetap jalan, tidak crash.
8. Video durasi panjang
   - Validasi: kandidat anti-overlap dan tersebar, cache source dipakai ulang.
9. Video low quality
   - Validasi: smart crop aman, output MP4 tetap playable.
10. Video audio kecil
    - Validasi: audio stream tetap terbawa ke output, tidak silent.

## Acceptance Criteria

- App bisa berjalan tanpa API key.
- Jika API key valid, AI hanya meningkatkan ranking/title/hook, bukan syarat render.
- Render default memakai automatic production pipeline.
- Output utama adalah MP4 yang dapat diputar.
- Caption memakai ASS modern, phrase-based, dan active word highlight.
- Hook tidak menumpuk dengan caption yang sama.
- Highlight tidak mengambil timestamp berdekatan untuk jumlah clip yang sama.
- GPU boleh gagal, tetapi CPU fallback harus tetap render.
- Cookies hanya dipakai saat yt-dlp membutuhkan login/age gate.
- Library hanya menampilkan output nyata.

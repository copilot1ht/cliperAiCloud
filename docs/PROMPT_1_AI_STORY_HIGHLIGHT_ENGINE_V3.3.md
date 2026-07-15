# CLIPER AI STUDIO V3.3

# AI STORY ENGINE & HIGHLIGHT PIPELINE

## PRODUCTION REFACTOR — PROMPT 1

## OBJECTIVE

Refactor total sistem pencarian highlight agar menghasilkan clip berkualitas seperti:
- Opus Clip
- Captions AI
- Vizard
- Klap

Tanpa mengubah UI utama.
Tanpa membuat struktur project baru jika file yang ada masih dapat digunakan.
Prioritaskan refactor pada engine yang sudah ada.

---

## CURRENT PROBLEM

Saat ini ditemukan beberapa masalah besar:
- hanya menghasilkan sekitar 6 clip dari video ±1 jam
- judul clip hampir sama
- hook hampir sama
- AI sulit menemukan cerita
- score Hook hampir selalu 99
- score tidak realistis
- banyak clip membahas topik yang sama
- clip saling overlap
- AI hanya membaca sebagian transcript
- AI bekerja satu kali sehingga kualitas rendah

Masalah ini berasal dari Highlight Engine dan Story Engine, bukan dari UI.

---

## DO NOT CHANGE

Jangan mengubah:
- Electron UI
- halaman utama
- workflow user
- render button
- output format
- database
- folder project

Gunakan engine yang sudah ada dan lakukan refactor internal.

---

## CURRENT PIPELINE

Saat ini kira-kira seperti berikut:

```
Download Video
↓
Whisper Transcript
↓
AI
↓
Highlight
↓
Render
```

Pipeline ini terlalu sederhana.

---

## NEW PIPELINE

Ubah menjadi:

```
Download Video
↓
Metadata Extraction
↓
Scene Detection
↓
Audio Analysis
↓
Speaker Timeline
↓
Transcript Cleaning
↓
Topic Detection
↓
Story Segmentation
↓
Emotion Detection
↓
Conflict Detection
↓
Question Detection
↓
Payoff Detection
↓
Candidate Generator
↓
AI Candidate Analysis
↓
Ranking Engine
↓
Diversity Filter
↓
Clip Merge
↓
Title Generator
↓
Metadata Generator
↓
Final Clip List
↓
Render Queue
```

Semua tahap harus saling terhubung.

---

## STEP 1 — VIDEO ANALYSIS

Sebelum AI dipanggil lakukan analisis lokal.

Gunakan informasi:
- transcript
- timestamp
- speaker
- scene
- silence
- laughter
- applause
- music
- face activity
- body activity

Semua menjadi metadata.
Jangan langsung kirim transcript mentah ke AI.

---

## STEP 2 — STORY SEGMENTATION

Jangan membagi berdasarkan waktu.

Salah:
```
00-05 clip
05-10 clip
10-15 clip
```

Benar:
```
Intro
Cerita Mantan
Konflik
Rahasia
Lucu
Penyesalan
Penutup
```

Story Engine harus menemukan perubahan topik.

Gunakan kombinasi:
- semantic similarity
- speaker transition
- keyword density
- emotion shift
- silence
- scene cut

---

## STEP 3 — TOPIC DETECTION

Untuk setiap story buat:
```
Topic
Summary
Keyword
Emotion
Conflict
Payoff
Question
People Mentioned
Location Mentioned
Objects Mentioned
```

Semua menjadi metadata internal.

---

## STEP 4 — MICRO HIGHLIGHT

Setelah story ditemukan.

Cari:
- Hook
- Surprise
- Conflict
- Curiosity
- Punchline
- Emotional Peak
- Funny Moment
- Educational Moment
- Strong Opinion
- Viral Quote
- Call To Action

Bukan hanya kalimat menarik.

---

## STEP 5 — CANDIDATE GENERATOR

Jangan langsung memilih clip.

Generate sebanyak mungkin kandidat.

Target:
- Video 60 menit
- Minimal 40-80 candidate
- Bukan 6 clip

---

## STEP 6 — CANDIDATE SCORE

Setiap candidate mempunyai score dengan bobot realistis.

```
Hook                  18%
Story Continuity      18%
Conflict              12%
Emotion               12%
Payoff                15%
Retention             10%
Speaker Energy         5%
Visual Activity        5%
Novelty                5%
SEO Potential          5%
```

Total: 100%

---

## STEP 7 — SCORE NORMALIZATION

Jangan menghasilkan:
```
Hook 99
Hook 99
Hook 99
```

Normalisasikan.
Sebaran alami.

Contoh:
```
67
72
81
85
88
91
95
97
```

---

## STEP 8 — DIVERSITY FILTER

Jika dua candidate memiliki Topic Similarity lebih dari 0.75, berikan penalty.

Misalnya:
```python
final_score -= 20
```

Tujuan: AI tidak memilih topik sama terus.

---

## STEP 9 — OVERLAP FILTER

Jika:
- Clip A: 10:00-11:30
- Clip B: 10:40-12:00

Maka: merge atau pilih score terbaik.
Tidak boleh dua-duanya lolos.

---

## STEP 10 — MULTI PASS AI

Jangan hanya satu request AI.

Pipeline:
```
Pass 1 → Candidate Analysis
↓
Pass 2 → Ranking
↓
Pass 3 → Rewrite
↓
Final Selection
```

---

## STEP 11 — TITLE GENERATOR

Judul dibuat setelah clip final dipilih.

Pipeline:
```
Clip
↓
Summary
↓
Emotion
↓
Conflict
↓
Keyword
↓
SEO
↓
AI Rewrite
↓
Final Title
```

### TITLE RULE

Tidak boleh:
```
Sisi Lain Adem
Sisi Lain Adem
Sisi Lain Adem
```

Harus:
```
Adem Bongkar Rahasia yang Selama Ini Disembunyikan
Kenapa Adem Sampai Tidak Percaya Hal Ini
Cerita yang Membuat Adem Menyesal
Kesalahan Besar yang Baru Diakui Adem
Momen yang Membuat Semua Orang Terdiam
```

Semua unik.

---

## STEP 12 — METADATA AI

Generate otomatis:

### YouTube
- title
- description
- hashtags

### TikTok
- hook
- caption

### Facebook
- caption

### Instagram
- caption

Semua berdasarkan isi clip.

---

## STEP 13 — AI CONTEXT

AI jangan menerima transcript penuh.

AI menerima:
- Story Summary
- Topic
- Emotion
- Conflict
- Keyword
- Payoff
- Timestamp
- Candidate

Ini jauh lebih hemat token.

---

## STEP 14 — LOCAL PREPROCESS

Semua proses berikut dilakukan lokal:
- transcript cleaning
- filler removal
- silence detection
- duplicate sentence removal
- topic grouping
- sentence embedding
- semantic similarity

AI hanya dipakai untuk reasoning.

---

## STEP 15 — PERFORMANCE

AI tidak boleh dipanggil untuk:
- setiap kalimat
- setiap kata

Gunakan batching.

Target: Mengurangi penggunaan token.

---

## STEP 16 — FALLBACK

Jika AI gagal.
Gunakan: Local Highlight Engine.
Output tetap tersedia.

---

## STEP 17 — CACHE

Cache:
- Transcript
- Embedding
- Topic
- Story
- Summary
- Candidate

Jika user render ulang, tidak perlu analisis dari awal.

---

## STEP 18 — LOGGING

Setiap stage memiliki log.

Contoh:
```
Story Detection
12 Story ditemukan

Topic Detection
18 Topic

Candidate
63 Candidate

Ranking
18 Candidate

Merge
12 Candidate

Rewrite
10 Final Clip
```

Memudahkan debugging.

---

## STEP 19 — QA

Engine harus lulus:
- Video 15 menit
- Video 30 menit
- Video 1 jam
- Podcast
- Interview
- Music Talk
- Gaming
- Reaction
- Vlog
- Seminar

---

## TARGET OUTPUT

Video: 1 jam

Target:
```
Story: 12-25
↓
Candidate: 40-80
↓
AI Ranking: 20
↓
Final Clip: 10-20
```

Bukan:
```
1 jam → 6 clip
```

---

## EXISTING FILES TO IMPROVE

Fokus refactor file yang sudah ada:
```
worker/highlight_engine.py
worker/story_engine.py
worker/speaker_engine.py
worker/camera_engine.py
worker/render_engine.py
worker/cliper_worker.py
```

Jangan membuat file baru jika logikanya masih bisa dimasukkan ke engine yang ada.

---

## FINAL VALIDATION

Implementasi dianggap selesai jika memenuhi seluruh kriteria berikut:

✓ Highlight ditemukan berdasarkan cerita, bukan hanya kata kunci.

✓ AI menghasilkan minimal 40–80 kandidat sebelum proses seleksi.

✓ Final clip 10–20 untuk video ±1 jam (tergantung kualitas konten).

✓ Tidak ada clip overlap.

✓ Tidak ada judul yang mirip.

✓ Score tersebar alami, tidak selalu 99.

✓ Metadata, hook, dan judul relevan dengan isi clip.

✓ Penggunaan token AI lebih efisien melalui preprocessing lokal.

✓ Cache bekerja saat analisis ulang.

✓ Seluruh perubahan terintegrasi dengan pipeline dan UI yang sudah ada.

✓ Tidak merusak fitur render, subtitle, camera engine, maupun workflow aplikasi.

✓ Siap digunakan sebagai fondasi production untuk Cliper AI Studio V3.3.

---

## NEXT STEPS

Setelah Prompt 1 (AI Story Engine & Highlight Pipeline) selesai dan stabil, lanjut ke:

**PROMPT 2 — Subtitle Engine V4 + Camera Engine + Video Enhancement**

Fokus pada:
- Subtitle sinkron dengan audio
- Camera reframing natural
- Video enhancement (color, audio, effects)

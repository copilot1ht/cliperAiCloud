# CLIPER STUDIO PLUS V3.2

# PRODUCTION AUDIT & FINAL REFACTOR

# DO NOT CHANGE EXISTING UI

## OBJECTIVE

Audit seluruh project Cliper Studio Plus dan lakukan perbaikan agar siap production tanpa membuat UI baru dan tanpa mengubah workflow user yang sudah ada.

Fokus:
- kualitas highlight
- subtitle sinkron
- human editor camera
- metadata SEO
- stabilitas render
- AI output berkualitas
- score real, bukan fake
- output mendekati editor manusia.

---

## IMPORTANT RULES

JANGAN:
- membuat menu baru
- membuat UI baru jika tidak diperlukan
- mengubah alur user
- menghapus fitur yang masih dipakai.

LAKUKAN:
- perbaiki engine di belakang layar
- refactor service
- perbaiki algoritma.

---

## STEP 1 — FULL PROJECT AUDIT

Audit:

### Highlight Engine
- scoring
- overlap
- story completion
- transcript quality
- AI prompts

### Camera Engine
- face tracking
- crop engine
- split screen
- active speaker
- scene change

### Subtitle Engine
- timestamp
- delay
- word alignment
- speaker sync
- animation

### Render Engine
- ffmpeg command
- memory leak
- temporary files
- resume render
- crash handling

### Metadata Engine
- title generation
- hook generation
- seo keywords
- hashtags

---

## STEP 2 — HUMAN EDITOR CAMERA ENGINE

Tujuan: hasil seperti editor manusia.

JANGAN gunakan slow pan.

Gunakan:

### SINGLE SPEAKER
- hard cut

### FAST CONVERSATION
- quick cut 150-250ms

### TWO SPEAKERS
- split screen

### THREE SPEAKERS
- focus speaker active

### ZONE MAPPER
Bagi video menjadi LEFT / CENTER / RIGHT. Speaker dipetakan otomatis ke zona.
Jika speaker berpindah, kamera langsung cut. Bukan geser pelan.

### ACTIVE SPEAKER
Gunakan kombinasi:
- voice activity
- mouth movement
- head movement
- body movement

### TRACKING PRIORITY
Face -> Upper Body -> Full Body.
Jika face hilang, pakai body tracking.

---

## STEP 3 — SUBTITLE ENGINE V4

Masalah saat ini: subtitle telat.

Target: subtitle muncul tepat ketika kata diucapkan.

### PIPELINE
Audio -> Whisper -> Word Timestamp -> Speaker Timeline -> Subtitle Generator -> Animated Subtitle

### TIMING RULE
- subtitle lead: 50-100ms
- subtitle lag: maksimal 80ms

### WORD LEVEL
Subtitle per kata, bukan per kalimat.

### SEGMENT RULE
- maksimal 2 baris
- maksimal 42 karakter
- pecah berdasarkan koma, titik, atau jeda bicara

### EMOTION SUBTITLE
- normal: putih
- emphasis: kuning
- shout: merah
- question: biru

### ANIMATION
Gunakan Pop / Scale / Fade.

---

## STEP 4 — HIGHLIGHT ENGINE V4

Score:
- hook_score: 30%
- emotion_score: 15%
- retention_score: 15%
- story_score: 50%
- payoff_score: 20%
- virality_score: 10%

### STORY COMPLETION
Clip tidak boleh selesai sebelum:
- pertanyaan terjawab
- punchline selesai
- konflik selesai
- payoff selesai.

### AUTO CLIP
Generate clip sebanyak mungkin, tetapi hanya render yang punya score >= 85. Jika score < 85, jangan render.

---

## STEP 5 — AI QUALITY IMPROVEMENT

Gunakan AI untuk:
- highlight ranking
- hook rewrite
- title generation
- metadata generation.

Jangan gunakan AI untuk:
- subtitle timing
- crop engine
- face tracking.

Itu harus lokal.

### RECOMMENDED MODELS
- Highlight: Gemini 2.5 Flash
- Hook: Gemini 2.5 Flash
- Title: Gemini 2.5 Flash
- Metadata: Gemini 2.5 Flash Lite
- Fallback: DeepSeek V3

---

## STEP 6 — METADATA ENGINE

Generate:

### YouTube
- title
- description
- hashtags

### TikTok
- caption
- hook
- keywords

### Facebook
- caption
- hashtags

Semua metadata harus:
- original
- tidak clickbait berlebihan
- aman monetisasi

---

## STEP 7 — PERFORMANCE

Gunakan:
- render cache
- resume render
- staged rendering

Batasi:
- cpu_threads = max(2, cpu_count() // 2)

---

## STEP 8 — QA CHECKLIST

Wajib lulus:
- subtitle sinkron
- subtitle tidak telat
- crop natural
- split screen benar
- active speaker benar
- body tracking benar
- highlight bagus
- hook bagus
- title bagus
- score real
- metadata bagus
- render resume jalan
- mp4 valid
- memory leak tidak ada
- 100 render tanpa crash

---

## RELEASE RULE

- 0 crash
- 0 corrupt mp4
- 0 subtitle delay
- 0 invalid json
- 0 ffmpeg error
- 0 memory leak

Jika semua lulus, project siap production dan public launch.

JANGAN membuat UI baru.
JANGAN mengubah workflow user.
Perbaiki engine yang sudah ada dan pertahankan kompatibilitas dengan seluruh project.

Untuk AI model production, kombinasi yang paling seimbang antara kualitas dan biaya untuk Cliper Studio Plus saat ini adalah:
- Gemini 2.5 Flash -> highlight, hook, title, metadata
- DeepSeek V3 -> fallback murah dan batch processing
- Whisper Large-v3 -> subtitle dan transcript
- MediaPipe + YOLO -> tracking dan reframing

Dengan kombinasi ini, kualitas output bisa mendekati aplikasi seperti Opus Clip atau Vizard tanpa biaya API terlalu tinggi.

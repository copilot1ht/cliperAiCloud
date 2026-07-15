# CLIPER STUDIO PLUS V3.2

# PRODUCTION STABILIZATION UPDATE

# HUMAN-LIKE AUTO CLIPPING ENGINE

# READY FOR PUBLIC LAUNCH

## OBJECTIVE

Refactor dan perbaiki engine yang sudah ada agar:
- highlight lebih berkualitas
- subtitle sinkron dengan speaker
- crop seperti editor manusia
- score lebih realistis
- metadata SEO lebih baik
- render lebih stabil
- tidak membuat fitur palsu
- tidak membuat struktur baru jika belum diperlukan
- mempertahankan UI saat ini.

---

# RULE

DO NOT:
- membuat menu baru
- membuat setting baru yang tidak diperlukan
- mengubah alur user
- membuat AI dummy
- membuat score palsu
- membuat subtitle sintetis.

ONLY:
- memperbaiki engine yang ada
- meningkatkan kualitas output
- meningkatkan stabilitas.

---

# CURRENT PROJECT PATH

```text
C:\Users\USER\Desktop\Cliper Ai Studio\Cliper-AI
```

---

# PRIORITY ORDER

1. Subtitle Engine
2. Camera Engine
3. Highlight Engine
4. Metadata Engine
5. Render Stability
6. AI Generation Quality

---

# PART 1

# SUBTITLE ENGINE V3.2

## PROBLEM

Subtitle sering:
- telat
- tidak sesuai speaker
- terlalu panjang
- muncul setelah orang selesai bicara.

## TARGET

Subtitle harus muncul 50-120ms sebelum kata diucapkan agar terasa natural.

# WORD LEVEL TIMESTAMP

WAJIB:
```text
Whisper Word Timestamp
```

bukan:
```text
sentence timestamp
```

# PIPELINE

```text
Audio
↓
Transcription
↓
Word Timestamp
↓
Speaker Timeline
↓
Subtitle Segment
↓
Animated Subtitle
↓
Render
```

# TIMING RULE

```python
subtitle_start = word_start - 0.08
subtitle_end = word_end + 0.05
```

# SEGMENTATION

Maksimal 2 baris dan 42 karakter. Pecah pada koma, titik, tanda tanya, atau jeda bicara.

# SUBTITLE STYLE

- Normal: putih
- Emphasis: kuning
- Shouting: merah
- Question: biru

# ANIMATION

Gunakan Pop / Scale / Fade. Jangan Flash / Shake berlebihan.

---

# PART 2

# CAMERA ENGINE V3.2

## PROBLEM

Camera hanya geser pelan sehingga hasil tidak seperti editor manusia.

# TARGET

Gunakan CUT atau FAST REFRAME.

# ZONE DETECTION

Video 16:9 dibagi menjadi LEFT / CENTER / RIGHT.

# ZONE RULE

```python
if x < 0.33:
    LEFT
elif x < 0.66:
    CENTER
else:
    RIGHT
```

# SPEAKER MAPPING

```python
speaker_a -> LEFT
speaker_b -> CENTER
speaker_c -> RIGHT
```

# ACTIVE SPEAKER

Score:
```python
0.50 voice_activity +
0.20 mouth_movement +
0.15 body_movement +
0.15 face_visibility
```

# CAMERA RULE

Single speaker: crop langsung ke speaker. Tidak slow pan.

# TRANSITION

```text
150-250ms
```

# FAST CONVERSATION

Jika A/B/A/B, gunakan quick cut.

# TWO SPEAKER MODE

Jika overlap >1 detik, gunakan split screen. Layout: top bottom atau left right.

# FACE TRACKING PRIORITY

Face -> Upper Body -> Body

# BODY TRACKING

Jika face hilang, gunakan MediaPipe Pose atau YOLO Person.

---

# PART 3

# HIGHLIGHT ENGINE V3.2

## TARGET

Highlight seperti Opus Clip, Vizard, Klap, Captions AI.

# STORY DETECTOR

Deteksi setup, conflict, payoff, surprise, emotion, retention.

# SCORING

```python
score = (
    hook_score * 0.20 +
    emotion_score * 0.15 +
    retention_score * 0.15 +
    story_score * 0.20 +
    payoff_score * 0.20 +
    virality_score * 0.10
)
```

# SCORE INTERPRETATION

- 95-100 = Exceptional
- 90-94 = Viral Potential
- 85-89 = Very Good
- 80-84 = Good
- <80 = Skip

# RENDER RULE

```python
if score >= 85:
    render()
else:
    skip()
```

# AUTO CLIP

Tidak perlu jumlah clip manual. Generate sebanyak mungkin tetapi hanya render yang score >= 85.

# STORY COMPLETION

Clip tidak boleh berhenti sebelum pertanyaan terjawab, punchline selesai, atau payoff selesai.

# DURATION

- Punchline: 30-60 detik
- Tutorial: 60-120 detik
- Story: 90-180 detik

---

# PART 4

# AI GENERATION

## TITLE

Harus punya curiosity, emotion, conflict, payoff.

## HOOK

Maksimal 10 kata.

## CTA

Maksimal 15 kata.

# PROVIDER ROUTER

Priority:
Gemini Flash -> DeepSeek -> OpenAI -> Local

# MODEL RECOMMENDATION

## Murah
- Gemini 2.5 Flash
- DeepSeek V3

## Production
- Gemini 2.5 Flash + OpenAI GPT-5 Mini

## Premium
- Gemini 2.5 Pro + GPT-5

---

# PART 5

# METADATA ENGINE

Generate:

## YouTube
- Title
- Description
- Hashtags

## Facebook
- Caption
- Hashtags

## TikTok
- Hook
- Keywords

---

# COPYRIGHT SAFETY

Jangan klaim: Official, Full Episode, Original Broadcast. Gunakan: Clip, Highlight, Commentary, Reaction, Educational.

---

# PART 6

# RENDER STABILITY

Pipeline:
Decode -> Crop -> Subtitle -> Watermark -> Encode

# RESUME

Jika clip_3 gagal, lanjut ke clip_3. Jangan ulang clip_1 atau clip_2.

# THREAD

```python
cpu_threads = max(2, cpu_count() // 2)
```

---

# QA VALIDATION

Wajib lulus:
- subtitle sinkron
- speaker sinkron
- crop tidak lompat
- split screen benar
- active speaker benar
- body tracking benar
- highlight natural
- title AI bagus
- hook AI bagus
- metadata valid
- render resume jalan
- mp4 valid
- memory leak tidak ada
- score real
- subtitle tidak telat
- 100 render tanpa crash

---

# RELEASE RULE

- 0 crash
- 0 corrupt mp4
- 0 subtitle delay
- 0 invalid json
- 0 ffmpeg error
- 0 memory leak
- 0 fake score

---

# FINAL INSTRUCTION TO CODEX

Do not redesign UI.
Do not create new settings.
Improve existing engines only.
Keep backward compatibility.
Every feature must have production implementation.
No placeholders.
No fake AI.
No hardcoded scores.
No hardcoded subtitles.
Everything must be measurable and testable.

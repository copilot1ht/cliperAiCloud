CLIPER STUDIO PLUS V3.1 - PRODUCTION PROMPT FOR CODEX

Goal: Implement core video editing pipeline (subtitle -> speaker -> camera -> split -> highlight) dengan integrasi ke codebase existing, menghasilkan output mirip Opus Clip.

CORE PRINCIPLES
===============
- Jangan buat file baru tanpa pengecekan folder worker/. Reuse/extend:
  camera_engine.py, speaker_engine.py, render_engine.py, split_screen.py, highlight_engine.py
- Setiap phase terpisah, sequential, dan bisa di-test secara unit.
- Prioritas utama: accuracy & stability, bukan fitur lengkap.

PHASE 1: SUBTITLE ENGINE (Forced Alignment)
===========================================
- Gunakan librosa + torchaudio untuk forced alignment (Wav2Vec2)
- Output: timestamped_subtitles.json (start/end/text)
- Requirement:
  - Min duration per subtitle: 0.5s
  - Handle silent gaps >= 0.3s secara otomatis

PHASE 2: SPEAKER DETECTION (Hysteresis Added)
==============================================
- Gunakan pyannote.audio atau SpeechBrain
- Output: speakers.json (speaker_id, start, end, embedding)
- Requirement:
  - MIN_SPEAKER_DURATION = 0.8s (hysteresis for stability)
  - Speaker switching gap <= 0.5s -> merge ke speaker yang sama

PHASE 3: CAMERA REFRAME
=======================
- Gunakan dlib/MediaPipe face detection + speaker mapping
- Output: camera_moves.json (clip_id, speaker_id, zoom, pan, duration)
- Requirement:
  - Smooth transitions (jitter reduction)
  - Jangan flip speaker tiba-tiba tanpa hysteresis

PHASE 4: SPLIT SCREEN
=====================
- Match speaker duration + overlap time
- Output: split_layouts.json (frame_id, speaker_left, speaker_right)
- Requirement:
  - MIN_OVERLAP_DURATION = 0.7s
  - Jangan split jika overlap < threshold

PHASE 5: HIGHLIGHT GENERATION (with Penalty Score)
===================================================
- Compute highlight score: score = engagement_score + (speaker_density * 10) - penalties
- Penalties:
  too_silent = -20
  too_short = -10
  no_payoff = -15
- Output: highlights.json (start, end, score, reason)
- Requirement:
  - Min duration highlight: 3s
  - Max overlap 25% antar highlight

OUTPUT FORMAT (consistent JSON)
===============================
Setiap phase output file JSON dengan struktur wajib:
{
  version: 3.1,
  phase: subtitle|speaker|camera|split|highlight,
  timestamp: 2026-07-06T10:35:00Z,
  data: [...]
}

QA CHECKLIST
============
- Subtitle sync jitter <= 0.1s
- Speaker idempotent (re-run = hasil sama)
- Camera tidak berkedip antar speaker
- Split screen tidak menampilkan wajah di bawah MIN_OVERLAP_DURATION
- Highlight score tidak fake (penalty terakumulasi)

FILE INTEGRATION
================
Hanya modifikasi atau tambahkan dalam worker/:

Existing              Action
-------------------   --------------------------------
speaker_engine.py     Extend: add hysteresis & forced alignment
camera_engine.py      Extend: add hysteresis, zoom/smooth
highlight_engine.py   Rewrite: add penalty score
split_screen.py       Add MIN_OVERLAP_DURATION filter
render_engine.py      Integrate final layout
subtitle_engine.py    NEW (forced alignment)

Final output: Full pipeline JSON + rendered output.mp4 (1080p, 30fps).
DO NOT create new engine Unless jelas tidak ada di worker/.

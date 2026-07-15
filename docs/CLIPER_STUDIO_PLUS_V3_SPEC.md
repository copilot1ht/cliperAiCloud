# CLIPER STUDIO PLUS V3.1 — Production Specification

This document is a machine-friendly, implementation-ready specification for the
Human Editor Camera Engine, Podcast Auto Reframe, and Subtitle/Highlight
behaviour. Use it as the authoritative prompt for Codex/Copilot or for
engineers implementing the features.

---

OBJECTIVE

Refactor camera, subtitle, and editing systems so outputs resemble human-edited
clips (Opus Clip, Captions AI, Vizard, Klap) and avoid slow pans, late captions,
or speaker-mismatched subtitles. Priorities: 1) subtitle sync, 2) camera framing,
3) quick reframe/cuts, 4) split screen for two speakers, 5) accurate highlight
scoring, 6) no fake scores.

TARGET OUTPUT

- Single active speaker -> crop to LEFT/CENTER/RIGHT (CUT or FAST_REFRAME).
- Quick alternation conversation -> FAST_CUT (200ms transition).
- Two speakers overlapping (>1s) -> SPLIT_SCREEN (choose TOP_BOTTOM or
  LEFT_RIGHT by face area).
- Three speakers -> focus active speaker and support 3-up layout.

VIDEO ANALYSIS PIPELINE

Input Video -> Audio Analysis (VAD, diarization, active speaker, emotion) ->
Video Analysis (face/body/person/scene) -> Zone Mapper -> Camera Engine ->
Subtitle Engine -> Render Engine

ZONE DETECTION

- Divide 16:9 frames into 3 zones. Implementation detail:

  ZONE_LEFT = 1
  ZONE_CENTER = 2
  ZONE_RIGHT = 3

  if center_x < width * 0.33: zone = LEFT
  elif center_x < width * 0.66: zone = CENTER
  else: zone = RIGHT

SPEAKER MAPPING

Map each speaker id to nearest zone center.

ACTIVE SPEAKER SCORING

Use weighted combination (0..1 inputs):

score = 0.50*voice_activity + 0.20*mouth_movement + 0.15*body_movement + 0.15*face_visibility

Camera decision picks highest-scoring speaker in a time window.

CAMERA ENGINE

- Single speaker -> cut to that speaker's zone (hard cut / snap reframe, 150-250ms).
- Fast conversation -> FAST_CUT with ~200ms transition.
- Two speakers overlapping >1s -> SPLIT_SCREEN.
- Avoid slow pans or long smooth slides (>300ms).

FACE/BODY TRACKING

Priority: face -> upper body -> full body. When face lost, fall back to
MediaPipe Pose or YOLO Person to avoid jumpy crops.

SUBTITLE ENGINE V3

Pipeline: Audio -> Whisper -> word-level timestamps -> speaker timeline ->
subtitle generator -> animated subtitle. Subtitles must be word-level, appear
50-120ms early, with target subtitle_delay < 100ms. Subtitles follow active
speaker only.

EMOTION SUBTITLE

- Normal: White
- Emphasis: Yellow
- Shout: Red
- Question: Blue

HIGHLIGHT ENGINE V3

score = 0.20*hook_score + 0.15*emotion_score + 0.15*retention_score + 0.20*story_score + 0.20*payoff_score + 0.10*virality_score

Render rule: if score >= 85 -> render, else skip.

FILE STRUCTURE GUIDANCE

Prefer using existing files in `worker/` when possible. Suggested files to
update or implement:

worker/
├── camera_engine.py
├── speaker_engine.py
├── split_screen.py
├── body_tracking.py
├── highlight_engine.py
├── render_engine.py
├── story_engine.py
└── cliper_worker.py

QA CHECKLIST (production acceptance)

✓ subtitle sync
✓ speaker sync
✓ crop stable (no jump)
✓ split screen correct
✓ body tracking fallback works
✓ active speaker detection enabled
✓ title/hook AI quality
✓ no fake scores
✓ render resumes/retries
✓ output MP4 valid
✓ no memory leak
✓ survive 100 renders without crash

RELEASE RULES

0 crash, 0 corrupt mp4, 0 subtitle delay, 0 invalid json, 0 ffmpeg error, 0 memory leak

---

Implementation notes:
- Keep API boundaries small: `speaker_engine.compute_speaker_score(...)`,
  `zone_mapper.detect_zone_from_center_x(...)`, `camera_engine.decide_camera_action(...)`.
- Add unit tests for scoring, zone mapping, and decision logic.
- Instrument AI requests with detailed debug logs and retry on empty responses.

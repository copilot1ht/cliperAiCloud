# Cliper Studio Plus - Opus-Like Local Ecosystem

This project follows a local-first clipping architecture inspired by modern AI clipping tools, while keeping API usage optional and render work on the user's PC.

## Pipeline

```text
Input Engine
-> Source Cache Engine
-> Transcript Engine
-> Moment AI Engine
-> Multimodal Scoring Engine
-> Automatic Production Pipeline
-> Reframe / Face Tracking Engine
-> Caption / Hook Engine
-> Render Engine
-> Quality Validation
-> Library Engine
```

## Core Rules

- Public YouTube videos are processed without cookies first.
- Cookies are only used as retry/fallback for login, age, region, member, or private access cases.
- Source video is downloaded once and reused from local cache.
- AI providers are optional. Without API key, local scoring and FFmpeg render still work.
- API requests should send ranked candidates, not the full transcript, to keep token usage low.
- Render output is MP4-first with creator package folders:
  `Video Original`, `Clip`, `Caption`, `Metadata`, `XML`, and `Thumbnail`.
- Enhancement checkboxes are not part of the main creator flow. Smart crop, face tracking, dynamic zoom, auto cut, hook, and ASS captions run automatically with safe fallbacks.
- Final MP4 filenames use sanitized SEO-style titles, not `clip_01.mp4`.

## Moment AI Engine

Moment selection must not simply take adjacent high-score windows. The engine must prefer clips that are:

- anti-overlap
- semantically diverse
- story complete
- clean at the beginning
- clean at the ending
- close to the configured target duration
- useful for Shorts, Reels, TikTok, and Facebook

Current local metrics:

- Hook
- Flow
- Value
- Emotion
- Trend
- Conversation
- Payoff
- Cut
- Novelty
- Story Complete

If API is configured, AI ranks and rewrites moment title/hook/reason. If AI fails or returns too few moments, local diversity fill completes the target clip count.

## Reframe / Face Tracking Engine

The reframe engine is designed to be safe on local machines:

- OpenCV face detection first
- MediaPipe can be added later as an optional upgrade
- center crop fallback if no face is detected
- single speaker crop
- speaker priority crop
- conversation group crop for 2-4 visible people
- smooth keyframe crop expression in FFmpeg
- conservative dynamic zoom when multiple people are visible

## Render Safety

- FFmpeg commands are argument lists, not shell strings.
- GPU encoder is auto detected and falls back to CPU `libx264`.
- Optional enhancements should never block basic MP4 render.
- Unicode output and JSON files are written as UTF-8.
- FFprobe validates each rendered MP4 for video stream, duration, and audio presence.
- Invalid output retries once with safe CPU render before being reported as warning/error.

## Output Naming

Each selected moment is converted into an upload-ready title:

- 25-65 characters
- Windows-safe filename
- no emoji or invalid symbols
- title case
- duplicate names become `Title (2).mp4`

Metadata JSON stores the title, hook, score, duration, speaker mode, aspect ratio, transcript, keywords, language, scene id, timestamps, validation result, and output paths.

## Next Stability Priorities

- Add optional MediaPipe face landmarker package detection.
- Add optional Whisper/faster-whisper local transcript fallback.
- Add manual crop override in preview editor.
- Add caption animation templates after render stability is proven.

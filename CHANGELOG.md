# Cliper Studio Plus Changelog

## v1.12.2 - Stable Hotfix

Fixed:

* Target-aware manual review fallback prevents a valid analysis from ending with zero visible moments when Cloud selection is empty and the strict auto-render gate rejects every candidate.
* Honest raw scores are preserved; review fallback moments are never promoted to auto-render or cosmetically boosted.
* Travel vlog titles such as first-visit and destination videos now use the vlog content profile instead of conversational podcast defaults.

Validation:

* 254 automated Desktop tests pass, including target fallback, low-evidence rejection, content profile, story scoring, session handling, render validation, and publishing plans.
* The production-reported 41-minute source now returns 4 reviewable moments for target 4 instead of 0 while retaining the original evidence scores.
* Target 1 returns 1 and target 6 returns 5 on the same weak-evidence source; target 10 remains quality-limited to 5 rather than padding unsafe candidates.

## v1.12.1 - Stable

Improved:

* Requested clip targets stay synchronized across presets, controls, button labels, saved settings, and worker payloads.
* Adaptive discovery preserves evidence gates while widening the story pool for larger targets without padding weak candidates.
* Public quality tiers use deterministic evidence calibration; no random or cosmetic score inflation is applied.
* Story boundaries reduce unnecessary pre-context and tails while preserving context, development, payoff, and natural sentence endings.
* Studio and Settings remain responsive and scrollable across supported desktop sizes without exposing wallet balance or upfront cost estimates in the main workflow.
* Cloud connection state now communicates AI readiness without treating wallet balance as an API-key connection requirement.

Validation:

* 253 automated Desktop tests pass across UI contracts, story discovery, scoring, session handling, render validation, and publishing plans.
* Real-video target acceptance completed for 1/4/6/10 with honest quality gating; weak source material is never padded to meet the requested count.
* Real enhanced and CPU-fallback renders pass MP4 and ffprobe validation with audio, subtitles, Hook timeline, and recorded encoder fallback behavior.
* Cloud typecheck, tests, API/Web builds, Prisma validation, and Prisma generation pass before production release.

## v1.12.0 - Local Release Candidate

Added:

* Evidence-based story-role discovery with adaptive candidate durations and contextual boundary backtracking.
* Local YouTube Session V2 with persistent browser refresh, manual cookies fallback, bounded authentication recovery, and automatic job resume.
* Hook Director layouts for top banner, center card, and minimal safe-area presentation.
* Smart Publishing Planner that writes per-clip and session-level plans without hidden AI requests.

Improved:

* Completed stories can end near a strong payoff instead of being padded toward one fixed duration.
* Generic or unsupported hook copy is rejected while relevant explicit hooks remain available.
* YouTube HTTP 403 remains separately classified and only confirmed authentication failures trigger session refresh.
* Publishing schedules honor selected platforms, timezone fallback, daily caps, and minimum post gaps.
* Restored the modern desktop layout contract across Studio, Moment AI, Render, Output, and Settings after the shell redesign dropped shared form and panel styles.
* Settings now opens canonical runtime-backed sections instead of the prototype dashboard with sample usage/session values.
* Moment AI empty states no longer display sample scores, candidates, source metadata, or confidence before a real analysis exists.
* Hook placement and Render pipeline summaries are now connected to the same settings and worker payload used by the final render.
* Candidate ranking now keeps broad timeline discovery while prefiltering expensive boundary refinement to a deterministic, diverse shortlist.
* Podcast, interview, news, review, tutorial, storytelling, and commentary boundaries use profile-aware short-form guardrails without forcing one fixed duration.
* The desktop shell keeps Studio, Moment AI, Render, Output, and Settings as separate active pages; Settings sections scroll internally without turning the app into one long document.

Validation:

* 244 automated tests pass across Electron UI/DOM contracts, worker logic, story scoring, YouTube sessions, subtitle/hook timelines, tracking, cache, render manifests, and publishing plans.
* Cached real-content acceptance passes for podcast, interview, storytelling, and commentary with 10 non-overlapping candidates per profile and honest evidence-based scores.
* A fresh real-content render passes ffprobe and production output validation at 720x1280 H.264/AAC with Hook, subtitles, smart crop, face tracking, and recorded GPU fallback behavior.
* Cloud contracts, AI Router, API, Web, Prisma validation/generation, billing, and admin tests pass locally. No production deployment or online release is claimed by this entry.

## v1.11.0 - Stable Desktop Release

Added:

* System status yang mengelompokkan komponen inti, analisis video, cerita/subtitle, dan output berdasarkan pemeriksaan runtime nyata.
* Folder release berversi yang otomatis berisi Setup, Portable, checksum SHA-256, updater metadata, dan petunjuk upload Google Drive.

Improved:

* Akselerasi perangkat dan CPU fallback kini dijelaskan dengan bahasa produk yang jelas tanpa menyembunyikan status fallback.
* Paket release Windows memakai nama artefak berversi agar checksum dan tautan distribusi tidak saling tertimpa.

Validation:

* 173 automated tests pass.
* Dependency scan nyata: Python, yt-dlp, FFmpeg/FFprobe, OpenCV, MediaPipe, Faster-Whisper, dan encoder H.264 tersedia.
* Render lokal 60 detik lulus: video H.264 720x1280, audio AAC, subtitle terbakar, ASS/SRT, camera director, dan tanpa warning worker.

## v1.11.0-beta.1 - Adaptive Editorial Quality

Added:

* Lightweight Cloud download center for Setup, Portable, checksums, and version history.
* Admin release catalog backed by GitHub Release assets.

Improved:

* Unified content-aware evidence gates across local ranking and AI review.
* Long-form conversation detection using duration, dialogue turns, questions, and episode evidence.
* Profile-specific highlight validation for podcast, tutorial, review, news, vlog, gaming, and music.

Changed:

* Render quality is no longer benchmarked against the legacy subtitle QA sample.
* YouTube heatmap remains corroborating evidence and never controls crop or score by itself.

## v1.10.0-beta.3 - Subtitle Readability and User Onboarding

Added:

* Complete Indonesian user guide covering PC requirements, runtime installation, Custom AI, cookies, workflow, output, security, and troubleshooting.
* Tested `requirements-runtime.txt` and a PowerShell runtime setup helper.
* Packaged offline guide access from `Settings > Runtime > Buka panduan`.

Improved:

* Caption letter spacing is subtly increased by resolution: 1.0 at 720p and 1.4 at 1080p/2K, without changing word timestamps or line timing.
* Long bold caption phrases wrap earlier so added spacing cannot push text outside the safe frame.
* Runtime documentation separates mandatory end-user dependencies from developer-only tools.

Validation:

* 30 automated tests pass, including resolution-aware ASS caption spacing.
* PowerShell runtime helper parses successfully without executing installation during QA.

## v1.10.0-beta.2 - Custom AI Compatibility and Batched Highlight Ranking

Added:

* Provider-neutral Custom AI adapter for OpenAI-compatible Chat Completions and Responses API endpoints.
* Module-specific timeout, retry, exponential backoff, and compatibility downgrade policies.
* Story/timeline-balanced highlight batches with compact evidence payloads.
* Analysis-time `ai-debug-log.json` with endpoint, parser, latency, retry, request size, and fallback diagnostics.
* Adaptive luma/chroma sampling before render with conservative cast classification.

Improved:

* SSL timeout, rate-limit, and transient server failures retry before local fallback.
* One failed highlight batch no longer discards successful results from other batches.
* The selected model is preserved and is no longer silently replaced with a provider-specific model.
* Reasoning prose is not accepted as a final title/highlight response unless it contains a JSON result.
* AI scores remain evidence-gated and are checked against local story, hook, payoff, retention, and filler signals.
* Video enhancement no longer treats incidental transcript words as visual profiles; saturation is capped near +2% and reduced for strong color casts.
* Unsafe automatic channel balancing was removed, while denoise, gradation smoothing, and sharpening use lighter thresholds.
* Output explicitly declares YUV420P BT.709 metadata for consistent playback across Windows players and social platforms.

Validation:

* 29 automated tests pass, including timeout recovery, unsupported-parameter downgrade, multiple response formats, story-balanced batching, partial-batch recovery, conservative visual profiles, and color-cast safeguards.
* Real-source filter render passed at 720x1280 with YUV420P BT.709 metadata; a 22.42% heavy-pass overhead correctly triggered integrated-light fallback.
* Packaged portable smoke passed with five responsive processes and no renderer error.

## v1.10.0-beta.1 - Highlight Intelligence and Timeline Lock

Added:

* Opening-scoped highlight metrics and deterministic evidence-gated rank calibration.
* Cached per-second audio activity evidence for transcript, dialogue, and retention ranking.
* Dynamic candidate duration profiles and a quality/timeline-balanced candidate pool.
* Responsive Moment AI grid, search, quality filter, sorting, and persistent review drawer.
* Subtitle timeline signature, ASS coverage validation, automatic one-pass recovery, and render safety gate.

Improved:

* AI results that contain only one valid clip are supplemented with non-overlapping Optional candidates instead of ending the workflow early.
* A 51-minute regression source now produces 14 unique review candidates from a reduced 336-item ranking pool.
* Camera Director repeats editorial patterns on long clips and caps a decision near 5-7 seconds instead of stretching four shots across minutes.
* Local titles prefer concrete spoken evidence and no longer invent counts such as "ditolak dua kali".
* Subtitle event capacity scales with clip duration instead of stopping at 32 caption phrases.

Removed:

* Quick Editor offline navigation, page, renderer bindings, preload bridge, and Electron video-picker IPC.

Validation:

* 20 automated tests pass.
* Real subtitle render: 19 words, 19 ASS events, 100% coverage, valid audio/video MP4.
* Real camera analysis: three faces, left/center/right zones, 11 shots over 60 seconds, maximum hold 5.46 seconds.

## v1.9.1 - Moment AI Recovery and Adaptive 4K Look

Fixed:

* Moment AI no longer renders an empty grid when analysis returns only sub-threshold candidates.
* Full Auto still requires score 85+, while lower candidates remain visible as Optional with their original evidence score.
* Empty and stale analysis results now show an actionable UI state instead of a blank page.
* 4K Look fallback only retries when the optional heavy filter chain was actually active.

Improved:

* Multi-clip title diversity rejects repeated suffix template families.
* Automatic 4K Look preserves source resolution and benchmarks heavy filters against an 8% safety threshold.
* The renderer keeps the integrated light enhancement when expensive filters exceed the performance budget.
* Active Python workers are terminated when the Electron application exits.

## v1.9.0 - V3.3 Human Editor Pipeline

Added:

* Story timeline, topic metadata, and deterministic 40-80 candidate pool for long videos.
* Camera Director hard-cut sequences driven by story, speaker evidence, emotion, and fixed zones.
* Audio-first word timestamps with cached per-word ASS highlight events.
* Always-on Natural Podcast video enhancement in one FFmpeg filter graph.
* NVENC -> AMF -> QSV -> libx264 encoder fallback chain.

Improved:

* DeepSeek detection now also works when configured as Custom/OpenAI Compatible.
* AI scores are validated against local story, payoff, retention, and transcript evidence.
* Full Auto renders only score 85+; a lower local fallback remains visible as optional.
* Titles and hooks remove rolling-caption duplicates and reject repeated template families.
* Story, candidate, camera, subtitle, and filter graph diagnostics are cached as JSON artifacts.

Removed:

* Random highlight metrics and random candidate ordering.
* Local AI Upscaler settings and runtime status.
* Continuous crop interpolation and sinusoidal camera drift.

## v1.6.0 - Cinematic Speaker Engine Production Test

Added:

* Cinematic camera decision engine for face/body/split/center crop.
* Story boundary extender with ending buffer for more natural clips.
* Highlight Engine V2 scoring: hook, emotion, payoff, retention, story completion, duration fit.
* Dynamic duration profiles for punchline, tutorial, storytelling, and general clips.
* Worker modules for speaker, camera, body tracking, split screen, story, and highlight logic.
* Quick Editor / Local Video mode for finishing already-cut local clips.

Improved:

* Human-editor style highlight duration up to 180 seconds when story needs it.
* Filler-heavy moments are penalized before selection.
* Tracking metadata now records camera layout and camera score.
* YouTube source cache retries now resume more patiently on unstable connections.
* Quick Editor speaker mode is now passed into the render crop pipeline.
* Highlight title/hook generation now filters filler transcript noise and avoids repeated generic templates.
* Caption active-word emphasis now defaults to the green creator style and targets stronger words in the phrase.

Fixed:

* Prevented fake captions from being generated from title/hook text when transcript is missing.
* SRT export now uses the same transcript segments as burned ASS captions.
* Hook intro is skipped automatically when it duplicates the opening caption.
* Render manifest/log JSON now handles OpenCV/numpy scalar values safely.
* Score below 70 can no longer be auto-selected for render from stale or fallback moment data.

## v1.5.2 - Production Release Candidate

### Added

- New Branding
- Unlimited Duration Support
- Time Selection
- Story Complete Engine
- Interactive Preview
- Watermark Editor
- Caption Editor
- Render Cache
- Resume Render

### Improved

- Highlight Quality
- Render Stability
- GPU Fallback
- Audio Pipeline
- Subtitle Sync

### Fixed

- Render Crash
- Duplicate Subtitle
- Missing Audio
- Metadata Duration Limit
- Open Folder
- FFmpeg Errors

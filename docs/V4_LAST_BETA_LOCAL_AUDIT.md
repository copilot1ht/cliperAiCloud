# Cliper Studio Plus V4 - Last Beta Local Audit

Date: 2026-07-26
Build: v1.11.0-beta.1
Scope: Desktop Electron, Python Worker, Cliper AI Cloud local API/Web, billing, provider router, subtitle, camera, highlight, and render pipeline.

Status: LAST BETA LOCAL BUILD - READY FOR MANUAL USER TESTING

This is not a public production release. No GitHub push, no GitHub release, no Vercel deploy, no Railway deploy, and no Midtrans production validation were performed in this pass.

## What Changed

- Desktop now uses Cliper AI Cloud as the only visible AI gateway option.
- Cloud connection state is stored explicitly after a successful test, so Generate does not send the user back to Settings just because a status label changed.
- Moment selection is handled directly from the card check control, so manual checkbox selection is more reliable.
- Processing failures now use explicit run IDs and terminal error state. A stale error, dismissed error, or user cancellation can no longer leave the red failure banner visible while a new analysis is running.
- Moment AI separates `Terpilih otomatis` from `Rekomendasi untuk ditinjau` without inflating weak scores.
- The old "Random Viral Mix" UI/payload label was removed from the production flow. Scoring now stays content-aware and evidence-based.
- Speaker detection no longer invents generic speaker labels when diarization is absent.
- Camera schema 4 only builds spatial cuts from detected human centers. It validates detection continuity, estimated human coverage inside the portrait crop, edge visibility, and composition before enabling a crop.
- Unsafe camera analysis falls back to the original full frame with padding instead of guessing a center crop. Tracking caches from older camera schemas are ignored.
- Every clip now has a source/transcript/boundary artifact identity. Subtitle ASS, transcript slices, validation data, and render plans cannot collide across clips with different boundaries.
- AI responses now use a deterministic local cache keyed by provider, model, task, prompt version, and prompt hash. Identical analysis requests reuse approved output without another provider call.
- Render jobs enforce `render-only-zero-provider-requests`: changing crop, caption style, watermark, encoder, or output quality reuses analysis artifacts and cannot call hook/title AI.
- Cache metrics (`cache_hits` and `cache_misses`) are included in AI diagnostics. Prompt text is not duplicated into cache identity files.
- Hook generation rejects filler fragments and stale cached hooks when they are weaker than the approved title.
- Subtitle generation keeps audio-derived timing, word-level highlight, spacing, and coverage validation.
- Video enhancement defaults to natural/light processing and avoids the previous blue-tint failure mode.

## Local Service Evidence

| Area | Result | Evidence |
| --- | --- | --- |
| Cloud API | PASS | `http://127.0.0.1:4100/health/live` returned OK during local test |
| Web app | PASS | `http://127.0.0.1:3000` returned HTTP 200 during local test |
| Desktop QA | PASS | `npm run qa` completed with 104 Python tests passing |
| Cloud QA | PASS | `pnpm qa` completed typecheck, API tests, web tests, and Next production build |
| Web production build | PASS | Sequential web typecheck passed and Next generated 44 routes |
| Packaged desktop startup | PASS | New packaged EXE remained alive, opened `app.asar/index.html`, and emitted `renderer:did-finish-load` |
| Secret scan | PASS with warning | No tracked source matches for pasted provider/Midtrans keys, but pasted keys must still be rotated before deploy |

## Real Podcast E2E Evidence

Source test:

`https://youtu.be/zgkhJPjtEWA?si=p2lYaBnfxSSJeEZd`

Rendered sample:

`Local Test Builds/Beta-Stable-20260724-224138/rendered-samples/Cliper Local E2E 2026-07-24_225523/Clip/Telepon Kejutan yang Ubah Hidup Nunu.mp4`

Result:

- Metadata: PASS
- Analysis: PASS
- Highlight selection: PASS
- Billing reservation/settlement: PASS
- Render: PASS
- MP4 validation: PASS
- Temporary QA key revoke: PASS

Selected clip:

- Title: `Telepon Kejutan yang Ubah Hidup Nunu`
- Duration: 75 seconds
- Score: 74
- Reviewer approved: true
- AI evidence gate: true
- Reason: strong emotional story with natural payoff

Billing proof:

- Job status: COMPLETED
- Reserved: 2000 credits
- Charged: 350 credits
- Released: 1650 credits
- Provider cost: Rp 61
- AI requests: 11
- Provider route: DeepSeek for highlight tasks and OpenAI mini route for ranking/title tasks

## Final Camera Repair Render

Rendered sample:

`Local Test Builds/Render-Repair-Podcast-LastBeta/rendered-samples/Cliper Camera Final Podcast 2026-07-24_231559/Clip/Telepon Kejutan yang Ubah Hidup Nunu.mp4`

Validation:

- MP4 exists: PASS
- Video codec: H.264
- Audio codec: AAC
- Resolution: 1080x1920
- FPS: 30
- Duration: 75.066667 seconds
- Subtitle coverage: 98.8 percent
- Subtitle validation: PASS
- Camera source: visual activity fallback
- Camera layout: VISUAL_ACTIVITY_CUT
- Camera movement: hard-cut style, not slow pan
- Encoder fallback: NVENC failed, AMF succeeded
- Color: natural, no blue tint

Camera note:

The tested podcast did not provide verified diarization/active-speaker evidence. The engine correctly avoided fake speaker IDs and used visual activity hard cuts. True active-speaker cuts still require diarization, mouth movement, or a stronger speaker timeline on future samples.

## Human-Aware Camera Schema 4 Validation

The current camera patch was tested directly against the cached real podcast source for a 24-second window.

- Detected people: 4
- Human detection ratio: 93.3 percent
- Estimated portrait human coverage: 24.47 percent
- Safe visibility: 89.29 percent
- Composition score: 93/100
- Camera source: `human_tracks`
- Camera layout: `HUMAN_ACTIVITY_CUT`
- Keyframes: detected human centers at x=0.7099 and x=0.4229
- Invented speaker-zone mapping: false
- Slow pan: false

Two actual 1080x1920 crop frames were generated at those focus positions and visually inspected. Both contain valid people with safe heads and useful composition; neither crop points to an empty wall. This validates camera selection logic, but it is not a substitute for the required fresh five-clip manual batch test.

The earlier packaged-startup false alarm was also resolved. The QA shell inherited `ELECTRON_RUN_AS_NODE=1`, which makes Electron exit as a Node process. With that QA-only variable removed, the packaged application starts normally.

## Build Artifacts

Portable:

`dist/Cliper-Studio-Plus-Portable.exe`

SHA256:

`4997E1664E81EC384C985D2137D2E2BA397618F427DBEC60AD5D090D8DF7D1B8`

Installer:

`dist/Cliper-Studio-Plus-Setup.exe`

SHA256:

`14A0FFB33A25E69881405988FFDE21794E42B41B711ECD2D1CF0745357EC5619`

Checksum file:

`dist/SHA256SUMS-Last-Beta.txt`

## Known Limitations

- This pass validates local beta behavior, not public production deployment.
- Production Vercel, Railway, public domain, and Midtrans production payment were not tested.
- Only one full podcast E2E render was completed in this pass. Music, vlog, review, news, gaming, and product-review samples still need a manual sample matrix before public launch.
- The camera schema 4 patch has automated tests, real-source analysis, and visual crop-frame evidence, but still needs a fresh five-clip batch render to verify the final encoded output across different speaker layouts.
- Multi-clip subtitle isolation has regression coverage, but the required 5- and 10-clip real batch timing inspection remains a manual acceptance gate.
- Legacy web route modules still exist for backward-compatible URLs, but they are not present in the current user/admin navigation. Remove them only after confirming no production bookmarks or callbacks depend on them.
- The earlier E2E sample metadata may still show an old weak cached hook. The code now rejects that style of cached filler hook; run a fresh analysis to produce updated hook metadata.
- Heavy 4K-look filter was rejected by benchmark because overhead was too high; the actual render used integrated light enhancement. The log wording can be improved later to make this clearer.
- The worktree is intentionally dirty from active development. Review diffs before any commit.

## July 29 Camera And Heatmap Update

This update adds evidence sources without replacing the established render
pipeline:

- YouTube Most Replayed is optional highlight evidence. Peaks are bound to
  complete story boundaries and can contribute at most five score points.
- The heatmap parser accepts legacy renderer data, yt-dlp marker data, and the
  current compact YouTube marker shape. Missing heatmaps do not fail analysis.
- YuNet is the primary local face detector for small and profile faces; Haar
  remains the fallback. Persistent-track validation still rejects transient
  logo and edge detections.
- Transcript question/payoff beats add tightly bounded visual observations.
  Camera positions still come only from detected subjects.
- Camera story beats may inspect visual evidence up to 350 ms after the text
  boundary, matching the mouth-motion sample without changing ordinary cuts.
- The obsolete untracked `worker/speaker_engine_backup.py` was removed after
  confirming that it had no runtime imports.

Automated result:

- Python suite: 143 passed.
- Electron JavaScript syntax: PASS.
- Python compile: PASS.

Real-source camera QA used a 12-second podcast section containing a host
question and guest answer:

- Initial shot: center guest.
- Question at 2.16 seconds: right host.
- Answer/payoff at 6.599 seconds: center guest.
- Output: valid H.264/AAC MP4, 720x1280, 12.0 seconds.
- Camera preview:
  `qa-render-output-camera/host-question-yunet-preview.mp4`
- Camera manifest:
  `qa-render-output-camera/host-question-yunet-analysis.json`

The preview is a generated local QA artifact and is intentionally excluded
from Git.

## Manual Test Plan

1. Start local cloud with `npm run start:local-cloud`.
2. Open web at `http://127.0.0.1:3000`.
3. Login as admin, add/test providers, and verify AI Router status.
4. Login as user, generate a `clip_sk_` key.
5. In desktop Settings, use endpoint `http://127.0.0.1:4100/v1` and paste the `clip_sk_` key.
6. Click `Hubungkan & Test Cloud` until status is connected.
7. Test at least one podcast link and render one selected clip.
8. Repeat for music, vlog, product review, news, gaming, and reaction samples.
9. Confirm Output page opens the rendered folder.
10. Confirm web Usage and admin Revenue/Provider Usage update after desktop requests.

## Release Gate

Move to RC1 only after:

- At least five video categories pass analysis and render locally.
- Subtitle coverage stays above 98 percent for each sample.
- Camera framing is acceptable in solo, two-speaker, and multi-speaker samples.
- No stale/filler hook appears in fresh analysis output.
- Billing reservation, release, and provider cost logging remain idempotent.

Move to Cloud Beta only after:

- Vercel production deploy passes.
- Railway API deploy passes.
- Midtrans sandbox callback reaches the public API and credits wallet exactly once.
- All leaked/pasted provider and Midtrans keys are rotated.

## August 1 Phase 1-3 Acceptance

The three-phase master plan was reconciled with the current implementation.
Existing content profiling, bounded heatmap evidence, human-aware camera
planning, deterministic AI cache, per-clip render plans, hardware encoder
fallback, and production validation were retained instead of duplicated.

Resolved regression:

- ASS timestamps now carry centiseconds correctly across minute/hour boundaries.
- Hook deduplication is scoped to the hook intro and no longer removes a valid
  matching reply later in the clip.
- Very short spoken words keep their acoustic end timestamp.
- A subtitle validation failure is isolated to its clip; the remaining batch
  continues and the manifest reports the failed count honestly.

Automated acceptance:

- Electron JavaScript syntax: PASS.
- Python tests: 152 passed.
- Existing production batch: 10 requested, 10 rendered, 10 valid MP4 files.

Real regression render used the original failed podcast interval
`47:14-49:14` from the local source cache with all AI provider calls disabled:

- Runtime: about 3 minutes 42 seconds for a 120-second 720p QA render.
- Subtitle: PASS, 287 words, 291 ASS events, 100 percent coverage.
- Subtitle end: 119.47 seconds for a 120.07-second MP4.
- Camera: 19 planned events, zero wall crops, zero empty shots, zero timer resets.
- Output: H.264/AAC, 720x1280, NVENC, ffprobe valid.
- Production manifest check: 1 requested, 1 rendered, 1 valid MP4.
- Artifact: `Local Test Builds/Real-Render-20260801-202323/`.

Windows build acceptance:

- Installer: `dist/Cliper-Studio-Plus-Setup.exe`.
- Portable: `dist/Cliper-Studio-Plus-Portable.exe`.
- Clean-environment packaged executable smoke test: PASS.
- SHA-256 verification: PASS for both artifacts.
- Authenticode: `NotSigned`; Windows code-signing remains a release blocker,
  not a runtime failure.

Status remains **Last Beta Local**. Do not label this build public stable until
the content matrix, code signing, Cloud deployment, and payment gates above
have passed.

# Cliper Production System Specification

## Purpose

This document is the current source of truth for product boundaries and
production acceptance. It replaces historical implementation prompts; those
remain in `docs/archive/` for traceability only.

## Product boundary

Cliper Studio Plus is a local-first Electron video editor. The creator's PC
owns source media and every media-heavy operation:

- download, source cache, local import, and cookies;
- transcription, scene/audio analysis, face/person evidence, camera planning,
  subtitle generation, FFmpeg processing, and MP4 export;
- CPU/GPU encoder selection and all rendered artifacts.

Cliper AI Cloud is a control plane only. It owns accounts, sessions,
device-bound `clip_sk_` licenses, USD wallet/usage, provider-key custody, AI
routing, payment callbacks, and desktop release metadata. It must never accept
video uploads or run Whisper, FFmpeg, GPU processing, or cloud rendering.

## Canonical worktrees

```text
C:\Users\USER\Desktop\Cliper Ai Studio  Electron + Python worker
C:\Users\USER\Desktop\Cliper Ai Cloud   Web + API + PostgreSQL
```

`WEB PRODUCTION SAAS` inside the Desktop tree is a legacy Cloud worktree. It is
not an execution or deployment source.

## Desktop pipeline

```text
source/cache -> transcript -> local story/candidates -> compact AI review
-> selected moments -> camera/subtitle/render plans -> FFmpeg -> MP4 validation
```

The Cloud receives only bounded textual/editorial evidence and safe aggregate
job metadata. It never receives media bytes, local paths, frames, audio, or an
unbounded transcript.

## Editorial contracts

### Highlighting

- A recommendation needs story evidence: setup/context, meaningful event or
  question, and a natural payoff/end.
- Scores are evidence-based and calibrated; a high score must not be invented
  for UI presentation.
- Heatmap, audio peaks, emotion, chapter markers, and visual activity are
  corroborating signals. They do not replace story boundaries.
- Weak candidates remain manually reviewable and are not labelled auto-selected.

### Camera

- A camera event targets a verified person/subject track, never a fixed
  left/centre/right zone.
- Speaker evidence, face/body visibility, scene continuity, and composition
  determine the subject.
- Meaningful turns can trigger a cut; short backchannels, noise, and brief
  laughter must not cause churn.
- Invalid/stale tracks are rejected. Fallback order is validated speaker shot,
  valid two/group shot, then safe source framing. Empty/wall crops are invalid.
- Same-speaker monologues use safe shot variation, not random listener shots or
  a long pan across the scene.

### Subtitles and overlays

- Every clip uses one clip-local timeline beginning at `00:00.000`.
- Subtitle, hook, camera, watermark, and render plans use that same timeline.
- When captions are enabled, an ASS file with non-empty events and the subtitle
  filter are mandatory. A clip may not be marked successful without them.
- Phrase grouping is readable, normally 2-6 words, using pauses, punctuation,
  semantic phrase boundaries, and width limits.
- Preview settings and the emitted render plan share the same normalized style:
  font, size, spacing, stroke, shadow, safe margins, and watermark position.

### Render

- Build one `render_plan.json` per clip before FFmpeg.
- Apply in order: trim -> camera/crop -> scale -> light adaptive enhancement ->
  hook -> subtitle -> watermark -> final format.
- Prefer available NVENC, AMF, or QSV; make one bounded fallback to `libx264`.
- Validate every output with ffprobe: video/audio streams, H.264/AAC, expected
  dimensions/duration, playable MP4, subtitle coverage, and safe camera crops.
- Batch jobs are isolated: one failure is recorded per clip and must not corrupt
  another clip's artifacts or falsely mark the batch successful.

## Cache contract

- Source and transcript caches are reusable when their identity remains valid.
- Subtitle, camera, and render plans include source, clip boundary, and schema
  identity; an engine schema change invalidates only the affected artifact.
- Style-only rerenders reuse approved editorial analysis and do not call an AI
  provider again.

## Cloud contracts

### Environments

```text
Local Web:      http://127.0.0.1:3000
Local API:      http://127.0.0.1:4100
Local Gateway:  http://127.0.0.1:4100/v1
Production Web: https://www.cliperaicloud.online
Production API: Railway public API domain + /v1
```

Packaged production Electron must never silently fall back to `localhost` or
`127.0.0.1`.

### Identity and gateway

- Browser sessions use secure, HttpOnly first-party cookies through the Web
  proxy. Provider secrets remain server-side.
- Electron activates `clip_sk_` into a short-lived, device-bound session and
  signs worker requests. Raw provider keys never reach Electron.
- Every gateway request is associated with a user, license, request/job ID,
  provider/model, usage, reservation, and settlement outcome.

### Wallet and payments

- Production persistence is PostgreSQL; memory fallback is development only.
- A member sees one prepaid USD balance. Internal micro-USD integers protect
  accounting precision, but the Web and Electron UI never present a separate
  credit currency.
- A job reserves its protected cost estimate plus configured headroom before
  the first AI provider call, then settles actual protected cost and releases
  the unused balance. The configured maximum job charge is a safety ceiling,
  never a blanket reservation, login gate, or API-key requirement. A usable
  result, not a quality score, is the only condition for settlement.
- An active device-bound `clip_sk_` key remains connected at any wallet
  balance. A zero balance is rejected only when a specific paid operation
  cannot reserve its required USD amount.
- QRIS amount/status and the wallet balance are server-controlled. Payment
  completion is authoritative only after a verified provider webhook or
  official status reconciliation. Redirects and browser callbacks never alter
  the wallet.
- Ledger entries and callbacks are idempotent. Provider cost remains internal.
- The active payment provider stays disabled until its production credentials,
  public HTTPS notification URL, and one verified small live settlement are
  available.

## Deployment ownership

```text
Railway: @cliper/api + PostgreSQL
Vercel:  @cliper/web
```

Railway does not host the Web application or media workloads. Vercel forwards
browser `/cloud-api` traffic to the API through a server-side proxy.

## QA gates

Desktop is release-candidate ready only after a fresh worktree run proves:

1. syntax/unit/regression tests pass;
2. one real render passes manual and ffprobe validation;
3. a 5-10 clip batch proves subtitle isolation and per-clip failure isolation;
4. multiple content categories meet subtitle, camera, and output checks;
5. Setup and Portable builds start and are checksum-verified.

Cloud is deploy-ready only after local Prisma, API, and Web tests/builds pass;
then Railway health and Vercel production login/API-key flows are verified.

Public production also requires a rotated secret inventory, verified database
migrations, HTTPS cookie/auth checks, a valid provider configuration, and a
documented payment settlement test. A passing typecheck alone is never a
production claim.

## Security non-negotiables

- Never commit or display provider, Midtrans, password, session, encryption, or
  signing secrets.
- Rotate all secrets ever pasted into tickets, chat, screenshots, or logs before
  production use.
- Never reset or delete production data while validating a deployment.
- Preserve a known-good desktop build and migration history for rollback.

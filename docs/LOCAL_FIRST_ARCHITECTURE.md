# Local-First Architecture

Cliper Studio Plus is a desktop video editor. The creator's PC performs all
media work; Cliper AI Cloud is a companion service for account and editorial
intelligence only.

## Desktop ownership

The Electron app and Python worker own these operations locally:

- YouTube download, source cache, cookies, and local-video import.
- FFmpeg/FFprobe, Faster-Whisper, scene/audio analysis, face and person
  tracking, subtitle timing, camera planning, watermarking, and MP4 export.
- Source media, frames, audio samples, local file paths, render plans, and
  final files.

The worker may use CPU, NVIDIA NVENC, AMD AMF, Intel QSV, or `libx264` on the
creator's PC. Cloud services must never be required for the media pipeline to
finish once the editorial response has been received.

## Cloud ownership

Cliper AI Cloud provides:

- registration, login, device-bound `clip_sk_` licenses, wallet and usage;
- payment webhook processing and release/download metadata;
- provider key custody, AI routing, fallback, rate limiting, and billing;
- compact editorial decisions: content classification, candidate ranking,
  hook/title refinement, caption cleanup, and metadata suggestions.

Cloud does **not** accept, store, transcribe, render, or transcode user video.
It does not run FFmpeg, Whisper, or GPU workloads for a Cliper job.

## Desktop-to-Cloud contract

For analysis billing, Desktop sends only:

```json
{
  "requestId": "analysis-...",
  "sourceId": "sha256-prefix",
  "sourceDurationSeconds": 352,
  "requestedClipCount": 8
}
```

`sourceId` is derived locally and is not a source URL or local path. Completion
only sends aggregate clip scores and failure only sends a short safe error.

For AI, Desktop first creates a local story/candidate shortlist. Cloud receives
compact textual evidence, never media bytes, data URIs, frames, audio, local
paths, or full unbounded transcripts. The worker redacts accidental local
media references and rejects editorial requests above 48,000 characters.

## Guardrails

- Provider secrets stay in the Cloud API; Electron stores only `clip_sk_` and
  a short-lived desktop session using OS-backed secure storage.
- The Cloud API JSON body limit is 256 KB and it has no multipart media route.
- Rendering runs from one local render plan and produces output locally.
- Cloud outages affect only AI assistance and account validation. They do not
  turn the API into a media-processing service.

## Development rule

New features must preserve this boundary. A feature that needs source media,
frames, audio, FFmpeg, Whisper, GPU, or a render plan belongs in Desktop/worker,
not the Web/API worktree.

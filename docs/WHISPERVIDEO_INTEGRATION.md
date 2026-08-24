# WhisperVideo Speaker Grounding

Cliper can optionally consume audio-visual active-speaker evidence from
[showlab/whisperVideo](https://github.com/showlab/whisperVideo). The main
desktop runtime remains lightweight; WhisperVideo runs in a separate
Python 3.10/3.11 CUDA environment.

## Why It Is Optional

WhisperVideo uses a heavy stack including Torch, WhisperX, Pyannote,
TalkNet, identity embeddings, and SAM3. It also requires a Hugging Face
token for diarization and works best with CUDA. Installing this stack into
Cliper's core Python runtime would make ordinary CPU installations fragile.

The upstream repository contains components under different licenses.
Review and retain the upstream notices before redistribution. Cliper does
not bundle upstream model weights.

## Setup

```powershell
npm run setup:whispervideo
```

Create the isolated environment by following the upstream documentation.
After running WhisperVideo on a source video, export its trusted local
results:

```powershell
python scripts/export-whispervideo-grounding.py `
  --pywork "C:\path\to\video\pywork" `
  --video "C:\path\to\video\source.mp4" `
  --output "C:\path\to\source-cache\speaker_grounding.json"
```

Never run the exporter on pickle files downloaded from another person.

## Runtime Contract

The JSON sidecar uses schema `cliper.speaker-grounding.v1`:

```json
{
  "schema": "cliper.speaker-grounding.v1",
  "provider": "showlab/whisperVideo+TalkNet",
  "subjects": [
    {
      "external_id": "Person_01",
      "focus_x": 0.81,
      "focus_y": 0.48,
      "confidence": 0.91
    }
  ],
  "segments": [
    {
      "start": 12.2,
      "end": 16.8,
      "speakerId": "SPEAKER_01",
      "personId": "Person_01",
      "activeSpeakerProbability": 0.93
    }
  ]
}
```

Place the file beside the cached `source.mp4`, or set
`CLIPER_SPEAKER_GROUNDING_JSON`. Cliper maps external identities to its
local persistent tracks, prefers verified TalkNet intervals for camera
decisions, and falls back to local visual evidence elsewhere.

Subtitle word timestamps remain the source of truth. Speaker grounding is
metadata for camera direction and never changes subtitle timing.

## Local Camera Evidence Stack

WhisperVideo is an optional high-accuracy layer, not a requirement for every
desktop installation. The normal local fallback now uses:

```text
YuNet small/profile face detection
  -> Haar frontal/profile fallback
  -> persistent subject identity
  -> mouth/jaw motion
  -> transcript-guided observation windows
  -> story-aware question/answer handoff
  -> Camera Director
```

The bundled YuNet model is loaded locally from
`worker/models/face_detection_yunet_2023mar.onnx`. Its MIT notice is retained
beside the model. If the model or the required OpenCV API is unavailable,
Cliper continues with Haar detection and safe-wide fallback rather than
failing the render.

Transcript beats decide when to observe more closely, but never invent a
screen position. Every camera target must still come from a persistent
detected subject. Verified WhisperVideo/TalkNet intervals override the local
visual guess only for the interval they actually cover.

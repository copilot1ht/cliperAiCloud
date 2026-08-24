"""Export trusted WhisperVideo pickle output to Cliper's JSON contract.

Run this script only against output generated locally by WhisperVideo. Python
pickle is executable input and must never be accepted from an untrusted user.
"""

import argparse
import json
import pickle
import shutil
import subprocess
from pathlib import Path


def values(value):
    if hasattr(value, "tolist"):
        return value.tolist()
    return list(value or [])


def video_dimensions(video_path):
    if not video_path:
        return None
    ffprobe = shutil.which("ffprobe") or shutil.which("ffprobe.exe")
    if not ffprobe:
        raise SystemExit("ffprobe is required to normalize WhisperVideo pixel coordinates")
    result = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "json",
            str(Path(video_path).expanduser().resolve()),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(f"ffprobe failed: {result.stderr.strip()}")
    streams = (json.loads(result.stdout or "{}").get("streams") or [])
    if not streams:
        raise SystemExit("video stream was not found while normalizing WhisperVideo tracks")
    width = int(streams[0].get("width") or 0)
    height = int(streams[0].get("height") or 0)
    if width <= 0 or height <= 0:
        raise SystemExit("invalid video dimensions")
    return width, height


def normalized_axis(items, axis_size):
    result = [float(item) for item in items]
    if not result:
        return []
    if max(abs(item) for item in result) <= 1.5:
        return [max(0.0, min(1.0, item)) for item in result]
    if not axis_size:
        raise SystemExit(
            "WhisperVideo tracks contain pixel coordinates; pass --video so they can be normalized"
        )
    return [max(0.0, min(1.0, item / float(axis_size))) for item in result]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pywork", required=True)
    parser.add_argument("--video")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    pywork = Path(args.pywork).expanduser().resolve()
    timeline_path = pywork / "matched_diriazation.pckl"
    tracks_path = pywork / "tracks_identity.pckl"
    if not timeline_path.exists() or not tracks_path.exists():
        raise SystemExit("WhisperVideo output incomplete: matched_diriazation.pckl/tracks_identity.pckl not found")

    with timeline_path.open("rb") as handle:
        raw_segments = pickle.load(handle)
    with tracks_path.open("rb") as handle:
        raw_tracks = pickle.load(handle)

    dimensions = video_dimensions(args.video) if args.video else None
    video_width = dimensions[0] if dimensions else None
    video_height = dimensions[1] if dimensions else None
    subjects = []
    for track in raw_tracks if isinstance(raw_tracks, list) else []:
        if not isinstance(track, dict):
            continue
        identity = str(track.get("identity") or "").strip()
        details = track.get("proc_track") if isinstance(track.get("proc_track"), dict) else {}
        xs = normalized_axis(values(details.get("x")), video_width)
        ys = normalized_axis(values(details.get("y")), video_height)
        if not identity or not xs:
            continue
        subjects.append(
            {
                "external_id": identity,
                "focus_x": round(sum(xs) / len(xs), 6),
                "focus_y": round(sum(ys) / len(ys), 6) if ys else None,
                "sample_count": len(xs),
                "confidence": 0.90,
            }
        )

    segments = []
    for item in raw_segments if isinstance(raw_segments, list) else []:
        if not isinstance(item, dict):
            continue
        identity = str(item.get("identity") or item.get("personId") or "").strip()
        start = float(item.get("start") or 0.0)
        end = float(item.get("end") or start)
        if not identity or end <= start:
            continue
        segments.append(
            {
                "start": round(start, 6),
                "end": round(end, 6),
                "speakerId": str(item.get("speaker") or identity),
                "personId": identity,
                "activeSpeakerProbability": float(item.get("confidence") or 0.90),
                "text": str(item.get("text") or ""),
            }
        )

    if not subjects:
        raise SystemExit(
            "no visual identities were exported; verify tracks_identity.pckl and pass --video"
        )
    if not segments:
        raise SystemExit("no grounded speaker segments were exported")

    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(
            {
                "schema": "cliper.speaker-grounding.v1",
                "provider": "showlab/whisperVideo+TalkNet",
                "subjects": subjects,
                "segments": segments,
                "source_video": str(Path(args.video).expanduser().resolve()) if args.video else None,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(output)


if __name__ == "__main__":
    main()

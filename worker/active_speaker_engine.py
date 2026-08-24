import json
import math
import os
from pathlib import Path


GROUNDING_SCHEMA = "cliper.speaker-grounding.v1"


def _finite_number(value, default=0.0):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return float(default)
    return number if math.isfinite(number) else float(default)


def _clean_id(value):
    return str(value or "").strip()


def speaker_grounding_fingerprint(path):
    if not path:
        return None
    try:
        source_path = Path(path)
        stat = source_path.stat()
        return f"{source_path.resolve()}:{stat.st_size}:{stat.st_mtime_ns}"
    except OSError:
        return None


def discover_speaker_grounding_path(video_path=None, explicit_path=None):
    """Find a JSON speaker-grounding sidecar without loading unsafe pickle files."""
    candidates = []
    if explicit_path:
        candidates.append(Path(str(explicit_path)).expanduser())
    configured = os.environ.get("CLIPER_SPEAKER_GROUNDING_JSON")
    if configured:
        candidates.append(Path(configured).expanduser())
    if video_path:
        source = Path(str(video_path)).expanduser()
        candidates.extend(
            [
                source.parent / "speaker_grounding.json",
                source.with_suffix(".speaker-grounding.json"),
                source.parent / "whispervideo" / "speaker_grounding.json",
            ]
        )
    for candidate in candidates:
        try:
            if candidate.exists() and candidate.is_file():
                return candidate.resolve()
        except OSError:
            continue
    return None


def load_speaker_grounding(path, clip_start=0.0, duration=None):
    """Load normalized WhisperVideo/TalkNet evidence from a safe JSON sidecar."""
    if not path:
        return {
            "available": False,
            "verified": False,
            "source": "local_visual_fallback",
            "subjects": [],
            "segments": [],
        }
    source_path = Path(path)
    try:
        if source_path.stat().st_size > 32 * 1024 * 1024:
            raise ValueError("speaker grounding JSON exceeds the 32 MB safety limit")
        payload = json.loads(source_path.read_text(encoding="utf-8", errors="replace"))
    except Exception as exc:
        return {
            "available": False,
            "verified": False,
            "source": "invalid_grounding_json",
            "path": str(source_path),
            "reason": str(exc),
            "subjects": [],
            "segments": [],
        }

    if isinstance(payload, list):
        payload = {"segments": payload}
    if not isinstance(payload, dict):
        return {
            "available": False,
            "verified": False,
            "source": "invalid_grounding_schema",
            "path": str(source_path),
            "subjects": [],
            "segments": [],
        }

    provider = _clean_id(payload.get("provider") or payload.get("source") or "external")
    schema = _clean_id(payload.get("schema"))
    raw_subjects = payload.get("subjects") or payload.get("identities") or []
    if isinstance(raw_subjects, dict):
        raw_subjects = [
            {"external_id": subject_id, **(value if isinstance(value, dict) else {})}
            for subject_id, value in raw_subjects.items()
        ]
    subjects = []
    for index, item in enumerate(raw_subjects if isinstance(raw_subjects, list) else []):
        if not isinstance(item, dict):
            continue
        external_id = _clean_id(
            item.get("external_id")
            or item.get("personId")
            or item.get("person_id")
            or item.get("identity")
            or item.get("subject_id")
            or f"external_{index + 1:02d}"
        )
        focus_x = _finite_number(item.get("focus_x", item.get("x")), -1.0)
        focus_y = _finite_number(item.get("focus_y", item.get("y")), -1.0)
        subjects.append(
            {
                "external_id": external_id,
                "focus_x": round(focus_x, 5) if 0.0 <= focus_x <= 1.0 else None,
                "focus_y": round(focus_y, 5) if 0.0 <= focus_y <= 1.0 else None,
                "confidence": round(
                    max(0.0, min(1.0, _finite_number(item.get("confidence"), 0.85))),
                    4,
                ),
                "sample_count": max(0, int(_finite_number(item.get("sample_count"), 0))),
            }
        )

    raw_segments = (
        payload.get("segments")
        or payload.get("speaker_timeline")
        or payload.get("active_speakers")
        or []
    )
    normalized_raw = []
    for item in raw_segments if isinstance(raw_segments, list) else []:
        if not isinstance(item, dict):
            continue
        start = _finite_number(item.get("start", item.get("start_time")), 0.0)
        end = _finite_number(item.get("end", item.get("end_time")), start)
        if end <= start:
            continue
        person_id = _clean_id(
            item.get("personId")
            or item.get("person_id")
            or item.get("identity")
            or item.get("subject_id")
        )
        speaker_id = _clean_id(
            item.get("speakerId")
            or item.get("speaker_id")
            or item.get("speaker")
            or person_id
        )
        confidence = _finite_number(
            item.get(
                "activeSpeakerProbability",
                item.get("active_speaker_probability", item.get("confidence", item.get("score"))),
            ),
            0.85,
        )
        normalized_raw.append(
            {
                "start": start,
                "end": end,
                "speaker_id": speaker_id,
                "person_id": person_id,
                "confidence": max(0.0, min(1.0, confidence)),
                "text": str(item.get("text") or "").strip(),
            }
        )

    clip_start = max(0.0, _finite_number(clip_start, 0.0))
    clip_duration = (
        max(0.0, _finite_number(duration, 0.0))
        if duration is not None
        else None
    )
    looks_relative = False
    if normalized_raw and clip_duration is not None:
        maximum_end = max(item["end"] for item in normalized_raw)
        minimum_start = min(item["start"] for item in normalized_raw)
        looks_relative = maximum_end <= clip_duration + 2.0 and minimum_start < max(5.0, clip_duration)

    segments = []
    for item in normalized_raw:
        start = item["start"] if looks_relative else item["start"] - clip_start
        end = item["end"] if looks_relative else item["end"] - clip_start
        if clip_duration is not None:
            if end <= 0.0 or start >= clip_duration:
                continue
            start = max(0.0, start)
            end = min(clip_duration, end)
        if end <= start:
            continue
        segments.append(
            {
                **item,
                "start": round(start, 4),
                "end": round(end, 4),
                "confidence": round(item["confidence"], 4),
            }
        )

    trusted_schema = schema == GROUNDING_SCHEMA
    talknet_source = "talknet" in provider.lower() or "whispervideo" in provider.lower()
    trusted_segments = [
        item
        for item in segments
        if item.get("person_id")
        and item.get("speaker_id")
        and item.get("confidence", 0.0) >= 0.50
    ]
    verified = bool(trusted_segments) and (trusted_schema or talknet_source)
    return {
        "available": bool(trusted_segments),
        "verified": verified,
        "schema": schema or GROUNDING_SCHEMA,
        "source": provider,
        "path": str(source_path),
        "input_fingerprint": speaker_grounding_fingerprint(source_path),
        "subjects": subjects,
        "segments": trusted_segments,
        "rejected_segment_count": max(0, len(segments) - len(trusted_segments)),
        "timeline_source": "relative" if looks_relative else "source_absolute",
    }


def _map_external_subjects(external_subjects, local_subjects):
    local_by_id = {
        _clean_id(item.get("subject_id")): item
        for item in local_subjects or []
        if _clean_id(item.get("subject_id"))
    }
    mapping = {}
    claimed = set()
    for external in sorted(
        external_subjects or [],
        key=lambda item: (
            _finite_number(item.get("sample_count"), 0.0),
            _finite_number(item.get("confidence"), 0.0),
        ),
        reverse=True,
    ):
        external_id = _clean_id(external.get("external_id"))
        if not external_id:
            continue
        if external_id in local_by_id:
            mapping[external_id] = {
                "subject_id": external_id,
                "confidence": 1.0,
                "evidence": "exact_identity",
            }
            claimed.add(external_id)
            continue
        focus_x = external.get("focus_x")
        if focus_x is None:
            continue
        focus_y = external.get("focus_y")
        options = []
        for subject_id, local in local_by_id.items():
            if subject_id in claimed:
                continue
            x_distance = abs(_finite_number(local.get("focus_x"), 0.5) - float(focus_x))
            y_distance = (
                abs(_finite_number(local.get("focus_y"), 0.5) - float(focus_y))
                if focus_y is not None and local.get("focus_y") is not None
                else 0.0
            )
            distance = x_distance + y_distance * 0.35
            options.append((distance, subject_id))
        if not options:
            continue
        distance, subject_id = min(options)
        if distance > 0.22:
            continue
        mapping[external_id] = {
            "subject_id": subject_id,
            "confidence": round(max(0.50, 1.0 - distance / 0.30), 4),
            "evidence": "spatial_identity_alignment",
        }
        claimed.add(subject_id)
    return mapping


def fuse_speaker_grounding(local_events, local_subjects, grounding):
    """Prefer verified TalkNet intervals and retain local evidence outside them."""
    grounding = grounding if isinstance(grounding, dict) else {}
    if not grounding.get("verified"):
        return list(local_events or []), {
            **grounding,
            "speaker_subject_map": {},
            "mapped_segments": [],
        }

    identity_map = _map_external_subjects(
        grounding.get("subjects") or [],
        local_subjects or [],
    )
    local_ids = {
        _clean_id(item.get("subject_id"))
        for item in local_subjects or []
        if _clean_id(item.get("subject_id"))
    }
    mapped_segments = []
    speaker_subject_map = {}
    for segment in grounding.get("segments") or []:
        external_id = _clean_id(segment.get("person_id"))
        mapped = identity_map.get(external_id)
        if mapped is None and external_id in local_ids:
            mapped = {
                "subject_id": external_id,
                "confidence": 1.0,
                "evidence": "exact_identity",
            }
        if mapped is None:
            continue
        confidence = min(
            _finite_number(segment.get("confidence"), 0.0),
            _finite_number(mapped.get("confidence"), 0.0),
        )
        if confidence < 0.50:
            continue
        subject_id = mapped["subject_id"]
        speaker_id = _clean_id(segment.get("speaker_id") or external_id)
        normalized = {
            **segment,
            "subject_id": subject_id,
            "speaker": speaker_id,
            "confidence": round(confidence, 4),
            "verified": True,
            "evidence": "talknet_audio_visual_grounding",
            "turn_evidence": round(
                min(
                    1.0,
                    confidence
                    * (
                        0.72
                        + min(
                            0.28,
                            max(0.0, segment["end"] - segment["start"]) / 3.0 * 0.28,
                        )
                    ),
                ),
                4,
            ),
        }
        mapped_segments.append(normalized)
        current = speaker_subject_map.get(speaker_id)
        if current is None or confidence > current["confidence"]:
            speaker_subject_map[speaker_id] = {
                "subject_id": subject_id,
                "confidence": round(confidence, 4),
                "evidence": "talknet_audio_visual_grounding",
            }

    if not mapped_segments:
        return list(local_events or []), {
            **grounding,
            "verified": False,
            "speaker_subject_map": {},
            "mapped_segments": [],
            "reason": "external identities could not be aligned with local tracks",
        }

    def covered_by_verified(event):
        event_time = _finite_number(event.get("time"), 0.0)
        return any(
            segment["start"] - 0.08 <= event_time <= segment["end"] + 0.08
            for segment in mapped_segments
        )

    fused = [
        dict(event)
        for event in local_events or []
        if not covered_by_verified(event)
    ]
    local_by_id = {
        _clean_id(item.get("subject_id")): item
        for item in local_subjects or []
    }
    for segment in mapped_segments:
        duration = max(0.0, segment["end"] - segment["start"])
        subject = local_by_id.get(segment["subject_id"]) or {}
        event_times = [segment["start"]]
        if duration >= 0.70:
            event_times.append(min(segment["end"] - 0.05, segment["start"] + min(1.0, duration * 0.55)))
        for event_time in event_times:
            fused.append(
                {
                    "time": round(max(0.0, event_time), 4),
                    "subject_id": segment["subject_id"],
                    "speaker": segment["speaker"],
                    "focus_x": subject.get("focus_x"),
                    "confidence": segment["confidence"],
                    "run_samples": len(event_times),
                    "run_duration": round(duration, 4),
                    "sustained": duration >= 0.65,
                    "speaker_verified": True,
                    "turn_evidence": segment.get("turn_evidence"),
                    "evidence": "talknet_audio_visual_grounding",
                }
            )
    fused.sort(key=lambda item: _finite_number(item.get("time"), 0.0))
    return fused, {
        **grounding,
        "verified": True,
        "speaker_subject_map": speaker_subject_map,
        "mapped_segments": mapped_segments,
        "mapped_segment_count": len(mapped_segments),
    }


def merge_speaker_context_with_grounding(context, grounding):
    context = dict(context or {})
    grounded = grounding.get("mapped_segments") or []
    if not grounding.get("verified") or not grounded:
        return context
    turns = [
        {
            "start": round(_finite_number(item.get("start"), 0.0), 4),
            "end": round(_finite_number(item.get("end"), 0.0), 4),
            "speaker": _clean_id(item.get("speaker") or item.get("person_id")),
            "subject_id": _clean_id(item.get("subject_id")),
            "confidence": round(_finite_number(item.get("confidence"), 0.0), 4),
            "speaker_verified": True,
            "evidence": "talknet_audio_visual_grounding",
        }
        for item in grounded
        if _finite_number(item.get("end"), 0.0) > _finite_number(item.get("start"), 0.0)
    ]
    speakers = []
    for turn in turns:
        if turn["speaker"] and turn["speaker"] not in speakers:
            speakers.append(turn["speaker"])
    boundaries = sorted(
        {
            boundary
            for turn in turns
            for boundary in (turn["start"], turn["end"])
        }
    )
    overlap_seconds = 0.0
    for start, end in zip(boundaries, boundaries[1:]):
        if end <= start:
            continue
        active_speakers = {
            turn["speaker"]
            for turn in turns
            if turn["speaker"] and turn["start"] < end and turn["end"] > start
        }
        if len(active_speakers) >= 2:
            overlap_seconds += end - start
    return {
        **context,
        "speakers": speakers,
        "speaker_count": len(speakers),
        "turns": turns,
        "overlap_seconds": round(overlap_seconds, 4),
        "grounding_verified": True,
        "grounding_source": grounding.get("source"),
    }

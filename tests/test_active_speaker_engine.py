import json
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))

from active_speaker_engine import (
    fuse_speaker_grounding,
    load_speaker_grounding,
    merge_speaker_context_with_grounding,
)
from camera_engine import CameraEngine


def write_grounding(tmp_path, payload):
    path = tmp_path / "speaker_grounding.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_grounding_normalizes_source_timeline_to_clip_time(tmp_path):
    path = write_grounding(
        tmp_path,
        {
            "schema": "cliper.speaker-grounding.v1",
            "provider": "showlab/whisperVideo+TalkNet",
            "subjects": [
                {
                    "external_id": "Person_01",
                    "focus_x": 0.82,
                    "focus_y": 0.45,
                    "confidence": 0.94,
                }
            ],
            "segments": [
                {
                    "start": 120.0,
                    "end": 124.5,
                    "speakerId": "SPEAKER_01",
                    "personId": "Person_01",
                    "activeSpeakerProbability": 0.92,
                }
            ],
        },
    )

    result = load_speaker_grounding(path, clip_start=120.0, duration=10.0)

    assert result["verified"] is True
    assert result["timeline_source"] == "source_absolute"
    assert result["segments"][0]["start"] == 0.0
    assert result["segments"][0]["end"] == 4.5
    assert result["input_fingerprint"]


def test_grounding_maps_external_identity_to_nearest_persistent_subject(tmp_path):
    path = write_grounding(
        tmp_path,
        {
            "schema": "cliper.speaker-grounding.v1",
            "provider": "showlab/whisperVideo+TalkNet",
            "subjects": [
                {"external_id": "Person_01", "focus_x": 0.81, "focus_y": 0.44}
            ],
            "segments": [
                {
                    "start": 2.0,
                    "end": 5.2,
                    "speakerId": "host",
                    "personId": "Person_01",
                    "activeSpeakerProbability": 0.93,
                }
            ],
        },
    )
    grounding = load_speaker_grounding(path, clip_start=0.0, duration=8.0)
    events, result = fuse_speaker_grounding(
        [
            {"time": 0.2, "subject_id": "guest", "focus_x": 0.50, "confidence": 0.82},
            {"time": 3.0, "subject_id": "guest", "focus_x": 0.50, "confidence": 0.80},
        ],
        [
            {"subject_id": "guest", "focus_x": 0.50, "focus_y": 0.45},
            {"subject_id": "right_host", "focus_x": 0.82, "focus_y": 0.44},
        ],
        grounding,
    )

    assert result["speaker_subject_map"]["host"]["subject_id"] == "right_host"
    grounded_events = [item for item in events if item.get("speaker_verified")]
    assert grounded_events
    assert {item["subject_id"] for item in grounded_events} == {"right_host"}
    assert all(item["turn_evidence"] >= 0.8 for item in grounded_events)


def test_untrusted_or_low_confidence_grounding_does_not_claim_verified(tmp_path):
    path = write_grounding(
        tmp_path,
        {
            "provider": "generic-json",
            "segments": [
                {
                    "start": 0.0,
                    "end": 3.0,
                    "speakerId": "speaker",
                    "personId": "person",
                    "confidence": 0.98,
                }
            ],
        },
    )

    result = load_speaker_grounding(path, duration=5.0)

    assert result["available"] is True
    assert result["verified"] is False


def test_grounded_question_answer_cuts_and_ignores_short_backchannel():
    plan = CameraEngine().build_editor_plan(
        speakers=[
            {"speaker": "host", "subject_id": "right_host"},
            {"speaker": "guest", "subject_id": "center_guest"},
        ],
        scene={
            "content_type": "podcast",
            "speaker_evidence": True,
            "speaker_grounding_mode": "FULL",
            "subject_tracks": [
                {
                    "subject_id": "right_host",
                    "focus_x": 0.82,
                    "focus_y": 0.45,
                    "visibility": 0.75,
                    "confidence": 0.86,
                    "safe_visibility": 1.0,
                },
                {
                    "subject_id": "center_guest",
                    "focus_x": 0.51,
                    "focus_y": 0.45,
                    "visibility": 0.94,
                    "confidence": 0.91,
                    "safe_visibility": 1.0,
                },
            ],
            "activity_events": [
                {
                    "time": 0.1,
                    "subject_id": "right_host",
                    "confidence": 0.91,
                    "run_duration": 2.2,
                    "sustained": True,
                    "speaker_verified": True,
                    "turn_evidence": 0.92,
                },
                {
                    "time": 2.4,
                    "subject_id": "center_guest",
                    "confidence": 0.93,
                    "run_duration": 4.0,
                    "sustained": True,
                    "speaker_verified": True,
                    "turn_evidence": 0.95,
                },
                {
                    "time": 5.0,
                    "subject_id": "right_host",
                    "confidence": 0.92,
                    "run_duration": 0.3,
                    "sustained": False,
                    "speaker_verified": True,
                    "turn_evidence": 0.60,
                },
            ],
            "story_beats": [
                {
                    "time": 0.3,
                    "end": 2.1,
                    "type": "question",
                    "speaker": "host",
                    "speaker_verified": True,
                    "confidence": 0.86,
                }
            ],
        },
        duration=8.0,
    )

    events = plan["camera_events"]
    assert plan["evidence_mode"] == "audio_visual_grounding+story_evidence"
    assert events[0]["subject_id"] == "right_host"
    assert any(
        item["subject_id"] == "center_guest" and item["reason"] == "answerer_turn"
        for item in events
    )
    assert not any(
        item["subject_id"] == "right_host" and 4.7 <= item["start"] <= 5.3
        for item in events
    )


def test_grounded_overlap_is_recomputed_for_split_screen_decisions():
    context = merge_speaker_context_with_grounding(
        {"overlap_seconds": 0.0},
        {
            "verified": True,
            "source": "talknet",
            "mapped_segments": [
                {
                    "start": 1.0,
                    "end": 3.2,
                    "speaker": "host",
                    "subject_id": "right_host",
                    "confidence": 0.91,
                },
                {
                    "start": 2.0,
                    "end": 4.0,
                    "speaker": "guest",
                    "subject_id": "center_guest",
                    "confidence": 0.93,
                },
            ],
        },
    )

    assert context["speaker_count"] == 2
    assert context["overlap_seconds"] == 1.2

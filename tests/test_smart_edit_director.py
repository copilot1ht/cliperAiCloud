import math
from pathlib import Path
import sys
import pytest

ROOT = Path(__file__).resolve().parents[1]
WORKER_ROOT = ROOT / "worker"
for path in (ROOT, WORKER_ROOT):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import camera_engine
from camera_engine import (
    SmartEditDirector,
    validate_edit_plan,
    create_keyframe,
    create_overlay_event,
    SpeakerAttentionMap,
    KEYFRAME_STATIC,
    KEYFRAME_PUNCH_IN,
    KEYFRAME_REACTION_FOCUS,
    KEYFRAME_GAMEPLAY_FOCUS,
    KEYFRAME_PRODUCT_FOCUS,
    KEYFRAME_SCREEN_FOCUS,
    KEYFRAME_FACECAM_FOCUS,
    KEYFRAME_WIDE_RETURN,
    EVENT_IMPORTANT_POINT,
    EVENT_REACTION,
    EVENT_GAMEPLAY_CLIMAX,
    EVENT_PAYOFF,
    EVENT_PRODUCT_SHOW,
    EVENT_VERDICT,
    EVENT_SCREEN_REFERENCE,
    EVENT_STREAMER_REACTION,
    OVERLAY_SCREEN_FOCUS,
    OVERLAY_SOURCE_REGION,
)
import cliper_worker


def test_smart_edit_director_mode_initialization():
    director_auto = SmartEditDirector("auto")
    assert director_auto.content_mode == "auto"
    assert director_auto.profile == "AUTO_EDIT"

    director_podcast = SmartEditDirector("podcast")
    assert director_podcast.content_mode == "podcast"
    assert director_podcast.profile == "PODCAST_DYNAMIC"

    director_gaming = SmartEditDirector("gaming")
    assert director_gaming.content_mode == "gaming"
    assert director_gaming.profile == "GAMING_SPLIT"

    director_summary = SmartEditDirector("summary")
    assert director_summary.content_mode == "summary"
    assert director_summary.profile == "SUMMARY_COMPOSED"

    director_blur = SmartEditDirector("landscape_blur")
    assert director_blur.content_mode == "landscape_blur"
    assert director_blur.profile == "LANDSCAPE_BLUR"


def test_event_driven_keyframes_and_motion_budget():
    director = SmartEditDirector("podcast")
    story_beats = [
        {"time": 2.5, "type": EVENT_IMPORTANT_POINT, "reason": "speaker emphasis"},
        {"time": 4.0, "type": EVENT_IMPORTANT_POINT, "reason": "too soon - should be skipped by budget"},
        {"time": 8.5, "type": EVENT_REACTION, "reason": "listener laugh"},
    ]
    cuts = [{"start": 0.0, "end": 12.0, "focus_x": 0.5, "focus_y": 0.45}]
    keyframes = director._plan_podcast_keyframes(story_beats, cuts, 12.0, punch_scale=1.06, min_motion_gap=4.0)

    # First event at 2.5s should be included
    assert len(keyframes) == 2
    assert keyframes[0]["type"] in {KEYFRAME_PUNCH_IN, "PUNCH_IN"}
    assert keyframes[0]["startTime"] == 2.5
    assert keyframes[0]["startScale"] == 1.00
    assert keyframes[0]["endScale"] == 1.06
    assert keyframes[0]["reason"] == "important_point_emphasis"

    # Second event at 4.0s skipped due to motion budget (gap < 4.0s)
    # Third event at 8.5s should be included as reaction focus
    assert keyframes[1]["type"] in {KEYFRAME_REACTION_FOCUS, "REACTION_FOCUS"}
    assert keyframes[1]["startTime"] == 8.5
    assert keyframes[1]["startScale"] == 1.00
    assert keyframes[1]["endScale"] <= 1.06


def test_punch_in_suppression_on_recent_cuts():
    director = SmartEditDirector("podcast")
    story_beats = [
        {"time": 5.2, "type": EVENT_IMPORTANT_POINT, "reason": "clashing with cut"},
    ]
    # Cut at 5.0s is within 0.8s of the beat at 5.2s
    cuts = [
        {"start": 0.0, "end": 5.0, "focus_x": 0.3},
        {"start": 5.0, "end": 10.0, "focus_x": 0.7},
    ]
    keyframes = director._plan_podcast_keyframes(story_beats, cuts, 10.0, punch_scale=1.06, min_motion_gap=4.0)
    assert keyframes == []


def test_speaker_hysteresis_and_interjection_filtering():
    director = SmartEditDirector("podcast")
    speaker_timeline = {
        "turns": [
            {"speaker": "Alice", "start": 0.0, "end": 4.5, "text": "Kita mulai pembahasan utama hari ini."},
            {"speaker": "Bob", "start": 4.6, "end": 5.1, "text": "iya"},  # Short interjection, should be ignored
            {"speaker": "Alice", "start": 5.2, "end": 7.0, "text": "Lalu konsep keduanya adalah..."},
            {"speaker": "Bob", "start": 7.2, "end": 11.0, "text": "Menurut saya hal itu sangat menarik dan relevan."},
        ]
    }
    face_analysis = {
        "focus_x": 0.5,
        "subject_tracks": [
            {"speaker": "Alice", "focus_x": 0.35},
            {"speaker": "Bob", "focus_x": 0.65},
        ]
    }
    cuts, _ = director._plan_podcast_cuts(speaker_timeline, face_analysis, 11.0)

    # Bob's brief "iya" (0.5s) must not trigger a cut to Bob
    # There should only be Alice -> Bob main handoff at ~7.2s
    speakers = [c.get("speaker") for c in cuts]
    assert speakers == ["Alice", "Bob"]
    assert len(cuts) == 2
    assert cuts[0]["start"] == 0.0
    assert cuts[0]["end"] == 7.2
    assert cuts[0]["focus_x"] == 0.35
    assert cuts[1]["start"] == 7.2
    assert cuts[1]["end"] == 11.0
    assert cuts[1]["focus_x"] == 0.65


def test_gaming_split_layout_with_facecam():
    director = SmartEditDirector("gaming")
    face_analysis = {
        "face_count": 1,
        "subject_tracks": [
            {
                "track_id": "face_1",
                "kind": "face",
                "focus_x": 0.78,
                "focus_y": 0.72,
                "confidence": 0.88,
                "detected_region": [0.62, 0.50, 0.28, 0.32],
            },  # Bottom right streamer cam
        ]
    }
    story_beats = [
        {"time": 6.0, "type": EVENT_GAMEPLAY_CLIMAX, "reason": "epic boss kill"},
        {"time": 10.0, "type": EVENT_REACTION, "reason": "streamer excitement"},
    ]
    plan = director.plan_edit(
        duration=15.0,
        story_beats=story_beats,
        face_analysis=face_analysis,
    )

    assert plan["layout"] == "GAMING_SPLIT"
    assert plan["editingProfile"] == "GAMING_SPLIT"
    assert any(sr["type"] == "facecam" for sr in plan["safeRegions"])
    assert any(sr["type"] == "gameplay_hud" for sr in plan["safeRegions"])

    # Keyframes should focus on gameplay and reaction
    kf_types = [kf["type"] for kf in plan["keyframes"]]
    assert any(k in kf_types for k in (KEYFRAME_GAMEPLAY_FOCUS, "GAMEPLAY_FOCUS"))
    assert any(k in kf_types for k in (KEYFRAME_REACTION_FOCUS, "REACTION_FOCUS"))


def test_gaming_split_layout_fallback_when_no_facecam():
    director = SmartEditDirector("gaming")
    face_analysis = {
        "face_count": 0,
        "subject_tracks": []
    }
    plan = director.plan_edit(
        duration=15.0,
        face_analysis=face_analysis,
    )

    # When no streamer facecam is detected, never hallucinate facecam.
    # Preserve the full gameplay frame with a blurred portrait background.
    assert plan["layout"] == "LANDSCAPE_BLUR"
    assert not any(sr.get("type") == "facecam" for sr in plan["safeRegions"])
    assert any(sr.get("type") == "full_landscape" for sr in plan["safeRegions"])


def test_podcast_preserves_two_person_frame_without_speaker_grounding():
    director = SmartEditDirector("podcast")
    face_analysis = {
        "face_count": 2,
        "person_count": 2,
        "average_faces": 1.12,
        "subject_tracks": [
            {"subject_id": "person_01", "focus_x": 0.52, "confidence": 0.86}
        ],
        "editor_plan": {"qa": {"rawSubjectCount": 4}},
    }
    plan = director.plan_edit(
        duration=20.0,
        face_analysis=face_analysis,
        story_beats=[{"time": 6.0, "type": "QUESTION"}],
    )

    assert plan["resolvedMode"] == "podcast"
    assert plan["layout"] == "LANDSCAPE_BLUR"
    assert plan["cuts"][0]["shot"] == "wide"
    assert plan["cuts"][0]["reason"] == "two_person_preserve_no_speaker_grounding"
    assert any(sr.get("type") == "two_person_wide" for sr in plan["safeRegions"])


def test_auto_routes_multisubject_talking_head_to_podcast():
    director = SmartEditDirector("auto")
    plan = director.plan_edit(
        duration=12.0,
        face_analysis={
            "face_count": 2,
            "person_count": 2,
            "average_faces": 1.4,
            "subject_tracks": [],
        },
    )

    assert plan["resolvedMode"] == "podcast"


def test_landscape_blur_renderer_plan():
    director = SmartEditDirector("landscape_blur")
    story_beats = [
        {"time": 4.5, "type": EVENT_PAYOFF, "reason": "punchline payoff"},
    ]
    plan = director.plan_edit(
        duration=10.0,
        story_beats=story_beats,
    )

    assert plan["layout"] == "LANDSCAPE_BLUR"
    assert plan["editingProfile"] == "LANDSCAPE_BLUR"
    assert any(sr["type"] == "full_landscape" and sr.get("no_crop") is True for sr in plan["safeRegions"])

    # Generates subtle punch-in on payoff
    assert len(plan["keyframes"]) == 1
    assert plan["keyframes"][0]["endScale"] <= 1.06


def test_overlay_events_foundation():
    director = SmartEditDirector("auto")
    visual_detections = [
        {"type": "CHART", "time": 3.0, "duration": 2.5, "region": [0.1, 0.1, 0.8, 0.8]},
    ]
    plan = director.plan_edit(
        duration=10.0,
        visual_detections=visual_detections,
    )

    assert len(plan["overlays"]) == 1
    ov = plan["overlays"][0]
    assert ov["type"] == OVERLAY_SCREEN_FOCUS
    assert ov["startTime"] == 3.0
    assert ov["endTime"] == 5.5
    assert ov["reason"] == "visual_chart_reference"


def test_edit_plan_validator_graceful_degradation():
    # Corrupted / invalid input should be repaired safely without exception
    corrupted_plan = {
        "cuts": [
            {"start": -5.0, "end": 20.0, "focus_x": 2.5},  # Out of bounds
        ],
        "keyframes": [
            {"startTime": -2.0, "endTime": 1.0, "startScale": 0.5, "endScale": 2.5},  # Extreme scale
        ],
        "overlays": "invalid_type",
    }
    validated = validate_edit_plan(corrupted_plan, clip_duration=10.0)

    assert validated["qa"]["valid"] is True
    assert validated["cuts"][0]["start"] == 0.0
    assert validated["cuts"][0]["end"] == 10.0
    assert validated["cuts"][0]["focus_x"] <= 0.95

    assert validated["keyframes"][0]["startScale"] >= 1.0
    assert validated["keyframes"][0]["endScale"] <= 1.15
    assert validated["overlays"] == []


def test_gaming_split_filter_generation():
    edit_plan = {
        "layout": "GAMING_SPLIT",
        "safeRegions": [
            {"type": "gameplay_hud", "region": [0.0, 0.0, 1.0, 1.0]},
            {"type": "facecam", "region": [0.62, 0.50, 0.36, 0.40]},
        ],
    }
    vf = cliper_worker.gaming_split_filter(1080, 1920, edit_plan=edit_plan)
    assert "split=3[gameplay_bg_src][gameplay_fg_src][facecam_src]" in vf
    assert "[gameplay_bg_src]crop=w='iw*1.0000'" in vf
    assert "[gameplay_fg_src]crop=w='iw*1.0000'" in vf
    assert "force_original_aspect_ratio=decrease" in vf
    assert "boxblur=14:3" in vf
    assert "[facecam_src]crop=w='iw*0.4200'" in vf
    assert "vstack=inputs=2" in vf
    assert "drawbox=" in vf  # Divider between streams


def test_render_wires_clip_transcript_to_smart_edit_director():
    source = (ROOT / "worker" / "cliper_worker.py").read_text(encoding="utf-8")
    assert "transcript=clip_transcript" in source
    assert "transcript=transcript" not in source
    assert "visual_detections = (" in source
    assert "payload.get(\"visualDetections\")" in source


def test_gaming_split_filter_uses_detected_safe_regions():
    edit_plan = {
        "layout": "GAMING_SPLIT",
        "safeRegions": [
            {"type": "gameplay_hud", "region": [0.0, 0.0, 1.0, 0.75]},
            {"type": "facecam", "region": [0.62, 0.50, 0.36, 0.40]},
        ],
    }
    vf = cliper_worker.gaming_split_filter(1080, 1920, edit_plan=edit_plan)
    assert "[gameplay_bg_src]crop=w='iw*1.0000':h='ih*0.7500'" in vf
    assert "[gameplay_fg_src]crop=w='iw*1.0000':h='ih*0.7500'" in vf
    assert "[facecam_src]crop=w='iw*0.4200':h='ih*0.5100'" in vf
    assert "x='iw*0.5800':y='ih*0.4450'" in vf


def test_landscape_blur_filter_generation():
    vf = cliper_worker.landscape_blur_filter(1080, 1920)
    assert "split=2[bg_raw][fg_raw]" in vf
    assert "boxblur=20:5" in vf
    assert "overlay=(W-w)/2:(H-h)/2" in vf


def test_build_video_filter_routes_landscape_blur():
    payload = {"formatProfile": "9:16", "resolutionProfile": "1080p", "contentMode": "landscape_blur"}
    vf = cliper_worker.build_video_filter(payload)
    assert "boxblur=20:5" in vf
    assert "overlay=(W-w)/2:(H-h)/2" in vf


def test_build_video_filter_routes_gaming_split():
    payload = {"formatProfile": "9:16", "resolutionProfile": "1080p", "contentMode": "gaming"}
    edit_plan = {
        "layout": "GAMING_SPLIT",
        "gameplay_ratio": 0.65,
        "safeRegions": [
            {"type": "gameplay_hud", "region": [0.0, 0.0, 1.0, 1.0]},
            {"type": "facecam", "region": [0.62, 0.50, 0.36, 0.40]},
        ],
    }
    vf = cliper_worker.build_video_filter(payload, edit_plan=edit_plan)
    assert "split=3[gameplay_bg_src][gameplay_fg_src][facecam_src]" in vf
    assert "vstack=inputs=2" in vf


def test_build_video_filter_generates_keyframe_zoom_expression():
    payload = {"formatProfile": "9:16", "resolutionProfile": "1080p", "contentMode": "podcast", "dynamicZoom": True}
    edit_plan = {
        "layout": "PODCAST_DYNAMIC",
        "keyframes": [
            {"startTime": 2.0, "endTime": 4.0, "type": "KEYFRAME_PUNCH_IN", "startScale": 1.00, "endScale": 1.07}
        ]
    }
    vf = cliper_worker.build_video_filter(payload, edit_plan=edit_plan)
    # Filtergraph should contain scale with dynamic zoom expression
    assert "eval=frame" in vf
    assert "ceil(iw*(" in vf


def test_real_smoke_render_landscape_blur_with_ffprobe(tmp_path):
    import subprocess
    import json
    out_file = tmp_path / "smoke_blur.mp4"
    vf = cliper_worker.landscape_blur_filter(1080, 1920)
    cmd = [
        "ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=blue:s=1280x720:d=1",
        "-filter_complex", vf,
        "-c:v", "libx264", "-t", "1", str(out_file)
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    probe_cmd = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "json", str(out_file)
    ]
    probe = subprocess.run(probe_cmd, check=True, capture_output=True)
    data = json.loads(probe.stdout)
    assert data["streams"][0]["width"] == 1080
    assert data["streams"][0]["height"] == 1920


def test_real_smoke_render_gaming_split_with_ffprobe(tmp_path):
    import subprocess
    import json
    out_file = tmp_path / "smoke_gaming.mp4"
    vf = cliper_worker.gaming_split_filter(1080, 1920)
    cmd = [
        "ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=red:s=1280x720:d=1",
        "-filter_complex", vf,
        "-c:v", "libx264", "-t", "1", str(out_file)
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    probe_cmd = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "json", str(out_file)
    ]
    probe = subprocess.run(probe_cmd, check=True, capture_output=True)
    data = json.loads(probe.stdout)
    assert data["streams"][0]["width"] == 1080
    assert data["streams"][0]["height"] == 1920


def test_speaker_attention_map_builder():
    speaker_timeline = {
        "turns": [
            {"speaker": "spk_1", "start": 0.0, "end": 5.0, "text": "Kuncinya adalah memahami kebutuhan pasar.", "speaking_prob": 0.98},
            {"speaker": "spk_2", "start": 5.2, "end": 8.0, "text": "Wah gila itu keren banget!", "speaking_prob": 0.95},
        ]
    }
    face_analysis = {
        "subject_tracks": [
            {"speaker": "spk_1", "focus_x": 0.35, "confidence": 0.92},
            {"speaker": "spk_2", "focus_x": 0.65, "confidence": 0.89},
        ]
    }
    attention_map = SpeakerAttentionMap.build(
        speaker_timeline=speaker_timeline,
        face_analysis=face_analysis,
        clip_start=0.0,
        clip_end=10.0,
    )
    assert len(attention_map.regions) == 2
    r0 = attention_map.regions[0]
    assert r0["speakerId"] == "spk_1"
    assert r0["semanticImportance"] >= 0.8
    assert r0["confidence"] == 0.92

    r1 = attention_map.regions[1]
    assert r1["speakerId"] == "spk_2"
    assert r1["reactionProbability"] >= 0.7


def test_normalized_keyframe_section_c_schema():
    kf = create_keyframe(
        start=14.2,
        end=14.8,
        type="PUNCH_IN",
        scaleFrom=1.00,
        scaleTo=1.07,
        focusTarget="speaker_1",
        easing="easeInOut",
        reason="important_point",
    )
    # Section C Standard Attributes
    assert kf["start"] == 14.2
    assert kf["end"] == 14.8
    assert kf["type"] == "PUNCH_IN"
    assert kf["scaleFrom"] == 1.00
    assert kf["scaleTo"] == 1.07
    assert kf["focusTarget"] == "speaker_1"
    assert kf["easing"] == "easeInOut"
    assert kf["reason"] == "important_point"

    # Legacy Compatibility Attributes
    assert kf["startTime"] == 14.2
    assert kf["endTime"] == 14.8
    assert kf["startScale"] == 1.00
    assert kf["endScale"] == 1.07


def test_review_product_keyframes_choreography():
    director = SmartEditDirector("summary")
    story_beats = [
        {"time": 2.0, "type": EVENT_PRODUCT_SHOW, "reason": "presenting flagship device"},
        {"time": 8.0, "type": EVENT_SCREEN_REFERENCE, "reason": "benchmark screen demonstration"},
        {"time": 14.0, "type": EVENT_VERDICT, "reason": "final device verdict"},
    ]
    cuts = [{"start": 0.0, "end": 20.0, "focus_x": 0.5}]
    keyframes = director._plan_review_product_keyframes(
        story_beats, cuts, clip_duration=20.0, punch_scale=1.06, min_motion_gap=3.0
    )

    types = [k["type"] for k in keyframes]
    # Choreography: PRODUCT_FOCUS -> WIDE_RETURN to presenter -> SCREEN_FOCUS -> verdict PUNCH_IN
    assert any(k in types for k in (KEYFRAME_PRODUCT_FOCUS, "PRODUCT_FOCUS"))
    assert any(k in types for k in (KEYFRAME_WIDE_RETURN, "WIDE_RETURN"))
    assert any(k in types for k in (KEYFRAME_SCREEN_FOCUS, "SCREEN_FOCUS"))
    assert any(k in types for k in (KEYFRAME_PUNCH_IN, "PUNCH_IN"))

    product_kf = next(k for k in keyframes if k["type"] in {KEYFRAME_PRODUCT_FOCUS, "PRODUCT_FOCUS"})
    assert product_kf["focusTarget"] == "product"
    assert product_kf["scaleTo"] >= 1.06

    verdict_kf = next(k for k in keyframes if k["reason"] == "verdict_punch")
    assert verdict_kf["scaleTo"] <= 1.05


def test_gaming_streamer_reaction_enlarge_and_hud_protection():
    director = SmartEditDirector("gaming")
    face_analysis = {
        "face_count": 1,
        "subject_tracks": [
            {
                "track_id": "face_1",
                "kind": "face",
                "focus_x": 0.80,
                "focus_y": 0.70,
                "confidence": 0.9,
                "detected_region": [0.64, 0.52, 0.28, 0.30],
            }
        ],
    }
    story_beats = [
        {"time": 4.0, "type": EVENT_STREAMER_REACTION, "reason": "clutch reaction"},
    ]
    plan = director.plan_edit(duration=12.0, story_beats=story_beats, face_analysis=face_analysis)

    # Streamer reaction generates FACECAM_FOCUS
    kf_types = [k["type"] for k in plan["keyframes"]]
    assert any(k in kf_types for k in (KEYFRAME_FACECAM_FOCUS, "FACECAM_FOCUS"))

    # Safe regions must protect all critical HUD items
    safe_types = {sr["type"] for sr in plan["safeRegions"]}
    assert "hud_crosshair" in safe_types
    assert "hud_minimap" in safe_types
    assert "hud_health" in safe_types
    assert "hud_killfeed" in safe_types
    assert "subtitle_safe" in safe_types


def test_edit_plan_normalized_structure_and_qa_telemetry():
    director = SmartEditDirector("podcast")
    speaker_timeline = {
        "turns": [
            {"speaker": "Alice", "start": 0.0, "end": 4.0, "text": "Kenapa topik ini sangat menarik?"},
            {"speaker": "Bob", "start": 4.5, "end": 10.0, "text": "Jawabannya kuncinya adalah inovasi berkelanjutan."},
        ]
    }
    story_beats = [
        {"time": 1.5, "type": "QUESTION", "reason": "opening question"},
        {"time": 6.0, "type": "ANSWER", "reason": "deep explanation"},
    ]
    plan = director.plan_edit(
        duration=10.0,
        speaker_timeline=speaker_timeline,
        story_beats=story_beats,
    )

    # Section A Normalized Edit Plan Architecture
    assert "contentMode" in plan
    assert "layout" in plan
    assert "storyEvents" in plan
    assert "cameraEvents" in plan
    assert "keyframes" in plan
    assert "cuts" in plan
    assert "overlays" in plan
    assert "safeRegions" in plan
    assert "transitions" in plan

    # QA Telemetry
    qa = plan["qa"]
    assert qa["valid"] is True
    assert qa["mode"] == "podcast"
    assert qa["storyType"] in {"question_answer", "podcast_discussion"}
    assert qa["cutCount"] >= 1
    assert qa["motionBudgetCompliant"] is True
    assert qa["fallback"] is False


def test_source_based_overlays_from_story_beats():
    director = SmartEditDirector("summary")
    story_beats = [
        {"time": 3.0, "type": "SCREEN_REFERENCE", "reason": "speaker explains dashboard"},
        {"time": 8.0, "type": "BROLL_OPPORTUNITY", "reason": "speaker describes outdoor test"},
    ]
    plan = director.plan_edit(duration=15.0, story_beats=story_beats)
    assert len(plan["overlays"]) == 2
    types = [ov["type"] for ov in plan["overlays"]]
    assert OVERLAY_SCREEN_FOCUS in types
    assert OVERLAY_SOURCE_REGION in types


def test_visual_storyboard_five_modes():
    """Verify all 5 content modes produce exact storyboard beats matching the v1.13.x infographic."""
    from camera_engine import get_mode_storyboard_beats, build_visual_storyboard

    # 1. AUTO / SMART
    auto_beats = get_mode_storyboard_beats("auto", duration=50.0)
    auto_names = [b["name"] for b in auto_beats]
    assert auto_names == ["Hook", "Context", "Important Point", "Visual Reference", "Payoff"]
    assert auto_beats[0]["start"] == 0.0
    assert auto_beats[-1]["end"] == 50.0

    # 2. PODCAST / INTERVIEW
    pod_beats = get_mode_storyboard_beats("podcast", duration=60.0)
    pod_names = [b["name"] for b in pod_beats]
    assert pod_names == ["Setup", "Question", "Answer / Insight", "Reaction", "Conclusion"]
    assert pod_beats[0]["shotType"] == "WIDE_TWO_SHOT"
    assert pod_beats[-1]["shotType"] == "WIDE_RETURN"

    # 3. GAMING / STREAMER
    game_beats = get_mode_storyboard_beats("gaming", duration=60.0)
    game_names = [b["name"] for b in game_beats]
    assert game_names == ["Setup", "Build-up", "Action / Climax", "Result", "Streamer Reaction"]
    assert game_beats[0]["shotType"] == "SPLIT_65_35"

    # 4. REVIEW / SMART SUMMARY
    review_beats = get_mode_storyboard_beats("summary", duration=125.0)
    review_names = [b["name"] for b in review_beats]
    assert review_names == ["Hook", "Feature", "Demo", "Weakness", "Verdict"]

    # 5. LANDSCAPE / BLUR
    blur_beats = get_mode_storyboard_beats("landscape_blur", duration=60.0)
    blur_names = [b["name"] for b in blur_beats]
    assert blur_names == ["Establishing", "Highlight", "Detail", "Closing"]

    # Test build_visual_storyboard integrates beats
    plan = {
        "duration": 50.0,
        "contentMode": "auto",
        "resolvedMode": "auto",
        "layout": "PORTRAIT_SINGLE",
        "cuts": [{"start": 0.0, "end": 50.0, "speaker": "spk1"}],
        "keyframes": [],
    }
    sb = build_visual_storyboard(plan)
    assert "storyboardBeats" in sb
    assert len(sb["storyboardBeats"]) == 5
    assert len(sb["scenes"]) >= 1
    assert "storyboardPhase" in sb["scenes"][0]


def test_detect_gaming_regions_with_corner_tracks_without_explicit_kind():
    """Verify corner streamer facecam is detected even if subject track omits kind='face'."""
    director = SmartEditDirector("gaming")
    face_analysis = {
        "subject_tracks": [
            {
                "subject_id": "streamer_corner",
                "focus_x": 0.82,
                "focus_y": 0.75,
                "confidence": 0.85,
            }
        ]
    }
    region, gameplay = director._detect_gaming_regions(
        visual_detections=[],
        face_analysis=face_analysis,
        source_dims=[1920, 1080],
    )
    assert region is not None
    assert len(region) == 4
    # Corner coordinates centered around (0.82, 0.75)
    assert 0.65 <= region[0] <= 0.85
    assert 0.60 <= region[1] <= 0.80


def test_podcast_insight_punch_in():
    """Verify insight story beats generate punch-in keyframe per podcast editing behavior."""
    director = SmartEditDirector("podcast")
    story_beats = [
        {"time": 4.0, "type": "INSIGHT", "reason": "speaker explains core insight"},
    ]
    cuts = [{"start": 0.0, "end": 15.0, "focus_x": 0.5}]
    keyframes = director._plan_podcast_keyframes(story_beats, cuts, 15.0, punch_scale=1.06, min_motion_gap=3.0)
    assert len(keyframes) == 1
    assert keyframes[0]["type"] in {KEYFRAME_PUNCH_IN, "PUNCH_IN"}
    assert keyframes[0]["reason"] == "insight_punch_in"
    assert keyframes[0]["endScale"] == 1.06


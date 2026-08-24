import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))

from worker.camera_engine import CameraEngine
import cliper_worker


def test_director_builds_varied_shot_sequences():
    engine = CameraEngine()
    shots = engine.build_shot_sequence(
        speakers=[{"speaker": "A"}, {"speaker": "B"}, {"speaker": "C"}],
        scene={"speaker_count": 3, "emotion": 0.8, "overlap_seconds": 0.0},
        duration=12.0,
    )

    assert shots[0]["shot"] == "wide"
    assert any(item["zone"] == "LEFT" for item in shots)
    assert any(item["zone"] == "RIGHT" for item in shots)
    assert any(item["shot"] == "close" for item in shots)
    assert all(item["transition"] == "hard_cut" for item in shots)
    assert all(150 <= item["transition_ms"] <= 250 for item in shots)
    assert all(item["end"] > item["start"] for item in shots)


def test_duo_sequence_uses_split_when_overlap_is_high():
    engine = CameraEngine()
    shots = engine.build_shot_sequence(
        speakers=[{"speaker": "A"}, {"speaker": "B"}],
        scene={"speaker_count": 2, "emotion": 0.6, "overlap_seconds": 1.5},
        duration=8.0,
    )

    assert shots[0]["shot"] == "split"
    assert shots[0]["zone"] == "CENTER"


def test_subtitle_fontsdir_contains_only_selected_font(tmp_path):
    source_dir = tmp_path / "font-package"
    source_dir.mkdir()
    font_path = source_dir / "CaptionBold.ttf"
    font_path.write_bytes(b"test-font-binary")
    (source_dir / "OFL.txt").write_text("license text", encoding="utf-8")

    fonts_dir = cliper_worker.isolated_subtitle_fonts_dir(font_path)

    assert fonts_dir is not None
    assert (fonts_dir / font_path.name).read_bytes() == b"test-font-binary"
    assert not (fonts_dir / "OFL.txt").exists()


def test_long_podcast_never_holds_one_camera_decision_too_long():
    shots = CameraEngine().build_shot_sequence(
        speakers=[{"speaker": "A", "zone": "LEFT"}, {"speaker": "B", "zone": "RIGHT"}],
        scene={"speaker_count": 2, "emotion": 0.7, "overlap_seconds": 0.0},
        duration=180.0,
    )

    assert len(shots) >= 28
    assert max(item["end"] - item["start"] for item in shots) <= 6.0
    assert {item["zone"] for item in shots} >= {"LEFT", "RIGHT"}


def test_decide_camera_action_returns_director_style_cut():
    engine = CameraEngine()
    result = engine.decide_camera_action([
        {"speaker": "A", "score": 0.8},
        {"speaker": "B", "score": 0.4},
    ], current_time=0.0)

    assert result["action"] == "cut"
    assert result["shot"] in {"close", "medium"}
    assert result["zone"] in {"LEFT", "CENTER", "RIGHT"}


def test_director_preserves_detected_speaker_zones_and_measured_focus():
    shots = CameraEngine().build_shot_sequence(
        speakers=[
            {"speaker": "guest", "zone": "RIGHT"},
            {"speaker": "host", "zone": "LEFT"},
        ],
        scene={
            "speaker_count": 2,
            "zone_focus": {"LEFT": 0.27, "CENTER": 0.51, "RIGHT": 0.74},
        },
        duration=12.0,
    )

    guest_shots = [item for item in shots if item["speaker"] == "guest" and item["shot"] != "wide"]
    host_shots = [item for item in shots if item["speaker"] == "host" and item["shot"] != "wide"]
    assert guest_shots and {item["zone"] for item in guest_shots} == {"RIGHT"}
    assert host_shots and {item["zone"] for item in host_shots} == {"LEFT"}
    assert {item["focus_x"] for item in guest_shots} == {0.74}
    assert {item["focus_x"] for item in host_shots} == {0.27}


def test_camera_action_uses_top_speaker_detected_zone_and_holds_previous_zone():
    engine = CameraEngine()
    first = engine.decide_camera_action(
        [{"speaker": "guest", "zone": "RIGHT", "score": 0.9}],
        current_time=10.0,
    )
    held = engine.decide_camera_action(
        [
            {"speaker": "host", "zone": "LEFT", "score": 0.92},
            {"speaker": "guest", "zone": "RIGHT", "score": 0.7},
        ],
        current_time=10.2,
    )

    assert first["zone"] == "RIGHT"
    assert held["speaker"] == "guest"
    assert held["zone"] == "RIGHT"


def test_visual_active_subject_prefers_mouth_activity_over_larger_quiet_face():
    active = cliper_worker.select_visual_active_subject([
        {
            "x": 0.28,
            "area": 0.055,
            "kind": "face",
            "mouth_motion": 0.04,
            "frame_motion": 0.08,
        },
        {
            "x": 0.73,
            "area": 0.026,
            "kind": "face",
            "mouth_motion": 0.88,
            "frame_motion": 0.25,
        },
    ])

    assert active["x"] == 0.73


def test_visual_active_subject_hysteresis_ignores_small_one_frame_challenge():
    previous = {
        "x": 0.27,
        "area": 0.035,
        "kind": "face",
        "mouth_motion": 0.52,
        "frame_motion": 0.18,
    }
    active = cliper_worker.select_visual_active_subject(
        [
            {**previous, "x": 0.28, "mouth_motion": 0.48},
            {
                "x": 0.76,
                "area": 0.039,
                "kind": "face",
                "mouth_motion": 0.55,
                "frame_motion": 0.24,
            },
        ],
        previous_active=previous,
    )

    assert active["x"] == 0.28


def test_profile_jaw_articulation_beats_quiet_frontal_head_motion():
    quiet_frontal = cliper_worker.visual_speech_motion_score(
        mouth_motion=0.10,
        jaw_motion=0.14,
        upper_face_motion=0.30,
        frame_motion=0.34,
        detector="frontal",
    )
    speaking_profile = cliper_worker.visual_speech_motion_score(
        mouth_motion=0.18,
        jaw_motion=0.72,
        upper_face_motion=0.17,
        frame_motion=0.40,
        detector="profile_left",
    )

    assert speaking_profile > quiet_frontal + 0.45


def test_news_profile_stays_stable_without_repeating_close_zoom():
    shots = CameraEngine().build_shot_sequence(
        speakers=[{"speaker": "anchor"}],
        scene={"speaker_count": 1, "content_type": "news"},
        duration=30.0,
    )

    assert {shot["shot"] for shot in shots} <= {"wide", "medium"}
    assert max(shot["end"] - shot["start"] for shot in shots) <= 7.5


def test_review_profile_has_context_evidence_and_verdict_shots():
    shots = CameraEngine().build_shot_sequence(
        speakers=[{"speaker": "reviewer"}],
        scene={"speaker_count": 1, "content_type": "review"},
        duration=24.0,
    )

    reasons = {shot["reason"] for shot in shots}
    assert "product evidence" in reasons
    assert "verdict" in reasons


def test_visual_faces_do_not_invent_speaker_identities_without_diarization():
    speakers, count, verified = cliper_worker.verified_camera_speakers({
        "speakers": [],
        "speaker_count": 0,
        "overlap_seconds": 0,
    })
    shots = CameraEngine().build_shot_sequence(
        speakers=speakers,
        scene={
            "face_count": 4,
            "visual_subject_count": 4,
            "speaker_count": count,
            "speaker_evidence": verified,
            "content_type": "news",
        },
        duration=30.0,
    )

    assert verified is False
    assert count == 1
    assert {shot["speaker"] for shot in shots} == {"subject"}
    assert {shot["zone"] for shot in shots} == {"CENTER"}


def test_verified_duo_maps_to_left_and_right_zones():
    speakers, count, verified = cliper_worker.verified_camera_speakers({
        "speakers": ["host", "guest"],
        "speaker_count": 2,
    })

    assert verified is True
    assert count == 2
    assert speakers == [
        {"speaker": "host", "zone": "LEFT"},
        {"speaker": "guest", "zone": "RIGHT"},
    ]


def test_director_focus_expression_uses_hard_cuts_not_slow_pan():
    expression = cliper_worker.focus_curve_expression({
        "focus_x": 0.5,
        "camera_director": [
            {"start": 0.0, "focus_x": 0.2},
            {"start": 3.0, "focus_x": 0.8},
            {"start": 6.0, "focus_x": 0.5},
        ],
    })

    assert expression == "if(lt(t,3),0.2,if(lt(t,6),0.8,0.5))"
    assert "(t -" not in expression


def test_visual_fallback_expression_uses_hard_cuts_not_slow_pan():
    expression = cliper_worker.focus_curve_expression({
        "focus_x": 0.5,
        "keyframes": [
            {"t": 0.0, "x": 0.25},
            {"t": 4.0, "x": 0.75},
            {"t": 8.0, "x": 0.5},
        ],
    })

    assert expression == "if(lt(t,4),0.25,if(lt(t,8),0.75,0.5))"
    assert "(t -" not in expression


def test_visual_cut_keyframes_keep_verified_human_centers_and_dedupe_jitter():
    keyframes = cliper_worker.visual_cut_keyframes(
        [0.18, 0.22, 0.81, 0.78, 0.52, 0.48],
        duration=18.0,
        max_points=8,
        min_gap=0.0,
    )

    assert [item["x"] for item in keyframes] == [0.18, 0.81, 0.52]
    assert keyframes[0]["t"] == 0.0


def test_visual_cut_keyframes_accept_human_detection_records():
    keyframes = cliper_worker.visual_cut_keyframes(
        [{"x": 0.31, "kind": "face"}, {"x": 0.33, "kind": "face"}, {"x": 0.72, "kind": "body"}],
        duration=9.0,
        max_points=8,
        min_gap=0.0,
    )

    assert [item["x"] for item in keyframes] == [0.31, 0.72]


def test_human_safe_fallback_preserves_full_frame_instead_of_empty_center_crop():
    payload = {
        "formatProfile": "9:16 YouTube Shorts",
        "resolutionProfile": "1080p",
        "smartCrop": True,
        "dynamicZoom": True,
        "disableAutoEnhancement": True,
        "disable4KLook": True,
    }
    filters = cliper_worker.build_video_filter(
        payload,
        focus_x={"human_safe_fallback": True, "focus_x": None},
    )

    assert "force_original_aspect_ratio=decrease" in filters
    assert "pad=1080:1920" in filters
    assert "iw*(" not in filters


def test_human_shot_eligibility_rejects_tiny_or_edge_only_subjects():
    result = cliper_worker.human_shot_eligibility(
        detection_ratio=0.8,
        human_coverage=0.04,
        safe_visibility_ratio=0.45,
        person_count=1,
        face_count=1,
    )

    assert result["eligible"] is False
    assert "human subject too small for portrait crop" in result["rejectionReasons"]
    assert "human subject is too close to frame edge" in result["rejectionReasons"]


def test_human_shot_eligibility_accepts_stable_safe_portrait_subject():
    result = cliper_worker.human_shot_eligibility(
        detection_ratio=0.86,
        human_coverage=0.24,
        safe_visibility_ratio=0.94,
        person_count=2,
        face_count=2,
    )

    assert result["eligible"] is True
    assert result["compositionScore"] >= 80
    assert result["backgroundRatio"] == 0.76


def test_legacy_generic_speaker_labels_are_not_verified():
    context = cliper_worker.speaker_timeline_context([
        {"start": 0, "end": 2, "speaker_id": "A", "text": "caption cache lama"},
        {"start": 2, "end": 4, "speaker_id": "B", "text": "caption cache lama"},
    ])

    assert context["speakers"] == []
    assert context["speaker_count"] == 0


def test_subject_track_ids_follow_people_instead_of_screen_zones():
    tracks = {}
    first, tracks, next_id = cliper_worker.assign_subject_track_ids(
        [
            {"x": 0.24, "y": 0.40, "w": 0.10, "h": 0.18, "area": 0.018, "kind": "face"},
            {"x": 0.74, "y": 0.42, "w": 0.11, "h": 0.19, "area": 0.020, "kind": "face"},
        ],
        tracks,
        1,
        0.0,
    )
    second, tracks, next_id = cliper_worker.assign_subject_track_ids(
        [
            {"x": 0.28, "y": 0.41, "w": 0.10, "h": 0.18, "area": 0.018, "kind": "face"},
            {"x": 0.70, "y": 0.43, "w": 0.11, "h": 0.19, "area": 0.020, "kind": "face"},
        ],
        tracks,
        next_id,
        1.5,
    )

    first_by_side = sorted(first, key=lambda item: item["x"])
    second_by_side = sorted(second, key=lambda item: item["x"])
    assert first_by_side[0]["subject_id"] == second_by_side[0]["subject_id"]
    assert first_by_side[1]["subject_id"] == second_by_side[1]["subject_id"]
    assert len({item["subject_id"] for item in first + second}) == 2


def test_spatial_track_consolidation_keeps_returning_profile_host():
    merged, aliases = cliper_worker.consolidate_spatial_subject_tracks(
        {
            "person_04": [
                {
                    "time": 1.5,
                    "x": 0.80,
                    "y": 0.47,
                    "w": 0.08,
                    "h": 0.11,
                    "area": 0.008,
                    "kind": "face",
                },
                {
                    "time": 3.0,
                    "x": 0.81,
                    "y": 0.48,
                    "w": 0.08,
                    "h": 0.11,
                    "area": 0.008,
                    "kind": "face",
                },
            ],
            "person_08": [
                {
                    "time": 9.0,
                    "x": 0.84,
                    "y": 0.49,
                    "w": 0.08,
                    "h": 0.11,
                    "area": 0.0082,
                    "kind": "face",
                },
                {
                    "time": 10.5,
                    "x": 0.83,
                    "y": 0.48,
                    "w": 0.08,
                    "h": 0.11,
                    "area": 0.0081,
                    "kind": "face",
                },
            ],
        }
    )

    assert aliases["person_08"] == "person_04"
    assert len(merged["person_04"]) == 4


def test_spatial_track_consolidation_never_merges_concurrent_people():
    merged, aliases = cliper_worker.consolidate_spatial_subject_tracks(
        {
            "person_01": [
                {
                    "time": 2.0,
                    "x": 0.75,
                    "y": 0.45,
                    "w": 0.08,
                    "h": 0.11,
                    "area": 0.008,
                    "kind": "face",
                }
            ],
            "person_02": [
                {
                    "time": 2.0,
                    "x": 0.81,
                    "y": 0.46,
                    "w": 0.08,
                    "h": 0.11,
                    "area": 0.008,
                    "kind": "face",
                }
            ],
        }
    )

    assert aliases["person_01"] != aliases["person_02"]
    assert len(merged) == 2


def test_subject_validation_rejects_transient_logo_and_keeps_persistent_faces():
    accepted, rejected, minimum_samples = cliper_worker.validate_subject_tracks(
        [
            {
                "subject_id": "person_01",
                "focus_x": 0.28,
                "focus_y": 0.44,
                "visibility": 0.55,
                "confidence": 0.68,
                "safe_visibility": 1.0,
                "average_area": 0.012,
                "kind": "face",
                "sample_count": 11,
            },
            {
                "subject_id": "logo_false_positive",
                "focus_x": 0.78,
                "focus_y": 0.04,
                "visibility": 0.05,
                "confidence": 0.15,
                "safe_visibility": 1.0,
                "average_area": 0.003,
                "kind": "face",
                "sample_count": 1,
            },
        ],
        total_samples=20,
    )

    assert minimum_samples == 2
    assert [item["subject_id"] for item in accepted] == ["person_01"]
    assert rejected[0]["subject_id"] == "logo_false_positive"
    assert "transient_track" in rejected[0]["reasons"]
    assert "non_human_face_region" in rejected[0]["reasons"]


def test_subject_validation_keeps_three_sample_profile_questioner():
    accepted, rejected, minimum_samples = cliper_worker.validate_subject_tracks(
        [
            {
                "subject_id": "right_questioner",
                "focus_x": 0.82,
                "focus_y": 0.48,
                "visibility": 3 / 38,
                "confidence": 0.27,
                "safe_visibility": 1.0,
                "average_area": 0.008,
                "profile_ratio": 1.0,
                "kind": "face",
                "sample_count": 3,
            }
        ],
        total_samples=42,
    )

    assert minimum_samples == 3
    assert [item["subject_id"] for item in accepted] == ["right_questioner"]
    assert rejected == []


def test_editor_director_defensively_rejects_transient_subject_tracks():
    plan = CameraEngine().build_editor_plan(
        speakers=[],
        scene={
            "content_type": "podcast",
            "min_subject_samples": 3,
            "subject_tracks": [
                {
                    "subject_id": "person_01",
                    "focus_x": 0.28,
                    "focus_y": 0.44,
                    "visibility": 0.8,
                    "confidence": 0.82,
                    "safe_visibility": 1.0,
                    "sample_count": 8,
                },
                {
                    "subject_id": "transient",
                    "focus_x": 0.82,
                    "focus_y": 0.05,
                    "visibility": 0.05,
                    "confidence": 0.18,
                    "safe_visibility": 1.0,
                    "sample_count": 1,
                },
            ],
            "activity_events": [
                {"time": 0.2, "subject_id": "person_01", "confidence": 0.82},
                {"time": 3.0, "subject_id": "transient", "confidence": 0.95},
                {"time": 5.0, "subject_id": "person_01", "confidence": 0.80},
            ],
        },
        duration=8.0,
    )

    assert {item["subject_id"] for item in plan["camera_events"]} == {"person_01"}
    assert {item["subject_id"] for item in plan["subject_tracks"]} == {"person_01"}


def test_editor_director_uses_subject_activity_and_story_evidence():
    plan = CameraEngine().build_editor_plan(
        speakers=[
            {"speaker": "host", "subject_id": "person_01"},
            {"speaker": "guest", "subject_id": "person_02"},
        ],
        scene={
            "content_type": "podcast",
            "camera_style": "recommended",
            "source_height": 1080,
            "subject_tracks": [
                {
                    "subject_id": "person_01",
                    "focus_x": 0.23,
                    "visibility": 0.95,
                    "confidence": 0.88,
                    "safe_visibility": 1.0,
                },
                {
                    "subject_id": "person_02",
                    "focus_x": 0.76,
                    "visibility": 0.92,
                    "confidence": 0.86,
                    "safe_visibility": 1.0,
                },
            ],
            "activity_events": [
                {"time": 0.4, "subject_id": "person_01", "confidence": 0.80},
                {"time": 2.0, "subject_id": "person_01", "confidence": 0.76},
                {"time": 4.2, "subject_id": "person_02", "confidence": 0.84},
                {"time": 6.0, "subject_id": "person_02", "confidence": 0.82},
            ],
            "story_beats": [
                {"time": 7.0, "type": "reveal", "confidence": 0.90},
            ],
        },
        duration=12.0,
    )

    events = plan["camera_events"]
    assert plan["director"] == "subject_first_event_director"
    assert plan["evidence_mode"] == "visual_activity+story_evidence"
    assert events[0]["subject_id"] == "person_01"
    assert events[0]["focus_x"] == 0.23
    guest_events = [item for item in events if item["subject_id"] == "person_02"]
    assert guest_events
    assert any(item["reason"] == "active_subject_change" for item in guest_events)
    assert any(item["reason"] == "story_reveal" and item["zoom"] > 1.10 for item in guest_events)
    assert all(item["subject_id"] in {"person_01", "person_02"} for item in events)
    assert plan["qa"]["wallCropCount"] == 0
    assert plan["qa"]["emptyShotCount"] == 0


def test_editor_director_ignores_low_confidence_backchannel_switch():
    plan = CameraEngine().build_editor_plan(
        speakers=[],
        scene={
            "content_type": "podcast",
            "subject_tracks": [
                {"subject_id": "person_01", "focus_x": 0.25, "visibility": 1, "confidence": 0.9, "safe_visibility": 1},
                {"subject_id": "person_02", "focus_x": 0.75, "visibility": 1, "confidence": 0.8, "safe_visibility": 1},
            ],
            "activity_events": [
                {"time": 0.2, "subject_id": "person_01", "confidence": 0.82},
                {"time": 0.9, "subject_id": "person_02", "confidence": 0.55},
                {"time": 1.3, "subject_id": "person_01", "confidence": 0.79},
                {"time": 4.0, "subject_id": "person_02", "confidence": 0.84},
            ],
        },
        duration=8.0,
    )

    switch_times = [
        item["start"]
        for item in plan["camera_events"]
        if item["reason"] == "active_subject_change" and item["subject_id"] == "person_02"
    ]
    assert switch_times == [4.0]


def test_visual_only_director_enforces_natural_subject_hold():
    plan = CameraEngine().build_editor_plan(
        speakers=[],
        scene={
            "content_type": "podcast",
            "subject_tracks": [
                {"subject_id": "host", "focus_x": 0.25, "visibility": 1, "confidence": 0.9, "safe_visibility": 1},
                {"subject_id": "guest", "focus_x": 0.75, "visibility": 1, "confidence": 0.9, "safe_visibility": 1},
            ],
            "activity_events": [
                {"time": 0.2, "subject_id": "host", "confidence": 0.88, "run_samples": 2},
                {"time": 2.2, "subject_id": "guest", "confidence": 0.90, "run_samples": 2},
                {"time": 3.0, "subject_id": "host", "confidence": 0.92, "run_samples": 2},
                {"time": 4.4, "subject_id": "host", "confidence": 0.88, "run_samples": 2},
                {"time": 6.0, "subject_id": "guest", "confidence": 0.91, "run_samples": 2},
            ],
        },
        duration=9.0,
    )

    switches = [
        (item["start"], item["subject_id"])
        for item in plan["camera_events"]
        if item["reason"] == "active_subject_change"
    ]
    assert switches == [(2.2, "guest"), (4.4, "host")]
    assert plan["qa"]["rapidSubjectSwitchCount"] == 0
    assert plan["qa"]["minimumSubjectHoldSeconds"] >= 1.1


def test_visual_only_question_does_not_claim_verified_speaker_role():
    plan = CameraEngine().build_editor_plan(
        speakers=[],
        scene={
            "content_type": "interview",
            "speaker_evidence": False,
            "subject_tracks": [
                {"subject_id": "left", "focus_x": 0.25, "visibility": 1, "confidence": 0.9, "safe_visibility": 1},
                {"subject_id": "right", "focus_x": 0.75, "visibility": 1, "confidence": 0.9, "safe_visibility": 1},
            ],
            "activity_events": [
                {"time": 0.2, "subject_id": "left", "confidence": 0.88, "run_samples": 2},
                {"time": 3.0, "subject_id": "right", "confidence": 0.92, "run_samples": 2},
            ],
            "story_beats": [
                {"time": 2.8, "end": 3.2, "type": "question", "confidence": 0.8},
            ],
        },
        duration=7.0,
    )

    reasons = {item["reason"] for item in plan["camera_events"]}
    assert "questioner_turn" not in reasons
    assert "answerer_turn" not in reasons


def test_sparse_tracker_does_not_merge_adjacent_podcast_faces():
    tracks = {}
    first, tracks, next_id = cliper_worker.assign_subject_track_ids(
        [
            {"x": 0.30, "y": 0.52, "w": 0.065, "h": 0.12, "area": 0.0078, "kind": "face", "detector": "frontal"},
            {"x": 0.51, "y": 0.52, "w": 0.062, "h": 0.12, "area": 0.0074, "kind": "face", "detector": "frontal"},
        ],
        tracks,
        1,
        0.5,
    )
    second, tracks, _next_id = cliper_worker.assign_subject_track_ids(
        [
            {"x": 0.305, "y": 0.523, "w": 0.066, "h": 0.12, "area": 0.0079, "kind": "face", "detector": "profile"},
            {"x": 0.515, "y": 0.518, "w": 0.061, "h": 0.12, "area": 0.0073, "kind": "face", "detector": "frontal"},
        ],
        tracks,
        next_id,
        2.0,
    )

    assert len({item["track_id"] for item in first}) == 2
    assert {item["track_id"] for item in second} == {item["track_id"] for item in first}


def test_editor_director_rejects_late_weak_visual_switch_and_timer_resets():
    plan = CameraEngine().build_editor_plan(
        speakers=[],
        scene={
            "content_type": "podcast",
            "subject_tracks": [
                {
                    "subject_id": "guest",
                    "focus_x": 0.51,
                    "visibility": 0.9,
                    "confidence": 0.86,
                    "safe_visibility": 1.0,
                    "expression_score": 0.72,
                },
                {
                    "subject_id": "quiet_host",
                    "focus_x": 0.29,
                    "visibility": 0.92,
                    "confidence": 0.82,
                    "safe_visibility": 1.0,
                    "expression_score": 0.08,
                },
            ],
            "activity_events": [
                {"time": 0.2, "subject_id": "guest", "confidence": 0.84},
                {"time": 2.0, "subject_id": "guest", "confidence": 0.82},
                {"time": 9.0, "subject_id": "quiet_host", "confidence": 0.61},
            ],
        },
        duration=18.0,
    )

    assert {item["subject_id"] for item in plan["camera_events"]} == {"guest"}
    assert not any(item["reason"] == "long_take_visual_reset" for item in plan["camera_events"])
    assert plan["qa"]["lowConfidenceHardCutCount"] == 0
    assert plan["qa"]["timerResetCount"] == 0


def test_editor_director_accepts_sustained_profile_turn_evidence():
    plan = CameraEngine().build_editor_plan(
        speakers=[],
        scene={
            "content_type": "podcast",
            "subject_tracks": [
                {
                    "subject_id": "center_guest",
                    "focus_x": 0.51,
                    "visibility": 0.9,
                    "confidence": 0.86,
                    "safe_visibility": 1.0,
                },
                {
                    "subject_id": "right_host",
                    "focus_x": 0.82,
                    "visibility": 0.62,
                    "confidence": 0.72,
                    "safe_visibility": 1.0,
                    "profile_ratio": 0.8,
                },
            ],
            "activity_events": [
                {
                    "time": 0.2,
                    "subject_id": "center_guest",
                    "confidence": 0.84,
                    "run_duration": 8.0,
                    "sustained": True,
                    "turn_evidence": 0.78,
                },
                {
                    "time": 9.0,
                    "subject_id": "right_host",
                    "confidence": 0.67,
                    "run_duration": 3.1,
                    "sustained": True,
                    "turn_evidence": 0.69,
                },
            ],
        },
        duration=15.0,
    )

    right_events = [
        item
        for item in plan["camera_events"]
        if item["subject_id"] == "right_host"
    ]
    assert right_events
    assert right_events[0]["zone"] == "RIGHT"
    assert right_events[0]["cut_evidence"]["turnEvidence"] >= 0.69


def test_editor_director_scales_distant_face_without_excessive_zoom():
    plan = CameraEngine().build_editor_plan(
        speakers=[],
        scene={
            "content_type": "podcast",
            "source_width": 1920,
            "source_height": 1080,
            "subject_tracks": [
                {
                    "subject_id": "guest",
                    "focus_x": 0.51,
                    "focus_y": 0.53,
                    "kind": "face",
                    "average_area": 0.0031,
                    "visibility": 0.9,
                    "confidence": 0.86,
                    "safe_visibility": 1.0,
                },
            ],
            "activity_events": [
                {"time": 0.2, "subject_id": "guest", "confidence": 0.84},
                {"time": 2.0, "subject_id": "guest", "confidence": 0.82},
            ],
        },
        duration=8.0,
    )

    event = plan["camera_events"][0]
    assert event["focus_y"] == 0.53
    assert 1.09 <= event["zoom"] <= 1.12


def test_editor_zoom_expression_uses_short_eases_not_slow_pan():
    expression = cliper_worker.zoom_curve_expression(
        {
            "camera_director": [
                {"start": 0.0, "zoom": 1.03, "transition_ms": 180},
                {"start": 3.0, "zoom": 1.12, "transition_ms": 220},
                {"start": 5.2, "zoom": 1.03, "transition_ms": 180},
            ]
        }
    )

    assert "t-3" in expression
    assert "t-5.2" in expression
    assert "1.12" in expression
    assert "1.03" in expression


def test_video_filter_executes_editor_zoom_plan_per_frame():
    filters = cliper_worker.build_video_filter(
        {
            "formatProfile": "9:16 YouTube Shorts",
            "resolutionProfile": "1080p",
            "smartCrop": True,
            "dynamicZoom": True,
            "disableAutoEnhancement": True,
            "disable4KLook": True,
        },
        focus_x={
            "focus_x": 0.25,
            "source_width": 1920,
            "source_height": 1080,
            "camera_director": [
                {"start": 0.0, "focus_x": 0.25, "focus_y": 0.44, "zoom": 1.03},
                {"start": 4.0, "focus_x": 0.75, "focus_y": 0.52, "zoom": 1.12},
            ],
        },
    )

    assert "eval=frame" in filters
    assert "ceil(iw*" in filters
    assert "if(lt(t,4)" in filters
    assert "ih*(if(lt(t,4),0.44,0.52))-oh*0.46" in filters


def test_clip_relative_speaker_timeline_normalizes_absolute_source_time():
    context = cliper_worker.speaker_timeline_context(
        [
            {
                "start": 120.0,
                "end": 123.0,
                "text": "pertanyaan",
                "speaker_id": "host",
                "speaker_verified": True,
            },
            {
                "start": 123.2,
                "end": 128.0,
                "text": "jawaban",
                "speaker_id": "guest",
                "speaker_verified": True,
            },
        ],
        {"start": 120.0, "duration": 10.0},
        10.0,
    )

    assert context["turns"][0]["start"] == 0.0
    assert context["turns"][0]["end"] == 3.0
    assert context["turns"][1]["start"] == 3.2
    assert context["turns"][1]["end"] == 8.0


def test_face_detection_scale_keeps_small_distant_host_candidate():
    class GrayFrame:
        shape = (405, 720)

    class FakeCascade:
        def detectMultiScale(self, _gray, **kwargs):
            assert kwargs["minSize"] == (24, 24)
            return [(570, 190, 30, 30)]

    result = cliper_worker.detect_face_candidates(
        GrayFrame(),
        FakeCascade(),
        None,
    )

    assert len(result) == 1
    assert result[0]["x"] > 0.80
    assert result[0]["area"] > 0.0018


def test_yunet_detector_keeps_profile_host_and_deduplicates_haar_face():
    class Image:
        shape = (405, 720, 3)

    class FakeYuNet:
        def setInputSize(self, size):
            assert size == (720, 405)

        def detect(self, _image):
            right_host = [552.0, 176.0, 31.0, 44.0] + [0.0] * 10 + [0.91]
            return 1, [right_host]

    yunet = cliper_worker.detect_yunet_face_candidates(Image(), FakeYuNet())
    combined = cliper_worker.deduplicate_face_candidates(
        yunet
        + [
            {
                "x": 0.788,
                "y": 0.49,
                "w": 0.045,
                "h": 0.11,
                "area": 0.0049,
                "kind": "face",
                "detector": "profile_left",
            }
        ]
    )

    assert len(combined) == 1
    assert combined[0]["detector"] == "yunet"
    assert combined[0]["x"] > 0.78


def test_story_beat_activity_uses_only_bounded_visual_lookahead():
    events = [
        {"time": 24.4, "subject_id": "host"},
        {"time": 25.8, "subject_id": "guest"},
        {"time": 27.0, "subject_id": "other"},
    ]

    assert CameraEngine._activity_at(events, 25.68)["subject_id"] == "host"
    assert (
        CameraEngine._activity_at(events, 25.68, lookahead=0.35)["subject_id"]
        == "guest"
    )
    assert (
        CameraEngine._activity_at(events, 25.68, lookahead=0.1)["subject_id"]
        == "host"
    )

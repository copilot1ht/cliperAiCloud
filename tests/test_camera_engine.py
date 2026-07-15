from worker.camera_engine import CameraEngine


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

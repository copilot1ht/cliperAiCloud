from engine import speaker_engine


def test_compute_speaker_score():
    s = speaker_engine.compute_speaker_score(1.0, 1.0, 1.0, 1.0)
    assert isinstance(s, float)
    assert s == 100.0


def test_pick_top_speaker():
    scores = {"a": 10.0, "b": 20.0}
    assert speaker_engine.pick_top_speaker(scores) == "b"
    assert speaker_engine.pick_top_speaker({}) is None

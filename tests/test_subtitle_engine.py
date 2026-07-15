from worker.subtitle_engine import SubtitleEngine, build_word_highlight_ass_text


def test_build_word_highlight_ass_text_uses_karaoke_tags():
    ass_text = build_word_highlight_ass_text(0.0, 1.5, "Saya sedang membuat aplikasi")

    assert "Saya" in ass_text
    assert "sedang" in ass_text
    assert "membuat" in ass_text
    assert "\\k" in ass_text
    assert ass_text.count("\\k") >= 3


def test_subtitle_engine_preserves_word_timestamps():
    transcript = [{
        "start": 0.10,
        "end": 1.10,
        "text": "Saya sedang membuat",
        "words": [
            {"word": "Saya", "start": 0.10, "end": 0.35},
            {"word": "sedang", "start": 0.36, "end": 0.70},
            {"word": "membuat", "start": 0.71, "end": 1.10},
        ],
    }]

    events = SubtitleEngine(lead_seconds=0.08).build_events({"start": 0}, transcript, 1.4)

    assert len(events) == 1
    assert [item["word"] for item in events[0]["words"]] == ["Saya", "sedang", "membuat"]
    assert events[0]["words"][0]["start"] < 0.10

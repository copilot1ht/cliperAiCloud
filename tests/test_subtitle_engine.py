from worker.subtitle_engine import CAPTION_MAX_CHARS, CAPTION_MAX_WORDS, SubtitleEngine, build_word_highlight_ass_text


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


def test_repeated_phrase_later_in_clip_is_preserved():
    transcript = [
        {"start": 0.5, "end": 1.5, "text": "aku tetap di sini"},
        {"start": 4.5, "end": 5.5, "text": "aku tetap di sini"},
    ]

    events = SubtitleEngine(lead_seconds=0.08).build_events({"start": 0}, transcript, 7)

    assert [event["text"] for event in events] == ["aku tetap di sini", "aku tetap di sini"]
    assert events[1]["start"] > events[0]["end"]


def test_lead_overlap_trims_previous_without_delaying_next_caption():
    transcript = [
        {"start": 0.5, "end": 1.5, "text": "kalimat pertama"},
        {"start": 1.5, "end": 2.5, "text": "kalimat kedua"},
    ]

    events = SubtitleEngine(lead_seconds=0.08).build_events({"start": 0}, transcript, 4)

    assert events[1]["start"] == 1.42
    assert events[0]["end"] == events[1]["start"]


def test_word_aligned_segment_is_split_into_portrait_safe_phrases():
    words = [
        {"word": word, "start": index * 0.35, "end": index * 0.35 + 0.28}
        for index, word in enumerate(
            "ini adalah contoh subtitle panjang yang harus tetap berada di dalam area aman video vertikal".split()
        )
    ]
    transcript = [{
        "start": 0.0,
        "end": words[-1]["end"],
        "text": " ".join(item["word"] for item in words),
        "words": words,
    }]

    events = SubtitleEngine(lead_seconds=0.08).build_events({"start": 0}, transcript, words[-1]["end"] + 0.2)

    assert len(events) >= 2
    assert " ".join(word["word"] for event in events for word in event["words"]) == " ".join(item["word"] for item in words)
    assert all(len(event["words"]) <= CAPTION_MAX_WORDS for event in events)
    assert all(len(event["text"]) <= CAPTION_MAX_CHARS for event in events)

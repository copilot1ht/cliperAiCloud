import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))
import cliper_worker


def long_transcript(duration=120):
    segments = []
    for start in range(0, duration, 2):
        text = f"kalimat panjang nomor {start} tetap sinkron"
        words = []
        tokens = text.split()
        step = 1.6 / len(tokens)
        for index, token in enumerate(tokens):
            word_start = start + 0.15 + index * step
            words.append({"word": token, "start": word_start, "end": word_start + step * 0.9})
        segments.append({"start": start + 0.15, "end": start + 1.75, "text": text, "words": words})
    return segments


def subtitle_payload():
    return {
        "addCaptions": True,
        "burnSubtitle": True,
        "addHook": False,
        "subtitleWordHighlight": True,
        "formatProfile": "9:16 YouTube Shorts",
        "resolutionProfile": "720p",
    }


def test_overlay_coordinates_use_center_semantics_and_frame_clamping():
    assert cliper_worker.pct_expr(50, "W", "w") == "max(0\\,min(W-w\\,W*0.5000-w/2))"
    assert cliper_worker.pct_expr(84, "W", "w") == "max(0\\,min(W-w\\,W*0.8400-w/2))"


def test_final_filter_keeps_required_subtitle_and_escaped_text_watermark():
    payload = {
        "formatProfile": "9:16",
        "resolutionProfile": "720p",
        "addCaptions": True,
        "burnSubtitle": True,
        "addWatermark": True,
        "watermarkText": "SOURCE KREASI MIND",
        "watermarkTextX": 48.5,
        "watermarkTextY": 21.9,
    }

    video_filter = cliper_worker.build_video_filter(payload, "C:/captions.ass", 0.5)

    expected_subtitle_path = cliper_worker.ffmpeg_filter_path("C:/captions.ass")
    assert f"subtitles=filename='{expected_subtitle_path}'" in video_filter
    assert "drawtext=" in video_filter
    assert "x=max(0\\,min(w-text_w\\,w*0.4850-text_w/2))" in video_filter
    assert "y=max(0\\,min(h-text_h\\,h*0.2190-text_h/2))" in video_filter


def test_ass_caption_geometry_matches_design_pixels_and_drag_position(tmp_path):
    transcript = [
        {
            "start": 0.1,
            "end": 1.9,
            "text": "PREVIEW SAMA OUTPUT",
            "words": cliper_worker.distribute_caption_words(0.1, 1.9, "PREVIEW SAMA OUTPUT"),
        }
    ]
    moment = {"start": 0.0, "end": 2.0, "duration": 2.0, "transcript": "PREVIEW SAMA OUTPUT"}
    payload_1080 = {
        **subtitle_payload(),
        "resolutionProfile": "1080p",
        "subtitleFontSize": 84,
        "subtitleX": 42,
        "subtitleY": 77,
        "subtitleLetterSpacing": 1.2,
    }
    payload_2k = {**payload_1080, "resolutionProfile": "2K"}
    ass_1080 = tmp_path / "geometry-1080.ass"
    ass_2k = tmp_path / "geometry-2k.ass"

    assert cliper_worker.build_ass_caption_file(moment, ass_1080, payload_1080, transcript)
    assert cliper_worker.build_ass_caption_file(moment, ass_2k, payload_2k, transcript)

    text_1080 = ass_1080.read_text(encoding="utf-8")
    text_2k = ass_2k.read_text(encoding="utf-8")
    style_1080 = next(line for line in text_1080.splitlines() if line.startswith("Style: Caption"))
    style_2k = next(line for line in text_2k.splitlines() if line.startswith("Style: Caption"))
    assert ",84," in style_1080
    assert ",112," in style_2k
    assert r"{\an5\pos(454,1478)}" in text_1080
    assert r"{\an5\pos(605,1971)}" in text_2k


def test_hook_style_is_visible_over_source_video(tmp_path):
    transcript = [
        {
            "start": 0.1,
            "end": 1.9,
            "text": "HOOK HARUS TERBACA",
            "words": cliper_worker.distribute_caption_words(0.1, 1.9, "HOOK HARUS TERBACA"),
        }
    ]
    moment = {"start": 0.0, "end": 2.0, "duration": 2.0, "transcript": "HOOK HARUS TERBACA"}
    ass_path = tmp_path / "hook-visible.ass"
    payload = {**subtitle_payload(), "addHook": True, "hookDuration": "1"}

    assert cliper_worker.build_ass_caption_file(moment, ass_path, payload, transcript)

    ass_text = ass_path.read_text(encoding="utf-8")
    hook_style = next(
        line for line in ass_text.splitlines() if line.startswith("Style: Hook,")
    )
    assert "&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000" in hook_style
    assert ",1,2,1,5," in hook_style
    assert "Style: HookBox" in ass_text
    assert ass_text.count("Dialogue: 0,") >= 4
    assert "Dialogue: 1," in ass_text
    assert "Dialogue: 3," in ass_text
    assert r"\an5\pos(" in ass_text
    # Portrait hook copy stays in the upper safe area instead of covering the
    # speaker's central face/action zone.
    assert r"\an5\pos(360,200)" in ass_text


def test_hook_off_emits_no_hook_card_or_hook_timeline(tmp_path):
    transcript = [{"start": 0.1, "end": 1.8, "text": "Dialog sumber tetap tampil"}]
    moment = {"start": 0.0, "end": 2.0, "duration": 2.0, "transcript": "Dialog sumber tetap tampil"}
    ass_path = tmp_path / "hook-off.ass"
    payload = {**subtitle_payload(), "addHook": False, "addTtsHook": True}

    assert cliper_worker.build_ass_caption_file(moment, ass_path, payload, transcript)

    text = ass_path.read_text(encoding="utf-8")
    dialogue_lines = [line for line in text.splitlines() if line.startswith("Dialogue:")]
    assert not any(",Hook," in line or ",HookBox," in line for line in dialogue_lines)
    plan = cliper_worker.hook_overlay_plan(moment, transcript, payload)
    assert plan["enabled"] is False
    assert plan["ttsRequested"] is False


def test_hook_v2_freezes_source_delays_audio_and_offsets_original_captions(tmp_path):
    transcript = [
        {
            "start": 0.2,
            "end": 1.8,
            "text": "jawaban lengkap dimulai dari sini",
            "words": cliper_worker.distribute_caption_words(
                0.2, 1.8, "jawaban lengkap dimulai dari sini"
            ),
        }
    ]
    moment = {
        "start": 0.0,
        "end": 4.0,
        "duration": 4.0,
        "hook": "Kenapa jawaban ini mengubah cara berpikir?",
        "transcript": "jawaban lengkap dimulai dari sini",
    }
    payload = {
        **subtitle_payload(),
        "addHook": True,
        "hookDuration": "2 seconds",
        "featureFlags": {"hookV2": True},
        "_activeHookTimelineSeconds": 2.0,
    }
    ass_path = tmp_path / "hook-v2.ass"

    assert cliper_worker.build_ass_caption_file(
        moment, ass_path, payload, transcript
    )

    dialogue = [
        line.split(",", 9)
        for line in ass_path.read_text(encoding="utf-8").splitlines()
        if line.startswith("Dialogue:")
    ]
    hook_event = next(parts for parts in dialogue if parts[3] == "Hook")
    caption_event = next(parts for parts in dialogue if parts[3] == "Caption")
    assert cliper_worker.timestamp_to_seconds(hook_event[1]) == 0.0
    assert cliper_worker.timestamp_to_seconds(hook_event[2]) == 2.0
    assert cliper_worker.timestamp_to_seconds(caption_event[1]) >= 2.10

    validation = cliper_worker.validate_subtitle_sync(
        moment, transcript, payload, 4.0, ass_path
    )
    assert validation["ok"] is True
    assert validation["clip_duration"] == 6.0

    video_filter = cliper_worker.build_video_filter(
        payload, str(ass_path), focus_x=0.5, moment=moment
    )
    assert video_filter.startswith("tpad=start_mode=clone:start_duration=2")
    assert cliper_worker.audio_filter(payload, 2.0).startswith(
        "adelay=delays=2000:all=1"
    )


def test_watermark_text_filter_scales_from_shared_design_pixels():
    filters = []
    payload = {
        "addWatermark": True,
        "watermarkText": "CLIPER",
        "watermarkTextSize": 42,
        "watermarkTextX": 82,
        "watermarkTextY": 20,
        "formatProfile": "9:16 YouTube Shorts",
        "resolutionProfile": "2K",
    }

    cliper_worker.add_text_overlay_filters(filters, payload)

    assert len(filters) == 1
    assert "fontsize=56" in filters[0]
    assert "x=max(0\\,min(w-text_w\\,w*0.8200-text_w/2))" in filters[0]
    assert "y=max(0\\,min(h-text_h\\,h*0.2000-text_h/2))" in filters[0]


def test_required_output_overlays_do_not_allow_silent_caption_or_watermark_drops(tmp_path):
    payload = {
        **subtitle_payload(),
        "addWatermark": True,
        "watermarkText": "CLIPER",
    }

    overlays = cliper_worker.required_output_overlays(payload, tmp_path / "logo.png")

    assert overlays == {"captions": True, "watermark": True}


def test_long_clip_is_not_truncated_to_32_caption_events(tmp_path):
    transcript = long_transcript()
    moment = {"start": 0.0, "end": 120.0, "duration": 120.0, "transcript": "long caption"}
    events = cliper_worker.build_timed_caption_events(moment, transcript, subtitle_payload(), 120.0, 0.0)
    ass_path = tmp_path / "captions.ass"

    assert len(events) > 32
    assert cliper_worker.build_ass_caption_file(moment, ass_path, subtitle_payload(), transcript)
    validation = cliper_worker.validate_subtitle_sync(moment, transcript, subtitle_payload(), 120.0, ass_path)

    assert validation["ok"] is True
    assert validation["coverage_ratio"] >= 0.90
    assert validation["subtitle_end"] > 118.0


def test_validator_rejects_ass_that_stops_mid_clip(tmp_path):
    transcript = long_transcript()
    moment = {"start": 0.0, "end": 120.0, "duration": 120.0, "transcript": "long caption"}
    ass_path = tmp_path / "captions.ass"
    cliper_worker.build_ass_caption_file(moment, ass_path, subtitle_payload(), transcript)
    lines = ass_path.read_text(encoding="utf-8").splitlines()
    dialogue = [line for line in lines if line.startswith("Dialogue:")]
    header = [line for line in lines if not line.startswith("Dialogue:")]
    ass_path.write_text("\n".join(header + dialogue[: max(1, len(dialogue) // 2)]), encoding="utf-8")

    validation = cliper_worker.validate_subtitle_sync(moment, transcript, subtitle_payload(), 120.0, ass_path)

    assert validation["ok"] is False
    assert validation["coverage_ratio"] < 0.90
    assert validation["errors"]


def test_ass_time_carries_centiseconds_across_minute_and_hour():
    assert cliper_worker.ass_time(59.999) == "0:01:00.00"
    assert cliper_worker.ass_time(3599.999) == "1:00:00.00"


def test_hook_dedupe_never_removes_matching_caption_after_intro(tmp_path, monkeypatch):
    transcript = [
        {"start": 0.1, "end": 0.7, "text": "SATU", "words": [{"word": "SATU", "start": 0.1, "end": 0.7}]},
        {"start": 1.1, "end": 1.7, "text": "DUA", "words": [{"word": "DUA", "start": 1.1, "end": 1.7}]},
        {"start": 2.1, "end": 2.7, "text": "TIGA", "words": [{"word": "TIGA", "start": 2.1, "end": 2.7}]},
        {"start": 3.1, "end": 3.7, "text": "EMPAT", "words": [{"word": "EMPAT", "start": 3.1, "end": 3.7}]},
        {"start": 4.3, "end": 4.7, "text": "IYA", "words": [{"word": "IYA", "start": 4.3, "end": 4.7}]},
    ]
    moment = {"start": 0.0, "end": 5.0, "duration": 5.0, "transcript": "SATU DUA TIGA EMPAT IYA"}
    payload = {**subtitle_payload(), "addHook": True, "hookDuration": "1"}
    ass_path = tmp_path / "hook-scope.ass"
    monkeypatch.setattr(cliper_worker, "make_hook_text", lambda *_args, **_kwargs: "IYA")

    assert cliper_worker.build_ass_caption_file(moment, ass_path, payload, transcript)
    caption_lines = [
        line for line in ass_path.read_text(encoding="utf-8").splitlines()
        if line.startswith("Dialogue:") and ",Caption," in line
    ]

    assert any(
        "IYA" in line and cliper_worker.timestamp_to_seconds(line.split(",", 9)[1]) > 4.0
        for line in caption_lines
    )
    validation = cliper_worker.validate_subtitle_sync(moment, transcript, payload, 5.0, ass_path)
    assert validation["ok"] is True
    assert validation["coverage_ratio"] == 1.0


def test_natural_silence_after_last_spoken_word_is_valid(tmp_path):
    transcript = [
        {
            "start": 0.2,
            "end": 4.2,
            "text": "UCAPAN SELESAI SEBELUM VIDEO",
            "words": cliper_worker.distribute_caption_words(0.2, 4.2, "UCAPAN SELESAI SEBELUM VIDEO"),
        }
    ]
    moment = {"start": 0.0, "end": 5.0, "duration": 5.0, "transcript": "UCAPAN SELESAI SEBELUM VIDEO"}
    ass_path = tmp_path / "natural-tail.ass"

    assert cliper_worker.build_ass_caption_file(moment, ass_path, subtitle_payload(), transcript)
    validation = cliper_worker.validate_subtitle_sync(moment, transcript, subtitle_payload(), 5.0, ass_path)

    assert validation["ok"] is True
    assert validation["subtitle_end"] < 4.5


def test_caption_style_has_subtle_resolution_aware_letter_spacing(tmp_path):
    transcript = long_transcript(duration=4)
    moment = {"start": 0.0, "end": 4.0, "duration": 4.0, "transcript": "subtitle spacing"}
    ass_720 = tmp_path / "caption-720.ass"
    ass_1080 = tmp_path / "caption-1080.ass"
    payload_720 = {**subtitle_payload(), "resolutionProfile": "720p"}
    payload_1080 = {**subtitle_payload(), "resolutionProfile": "1080p"}

    assert cliper_worker.build_ass_caption_file(moment, ass_720, payload_720, transcript)
    assert cliper_worker.build_ass_caption_file(moment, ass_1080, payload_1080, transcript)

    caption_720 = next(line for line in ass_720.read_text(encoding="utf-8").splitlines() if line.startswith("Style: Caption"))
    caption_1080 = next(line for line in ass_1080.read_text(encoding="utf-8").splitlines() if line.startswith("Style: Caption"))
    assert ",100,100,1.0,0,1," in caption_720
    assert ",100,100,1.4,0,1," in caption_1080

    long_words = cliper_worker.distribute_caption_words(0.0, 2.0, "BISA LAKUKAN KEMARIN DENGAN LEBIH BAIK")
    assert r"\N" in cliper_worker.ass_active_word_phrase(long_words, 2, "&H0047ff19&", "&H00ffffff&")


def test_word_highlight_animations_have_distinct_ass_behavior():
    words = cliper_worker.distribute_caption_words(0.0, 2.0, "SATU DUA TIGA")
    active = "&H0047ff19&"
    primary = "&H00ffffff&"

    none_text = cliper_worker.ass_active_word_phrase(words, 1, active, primary, "None")
    fade_text = cliper_worker.ass_active_word_phrase(words, 1, active, primary, "Fade")
    scale_text = cliper_worker.ass_active_word_phrase(words, 1, active, primary, "Scale")
    pop_text = cliper_worker.ass_active_word_phrase(words, 1, active, primary, "Pop")
    bounce_text = cliper_worker.ass_active_word_phrase(words, 1, active, primary, "Bounce")
    typewriter_text = cliper_worker.ass_active_word_phrase(words, 1, active, primary, "Typewriter")

    assert r"\t(" not in none_text
    assert r"\t(" not in fade_text
    assert r"\fscx106" in scale_text
    assert r"\fscx112" in pop_text
    assert r"\fscx116" in bounce_text
    assert "SATU" in typewriter_text
    assert "DUA" in typewriter_text
    assert "TIGA" not in typewriter_text


def test_caption_effect_prefix_respects_animation_and_word_highlight_mode():
    assert cliper_worker.caption_effect_prefix({"subtitleAnimation": "None"}) == ""
    assert cliper_worker.caption_effect_prefix({"subtitleAnimation": "Typewriter"}) == ""
    assert r"\fad(" in cliper_worker.caption_effect_prefix({"subtitleAnimation": "Fade"})
    assert r"\fad(" in cliper_worker.caption_effect_prefix({"subtitleAnimation": "Fade"}, word_highlight=True)
    assert cliper_worker.caption_effect_prefix({"subtitleAnimation": "Pop"}, word_highlight=True) == ""
    assert cliper_worker.caption_effect_prefix({"subtitleAnimation": "Scale"}) != cliper_worker.caption_effect_prefix({"subtitleAnimation": "Pop"})
    assert cliper_worker.caption_effect_prefix({"subtitleAnimation": "Pop"}) != cliper_worker.caption_effect_prefix({"subtitleAnimation": "Bounce"})


def test_ass_file_uses_selected_word_animation(tmp_path):
    transcript = [
        {
            "start": 0.1,
            "end": 1.9,
            "text": "SATU DUA TIGA",
            "words": cliper_worker.distribute_caption_words(0.1, 1.9, "SATU DUA TIGA"),
        }
    ]
    moment = {"start": 0.0, "end": 2.0, "duration": 2.0, "transcript": "SATU DUA TIGA"}
    ass_path = tmp_path / "bounce.ass"
    payload = {**subtitle_payload(), "subtitleAnimation": "Bounce"}

    assert cliper_worker.build_ass_caption_file(moment, ass_path, payload, transcript)
    dialogue = "\n".join(
        line for line in ass_path.read_text(encoding="utf-8").splitlines()
        if line.startswith("Dialogue:")
    )
    assert r"\fscx116" in dialogue


def test_typewriter_still_reveals_words_when_highlight_color_is_disabled(tmp_path):
    transcript = [
        {
            "start": 0.1,
            "end": 1.9,
            "text": "SATU DUA TIGA",
            "words": cliper_worker.distribute_caption_words(0.1, 1.9, "SATU DUA TIGA"),
        }
    ]
    moment = {"start": 0.0, "end": 2.0, "duration": 2.0, "transcript": "SATU DUA TIGA"}
    ass_path = tmp_path / "typewriter.ass"
    payload = {
        **subtitle_payload(),
        "subtitleAnimation": "Typewriter",
        "subtitleWordHighlight": False,
    }

    assert cliper_worker.build_ass_caption_file(moment, ass_path, payload, transcript)
    dialogue = [
        line for line in ass_path.read_text(encoding="utf-8").splitlines()
        if line.startswith("Dialogue:")
    ]
    assert len(dialogue) == 3
    assert "SATU" in dialogue[0]
    assert "DUA" not in dialogue[0]
    assert "SATU" in dialogue[1] and "DUA" in dialogue[1]
    assert "TIGA" not in dialogue[1]
    assert "SATU" in dialogue[2] and "DUA" in dialogue[2] and "TIGA" in dialogue[2]


def test_word_highlight_ends_at_acoustic_word_end_and_holds_neutral_during_pause(tmp_path):
    transcript = [
        {
            "start": 0.1,
            "end": 1.4,
            "text": "SATU DUA",
            "words": [
                {"word": "SATU", "start": 0.1, "end": 0.35},
                {"word": "DUA", "start": 0.9, "end": 1.2},
            ],
        }
    ]
    moment = {"start": 0.0, "end": 1.5, "duration": 1.5, "transcript": "SATU DUA"}
    ass_path = tmp_path / "pause.ass"

    assert cliper_worker.build_ass_caption_file(moment, ass_path, subtitle_payload(), transcript)
    dialogue = [
        line.split(",", 9)
        for line in ass_path.read_text(encoding="utf-8").splitlines()
        if line.startswith("Dialogue:") and ",Caption," in line
    ]

    assert [parts[4] for parts in dialogue] == ["Word", "Hold", "Word", "Hold"]
    assert cliper_worker.timestamp_to_seconds(dialogue[0][2]) == pytest.approx(0.39, abs=0.02)
    assert cliper_worker.timestamp_to_seconds(dialogue[1][1]) == pytest.approx(0.39, abs=0.02)
    assert cliper_worker.timestamp_to_seconds(dialogue[1][2]) == pytest.approx(0.82, abs=0.02)
    assert cliper_worker.timestamp_to_seconds(dialogue[2][1]) == pytest.approx(0.82, abs=0.02)
    assert cliper_worker.timestamp_to_seconds(dialogue[3][1]) == pytest.approx(
        cliper_worker.timestamp_to_seconds(dialogue[2][2]), abs=0.02
    )
    validation = cliper_worker.validate_subtitle_sync(moment, transcript, subtitle_payload(), 1.5, ass_path)
    assert validation["coverage_ratio"] == 1.0
    assert validation["highlight_event_count"] == 2
    assert validation["hold_event_count"] == 2


def test_final_word_keeps_neutral_caption_until_phrase_boundary(tmp_path):
    transcript = [
        {
            "start": 0.1,
            "end": 1.4,
            "text": "SATU DUA",
            "words": [
                {"word": "SATU", "start": 0.1, "end": 0.35},
                {"word": "DUA", "start": 0.9, "end": 1.1},
            ],
        }
    ]
    moment = {"start": 0.0, "end": 1.5, "duration": 1.5, "transcript": "SATU DUA"}
    ass_path = tmp_path / "final-hold.ass"

    assert cliper_worker.build_ass_caption_file(moment, ass_path, subtitle_payload(), transcript)
    dialogue = [
        line.split(",", 9)
        for line in ass_path.read_text(encoding="utf-8").splitlines()
        if line.startswith("Dialogue:") and ",Caption," in line
    ]
    validation = cliper_worker.validate_subtitle_sync(moment, transcript, subtitle_payload(), 1.5, ass_path)

    assert [parts[4] for parts in dialogue] == ["Word", "Hold", "Word", "Hold"]
    assert cliper_worker.timestamp_to_seconds(dialogue[-1][1]) == pytest.approx(
        cliper_worker.timestamp_to_seconds(dialogue[-2][2]), abs=0.02
    )
    assert validation["ok"] is True
    assert validation["highlight_end"] == pytest.approx(
        cliper_worker.timestamp_to_seconds(dialogue[-2][2]), abs=0.02
    )
    expected_end = cliper_worker.build_timed_caption_events(moment, transcript, subtitle_payload(), 1.5, 0.0)[-1]["end"]
    assert validation["subtitle_end"] == pytest.approx(expected_end, abs=0.02)


def test_repeated_caption_text_at_different_timestamps_is_not_removed():
    transcript = [
        {"start": 0.2, "end": 0.8, "text": "ULANG LAGI"},
        {"start": 2.2, "end": 2.8, "text": "ULANG LAGI"},
    ]
    events = cliper_worker.build_timed_caption_events(
        {"start": 0.0, "duration": 3.0},
        transcript,
        subtitle_payload(),
        3.0,
        0.0,
    )

    assert [event["text"] for event in events] == ["ULANG LAGI", "ULANG LAGI"]


def test_low_confidence_audio_subtitle_uses_source_caption_lkg():
    audio = [
        {
            "start": 0.0,
            "end": 1.9,
            "text": "kata salah",
            "confidence": 0.25,
        }
    ]
    source = [
        {
            "start": 0.1,
            "end": 4.0,
            "text": "caption sumber yang lebih lengkap dan jelas",
            "confidence": None,
        }
    ]

    selected, source_name, quality = cliper_worker.choose_caption_transcript(audio, source, 8.0)

    assert selected == source
    assert source_name == "source_caption_lkg"
    assert quality["reason"] == "audio_word_count_too_low"


def test_good_audio_subtitle_remains_primary():
    audio = [
        {
            "start": 0.1,
            "end": 3.0,
            "text": "hasil audio ini cukup lengkap dan sinkron",
            "confidence": 0.84,
        }
    ]
    source = [
        {
            "start": 0.1,
            "end": 3.0,
            "text": "caption sumber juga tersedia",
            "confidence": None,
        }
    ]

    selected, source_name, quality = cliper_worker.choose_caption_transcript(audio, source, 5.0)

    assert selected == audio
    assert source_name == "audio_whisper"
    assert quality["reason"] == "audio_quality_accepted"


def test_multi_clip_artifact_identity_prevents_subtitle_cache_collision(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"synthetic-source-signature")
    transcript_a = [{"start": 30.1, "end": 31.0, "text": "clip pertama"}]
    transcript_b = [{"start": 90.1, "end": 91.0, "text": "clip kedua"}]

    first = cliper_worker.clip_artifact_identity(source, 30.0, 20.0, transcript_a, 1)
    second = cliper_worker.clip_artifact_identity(source, 90.0, 20.0, transcript_b, 2)
    repeated = cliper_worker.clip_artifact_identity(source, 30.0, 20.0, transcript_a, 1)

    assert first["artifact_hash"] != second["artifact_hash"]
    assert first["transcript_hash"] != second["transcript_hash"]
    assert first == repeated
    assert first["schema"] == 4


def test_same_source_range_with_repaired_boundary_gets_new_subtitle_identity(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"synthetic-source-signature")
    transcript = [{"start": 10.1, "end": 11.0, "text": "batas cerita"}]

    original = cliper_worker.clip_artifact_identity(source, 10.0, 30.0, transcript, 1)
    repaired = cliper_worker.clip_artifact_identity(source, 8.5, 31.5, transcript, 1)

    assert original["artifact_hash"] != repaired["artifact_hash"]

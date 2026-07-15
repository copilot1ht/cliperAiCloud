import sys
from pathlib import Path

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

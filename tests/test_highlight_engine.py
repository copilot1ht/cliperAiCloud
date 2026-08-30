import sys
from pathlib import Path

from worker.highlight_engine import (
    evidence_metrics,
    generate_highlight_candidates,
    progressive_deficit_penalty,
    public_score_out_of_ten,
    score_highlight,
)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))
import cliper_worker


def test_highlight_scores_are_evidence_based_and_deterministic():
    strong = (
        "Kenapa strategi ini gagal? Saya ditolak, rugi, dan hampir menyerah. "
        "Tapi akhirnya ditemukan solusi, hasilnya penjualan naik tiga kali lipat!"
    )
    weak = "Kita sedang rekaman lalu ngobrol biasa dan belum ada kesimpulan"

    strong_score = score_highlight(evidence_metrics(strong, 45))
    weak_score = score_highlight(evidence_metrics(weak, 45))

    assert strong_score > weak_score
    assert strong_score < 99


def test_story_and_payoff_penalties_are_continuous_not_threshold_cliffs():
    near_story = progressive_deficit_penalty(47.9, 48, 8, 28)
    weak_story = progressive_deficit_penalty(20, 48, 8, 28)
    near_payoff = progressive_deficit_penalty(51.9, 52, 5, 32)

    assert 0 < near_story < 1
    assert 0 < near_payoff < 1
    assert weak_story == 8


def test_public_score_uses_deterministic_rounding_and_keeps_ten_rare():
    assert public_score_out_of_ten(65) == 7
    assert public_score_out_of_ten(75) == 8
    assert public_score_out_of_ten(85) == 9
    assert public_score_out_of_ten(93) == 9
    assert public_score_out_of_ten(94) == 10


def test_candidate_generation_is_repeatable_without_fake_99_scores():
    transcript = []
    for index in range(90):
        topic = "strategi bisnis akhirnya berhasil" if index < 45 else "cerita keluarga konflik akhirnya berdamai"
        transcript.append({
            "start": index * 5.0,
            "end": index * 5.0 + 4.2,
            "text": f"{topic} bagian {index}.",
            "speaker_id": "A" if index % 2 == 0 else "B",
        })

    config = {"min_candidates": 8, "max_candidates": 20}
    first = generate_highlight_candidates(transcript, metadata={"duration": 450}, config=config)
    second = generate_highlight_candidates(transcript, metadata={"duration": 450}, config=config)

    assert [(item["start"], item["end"], item["score"]) for item in first] == [
        (item["start"], item["end"], item["score"]) for item in second
    ]
    assert first
    assert max(item["score"] for item in first) <= 97


def test_empty_transcript_does_not_create_generic_low_quality_moments():
    moments = cliper_worker.find_moments(
        {"duration": 1800},
        [],
        {"selectionMode": "full", "formatProfile": "9:16", "resolutionProfile": "1080p"},
    )

    assert moments == []


def test_all_recommended_long_video_is_not_limited_to_one_clip():
    payload = {"clipCount": 0, "allRecommendedClips": True}
    transcript = [{"start": 0.0, "end": 4.0, "text": "bukti percakapan"}]

    target = cliper_worker.resolve_target_clip_count(
        payload,
        effective_duration=1829,
        transcript=transcript,
        minimum_duration=30,
    )

    # 30:29 has room for sixty non-overlapping minimum-duration clips. The
    # final count still follows quality and diversity gates, but must never
    # collapse to one because of a hidden UI/default cap.
    assert target == 60

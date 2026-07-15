import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))
import cliper_worker


def test_review_fallback_never_raises_scores_or_hides_candidates():
    topics = [
        "Strategi bisnis gagal lalu menemukan solusi penjualan",
        "Cerita keluarga tentang sekolah dan keputusan anak",
        "Musisi membahas proses penciptaan lagu tarling",
        "Pengalaman lucu saat tampil di panggung pertama",
        "Pendapat tentang teknologi dan masa depan creator",
    ]
    candidates = []
    for index, score in enumerate([67, 55, 42, 36, 31]):
        start = index * 180.0
        candidates.append({
            "id": index + 1,
            "start": start,
            "end": start + 75.0,
            "duration": 75.0,
            "text": topics[index],
            "transcript": topics[index],
            "title": f"Topik {index}",
            "titleSuggestion": f"Topik {index}",
            "hook": f"Kenapa topik {index} penting",
            "score": score,
            "metrics": {"hook": score, "story_complete": score, "trend": score},
        })

    fallback = cliper_worker.select_review_fallback_moments(candidates, 4, 900)
    refined = cliper_worker.apply_title_hook_diversity(fallback)

    assert len(refined) == 4
    original_scores = {item["id"]: item["score"] for item in candidates}
    assert all(item["score"] == original_scores[item["id"]] for item in refined)
    assert any(item["score"] == 67 for item in refined)
    assert all(item["manual_review_candidate"] for item in refined)
    assert all(item["render_eligible"] for item in refined)
    assert all(not item.get("rejected", False) for item in refined)
    assert all(not item["auto_render"] for item in refined)


def test_candidate_calibration_requires_real_evidence_gate():
    strong = {
        "score": 66,
        "text": "Kenapa strategi penjualan gagal, lalu akhirnya solusi baru terbukti berhasil",
        "metrics": {
            "hook": 82,
            "story_complete": 84,
            "retention_predictor": 79,
            "payoff": 72,
            "filler_ratio": 0.01,
        },
    }
    repetitive = {
        "score": 52,
        "text": "iya iya iya jadi gitu jadi gitu",
        "metrics": {
            "hook": 35,
            "story_complete": 45,
            "retention_predictor": 50,
            "payoff": 30,
            "filler_ratio": 0.30,
        },
    }

    calibrated = cliper_worker.calibrate_candidate_scores([strong, repetitive])

    assert strong["evidence_gate"] is True
    assert strong["score"] > strong["raw_score"]
    assert repetitive["evidence_gate"] is False
    assert repetitive["score"] <= repetitive["raw_score"] + 6
    assert strong["score"] > repetitive["score"]


def test_local_title_uses_spoken_evidence_without_invented_count():
    text = "Kenapa strategi ini gagal? Saya ditolak dan rugi. Akhirnya solusi baru terbukti berhasil."
    title = cliper_worker.fyp_title_from_text(text)

    assert "dua kali" not in title.lower()
    assert cliper_worker.relevance_ok(title, text, 0.08)

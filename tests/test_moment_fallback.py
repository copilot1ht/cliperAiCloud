import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))
import cliper_worker


def qualified_candidate(score, index, evidence=True, manual=False):
    return {
        "id": index,
        "start": float(index * 100),
        "end": float(index * 100 + 60),
        "score": score,
        "evidence_gate": evidence,
        "manualReview": manual,
    }


def test_adaptive_recommendations_never_force_target_or_optional_candidates():
    candidates = [qualified_candidate(82 - index, index) for index in range(4)]
    candidates.extend([
        qualified_candidate(88, 10, evidence=False),
        qualified_candidate(86, 11, manual=True),
        qualified_candidate(64, 12),
    ])

    count, info = cliper_worker.adaptive_recommendation_count(candidates, 6)

    assert count == 4
    assert info["qualified_count"] == 4


def test_adaptive_recommendations_allow_only_small_quality_margin():
    candidates = [qualified_candidate(92 - index, index) for index in range(10)]

    count, info = cliper_worker.adaptive_recommendation_count(candidates, 6)
    single_count, _single_info = cliper_worker.adaptive_recommendation_count(candidates, 1)

    assert count == 7
    assert single_count == 1
    assert info["qualified_count"] == 10


def test_selection_prefilter_is_independent_of_requested_clip_count():
    candidates = [qualified_candidate(90 - (index % 20), index) for index in range(90)]

    one = cliper_worker.prefilter_selection_candidates(candidates, 1)
    ten = cliper_worker.prefilter_selection_candidates(candidates, 10)

    assert [item["id"] for item in one] == [item["id"] for item in ten]


def test_story_score_requires_real_setup_and_payoff_evidence():
    weak = (
        "iya jadi gitu kan terus kita ngobrol biasa terus gitu kan "
        "iya jadi gitu kan terus ngobrol biasa"
    )
    strong = (
        "Kenapa penjualan kami gagal pada bulan pertama? Awalnya iklan salah sasaran, "
        "lalu kami mengubah pesannya setelah membaca data pelanggan. "
        "Akhirnya strategi baru terbukti berhasil dan penjualan kembali naik."
    )

    weak_story, weak_reasons = cliper_worker.story_completeness_score(weak, 55, 35, 110)
    strong_story, strong_reasons = cliper_worker.story_completeness_score(strong, 55, 35, 110)
    weak_evidence = cliper_worker.highlight_evidence_quality(weak)
    strong_evidence = cliper_worker.highlight_evidence_quality(strong)

    assert weak_story <= 54
    assert "payoff belum terbukti" in weak_reasons
    assert strong_story >= 78
    assert "ending punya payoff" in strong_reasons
    assert strong_evidence["hook_evidence"] > weak_evidence["hook_evidence"]
    assert strong_evidence["payoff_evidence"] > weak_evidence["payoff_evidence"]


def test_ai_boundary_anchors_map_to_local_transcript_without_model_timestamps():
    transcript = [
        {"start": 10.0, "end": 17.0, "text": "Awalnya strategi penjualan kami gagal total karena iklan salah sasaran."},
        {"start": 17.0, "end": 28.0, "text": "Setelah membaca data pelanggan, kami mengubah pesan dan penawarannya."},
        {"start": 28.0, "end": 39.0, "text": "Akhirnya strategi baru terbukti berhasil dan penjualan kembali naik."},
    ]

    start, end, evidence = cliper_worker.align_ai_boundary_anchors(
        12.0,
        30.0,
        transcript,
        "strategi penjualan kami gagal total",
        "strategi baru terbukti berhasil",
        80.0,
    )

    assert start == 10.0
    assert end == 39.0
    assert evidence["start"]["matched"] is True
    assert evidence["end"]["matched"] is True


def test_review_fallback_never_raises_scores_or_hides_candidates():
    topics = [
        "Strategi bisnis gagal lalu menemukan solusi penjualan",
        "Cerita keluarga tentang sekolah dan keputusan anak",
        "Musisi membahas proses penciptaan lagu tarling",
        "Pengalaman lucu saat tampil di panggung pertama",
        "Pendapat tentang teknologi dan masa depan creator",
    ]
    candidates = []
    for index, score in enumerate([72, 70, 68, 66, 31]):
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
            "evidence_gate": index < 4,
            "metrics": {
                "hook": score,
                "story_complete": score,
                "payoff": score,
                "trend": score,
            },
        })

    fallback = cliper_worker.select_review_fallback_moments(candidates, 4, 900)
    refined = cliper_worker.apply_title_hook_diversity(fallback)

    assert len(refined) == 4
    original_scores = {item["id"]: item["score"] for item in candidates}
    assert all(item["score"] == original_scores[item["id"]] for item in refined)
    assert any(item["score"] == 66 for item in refined)
    assert all(item["score"] >= cliper_worker.AUTO_RENDER_MIN_SCORE for item in refined)
    assert all(item["manual_review_candidate"] for item in refined)
    assert all(item["render_eligible"] for item in refined)
    assert all(not item.get("rejected", False) for item in refined)
    assert all(not item["auto_render"] for item in refined)


def test_review_fallback_preserves_reviewer_evidence_for_manual_rendering():
    candidate = {
        "id": 8,
        "start": 120.0,
        "end": 185.0,
        "duration": 65.0,
        "text": "Jawaban lengkap menjelaskan masalah, alasan, lalu hasil akhirnya.",
        "transcript": "Jawaban lengkap menjelaskan masalah, alasan, lalu hasil akhirnya.",
        "score": 65,
        "ai_evidence_gate": True,
        "evidence_gate": True,
        "reviewer_status": "approved",
        "providerScores": {"local": 63, "primary": 67, "reviewer": 65},
        "metrics": {"hook": 62, "story_complete": 70, "payoff": 58},
        "scoreProvenance": {"formula": "reviewed"},
    }

    fallback = cliper_worker.select_review_fallback_moments([candidate], 1, 360)

    assert len(fallback) == 1
    assert fallback[0]["score"] == 65
    assert fallback[0]["reviewer_status"] == "approved"
    assert fallback[0]["providerScores"]["reviewer"] == 65
    assert fallback[0]["manual_review_candidate"] is True
    assert fallback[0]["auto_render"] is False
    assert fallback[0]["render_eligible"] is True


def test_optional_supplement_fills_partial_results_without_score_or_auto_render_changes():
    candidates = [
        {
            "id": 1,
            "start": 0.0,
            "end": 60.0,
            "text": "Masalah pertama dijelaskan sampai keputusan akhirnya selesai.",
            "score": 83,
            "auto_render": True,
        },
        {
            "id": 2,
            "start": 180.0,
            "end": 240.0,
            "text": "Topik kedua membahas alasan spesifik lalu hasilnya dijelaskan.",
            "score": 72,
            "evidence_gate": True,
            "metrics": {"story_complete": 70, "payoff": 58, "hook": 62},
        },
        {
            "id": 3,
            "start": 360.0,
            "end": 420.0,
            "text": "Topik ketiga memberi jawaban yang berbeda dan lengkap.",
            "score": 67,
            "evidence_gate": True,
            "metrics": {"story_complete": 66, "payoff": 54, "hook": 58},
        },
    ]

    supplemented = cliper_worker.supplement_with_optional_review_candidates(
        [dict(candidates[0])],
        candidates,
        result_limit=3,
        video_duration=480,
    )

    assert [item["id"] for item in supplemented] == [1, 2, 3]
    assert [item["score"] for item in supplemented] == [83, 72, 67]
    assert supplemented[0].get("manual_review_candidate") is not True
    assert all(item["manual_review_candidate"] for item in supplemented[1:])
    assert all(item["auto_render"] is False for item in supplemented[1:])
    assert all(item["render_eligible"] is True for item in supplemented[1:])


def test_manual_review_supplement_keeps_target_close_without_fake_scores():
    selected = [
        {
            "id": 1,
            "start": 0.0,
            "end": 70.0,
            "text": "Kenapa strategi pertama gagal lalu akhirnya solusi baru terbukti bekerja.",
            "score": 78,
            "evidence_gate": True,
            "auto_render": True,
        }
    ]
    candidates = selected + [
        {
            "id": 2,
            "start": 130.0,
            "end": 195.0,
            "text": "Masalah kedua dijelaskan dengan konteks, alasan, dan hasil akhirnya selesai.",
            "score": 67,
            "evidence_gate": True,
            "metrics": {"story_complete": 58, "payoff": 44, "hook": 45},
        },
        {
            "id": 3,
            "start": 260.0,
            "end": 320.0,
            "text": "Bagian ini memberi jawaban yang berbeda, menjelaskan sebab, lalu menutup kesimpulan.",
            "score": 59,
            "metrics": {
                "story_complete": 52,
                "payoff": 42,
                "hook": 41,
                "retention_predictor": 62,
                "filler_ratio": 0.08,
            },
            "rejected": True,
            "reject_reason": "Quality/evidence gate tidak terpenuhi",
        },
        {
            "id": 4,
            "start": 390.0,
            "end": 450.0,
            "text": "Cerita terakhir punya pembuka, alasan utama, dan payoff yang bisa dipahami sendiri.",
            "score": 56,
            "metrics": {
                "story_complete": 50,
                "payoff": 40,
                "hook": 43,
                "retention_predictor": 60,
                "filler_ratio": 0.10,
            },
            "rejected": True,
            "reject_reason": "Score di bawah 65",
        },
    ]

    supplemented = cliper_worker.supplement_with_optional_review_candidates(
        selected,
        candidates,
        result_limit=4,
        video_duration=600,
    )

    assert len(supplemented) == 4
    assert [item["score"] for item in supplemented] == [78, 67, 59, 56]
    assert supplemented[0].get("manual_review_candidate") is not True
    assert all(item["manual_review_candidate"] for item in supplemented[1:])
    assert all(item["auto_render"] is False for item in supplemented[1:])
    assert all(item["render_eligible"] is True for item in supplemented[1:])
    assert all(item.get("review_fallback") is True for item in supplemented[1:])


def test_manual_review_fallback_rejects_repetitive_low_evidence_padding():
    candidate = {
        "id": 1,
        "start": 0.0,
        "end": 70.0,
        "text": "iya iya iya jadi gitu jadi gitu iya iya jadi gitu terus begitu terus",
        "score": 58,
        "rejected": True,
        "reject_reason": "Score di bawah 65",
        "metrics": {
            "story_complete": 58,
            "payoff": 46,
            "hook": 50,
            "retention_predictor": 62,
            "filler_ratio": 0.08,
        },
    }

    assert cliper_worker.select_review_fallback_moments([candidate], 1, 300) == []


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
    assert strong["score"] == strong["raw_score"]
    assert strong["calibration"]["rank_bonus"] == 0
    assert repetitive["evidence_gate"] is False
    assert repetitive["score"] == repetitive["raw_score"]
    assert strong["score"] > repetitive["score"]


def test_high_score_without_evidence_never_auto_renders():
    candidate = {
        "score": 81,
        "text": "iya iya jadi begitu lalu begitu",
        "metrics": {
            "story_complete": 42,
            "retention_predictor": 74,
            "payoff": 28,
            "filler_ratio": 0.28,
        },
    }

    cliper_worker.calibrate_candidate_scores([candidate])
    refined = cliper_worker.apply_title_hook_diversity([candidate])[0]

    assert candidate["evidence_gate"] is False
    assert candidate["auto_render"] is False
    assert refined["auto_render"] is False


def test_tutorial_gate_prefers_instructional_value_over_podcast_payoff():
    metrics = {
        "retention_predictor": 72,
        "filler_ratio": 0.03,
        "value": 76,
        "story_complete": 56,
        "payoff": 45,
    }
    evidence = {
        "specificity_count": 4,
        "repetition_ratio": 0.05,
        "dangling_end": False,
        "payoff_evidence": 47,
        "hook_evidence": 45,
    }

    assert cliper_worker.candidate_evidence_gate(metrics, evidence, "tutorial", 71) is True


def test_podcast_gate_accepts_coherent_answer_without_fake_extreme_payoff():
    metrics = {
        "retention_predictor": 74,
        "filler_ratio": 0.04,
        "story_complete": 68,
        "payoff": 46,
        "dialogue": 77,
    }
    evidence = {
        "specificity_count": 4,
        "repetition_ratio": 0.08,
        "dangling_end": False,
        "payoff_evidence": 45,
        "hook_evidence": 48,
    }

    assert cliper_worker.candidate_evidence_gate(metrics, evidence, "podcast", 73) is True


def test_calibration_uses_explicit_content_profile():
    candidate = {
        "score": 72,
        "text": "Langkah pertama buka menu ekspor, pilih 1080p, lalu hasil video tersimpan dengan benar.",
        "metrics": {
            "retention_predictor": 74,
            "filler_ratio": 0.02,
            "value": 78,
            "story_complete": 58,
            "payoff": 48,
        },
    }

    cliper_worker.calibrate_candidate_scores([candidate], {"videoType": "tutorial"})

    assert candidate["evidence_gate"] is True


def test_rejected_reviewer_state_survives_title_refinement():
    candidate = {
        "score": 86,
        "text": "Masalah anggaran akhirnya terjawab setelah audit resmi diumumkan.",
        "metrics": {
            "story_complete": 85,
            "retention_predictor": 82,
            "payoff": 84,
            "filler_ratio": 0.01,
        },
        "ai_evidence_gate": True,
        "reviewer_status": "rejected",
        "manualReview": True,
    }

    refined = cliper_worker.apply_title_hook_diversity([candidate])[0]

    assert refined["reviewer_status"] == "rejected"
    assert refined["auto_render"] is False
    assert refined["priority"] == "OPTIONAL"


def test_local_title_uses_spoken_evidence_without_invented_count():
    text = "Kenapa strategi ini gagal? Saya ditolak dan rugi. Akhirnya solusi baru terbukti berhasil."
    title = cliper_worker.fyp_title_from_text(text)

    assert "dua kali" not in title.lower()
    assert cliper_worker.relevance_ok(title, text, 0.08)


def test_title_hook_refinement_removes_unsupported_proof_claim():
    source = (
        "Surat terima kasih itu sekarang menjadi viral. Apa artinya? "
        "Surat tersebut mungkin memberi gambaran tentang keterlibatan pihak lain."
    )
    candidate = {
        "score": 78,
        "text": source,
        "transcript": source,
        "hook": "Surat terima kasih jadi bukti viral",
        "title": "Bukti Viral Ungkap Keterlibatan Pihak Lain",
        "titleSuggestion": "Bukti Viral Ungkap Keterlibatan Pihak Lain",
        "ai_evidence_gate": True,
        "reviewer_status": "approved",
    }

    refined = cliper_worker.apply_title_hook_diversity([candidate])[0]

    assert cliper_worker.unsupported_editorial_claims(candidate["hook"], source) == ["proof"]
    assert cliper_worker.editorial_claim_is_grounded(refined["hook"], source)
    assert cliper_worker.editorial_claim_is_grounded(refined["title"], source)
    assert "bukti" not in refined["hook"].lower()


def test_claim_guard_allows_terms_present_in_source():
    source = "Audit resmi mengumumkan bukti baru dan hasilnya sudah terverifikasi."

    assert cliper_worker.editorial_claim_is_grounded(
        "Bukti Baru dari Audit Resmi Sudah Terverifikasi",
        source,
    )

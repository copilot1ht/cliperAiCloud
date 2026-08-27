import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))
import cliper_worker
import story_engine


STRONG_STORY = (
    "Kenapa penjualan kami gagal pada bulan pertama? Awalnya iklan salah sasaran "
    "dan pelanggan tidak memahami produknya. Lalu kami membaca data pelanggan "
    "serta mengubah pesan kampanye. Akhirnya strategi baru terbukti berhasil "
    "dan penjualan kembali naik."
)


def test_story_arc_evidence_rewards_complete_grounded_story():
    weak = "iya jadi begitu terus ngobrol biasa dan lanjut lagi"
    strong = cliper_worker.story_arc_evidence(STRONG_STORY, 58, 30, 90)
    weak_arc = cliper_worker.story_arc_evidence(weak, 58, 30, 90)

    assert strong["complete"] is True
    assert strong["story_integrity"] >= 70
    assert strong["candidate_score"] > weak_arc["candidate_score"]
    assert weak_arc["complete"] is False


def test_story_arc_candidates_find_setup_progression_and_payoff():
    transcript = [
        {
            "start": 0.0,
            "end": 18.0,
            "text": "Kenapa penjualan kami gagal? Awalnya iklan salah sasaran dan pelanggan tidak paham.",
        },
        {
            "start": 18.0,
            "end": 36.0,
            "text": "Lalu kami membaca data pelanggan dan mengubah pesan kampanye.",
        },
        {
            "start": 36.0,
            "end": 54.0,
            "text": "Akhirnya strategi baru terbukti berhasil dan penjualan kembali naik.",
        },
    ]

    candidates = cliper_worker.build_story_arc_candidates(
        transcript, 3, 30, 50, 90
    )

    assert candidates
    assert any(
        item["candidate_source"] == "story_arc"
        and item["story_arc"]["complete"]
        and item["start"] == 0.0
        and item["end"] == 54.0
        for item in candidates
    )


def test_story_map_events_seed_natural_candidates():
    transcript = [
        {"start": 0.0, "end": 18.0, "text": "Kenapa penjualan kami gagal? Awalnya iklan salah sasaran."},
        {"start": 18.0, "end": 36.0, "text": "Karena data pelanggan belum dipakai untuk mengubah kampanye."},
        {"start": 36.0, "end": 54.0, "text": "Akhirnya strategi baru terbukti berhasil dan penjualan naik."},
    ]
    profile = cliper_worker.build_content_profile(
        {"title": "Strategi Penjualan", "duration": 54}, transcript
    )
    story_map = cliper_worker.build_story_map(
        {"title": "Strategi Penjualan", "duration": 54}, transcript, profile
    )
    candidates = cliper_worker.build_story_map_candidates(
        story_map, transcript, 20, 40, 70, profile
    )

    assert candidates
    assert all(item["candidate_source"].startswith("story_map:") for item in candidates)
    assert any("payoff" in item["candidate_sources"] for item in candidates)


def test_scorecard_is_explainable_and_cannot_promote_incomplete_story():
    strong = cliper_worker.score_moment_candidate(
        {"start": 0.0, "end": 58.0, "text": STRONG_STORY},
        {"_contentProfile": {"videoType": "podcast"}},
        0,
        30,
        90,
    )
    weak = cliper_worker.score_moment_candidate(
        {
            "start": 0.0,
            "end": 58.0,
            "text": "dan terus begitu lalu ngobrol biasa tanpa jawaban",
        },
        {"_contentProfile": {"videoType": "podcast"}},
        0,
        30,
        90,
    )

    scorecard = strong["scoreProvenance"]["scorecard"]
    assert round(sum(scorecard["weights"].values()), 2) == 1.0
    assert scorecard["schema"] == 3
    assert len(scorecard["dimensions"]) == 13
    assert scorecard["dimensions"]["contextClarity"] >= 60
    assert scorecard["groups"]["storyIntegrity"] >= 70
    assert strong["score"] > weak["score"]
    assert weak["scoreProvenance"]["scorecard"]["caps"]


def test_moment_scoring_feature_flag_activates_v3_reconciliation():
    result = cliper_worker.score_moment_candidate(
        {"start": 0.0, "end": 58.0, "text": STRONG_STORY},
        {
            "_contentProfile": {"videoType": "podcast"},
            "featureFlags": {"momentScoringV2": True},
        },
        0,
        30,
        90,
    )

    assert result["scoreProvenance"]["momentScoringV2"] is True
    assert result["scoreProvenance"]["formula"] == "content_profile_60_scorecard_40"
    assert result["selectionReasons"]
    assert result["weaknesses"]


def test_retention_uses_balanced_evidence_instead_of_highest_signal():
    connector_heavy = cliper_worker.score_moment_candidate(
        {
            "start": 0.0,
            "end": 75.0,
            "text": (
                "Jadi lalu kemudian setelah itu terus kami berbicara biasa, "
                "tetapi tidak ada pertanyaan, keputusan, atau hasil yang selesai."
            ),
        },
        {
            "_contentProfile": {"videoType": "podcast"},
            "featureFlags": {"momentScoringV2": True},
        },
        0,
        30,
        90,
    )
    complete_story = cliper_worker.score_moment_candidate(
        {"start": 0.0, "end": 58.0, "text": STRONG_STORY},
        {
            "_contentProfile": {"videoType": "podcast"},
            "featureFlags": {"momentScoringV2": True},
        },
        0,
        30,
        90,
    )

    weak_retention = connector_heavy["metrics"]["retention_predictor"]
    strong_retention = complete_story["metrics"]["retention_predictor"]
    components = connector_heavy["metrics"]["retention_components"]

    assert weak_retention < 90
    assert strong_retention > weak_retention
    assert round(sum(components["weights"].values()), 2) == 1.0
    assert components["final"] == weak_retention


def test_final_selection_revalidates_after_boundary_refinement():
    transcript = [
        {
            "start": 0.0,
            "end": 18.0,
            "text": "Kenapa penjualan kami gagal? Awalnya iklan salah sasaran.",
        },
        {
            "start": 18.0,
            "end": 36.0,
            "text": "Lalu kami membaca data pelanggan dan mengubah pesan kampanye.",
        },
        {
            "start": 36.0,
            "end": 54.0,
            "text": "Akhirnya strategi baru terbukti berhasil dan penjualan kembali naik.",
        },
    ]
    candidate = {
        "start": 0.0,
        "end": 38.0,
        "text": "Kenapa penjualan kami gagal? Awalnya iklan salah sasaran. Lalu kami membaca data pelanggan.",
        "score": 95,
        "evidence_gate": True,
    }

    selected = cliper_worker.select_diverse_moments(
        [candidate],
        1,
        transcript,
        30,
        50,
        90,
        {"_contentProfile": {"videoType": "podcast"}},
        54,
    )

    assert len(selected) == 1
    assert selected[0]["boundary_revalidated"] is True
    assert selected[0]["end"] >= 54.0
    assert "terbukti berhasil" in selected[0]["text"]
    assert selected[0]["boundaryRevalidation"]["scoreBefore"] == 95
    assert selected[0]["score"] != 95
    assert "scorecard" in selected[0]["scoreProvenance"]


def test_final_selection_stops_at_nearby_payoff_instead_of_hard_maximum():
    transcript = [
        {"start": 0.0, "end": 25.0, "text": "Kenapa penjualan gagal? Awalnya iklan salah sasaran."},
        {"start": 25.0, "end": 50.0, "text": "Lalu kami membaca data pelanggan dan mengubah kampanye."},
        {"start": 50.0, "end": 75.0, "text": "Akhirnya strategi baru terbukti berhasil dan penjualan kembali naik."},
        {"start": 75.0, "end": 105.0, "text": "Setelah itu pembicaraan pindah ke rencana kantor tahun depan."},
        {"start": 105.0, "end": 140.0, "text": "Topik baru membahas perekrutan dan lokasi cabang berikutnya."},
        {"start": 140.0, "end": 180.0, "text": "Percakapan berlanjut dengan agenda berbeda yang tidak terkait hasil penjualan."},
    ]
    candidate = {
        "start": 0.0,
        "end": 180.0,
        "text": " ".join(item["text"] for item in transcript),
        "score": 92,
        "evidence_gate": True,
    }

    selected = cliper_worker.select_diverse_moments(
        [candidate],
        1,
        transcript,
        30,
        75,
        180,
        {"_contentProfile": {"videoType": "podcast"}},
        180,
    )

    assert len(selected) == 1
    assert selected[0]["start"] == 0.0
    assert selected[0]["end"] <= 80.0
    assert "terbukti berhasil" in selected[0]["text"]
    assert "perekrutan" not in selected[0]["text"]


def test_selection_prefilter_keeps_quality_and_timeline_coverage():
    candidates = [
        {
            "id": index,
            "start": float(index * 10),
            "end": float(index * 10 + 60),
            "score": 100 - index * 0.1,
        }
        for index in range(300)
    ]

    filtered = cliper_worker.prefilter_selection_candidates(candidates, 10)

    assert len(filtered) == 140
    assert candidates[0] in filtered
    assert max(item["start"] for item in filtered) >= 2800
    assert len({item["id"] for item in filtered}) == len(filtered)


def test_short_form_duration_profiles_cap_unrelated_story_tail():
    podcast = cliper_worker.candidate_duration_bounds(
        STRONG_STORY, 30, 75, 180, {"videoType": "podcast"}
    )
    storytelling = cliper_worker.candidate_duration_bounds(
        STRONG_STORY, 30, 75, 180, {"videoType": "storytelling"}
    )
    general = cliper_worker.candidate_duration_bounds(
        STRONG_STORY, 30, 75, 180, {"videoType": "general"}
    )

    assert podcast[:3] == (35.0, 75.0, 125.0)
    assert storytelling[:3] == (40.0, 75.0, 150.0)
    assert 30.0 <= general[0] <= general[1] <= general[2] <= 120.0


def test_context_dependent_opening_cannot_pass_evidence_gate():
    evidence = cliper_worker.highlight_evidence_quality(
        "sama Habib Jafar itu baru mulai dibahas setelah bagian sebelumnya."
    )
    assert evidence["context_dependent_start"] is True
    assert evidence["dangling_start"] is True
    stage_direction = cliper_worker.highlight_evidence_quality(
        "[bersorak] Saya ingin menjelaskan keputusan ini."
    )
    assert stage_direction["context_dependent_start"] is False
    generic_reply = cliper_worker.highlight_evidence_quality("Oke, itu aja jawaban saya.")
    assert generic_reply["generic_opening"] is True
    metrics = {
        "filler_ratio": 0.0,
        "retention_predictor": 90.0,
        "story_complete": 90.0,
        "payoff": 90.0,
    }
    assert not cliper_worker.candidate_evidence_gate(
        metrics,
        evidence,
        "podcast",
        90,
    )


def test_boundary_keeps_natural_start_when_end_exceeds_duration_limit(monkeypatch):
    monkeypatch.setattr(cliper_worker, "external_extend_story_boundary", None)
    transcript = [
        {"start": 0.0, "end": 30.0, "text": "Kenapa harga naik? Ini masalah yang perlu dijawab."},
        {"start": 30.0, "end": 60.0, "text": "Awalnya biaya distribusi meningkat sangat tajam."},
        {"start": 60.0, "end": 90.0, "text": "Akhirnya kami menemukan cara menekan biaya dengan rute baru."},
        {"start": 90.0, "end": 120.0, "text": "Penutup ini tidak boleh memaksa awal klip bergeser."},
    ]
    start, end, text = cliper_worker.improve_story_boundaries(
        0.0, 120.0, transcript, 30, 75, 90
    )
    assert start == 0.0
    assert end == 90.0
    assert text.startswith("Kenapa")


def test_opening_gate_rejects_unresolved_acknowledgement_without_blacklisting_context():
    unresolved = cliper_worker.highlight_evidence_quality("Oke, itu aja jawaban saya.")
    contextual = cliper_worker.highlight_evidence_quality(
        "Oke, pemerintah mengubah kebijakan ekspor karena biaya logistik meningkat."
    )
    connector_with_context = cliper_worker.highlight_evidence_quality(
        "Karena itulah pemerintah kemudian mengubah kebijakan ekspor yang merugikan petani."
    )

    assert unresolved["generic_opening"] is True
    assert unresolved["generic_opening_unresolved"] is True
    assert unresolved["dangling_start"] is True
    assert contextual["generic_opening"] is True
    assert contextual["opening_context_clear"] is True
    assert contextual["context_dependent_start"] is False
    assert connector_with_context["opening_context_clear"] is True
    assert connector_with_context["context_dependent_start"] is False


def test_quality_tier_requires_evidence_before_promoting_raw_score():
    candidate = {"score": 84, "evidence_gate": False}
    assert cliper_worker.candidate_quality_tier(candidate) == "review"

    candidate["evidence_gate"] = True
    assert cliper_worker.candidate_quality_tier(candidate) == "strong"

    candidate["score"] = 75
    assert cliper_worker.candidate_quality_tier(candidate) == "good"

    candidate["manual_review_candidate"] = True
    assert cliper_worker.candidate_quality_tier(candidate) == "review"

    candidate["score"] = 55
    assert cliper_worker.candidate_quality_tier(candidate) == "reject"


def test_story_engine_never_moves_start_forward_for_max_duration():
    transcript = [
        {"start": 0.0, "end": 30.0, "text": "Kenapa harga naik? Ini masalah yang perlu dijawab."},
        {"start": 30.0, "end": 60.0, "text": "Awalnya biaya distribusi meningkat sangat tajam."},
        {"start": 60.0, "end": 90.0, "text": "Akhirnya kami menemukan cara menekan biaya dengan rute baru."},
        {"start": 90.0, "end": 120.0, "text": "Penutup ini tidak boleh menggeser awal klip."},
    ]

    start, end, text = story_engine.extend_story_boundary(
        transcript, 0.0, 120.0, min_duration=30, target_duration=75, max_duration=90
    )

    assert start == 0.0
    assert end == 90.0
    assert text.startswith("Kenapa harga naik")


def test_story_engine_backtracks_a_dependent_opening_to_nearby_context():
    transcript = [
        {"start": 0.0, "end": 8.0, "text": "Harga naik karena distribusi terganggu."},
        {"start": 8.2, "end": 16.0, "text": "Dan itu membuat stok cepat habis."},
        {"start": 16.0, "end": 25.0, "text": "Akhirnya rute baru menurunkan biaya."},
    ]

    assert story_engine.snap_to_sentence_start(transcript, 8.2) == 0.0


def test_coarse_asr_segment_uses_internal_sentence_boundaries():
    transcript = [{
        "start": 0.0,
        "end": 120.0,
        "text": (
            "Masalah pertama membuat pelanggan pergi. "
            "Kemudian tim membaca data penjualan. "
            "Mereka mengubah pesan berdasarkan kebutuhan pelanggan. "
            "Akhirnya penjualan naik dan strategi itu terbukti berhasil."
        ),
    }]

    start = story_engine.snap_to_sentence_start(transcript, 65.0)
    end = story_engine.snap_to_sentence_end(transcript, 78.0)
    refined_start, refined_end, text = story_engine.extend_story_boundary(
        transcript,
        35.0,
        78.0,
        min_duration=30,
        target_duration=55,
        max_duration=80,
    )

    assert 20.0 < start < 65.0
    assert 65.0 < end < 120.0
    assert refined_start > 0.0
    assert refined_end < 120.0
    assert 30.0 <= refined_end - refined_start <= 80.0
    assert "Kemudian" in text


def test_story_candidates_vary_duration_and_include_semantic_roles():
    transcript = [
        {"start": 0.0, "end": 12.0, "text": "Kenapa penjualan gagal? Awalnya iklan salah sasaran."},
        {"start": 12.0, "end": 28.0, "text": "Masalahnya pelanggan tidak memahami manfaat produk."},
        {"start": 28.0, "end": 43.0, "text": "Lalu kami mengubah pesan berdasarkan data pelanggan."},
        {"start": 43.0, "end": 58.0, "text": "Akhirnya penjualan naik dan strategi itu terbukti berhasil."},
        {"start": 58.0, "end": 72.0, "text": "Apa pelajaran berikutnya? Kami mulai menguji pasar baru."},
        {"start": 72.0, "end": 92.0, "text": "Hasilnya pasar kedua memberi pertumbuhan yang stabil."},
    ]

    candidates = story_engine.segment_into_story_candidates(transcript)
    durations = {round(item["end"] - item["start"], 1) for item in candidates}

    assert any(item.get("candidate_source") == "story_role" for item in candidates)
    assert len(durations) >= 3
    assert max(durations) - min(durations) >= 15


def test_optional_candidates_never_bypass_incomplete_boundary_gate():
    candidates = [
        {
            "id": "dangling",
            "start": 0,
            "end": 45,
            "score": 92,
            "text": "jawaban tanpa konteks",
            "metrics": {"dangling_start": True, "dangling_end": False},
        },
        {
            "id": "complete",
            "start": 120,
            "end": 168,
            "score": 61,
            "text": "pertanyaan jelas lalu jawaban dan kesimpulan selesai.",
            "metrics": {"dangling_start": False, "dangling_end": False},
        },
    ]

    selected = cliper_worker.select_review_fallback_moments(candidates, 2, 240)

    assert [item["id"] for item in selected] == ["complete"]
    assert selected[0]["manual_review_candidate"] is True

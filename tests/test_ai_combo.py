import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))
import cliper_worker


def test_ai_module_key_separates_primary_highlight_from_final_reviewer():
    assert cliper_worker.ai_module_key("Highlight Finder Batch 1/2") == "highlight"
    assert cliper_worker.ai_module_key("Final Ranking Reviewer") == "review"
    assert cliper_worker.ai_module_key("Publishing Planner") == "publishing"
    assert cliper_worker.ai_module_key("Metadata Generator") == "metadata"


def test_reviewer_has_its_own_output_budget():
    payload = cliper_worker.payload_for_ai_module(
        {"providerType": "cloud", "maxTokensByModule": {"ranking": 1300, "review": 1100}},
        "Final Ranking Reviewer",
    )

    assert payload["maxTokens"] == 1100
    assert payload["timeoutMs"] == 90


def test_balanced_cloud_review_blends_independent_scores(monkeypatch):
    calls = []

    def fake_provider_request(_payload, _prompt, module="AI"):
        calls.append(module)
        return {
            "response": json.dumps([
                {
                    "source_id": 7,
                    "score": 80,
                    "approve": True,
                    "reason": "Setup dan payoff lengkap",
                }
            ])
        }

    monkeypatch.setattr(cliper_worker, "provider_request", fake_provider_request)
    candidates = [{
        "id": 7,
        "_source_candidate_id": 7,
        "score": 76,
        "initial_score": 76,
        "local_score": 70,
        "primary_score": 78,
        "ai_score": 78,
        "ai_evidence_gate": True,
        "text": "Pembicara menjelaskan masalah, bukti, dan hasil akhirnya dengan jelas.",
        "metrics": {"story_complete": 82, "payoff": 80, "hook": 72},
    }]

    reviewed, reviewer_used = cliper_worker.review_ai_highlight_candidates(
        candidates,
        {
            "providerType": "cloud",
            "aiRoutingMode": "balanced",
            "_contentProfile": {"videoType": "podcast", "evidence": {"title": "Uji podcast"}},
        },
        1,
    )

    assert reviewer_used is True
    assert calls == ["Final Ranking Reviewer"]
    assert reviewed[0]["score"] == 75
    assert reviewed[0]["providerScores"] == {"local": 70, "primary": 78, "reviewer": 80}
    assert reviewed[0]["scoreProvenance"]["formula"] == "local*0.45 + capped_primary*0.30 + capped_reviewer*0.25"
    assert reviewed[0]["scoreProvenance"]["providerScoreCap"] == 80


def test_reviewer_retries_once_after_truncated_json(monkeypatch):
    responses = iter([
        {"response": '[{"source_id":7,"score":80,"approve":true,"title":"Terpotong'},
        {"response": json.dumps([{"source_id": 7, "score": 79, "approve": True}])},
    ])
    calls = []

    def fake_provider_request(_payload, _prompt, module="AI"):
        calls.append(module)
        return next(responses)

    monkeypatch.setattr(cliper_worker, "provider_request", fake_provider_request)
    reviewed, reviewer_used = cliper_worker.review_ai_highlight_candidates(
        [{
            "id": 7,
            "_source_candidate_id": 7,
            "score": 76,
            "initial_score": 76,
            "local_score": 70,
            "primary_score": 78,
            "ai_score": 78,
            "ai_evidence_gate": True,
            "text": "Masalah dijelaskan, bukti diberikan, lalu hasil akhirnya disampaikan.",
            "metrics": {"story_complete": 82, "payoff": 80, "hook": 72},
        }],
        {"providerType": "cloud", "aiRoutingMode": "balanced"},
        1,
    )

    assert reviewer_used is True
    assert calls == ["Final Ranking Reviewer", "Final Ranking Reviewer"]
    assert reviewed[0]["review_score"] == 79


def test_reviewer_retries_only_missing_source_ids(monkeypatch):
    responses = iter([
        {"response": json.dumps([{"source_id": 7, "score": 79, "approve": True}])},
        {"response": json.dumps([{"source_id": 8, "score": 76, "approve": True}])},
    ])
    prompts = []

    def fake_provider_request(_payload, prompt, module="AI"):
        prompts.append(prompt)
        return next(responses)

    monkeypatch.setattr(cliper_worker, "provider_request", fake_provider_request)
    candidates = [
        {
            "id": source_id,
            "_source_candidate_id": source_id,
            "score": 76,
            "initial_score": 76,
            "local_score": 70,
            "primary_score": 78,
            "ai_score": 78,
            "ai_evidence_gate": True,
            "text": f"Kandidat {source_id} memiliki setup, bukti, dan payoff yang lengkap.",
            "metrics": {"story_complete": 82, "payoff": 80, "hook": 72},
        }
        for source_id in (7, 8)
    ]

    reviewed, reviewer_used = cliper_worker.review_ai_highlight_candidates(
        candidates,
        {"providerType": "cloud", "aiRoutingMode": "balanced"},
        1,
    )

    assert reviewer_used is True
    assert len(prompts) == 2
    assert '"source_id": 7' not in prompts[1]
    assert '"source_id": 8' in prompts[1]
    assert [item["review_score"] for item in reviewed] == [79, 76]


def test_partial_reviewer_response_fails_closed_when_retry_still_omits_id(monkeypatch):
    responses = iter([
        {"response": json.dumps([{"source_id": 7, "score": 79, "approve": True}])},
        {"response": json.dumps([{"source_id": 7, "score": 79, "approve": True}])},
    ])
    monkeypatch.setattr(
        cliper_worker,
        "provider_request",
        lambda *_args, **_kwargs: next(responses),
    )
    candidates = [
        {
            "id": source_id,
            "_source_candidate_id": source_id,
            "score": 76,
            "initial_score": 76,
            "local_score": 70,
            "primary_score": 82,
            "ai_score": 82,
            "ai_evidence_gate": True,
            "auto_render": True,
            "text": f"Kandidat {source_id} memiliki setup, bukti, dan payoff yang lengkap.",
            "metrics": {"story_complete": 82, "payoff": 80, "hook": 72},
        }
        for source_id in (7, 8)
    ]

    reviewed, reviewer_used = cliper_worker.review_ai_highlight_candidates(
        candidates,
        {"providerType": "cloud", "aiRoutingMode": "balanced"},
        1,
    )

    assert reviewer_used is True
    assert reviewed[0]["reviewer_status"] == "approved"
    assert reviewed[1]["reviewer_status"] == "missing"
    assert reviewed[1]["score"] == 69
    assert reviewed[1]["manualReview"] is True
    assert reviewed[1]["auto_render"] is False


def test_missing_reviewer_cannot_auto_render_weak_local_evidence(monkeypatch):
    monkeypatch.setattr(
        cliper_worker,
        "provider_request",
        lambda *_args, **_kwargs: {"response": "not-json"},
    )
    reviewed, reviewer_used = cliper_worker.review_ai_highlight_candidates(
        [{
            "id": 4,
            "_source_candidate_id": 4,
            "score": 74,
            "initial_score": 74,
            "local_score": 57,
            "primary_score": 82,
            "ai_score": 82,
            "ai_evidence_gate": True,
            "text": "Pidato membahas program dan pengawasan secara lengkap.",
            "metrics": {"story_complete": 90, "payoff": 55, "hook": 40},
        }],
        {"providerType": "cloud", "aiRoutingMode": "balanced"},
        1,
    )

    assert reviewer_used is False
    assert reviewed[0]["score"] == 61
    assert reviewed[0]["providerScores"] == {"local": 57, "primary": 67}
    assert reviewed[0]["scoreProvenance"]["providerScoreCap"] == 67
    assert reviewed[0]["reviewer_status"] == "unavailable"
    assert reviewed[0]["manualReview"] is True
    assert reviewed[0]["auto_render"] is False


def test_candidate_title_generation_never_spends_ai_tokens(monkeypatch):
    def unexpected_provider_call(*_args, **_kwargs):
        raise AssertionError("candidate title must stay local until final quality gate")

    monkeypatch.setattr(cliper_worker, "provider_request", unexpected_provider_call)
    title = cliper_worker.make_title(
        "Nunu menerima telepon kejutan lalu mendapat kesempatan menyanyi profesional.",
        1,
        {
            "providerType": "cloud",
            "metadataToggle": True,
            "aiFeatures": {"title": True},
        },
    )

    assert title
    assert "Nunu" in title


def test_hook_quality_rejects_spoken_filler_fragment():
    source = (
        "Nunu belum tahu Mbak Siti Aliah dinaungi Musik Plus. "
        "Setelah itu ada telepon yang menawarkan kerja sama."
    )

    assert cliper_worker.hook_quality_score(
        "Nunu kan belum tahu ee Mbak Siti Aliah",
        source,
    ) == 0


def test_make_hook_text_replaces_cached_filler_with_approved_title():
    source = (
        "Nunu belum tahu Mbak Siti Aliah dinaungi Musik Plus. "
        "Setelah itu ada telepon yang menawarkan kerja sama."
    )
    moment = {
        "hook": "Nunu kan belum tahu ee Mbak Siti Aliah",
        "titleSuggestion": "Telepon Kejutan yang Ubah Hidup Nunu",
        "transcript": source,
    }

    hook = cliper_worker.make_hook_text(moment, {"addHook": False})

    assert hook == "Telepon Kejutan yang Ubah Hidup Nunu"
    assert " ee " not in f" {hook.lower()} "


def test_hook_director_skips_ungrounded_generic_hook():
    moment = {
        "hook": "Kamu wajib lihat ini sekarang",
        "title": "Pembahasan biasa",
        "transcript": "Pembicara melanjutkan obrolan tanpa klaim atau hasil yang jelas.",
        "duration": 45,
    }
    payload = {
        "addHook": True,
        "aiFeatures": {"hook": False},
        "featureFlags": {"hookV2": True, "hookDirectorV1": True},
    }

    assert cliper_worker.make_hook_text(moment, payload) == ""
    assert cliper_worker.hook_overlay_plan(moment, [], payload)["enabled"] is False


def test_hook_layouts_use_distinct_safe_frame_positions():
    top = cliper_worker.ass_hook_card_events(
        "Strategi Ini Mengubah Hasil", 3, 1080, 1920, 64, "top_banner"
    )
    center = cliper_worker.ass_hook_card_events(
        "Strategi Ini Mengubah Hasil", 3, 1080, 1920, 64, "center_card"
    )

    assert top
    assert center
    assert top != center
    assert "top_banner" == cliper_worker.normalized_hook_layout("auto", 1080, 1920)
    assert "center_card" == cliper_worker.normalized_hook_layout("center", 1080, 1920)

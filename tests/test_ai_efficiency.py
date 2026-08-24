import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))

import cliper_worker


def ai_payload(cache_root):
    return {
        "providerType": "openai",
        "baseUrl": "https://api.example.test/v1",
        "apiKey": "test-key",
        "model": "quality-mini",
        "highlightModel": "quality-mini",
        "cacheRoot": str(cache_root),
    }


def test_identical_ai_request_uses_deterministic_local_cache(tmp_path, monkeypatch):
    calls = []

    def fake_request(payload, prompt):
        calls.append((payload["highlightModel"], prompt))
        return {
            "response": '{"score":82,"reason":"complete story"}',
            "usage": {"prompt_tokens": 120, "completion_tokens": 18},
            "parser": "test",
        }

    monkeypatch.setattr(cliper_worker, "call_openai_compatible", fake_request)
    cliper_worker.AI_USAGE.update(
        {
            "input_tokens": 0,
            "output_tokens": 0,
            "requests": 0,
            "errors": 0,
            "cache_hits": 0,
            "cache_misses": 0,
        }
    )
    payload = ai_payload(tmp_path / "cache")
    prompt = "Rank candidate 7 using only supplied evidence."

    first = cliper_worker.provider_request(payload, prompt, module="Highlight Ranking")
    second = cliper_worker.provider_request(payload, prompt, module="Highlight Ranking")

    assert first["response"] == second["response"]
    assert second["cached"] is True
    assert len(calls) == 1
    assert cliper_worker.AI_USAGE["requests"] == 1
    assert cliper_worker.AI_USAGE["cache_hits"] == 1
    assert cliper_worker.AI_USAGE["cache_misses"] == 1


def test_ai_cache_key_changes_with_model_prompt_and_prompt_version(tmp_path):
    payload = ai_payload(tmp_path / "cache")
    key_a, identity_a = cliper_worker.ai_response_cache_identity(payload, "candidate A", "Hook Maker")
    key_b, _ = cliper_worker.ai_response_cache_identity(payload, "candidate B", "Hook Maker")
    changed_model = {**payload, "model": "quality-large", "highlightModel": "quality-large"}
    key_c, _ = cliper_worker.ai_response_cache_identity(changed_model, "candidate A", "Hook Maker")

    assert identity_a["prompt_version"] == "hook_v5"
    assert len({key_a, key_b, key_c}) == 3


def test_render_only_policy_disables_hook_and_title_provider_calls(monkeypatch):
    payload = {
        **ai_payload(Path("cache")),
        "_renderOnly": True,
        "addHook": True,
    }

    def forbidden(*_args, **_kwargs):
        raise AssertionError("render must not call an AI provider")

    monkeypatch.setattr(cliper_worker, "ai_generate_hook", forbidden)
    monkeypatch.setattr(cliper_worker, "ai_generate_upload_title", forbidden)
    moment = {
        "title": "Alasan Usaha Ini Akhirnya Berubah",
        "titleSuggestion": "Alasan Usaha Ini Akhirnya Berubah",
        "hook": "Usaha ini berubah setelah keputusan penting",
        "transcript": "Usaha ini berubah setelah keputusan penting yang mereka ambil bersama.",
    }

    assert cliper_worker.is_ai_feature_enabled(payload, "hook") is False
    assert cliper_worker.is_ai_feature_enabled(payload, "title") is False
    assert cliper_worker.make_hook_text(moment, payload)
    assert cliper_worker.seo_upload_title(moment, 1, payload)

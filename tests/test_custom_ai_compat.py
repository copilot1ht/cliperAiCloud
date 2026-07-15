import json
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))
import cliper_worker


def test_custom_provider_retries_timeout_then_succeeds(monkeypatch):
    calls = []

    def fake_fetch(url, data=None, headers=None, timeout=30):
        calls.append({"url": url, "timeout": timeout, "data": data})
        if len(calls) == 1:
            raise TimeoutError("SSL handshake operation timed out")
        return {
            "choices": [{"message": {"content": "OK"}}],
            "usage": {"prompt_tokens": 2, "completion_tokens": 1},
            "__http_status": 200,
        }

    monkeypatch.setattr(cliper_worker, "fetch_json", fake_fetch)
    monkeypatch.setattr(cliper_worker.time, "sleep", lambda _seconds: None)
    result = cliper_worker.call_openai_compatible(
        {
            "providerType": "custom",
            "baseUrl": "https://provider.example/v1",
            "apiKey": "key",
            "model": "model-a",
            "maxTokens": 100,
            "timeoutMs": 90,
            "aiRetry": 3,
        },
        "Reply only OK",
    )

    assert result["response"] == "OK"
    assert result["retry_count"] == 1
    assert len(calls) == 2
    assert calls[0]["timeout"] == 90
    assert calls[0]["url"] == "https://provider.example/v1/chat/completions"


def test_custom_provider_downgrades_unsupported_parameters(monkeypatch):
    requests = []

    def fake_fetch(_url, data=None, headers=None, timeout=30):
        requests.append(dict(data or {}))
        if len(requests) == 1:
            return {
                "error": {"message": "Unsupported parameter: temperature"},
                "__http_status": 400,
            }
        return {
            "choices": [{"message": {"content": "compatible"}}],
            "__http_status": 200,
        }

    monkeypatch.setattr(cliper_worker, "fetch_json", fake_fetch)
    result = cliper_worker.call_openai_compatible(
        {
            "providerType": "custom",
            "baseUrl": "https://provider.example/v1/chat/completions",
            "apiKey": "key",
            "model": "model-b",
            "maxTokens": 100,
            "aiRetry": 2,
        },
        "Test",
    )

    assert result["response"] == "compatible"
    assert result["compatibility_mode"] == "minimal"
    assert "temperature" in requests[0]
    assert "temperature" not in requests[1]
    assert requests[1]["model"] == "model-b"


def test_parse_multiple_openai_compatible_response_shapes():
    assert cliper_worker.parse_ai_content({"message": {"content": "ollama"}})[0] == "ollama"
    assert cliper_worker.parse_ai_content({"content": [{"type": "text", "text": "anthropic"}]})[0] == "anthropic"
    response_api = {
        "output": [
            {
                "type": "message",
                "content": [{"type": "output_text", "text": "responses"}],
            }
        ]
    }
    assert cliper_worker.parse_ai_content(response_api)[0] == "responses"
    reasoning_only = {"choices": [{"message": {"content": "", "reasoning_content": "thinking but no answer"}}]}
    assert cliper_worker.parse_ai_content(reasoning_only)[0] == ""


def test_highlight_shortlist_spreads_story_ids_and_batches():
    candidates = []
    for story_id in range(1, 7):
        for offset in range(5):
            item_id = len(candidates) + 1
            candidates.append(
                {
                    "id": item_id,
                    "story_id": story_id,
                    "start": story_id * 300 + offset * 35,
                    "end": story_id * 300 + offset * 35 + 40,
                    "duration": 40,
                    "score": 90 - offset,
                    "text": f"Story {story_id} candidate {offset}",
                    "metrics": {"hook": 70, "story_complete": 75},
                }
            )

    shortlist = cliper_worker.build_ai_highlight_shortlist(candidates, 5)
    batches = cliper_worker.build_ai_highlight_batches(candidates, 5, batch_size=10)

    assert len(shortlist) == 25
    assert {item["story_id"] for item in shortlist[:6]} == {1, 2, 3, 4, 5, 6}
    assert len(batches) == 3
    assert all(len(batch) <= 10 for batch in batches)


def test_module_policy_gives_highlight_longer_timeout_and_retries():
    payload = cliper_worker.payload_for_ai_module(
        {
            "providerType": "custom",
            "model": "any-model",
            "maxTokensByModule": {"highlight": 1500},
            "timeoutMsByModule": {"highlight": 90000},
            "aiRetryByModule": {"highlight": 3},
        },
        "Highlight Finder Batch 1/2",
    )

    assert payload["maxTokens"] == 1500
    assert payload["timeoutMs"] == 90
    assert payload["aiRetry"] == 3
    assert payload["_aiModuleKey"] == "highlight"


def test_highlight_selector_keeps_successful_batches_when_one_fails(monkeypatch):
    candidates = []
    for index in range(18):
        start = index * 80.0
        candidates.append(
            {
                "id": index + 1,
                "story_id": (index % 6) + 1,
                "start": start,
                "end": start + 45.0,
                "duration": 45.0,
                "score": 72,
                "title": f"Cerita Kandidat {index + 1}",
                "titleSuggestion": f"Cerita Kandidat {index + 1}",
                "hook": f"Cerita kandidat nomor {index + 1}",
                "text": f"Cerita kandidat {index + 1} punya hasil akhirnya jelas dan berhasil.",
                "transcript": f"Cerita kandidat {index + 1} punya hasil akhirnya jelas dan berhasil.",
                "metrics": {
                    "hook": 72,
                    "payoff": 72,
                    "story_complete": 82,
                    "retention_predictor": 80,
                    "filler_ratio": 0.02,
                },
            }
        )

    calls = []

    def fake_provider(_payload, prompt, module="AI"):
        calls.append(module)
        if len(calls) == 1:
            raise RuntimeError("SSL handshake operation timed out")
        batch = json.loads(prompt.split("Kandidat:\n", 1)[1])
        selected = [
            {
                "source_id": item["id"],
                "score": 90,
                "title": f"Cerita Kandidat {item['id']} Berhasil",
                "hook": f"Kenapa Kandidat {item['id']} Akhirnya Berhasil",
                "reason": "Payoff dan alur jelas",
                "layout": "single",
            }
            for item in batch[:2]
        ]
        return {"response": json.dumps(selected), "retry_count": 0, "usage": {}}

    monkeypatch.setattr(cliper_worker, "provider_request", fake_provider)
    result = cliper_worker.ai_select_moments(
        candidates,
        {
            "providerType": "custom",
            "baseUrl": "https://provider.example/v1",
            "apiKey": "key",
            "model": "model-a",
            "highlightModel": "model-a",
            "fullAutoMode": True,
            "aiFeatures": {"highlight": True},
        },
        target_count=3,
        transcript=[],
        min_duration=30,
        max_duration=90,
    )

    assert len(calls) >= 2
    assert result
    assert all(item["ai_selected"] for item in result)
    assert all(item["score"] >= cliper_worker.AUTO_SELECT_MIN_SCORE for item in result)

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))
import cliper_worker


def test_custom_deepseek_request_disables_thinking_and_normalizes_endpoint(monkeypatch):
    captured = {}

    def fake_fetch(url, data=None, headers=None, timeout=30):
        captured.update({"url": url, "data": data})
        return {
            "choices": [{"message": {"content": "OK"}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1},
            "__http_status": 200,
        }

    monkeypatch.setattr(cliper_worker, "fetch_json", fake_fetch)
    result = cliper_worker.call_openai_compatible(
        {
            "providerType": "custom",
            "baseUrl": "https://api.deepseek.com/v1",
            "apiKey": "test-key",
            "highlightModel": "deepseek-v4-flash",
            "maxTokens": 64,
            "aiRetry": 1,
        },
        "Reply only OK",
    )

    assert result["response"] == "OK"
    assert captured["url"] == "https://api.deepseek.com/chat/completions"
    assert captured["data"]["thinking"] == {"type": "disabled"}

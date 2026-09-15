import sys
from pathlib import Path

import pytest


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))
import cliper_worker


def test_cloud_job_contract_never_contains_local_media_or_paths():
    local_path = r"C:\\Users\\Creator\\Videos\\private source.mp4"
    payload = {
        "url": "https://youtu.be/example",
        "localVideoPath": local_path,
        "videoDuration": 352.0,
        "clipCount": 8,
        "transcript": "This must remain local.",
        "videoBase64": "not allowed",
    }

    request = cliper_worker.cloud_analysis_job_input(payload, "analysis-1")

    assert request == {
        "requestId": "analysis-1",
        "sourceId": cliper_worker.hashlib.sha256(payload["url"].encode("utf-8")).hexdigest()[:24],
        "contentMode": "auto",
        "sourceDurationSeconds": 352.0,
        "requestedClipCount": 8,
    }
    assert local_path not in str(request)
    assert "transcript" not in request
    assert "videoBase64" not in request


def test_cloud_job_contract_carries_safe_content_mode_for_trial_policy():
    payload = {
        "url": "https://youtu.be/example-summary",
        "contentMode": "summary",
        "videoDuration": 120,
        "clipCount": 8,
    }

    request = cliper_worker.cloud_analysis_job_input(payload, "analysis-summary")

    assert request["contentMode"] == "summary"
    assert request["requestedClipCount"] == 1
    assert "https://youtu.be/example-summary" not in str(request)


def test_local_source_analysis_does_not_start_cloud_billing_job(monkeypatch):
    called = False

    def fake_cloud_job_request(*_args, **_kwargs):
        nonlocal called
        called = True
        return {"id": "job"}

    monkeypatch.setattr(cliper_worker, "cloud_job_request", fake_cloud_job_request)

    result = cliper_worker.start_cloud_analysis_job({
        "providerType": "cloud",
        "sourceMode": "local",
        "contentMode": "landscape_blur",
        "localVideoPath": r"C:\\Users\\Creator\\Videos\\local.mp4",
    })

    assert result is None
    assert called is False


def test_cloud_editorial_prompt_redacts_local_media_references():
    prompt = (
        "Candidate evidence only. "
        r"Source C:\\Users\\Creator\\Videos\\private.mp4 "
        "asset data:image/png;base64,aGVsbG8="
    )

    sanitized = cliper_worker.prepare_cloud_editorial_prompt(prompt)

    assert "C:\\Users" not in sanitized
    assert "data:image" not in sanitized
    assert "[local-path-redacted]" in sanitized
    assert "[local-media-redacted]" in sanitized


def test_cloud_editorial_prompt_rejects_full_transcript_sized_payloads():
    with pytest.raises(RuntimeError, match="shortlist/ringkasan"):
        cliper_worker.prepare_cloud_editorial_prompt("x" * 48_001)

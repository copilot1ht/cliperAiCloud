import hashlib
import hmac
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "worker"
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

import cliper_worker as worker


def test_cloud_request_signature_matches_canonical_body():
    payload = {
        "cloudAccessToken": "clip_at_test",
        "cloudSigningSecret": "s" * 48,
    }
    data = {"model": "auto", "messages": [{"role": "user", "content": "Halo dunia"}]}
    endpoint = "http://localhost:4100/v1/chat/completions"
    headers = worker.cloud_signed_headers(payload, endpoint, data)
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    checksum = hashlib.sha256(body.encode("utf-8")).hexdigest()
    canonical = "\n".join([
        "POST",
        "/v1/chat/completions",
        headers["X-Cliper-Timestamp"],
        headers["X-Cliper-Nonce"],
        checksum,
    ])
    expected = hmac.new(("s" * 48).encode(), canonical.encode(), hashlib.sha256).hexdigest()
    assert headers["X-Cliper-Content-SHA256"] == checksum
    assert hmac.compare_digest(headers["X-Cliper-Signature"], expected)


def test_cloud_response_rejects_tampering():
    secret = "r" * 48
    payload = {"cloudSigningSecret": secret}
    endpoint = "http://localhost:4100/v1/chat/completions"
    response = {
        "id": "chat-1",
        "choices": [{"message": {"role": "assistant", "content": "valid"}}],
    }
    body = json.dumps(response, ensure_ascii=False, separators=(",", ":"))
    checksum = hashlib.sha256(body.encode("utf-8")).hexdigest()
    timestamp = "1700000000000"
    canonical = "\n".join(["RESPONSE", "/v1/chat/completions", timestamp, "response", checksum])
    signature = hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    response["integrity"] = {"timestamp": timestamp, "checksum": checksum, "signature": signature}

    worker.verify_cloud_response(payload, endpoint, response)
    response["choices"][0]["message"]["content"] = "tampered"
    with pytest.raises(RuntimeError, match="Checksum"):
        worker.verify_cloud_response(payload, endpoint, response)

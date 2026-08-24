import sys
from pathlib import Path

import pytest


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))

import cliper_worker


class _RetryingYdl:
    def __init__(self, failures):
        self.failures = failures
        self.calls = 0

    def YoutubeDL(self, _options):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def extract_info(self, _url, download=False):
        self.calls += 1
        if self.calls <= self.failures:
            raise OSError("The handshake operation timed out")
        return {"id": "abcdefghijk", "download": download}


def test_youtube_metadata_retry_recovers_from_transient_tls_timeout(monkeypatch):
    client = _RetryingYdl(failures=2)
    monkeypatch.setattr(cliper_worker.time, "sleep", lambda _seconds: None)

    result = cliper_worker.extract_info_with_network_retry(
        client,
        {},
        "https://youtu.be/abcdefghijk",
        False,
        "Metadata/download YouTube",
    )

    assert result["id"] == "abcdefghijk"
    assert client.calls == 3


def test_youtube_metadata_retry_reports_a_stable_tls_error(monkeypatch):
    client = _RetryingYdl(failures=5)
    monkeypatch.setattr(cliper_worker.time, "sleep", lambda _seconds: None)

    with pytest.raises(RuntimeError, match="NETWORK_TLS_TIMEOUT"):
        cliper_worker.extract_info_with_network_retry(
            client,
            {},
            "https://youtu.be/abcdefghijk",
            False,
            "Metadata/download YouTube",
        )

    assert client.calls == 3

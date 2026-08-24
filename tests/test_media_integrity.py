import json
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))

import cliper_worker


def _media_file(tmp_path):
    path = tmp_path / "source.mp4"
    path.write_bytes(b"0" * (64 * 1024))
    return path


def test_worker_payload_hydrates_secrets_from_environment_and_removes_them(
    tmp_path, monkeypatch
):
    payload_path = tmp_path / "payload.json"
    payload_path.write_text(
        json.dumps({"providerType": "cloud"}), encoding="utf-8"
    )
    monkeypatch.setenv("CLIPER_WORKER_CLOUD_ACCESS_TOKEN", "short-lived-token")
    monkeypatch.setenv(
        "CLIPER_WORKER_CLOUD_SIGNING_SECRET", "signing-secret"
    )

    payload = cliper_worker.load_payload(payload_path)

    assert payload["cloudAccessToken"] == "short-lived-token"
    assert payload["cloudSigningSecret"] == "signing-secret"
    assert "CLIPER_WORKER_CLOUD_ACCESS_TOKEN" not in cliper_worker.os.environ
    assert "CLIPER_WORKER_CLOUD_SIGNING_SECRET" not in cliper_worker.os.environ


def test_media_probe_fails_closed_when_ffprobe_is_unavailable(
    tmp_path, monkeypatch
):
    media_path = _media_file(tmp_path)
    monkeypatch.setattr(cliper_worker.shutil, "which", lambda _name: None)

    result = cliper_worker.probe_media_file(media_path)

    assert result["valid"] is False
    assert "ffprobe tidak tersedia" in result["reason"]


def test_media_probe_fails_closed_when_ffprobe_errors(tmp_path, monkeypatch):
    media_path = _media_file(tmp_path)
    monkeypatch.setattr(
        cliper_worker.shutil, "which", lambda _name: "ffprobe"
    )

    def fail_probe(*_args, **_kwargs):
        raise TimeoutError("probe timeout")

    monkeypatch.setattr(cliper_worker.subprocess, "run", fail_probe)

    result = cliper_worker.probe_media_file(media_path)

    assert result["valid"] is False
    assert "ffprobe gagal memverifikasi media" in result["reason"]


def test_media_probe_requires_successful_ffprobe_exit(tmp_path, monkeypatch):
    media_path = _media_file(tmp_path)
    monkeypatch.setattr(
        cliper_worker.shutil, "which", lambda _name: "ffprobe"
    )
    monkeypatch.setattr(
        cliper_worker.subprocess,
        "run",
        lambda *_args, **_kwargs: type(
            "Probe", (), {"returncode": 1, "stdout": "not media"}
        )(),
    )

    result = cliper_worker.probe_media_file(media_path)

    assert result["valid"] is False
    assert "tidak dapat membaca media" in result["reason"]


def test_media_probe_accepts_verified_video(tmp_path, monkeypatch):
    media_path = _media_file(tmp_path)
    monkeypatch.setattr(
        cliper_worker.shutil, "which", lambda _name: "ffprobe"
    )
    probe_output = json.dumps(
        {
            "streams": [
                {"codec_type": "video"},
                {"codec_type": "audio"},
            ],
            "format": {"duration": "12.5"},
        }
    )
    monkeypatch.setattr(
        cliper_worker.subprocess,
        "run",
        lambda *_args, **_kwargs: type(
            "Probe", (), {"returncode": 0, "stdout": probe_output}
        )(),
    )

    result = cliper_worker.probe_media_file(media_path)

    assert result == {
        "valid": True,
        "hasVideo": True,
        "hasAudio": True,
        "duration": 12.5,
        "reason": "ok",
    }


def test_media_probe_honors_configured_ffprobe_path(tmp_path, monkeypatch):
    media_path = _media_file(tmp_path)
    ffprobe_path = tmp_path / "ffprobe-custom.exe"
    ffprobe_path.write_bytes(b"test")
    cliper_worker.normalize_renderer_settings(
        {"ffprobePath": str(ffprobe_path)}
    )
    probe_output = json.dumps(
        {
            "streams": [{"codec_type": "video"}],
            "format": {"duration": "2.0"},
        }
    )

    def capture_probe(command, **_kwargs):
        assert command[0] == str(ffprobe_path)
        return type("Probe", (), {"returncode": 0, "stdout": probe_output})()

    monkeypatch.setattr(cliper_worker.subprocess, "run", capture_probe)

    result = cliper_worker.probe_media_file(media_path)

    assert result["valid"] is True
    cliper_worker.FFPROBE_OVERRIDE = ""

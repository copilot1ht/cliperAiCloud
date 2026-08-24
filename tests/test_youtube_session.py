import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))

import cliper_worker


def test_generic_http_403_is_not_mislabeled_as_expired_session():
    error = RuntimeError("HTTP Error 403: Forbidden")

    assert cliper_worker.download_error_class(error) == "HTTP_403"
    assert cliper_worker.needs_cookies_error(error) is False
    assert cliper_worker.session_retry_candidate(error) is True


def test_confirmed_auth_error_requires_session():
    error = RuntimeError("Sign in to confirm you are not a bot. Use --cookies.")

    assert cliper_worker.download_error_class(error) == "AUTH_REQUIRED"
    assert cliper_worker.needs_cookies_error(error) is True


def test_download_error_classes_are_stable():
    cases = {
        "Requested format is not available": "FORMAT_UNAVAILABLE",
        "HTTP Error 429: Too Many Requests": "RATE_LIMITED",
        "This video is not available in your country": "GEO_RESTRICTED",
        "Private video": "VIDEO_RESTRICTED",
        "The handshake operation timed out": "NETWORK_ERROR",
        "cookies are malformed": "COOKIE_INVALID",
    }

    for message, expected in cases.items():
        assert cliper_worker.download_error_class(RuntimeError(message)) == expected


def test_youtube_session_manager_persists_and_replaces_without_exposing_values(tmp_path):
    source = tmp_path / "source-cookies.txt"
    source.write_text(
        "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsecret-first\n",
        encoding="utf-8",
    )
    session_root = tmp_path / "app-data" / "auth" / "youtube"
    module_path = ROOT / "electron" / "youtube-session-manager.js"
    script = r"""
const fs = require("fs");
const { YouTubeSessionManager } = require(process.argv[1]);
const manager = new YouTubeSessionManager(process.argv[2]);
const first = manager.importFile(process.argv[3], { ok: true, warning: null });
fs.unlinkSync(process.argv[3]);
const persisted = manager.readMetadata();
fs.writeFileSync(process.argv[4], "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsecret-second\n");
const second = manager.importFile(process.argv[4], { ok: true, warning: null });
const checked = manager.recordCheck({ testOk: true, testedAt: "2026-08-24T00:00:00.000Z" });
const storedValue = fs.readFileSync(checked.path, "utf8");
const removed = manager.remove();
process.stdout.write(JSON.stringify({
  firstPresent: first.present,
  persistedAfterSourceDelete: persisted.present,
  replaced: storedValue.includes("secret-second") && !storedValue.includes("secret-first"),
  checkedState: checked.state,
  removedPresent: removed.present
}));
"""
    replacement = tmp_path / "replacement-cookies.txt"
    result = subprocess.run(
        [
            "node",
            "-e",
            script,
            str(module_path),
            str(session_root),
            str(source),
            str(replacement),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    data = json.loads(result.stdout)

    assert data == {
        "firstPresent": True,
        "persistedAfterSourceDelete": True,
        "replaced": True,
        "checkedState": "SESSION_VALID",
        "removedPresent": False,
    }
    assert "secret-first" not in result.stdout
    assert "secret-second" not in result.stdout


def test_youtube_session_ui_does_not_display_cookie_path_or_fake_expiry():
    app = (ROOT / "app.js").read_text(encoding="utf-8")
    html = (ROOT / "index.html").read_text(encoding="utf-8")

    assert 'setText("#cookieState", hasCookies ? info.path' not in app
    assert "Perbarui cookies setiap sekitar 1 minggu" not in html
    assert "HTTP 403 umum tidak otomatis dianggap" in html
    assert "removeYouTubeSession" in app

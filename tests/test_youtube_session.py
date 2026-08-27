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


def test_browser_session_update_is_atomic_persistent_and_auto_refreshable(tmp_path):
    session_root = tmp_path / "app-data" / "auth" / "youtube"
    module_path = ROOT / "electron" / "youtube-session-manager.js"
    script = r"""
const fs = require("fs");
const { YouTubeSessionManager } = require(process.argv[1]);
const manager = new YouTubeSessionManager(process.argv[2]);
const update = manager.beginBrowserUpdate("chrome");
fs.writeFileSync(update.outputPath, "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsecret-browser\n");
const completed = manager.completeBrowserUpdate("chrome", {
  ok: true,
  testedAt: "2026-08-25T00:00:00.000Z"
});
const restarted = new YouTubeSessionManager(process.argv[2]).readMetadata();
process.stdout.write(JSON.stringify({
  state: completed.state,
  source: completed.source,
  browser: completed.browser,
  autoRefresh: completed.autoRefresh,
  persisted: restarted.present && restarted.autoRefresh,
  stagingRemoved: !fs.existsSync(update.outputPath)
}));
"""
    result = subprocess.run(
        ["node", "-e", script, str(module_path), str(session_root)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )

    assert json.loads(result.stdout) == {
        "state": "SESSION_UPDATED",
        "source": "browser",
        "browser": "chrome",
        "autoRefresh": True,
        "persisted": True,
        "stagingRemoved": True,
    }
    assert "secret-browser" not in result.stdout


def test_worker_browser_update_exports_local_cookie_file_without_cloud(monkeypatch, tmp_path):
    output = tmp_path / "auth" / "youtube" / "cookies.browser-update.tmp"

    class FakeCookieJar:
        def save(self, pathname, **_kwargs):
            Path(pathname).write_text(
                "# Netscape HTTP Cookie File\n"
                ".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsecret-value\n",
                encoding="utf-8",
            )

    class FakeYoutubeDL:
        def __init__(self, options):
            self.options = options
            self.cookiejar = FakeCookieJar()

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def extract_info(self, _url, download=False):
            assert download is False
            assert self.options["cookiesfrombrowser"] == ("chrome",)
            return {"title": "Session validation"}

    fake_module = type("FakeYtDlp", (), {"YoutubeDL": FakeYoutubeDL})
    monkeypatch.setattr(cliper_worker, "require_yt_dlp", lambda: fake_module)

    result = cliper_worker.update_youtube_session_from_browser(
        {"browser": "chrome", "outputPath": str(output)}
    )

    assert result["ok"] is True
    assert result["testOk"] is True
    assert result["source"] == "browser"
    assert output.exists()
    assert "secret-value" not in json.dumps(result)


def test_browser_update_contract_is_exposed_to_renderer_and_has_manual_fallback():
    app = (ROOT / "app.js").read_text(encoding="utf-8")
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    preload = (ROOT / "electron" / "preload.js").read_text(encoding="utf-8")
    main = (ROOT / "electron" / "main.js").read_text(encoding="utf-8")

    assert "updateYouTubeSession" in preload
    assert 'ipcMain.handle("cliper:update-youtube-session"' in main
    assert "runWorkerWithYouTubeRecovery" in main
    assert 'errorClass === "AUTH_REQUIRED"' in main
    assert 'id="importCookiesButton"' in html
    assert "updateYouTubeSession" in app
    assert 'id="chooseCookieFile"' in html
    assert "await resumePendingSessionJob();" in app

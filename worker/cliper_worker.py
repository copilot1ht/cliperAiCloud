import argparse
import importlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import gc
import hashlib
import hmac
import secrets
import urllib.parse
import urllib.error
import urllib.request
from array import array
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any

from render_engine import RenderEngine, FilenameSanitizer, default_output_folder, RenderError

try:
    from highlight_engine import score_highlight as score_highlight_v2
    from highlight_engine import filler_ratio as highlight_filler_ratio
    from highlight_engine import dynamic_duration_profile
    from highlight_engine import generate_highlight_candidates as external_generate_highlight_candidates
except Exception:
    score_highlight_v2 = None
    highlight_filler_ratio = None
    dynamic_duration_profile = None
    external_generate_highlight_candidates = None

try:
    from story_engine import clip_segment_text as external_clip_segment_text
    from story_engine import extend_story_boundary as external_extend_story_boundary
    from story_engine import build_story_timeline as external_build_story_timeline
    from story_engine import segment_into_story_candidates as external_story_candidates
except Exception:
    external_clip_segment_text = None
    external_extend_story_boundary = None
    external_build_story_timeline = None
    external_story_candidates = None

CameraEngine = None
SpeakerEngine = None
try:
    # Worker-local engines are packaged with the Python runtime.
    from camera_engine import CameraEngine
except ImportError:
    CameraEngine = None
try:
    from speaker_engine import SpeakerEngine
except ImportError:
    SpeakerEngine = None

try:
    from subtitle_engine import SubtitleEngine as ProductionSubtitleEngine, build_word_highlight_ass_text, split_ass_tokens
except Exception:
    ProductionSubtitleEngine = None
    build_word_highlight_ass_text = None
    split_ass_tokens = None

try:
    from active_speaker_engine import (
        discover_speaker_grounding_path,
        fuse_speaker_grounding,
        load_speaker_grounding,
        merge_speaker_context_with_grounding,
        speaker_grounding_fingerprint,
    )
except Exception:
    discover_speaker_grounding_path = None
    fuse_speaker_grounding = None
    load_speaker_grounding = None
    merge_speaker_context_with_grounding = None
    speaker_grounding_fingerprint = None

try:
    from heatmap_engine import (
        heatmap_evidence_for_interval,
        load_or_fetch_heatmap,
        story_bound_heatmap_candidates,
    )
except Exception:
    heatmap_evidence_for_interval = None
    load_or_fetch_heatmap = None
    story_bound_heatmap_candidates = None

AI_DEBUG_EVENTS = []
AI_USAGE = {
    "input_tokens": 0,
    "output_tokens": 0,
    "requests": 0,
    "errors": 0,
    "cache_hits": 0,
    "cache_misses": 0,
}

AI_PROMPT_VERSIONS = {
    "highlight": "highlight_v4",
    "ranking": "ranking_v4",
    "story": "story_v3",
    "title": "title_v4",
    "hook": "hook_v5",
    "caption": "caption_v4",
    "tts": "tts_v1",
    "default": "default_v2",
}
WHISPER_MODEL_CACHE = {}
SETTINGS_CONTRACT_PATH = Path(__file__).with_name("settings-contract.json")
FFPROBE_OVERRIDE = ""

stdout_reconfigure = getattr(sys.stdout, "reconfigure", None)
if callable(stdout_reconfigure):
    stdout_reconfigure(encoding="utf-8", errors="replace")
stderr_reconfigure = getattr(sys.stderr, "reconfigure", None)
if callable(stderr_reconfigure):
    stderr_reconfigure(encoding="utf-8", errors="replace")


def safe_text(value):
    if value is None:
        return ""
    try:
        return str(value).encode("utf-8", errors="replace").decode("utf-8", errors="replace")
    except Exception:
        return ""


def safe_event(obj):
    if isinstance(obj, dict):
        return {safe_text(key): safe_event(value) for key, value in obj.items()}
    if isinstance(obj, list):
        return [safe_event(item) for item in obj]
    if isinstance(obj, tuple):
        return [safe_event(item) for item in obj]
    if hasattr(obj, "item"):
        try:
            return safe_event(obj.item())
        except Exception:
            pass
    if hasattr(obj, "tolist"):
        try:
            return safe_event(obj.tolist())
        except Exception:
            pass
    if obj is None or isinstance(obj, (bool, int, float)):
        return obj
    if isinstance(obj, Path):
        return str(obj)
    return safe_text(obj)


def json_default(value):
    cleaned = safe_event(value)
    if cleaned is value:
        return safe_text(value)
    return cleaned


def json_dumps(data, **kwargs):
    return json.dumps(data, ensure_ascii=False, default=json_default, **kwargs)


def emit(event_type, **payload):
    safe_payload = safe_event({"type": event_type, **payload})
    line = json.dumps(safe_payload, ensure_ascii=False) + "\n"
    try:
        sys.stdout.buffer.write(line.encode("utf-8", errors="replace"))
        sys.stdout.buffer.flush()
    except Exception:
        sys.stdout.write(line)
        sys.stdout.flush()


def boolean_contract_value(value, fallback=False):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "on"}:
            return True
        if normalized in {"false", "0", "no", "off", ""}:
            return False
    return bool(fallback)


@lru_cache(maxsize=1)
def load_settings_contract():
    contract = json.loads(SETTINGS_CONTRACT_PATH.read_text(encoding="utf-8"))
    if (
        not isinstance(contract.get("version"), int)
        or not isinstance(contract.get("booleanSettings"), list)
        or not isinstance(contract.get("defaults"), dict)
    ):
        raise RuntimeError("Settings contract tidak valid.")
    return contract


def normalize_renderer_settings(payload):
    global FFPROBE_OVERRIDE

    payload = dict(payload or {})
    contract = load_settings_contract()
    defaults = contract.get("defaults") or {}
    nested = payload.get("rendererSettings") if isinstance(payload.get("rendererSettings"), dict) else {}
    requested = payload.get("settingsRequested") if isinstance(payload.get("settingsRequested"), dict) else {}
    aliases = contract.get("legacyAliases") or {}
    normalized = {}
    for name in contract.get("booleanSettings") or []:
        candidates = [nested.get(name), requested.get(name), payload.get(name)]
        for alias in aliases.get(name) or []:
            candidates.extend((nested.get(alias), requested.get(alias), payload.get(alias)))
        selected = next((value for value in candidates if value is not None), None)
        normalized[name] = boolean_contract_value(selected, defaults.get(name, False))

    for setting, parent in (contract.get("dependencies") or {}).items():
        if not normalized.get(parent, False):
            normalized[setting] = False

    feature_defaults = contract.get("featureFlags") or {}
    supplied_flags = payload.get("featureFlags") if isinstance(payload.get("featureFlags"), dict) else {}
    feature_flags = {
        name: boolean_contract_value(supplied_flags.get(name), fallback)
        for name, fallback in feature_defaults.items()
    }

    client_version = payload.get(
        "_clientSettingsContractVersion", payload.get("settingsContractVersion")
    )
    payload["settingsContractVersion"] = contract["version"]
    payload["_clientSettingsContractVersion"] = client_version
    payload["rendererSettings"] = dict(normalized)
    payload["settingsRequested"] = dict(normalized)
    payload["_settingsRequested"] = dict(normalized)
    payload["featureFlags"] = feature_flags
    for name, value in normalized.items():
        payload[name] = value
    payload["disableAutoEnhancement"] = not normalized.get("autoVideoEnhancement", True)
    FFPROBE_OVERRIDE = safe_text(payload.get("ffprobePath") or payload.get("ffprobe_path")).strip()
    return payload


def resolve_ffprobe_path():
    candidate = safe_text(FFPROBE_OVERRIDE).strip()
    if candidate:
        candidate_path = Path(candidate).expanduser()
        if candidate_path.is_file():
            return str(candidate_path)
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
    return shutil.which("ffprobe") or shutil.which("ffprobe.exe")


def load_payload(path):
    # Electron writes UTF-8 without a BOM, while PowerShell and some Windows
    # tooling can write UTF-8 with one. Accept both for worker payloads.
    with open(path, "r", encoding="utf-8-sig", errors="replace") as handle:
        payload = json.load(handle)
    secret_fields = {
        "cloudAccessToken": "CLIPER_WORKER_CLOUD_ACCESS_TOKEN",
        "cloudSigningSecret": "CLIPER_WORKER_CLOUD_SIGNING_SECRET",
    }
    for field, environment_name in secret_fields.items():
        value = os.environ.pop(environment_name, "")
        if value:
            payload[field] = value
    return normalize_renderer_settings(payload)


def command_exists(name):
    return shutil.which(name) is not None


def youtube_runtime_options():
    """Use the installed Node runtime for modern YouTube player challenges.

    yt-dlp defaults to Deno, which is not commonly installed on Windows. Node
    ships with the desktop toolchain, so pass its resolved path explicitly
    rather than relying on yt-dlp's process PATH discovery.
    """
    node_path = shutil.which("node") or shutil.which("node.exe")
    return {"js_runtimes": {"node": {"path": node_path}}} if node_path else {}


def check_dependencies():
    ffprobe_path = resolve_ffprobe_path()
    deps = {
        "python": {
            "ok": True,
            "path": sys.executable,
            "version": sys.version.split()[0],
        },
        "yt_dlp": {"ok": False, "version": None},
        "ffmpeg": {"ok": command_exists("ffmpeg"), "path": shutil.which("ffmpeg")},
        "ffprobe": {"ok": bool(ffprobe_path), "path": ffprobe_path},
        "openai": {"ok": False, "version": None},
        "opencv": {"ok": False, "version": None},
        "mediapipe": {"ok": False, "version": None},
        "faster_whisper": {"ok": False, "version": None},
        "encoders": {"ok": False, "available": []},
    }
    try:
        yt_dlp = importlib.import_module("yt_dlp")
        version_module = getattr(yt_dlp, "version", None)
        version = getattr(yt_dlp, "__version__", None) or getattr(version_module, "__version__", None) or "installed"
        deps["yt_dlp"] = {"ok": True, "version": version}
    except Exception as exc:
        deps["yt_dlp"]["error"] = str(exc)
    try:
        openai = importlib.import_module("openai")
        deps["openai"] = {"ok": True, "version": getattr(openai, "__version__", "installed")}
    except Exception as exc:
        deps["openai"]["error"] = str(exc)
    try:
        cv2 = importlib.import_module("cv2")
        deps["opencv"] = {"ok": True, "version": getattr(cv2, "__version__", "installed")}
    except Exception as exc:
        deps["opencv"]["error"] = str(exc)
    try:
        mp = importlib.import_module("mediapipe")
        deps["mediapipe"] = {"ok": True, "version": getattr(mp, "__version__", "installed")}
    except Exception as exc:
        deps["mediapipe"]["error"] = str(exc)
    try:
        faster_whisper = importlib.import_module("faster_whisper")
        deps["faster_whisper"] = {"ok": True, "version": getattr(faster_whisper, "__version__", "installed")}
    except Exception as exc:
        deps["faster_whisper"]["error"] = str(exc)
    if deps["ffmpeg"]["ok"]:
        deps["encoders"] = {"ok": True, "available": available_h264_encoders()}
    return deps


def available_h264_encoders():
    try:
        result = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=12,
        )
        text = result.stdout.lower()
    except Exception:
        return []
    return [encoder for encoder in ["h264_nvenc", "h264_amf", "h264_qsv", "libx264"] if encoder in text]


DOWNLOAD_ERROR_MESSAGES = {
    "AUTH_REQUIRED": "YouTube meminta autentikasi",
    "COOKIE_MISSING": "Session YouTube belum tersedia",
    "COOKIE_INVALID": "File session YouTube tidak valid",
    "COOKIE_EXPIRED": "Session YouTube tidak lagi valid",
    "HTTP_403": "YouTube menolak request (HTTP 403)",
    "FORMAT_UNAVAILABLE": "Format video yang diminta tidak tersedia",
    "RATE_LIMITED": "YouTube membatasi request sementara",
    "GEO_RESTRICTED": "Video tidak tersedia di wilayah ini",
    "VIDEO_RESTRICTED": "Video memiliki pembatasan akses",
    "NETWORK_ERROR": "Koneksi download YouTube terputus",
    "DOWNLOADER_ERROR": "Downloader YouTube gagal memproses video",
    "UNKNOWN": "Download YouTube gagal",
}


def download_error_class(exc):
    text = str(exc).lower()
    for code in DOWNLOAD_ERROR_MESSAGES:
        if code.lower() in text:
            return "AUTH_REQUIRED" if code == "COOKIE_MISSING" else code
    if "session_update_required" in text:
        return "AUTH_REQUIRED"
    if any(
        item in text
        for item in [
            "bytes read",
            "more expected",
            "giving up after",
            "timed out",
            "timeout",
            "connection reset",
            "connection aborted",
            "remote end closed",
            "incomplete read",
            "read operation timed out",
            "temporary failure",
            "network is unreachable",
        ]
    ):
        return "NETWORK_ERROR"
    if any(item in text for item in ["429", "too many requests", "rate limit"]):
        return "RATE_LIMITED"
    if any(item in text for item in ["not available in your country", "geo-restricted", "geo restricted"]):
        return "GEO_RESTRICTED"
    if any(item in text for item in ["private video", "members-only", "members only", "join this channel"]):
        return "VIDEO_RESTRICTED"
    if "cookie" in text and any(item in text for item in ["expired", "invalid", "malformed"]):
        return "COOKIE_EXPIRED" if "expired" in text else "COOKIE_INVALID"
    if any(
        item in text
        for item in [
            "sign in to confirm",
            "sign in to verify",
            "login required",
            "authentication required",
            "use --cookies",
            "use --cookies-from-browser",
            "not a bot",
            "confirm your age",
            "age-restricted",
        ]
    ):
        return "AUTH_REQUIRED"
    if any(
        item in text
        for item in [
            "requested format is not available",
            "no video formats found",
            "format is not available",
            "format unavailable",
        ]
    ):
        return "FORMAT_UNAVAILABLE"
    if any(item in text for item in ["403", "forbidden", "access denied"]):
        return "HTTP_403"
    if any(item in text for item in ["unsupported url", "unable to extract", "yt-dlp"]):
        return "DOWNLOADER_ERROR"
    return "UNKNOWN"


def classify_download_error(exc):
    code = download_error_class(exc)
    return f"{code}: {DOWNLOAD_ERROR_MESSAGES[code]}"


def is_retryable_network_error(exc):
    text = str(exc).lower()
    return any(
        marker in text
        for marker in [
            "timed out",
            "timeout",
            "handshake operation",
            "connection reset",
            "connection aborted",
            "remote end closed",
            "temporary failure",
            "network is unreachable",
            "try again",
        ]
    )


def needs_cookies_error(exc):
    return download_error_class(exc) in {
        "AUTH_REQUIRED",
        "COOKIE_MISSING",
        "COOKIE_INVALID",
        "COOKIE_EXPIRED",
    }


def session_retry_candidate(exc):
    return needs_cookies_error(exc) or download_error_class(exc) == "HTTP_403"


def validate_cookie_file(cookie_path):
    if not cookie_path:
        return {"ok": False, "reason": "File cookies belum dipilih."}
    path = Path(cookie_path)
    if not path.exists():
        return {"ok": False, "reason": "File cookies tidak ditemukan.", "path": str(path)}
    try:
        stat = path.stat()
        if stat.st_size == 0:
            return {"ok": False, "reason": "Cookies kosong.", "path": str(path)}
        if stat.st_size > 20 * 1024 * 1024:
            return {"ok": False, "reason": "Ukuran cookies terlalu besar.", "path": str(path), "sizeBytes": stat.st_size}
        text = path.read_text(encoding="utf-8", errors="replace")
    except PermissionError:
        return {"ok": False, "reason": "Permission denied saat membaca cookies.", "path": str(path)}
    except Exception as exc:
        return {"ok": False, "reason": f"File cookies rusak: {exc}", "path": str(path)}

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    data_lines = [line for line in lines if not line.startswith("#")]
    has_netscape_header = any("netscape http cookie file" in line.lower() for line in lines[:8])
    valid_rows = [line for line in data_lines if len(line.split("\t")) >= 7]
    if not has_netscape_header and not valid_rows:
        return {"ok": False, "reason": "Format bukan Netscape Cookie File.", "path": str(path), "sizeBytes": stat.st_size}

    domains = [line.split("\t")[0].lower() for line in valid_rows]
    names = [line.split("\t")[5] for line in valid_rows if len(line.split("\t")) >= 6]
    has_youtube = any("youtube.com" in domain or "youtu.be" in domain for domain in domains)
    has_google = any("google.com" in domain for domain in domains)
    important = {"SID", "HSID", "SSID", "APISID", "SAPISID", "__Secure-1PSID", "__Secure-3PSID", "LOGIN_INFO"}
    important_found = sorted(set(names).intersection(important))
    if not has_youtube and not has_google:
        return {"ok": False, "reason": "Cookies tidak berisi domain YouTube/Google.", "path": str(path), "sizeBytes": stat.st_size}

    warning = None
    if not important_found:
        warning = "Cookie login penting tidak ditemukan. File mungkin hanya cookies publik."
    return {
        "ok": True,
        "path": str(path),
        "fileName": path.name,
        "sizeBytes": stat.st_size,
        "modifiedAt": datetime.fromtimestamp(stat.st_mtime).isoformat(),
        "hasYoutube": has_youtube,
        "hasGoogle": has_google,
        "importantCookies": important_found,
        "warning": warning,
    }


def test_cookies(payload):
    validation = validate_cookie_file(payload.get("cookiesPath"))
    if not validation.get("ok"):
        return {
            **validation,
            "testOk": False,
            "errorClass": "COOKIE_MISSING" if not payload.get("cookiesPath") else "COOKIE_INVALID",
            "testedAt": datetime.now().isoformat(),
        }
    yt_dlp = require_yt_dlp()
    test_url = payload.get("url") or "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    ydl_opts: Any = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "cookiefile": payload.get("cookiesPath"),
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.youtube.com/",
        },
        **youtube_runtime_options(),
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(test_url, download=False)
        return {
            **validation,
            "testOk": True,
            "status": "Cookies valid",
            "lastTestVideo": info.get("title"),
            "testedAt": datetime.now().isoformat(),
        }
    except Exception as exc:
        error_class = download_error_class(exc)
        return {
            **validation,
            "ok": False,
            "testOk": False,
            "status": classify_download_error(exc),
            "reason": DOWNLOAD_ERROR_MESSAGES[error_class],
            "errorClass": error_class,
            "testedAt": datetime.now().isoformat(),
        }


def extract_info_with_network_retry(yt_dlp, options, url, download, label):
    attempts = 3
    host = urllib.parse.urlsplit(str(url or "")).hostname or "sumber video"
    for attempt in range(1, attempts + 1):
        try:
            with yt_dlp.YoutubeDL(options) as ydl:
                return ydl.extract_info(url, download=download)
        except Exception as exc:
            if not is_retryable_network_error(exc) or attempt >= attempts:
                if is_retryable_network_error(exc):
                    raise RuntimeError(
                        f"NETWORK_TLS_TIMEOUT: koneksi ke {host} tetap timeout setelah {attempts} percobaan. "
                        "Coba lagi setelah koneksi stabil; cache lokal tidak dihapus."
                    ) from exc
                raise
            wait_seconds = min(8, attempt * 2)
            emit(
                "log",
                stage="network",
                message=(
                    f"{label} ke {host} timeout, retry {attempt + 1}/{attempts} "
                    f"dalam {wait_seconds}s."
                ),
            )
            time.sleep(wait_seconds)


def extract_info_with_cookie_retry(yt_dlp, ydl_opts, url, cookie_path, download=False):
    public_opts = dict(ydl_opts)
    public_opts.pop("cookiefile", None)
    try:
        return extract_info_with_network_retry(
            yt_dlp, public_opts, url, download, "Metadata/download YouTube"
        ), False
    except Exception as public_exc:
        public_class = download_error_class(public_exc)
        if not session_retry_candidate(public_exc):
            raise
        if not cookie_path:
            if public_class == "AUTH_REQUIRED":
                raise RuntimeError(
                    f"AUTH_REQUIRED: {DOWNLOAD_ERROR_MESSAGES['AUTH_REQUIRED']}. "
                    "Import session di Settings > YouTube Session."
                ) from public_exc
            raise RuntimeError(
                f"HTTP_403: {DOWNLOAD_ERROR_MESSAGES['HTTP_403']}. "
                "Request publik gagal; penyebab autentikasi belum terkonfirmasi."
            ) from public_exc
        validation = validate_cookie_file(cookie_path)
        if not validation.get("ok"):
            raise RuntimeError(
                f"COOKIE_INVALID: {validation.get('reason')}"
            ) from public_exc
        emit(
            "log",
            stage="auth",
            message=f"{classify_download_error(public_exc)}. Retry terbatas menggunakan session tersimpan.",
        )
        retry_opts = dict(ydl_opts)
        retry_opts["cookiefile"] = cookie_path
        try:
            return extract_info_with_network_retry(
                yt_dlp, retry_opts, url, download, "Metadata/download YouTube"
            ), True
        except Exception as cookie_exc:
            cookie_class = download_error_class(cookie_exc)
            if cookie_class in {"AUTH_REQUIRED", "COOKIE_INVALID", "COOKIE_EXPIRED"}:
                raise RuntimeError(
                    "SESSION_UPDATE_REQUIRED: Session YouTube perlu diperbarui. "
                    "Gunakan Update Session lalu coba lagi."
                ) from cookie_exc
            raise RuntimeError(
                f"{classify_download_error(cookie_exc)}. Session tersimpan juga tidak menyelesaikan request."
            ) from cookie_exc


def video_cache_id(info, url):
    candidate = info.get("id") or ""
    if not candidate:
        match = re.search(r"(?:v=|youtu\.be/)([A-Za-z0-9_-]{8,})", str(url))
        candidate = match.group(1) if match else safe_filename(str(url))[:40]
    return safe_filename(candidate) or "youtube-video"


def source_cache_dir(payload, info, url):
    root = Path(payload.get("cacheRoot") or (Path.home() / ".cliper-studio-plus" / "cache"))
    folder = root / "sources" / video_cache_id(info, url)
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def source_cache_manifest_path(cache_dir):
    return Path(cache_dir) / "source-cache.json"


def read_source_cache_manifest(cache_dir):
    path = source_cache_manifest_path(cache_dir)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace") or "{}")
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def cached_source_file(cache_dir):
    manifest = read_source_cache_manifest(cache_dir)
    manifest_path = manifest.get("source_path") or manifest.get("sourcePath")
    if manifest_path:
        try:
            path = Path(str(manifest_path))
            if path.exists() and path.is_file() and path.stat().st_size > 1024 * 1024:
                return path
        except Exception:
            pass
    for name in ["source.mp4", "source.mkv", "source.webm", "source.mov"]:
        path = cache_dir / name
        if path.exists() and path.stat().st_size > 1024 * 1024:
            return path
    for path in cache_dir.glob("source.*"):
        lower_name = path.name.lower()
        if lower_name.endswith((".part", ".ytdl", ".tmp", ".temp")):
            continue
        if path.is_file() and path.stat().st_size > 1024 * 1024:
            return path
    return None


def write_source_cache_manifest(cache_dir, info, url, source, probe, status):
    try:
        current = read_source_cache_manifest(cache_dir)
        reused_count = int(current.get("reused_count") or 0)
        if status == "cached":
            reused_count += 1
        data = {
            "schema": 1,
            "video_id": info.get("id"),
            "url": url,
            "webpage_url": info.get("webpage_url") or url,
            "title": info.get("title"),
            "channel": info.get("channel") or info.get("uploader"),
            "duration": info.get("duration"),
            "source_path": str(source),
            "source_name": Path(source).name,
            "source_size": Path(source).stat().st_size if Path(source).exists() else 0,
            "status": status,
            "downloaded_at": current.get("downloaded_at") or datetime.now().isoformat(),
            "last_used_at": datetime.now().isoformat(),
            "reused_count": reused_count,
            "ffprobe": probe or {},
        }
        source_cache_manifest_path(cache_dir).write_text(json_dumps(data, indent=2), encoding="utf-8")
    except Exception as exc:
        emit("log", stage="cache", message=f"source-cache.json tidak bisa ditulis: {exc}")


def source_has_audio(path):
    ffprobe = resolve_ffprobe_path()
    if not ffprobe or not path:
        return True
    try:
        result = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=codec_type",
                "-of",
                "csv=p=0",
                str(path),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
        )
        return "audio" in result.stdout.lower()
    except Exception as exc:
        emit("log", stage="audio", message=f"Audio probe dilewati: {exc}")
        return True


def probe_media_file(path):
    ffprobe = resolve_ffprobe_path()
    result = {"valid": False, "hasVideo": False, "hasAudio": False, "duration": 0.0, "reason": ""}
    if not path or not Path(path).exists():
        result["reason"] = "file tidak ditemukan"
        return result
    if Path(path).stat().st_size < 32 * 1024:
        result["reason"] = "ukuran file terlalu kecil"
        return result
    if not ffprobe:
        result["reason"] = "ffprobe tidak tersedia; integritas media tidak dapat diverifikasi"
        return result
    try:
        cmd = [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(path),
        ]
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", timeout=20)
        if proc.returncode != 0:
            result["reason"] = "ffprobe menolak atau tidak dapat membaca media"
            return result
        data = json.loads(proc.stdout or "{}")
        streams = data.get("streams") or []
        result["hasVideo"] = any(item.get("codec_type") == "video" for item in streams)
        result["hasAudio"] = any(item.get("codec_type") == "audio" for item in streams)
        result["duration"] = float((data.get("format") or {}).get("duration") or 0.0)
        result["valid"] = bool(result["hasVideo"] and result["duration"] > 0)
        result["reason"] = "ok" if result["valid"] else "video stream/duration tidak valid"
        return result
    except Exception as exc:
        result["reason"] = f"ffprobe gagal memverifikasi media: {exc}"
        return result


def build_audio_activity_timeline(source_path, cache_dir=None, sample_rate=400):
    """Extract a lightweight per-second audio activity score once per source."""
    source_path = Path(source_path) if source_path else None
    if not source_path or not source_path.exists():
        return []
    cache_path = Path(cache_dir) / "audio_activity.json" if cache_dir else None
    source_size = source_path.stat().st_size
    source_mtime = round(source_path.stat().st_mtime, 3)
    if cache_path and cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if (
                cached.get("schema") == 1
                and cached.get("source_size") == source_size
                and cached.get("source_mtime") == source_mtime
                and isinstance(cached.get("timeline"), list)
            ):
                return cached["timeline"]
        except Exception:
            pass
    ffmpeg = shutil.which("ffmpeg") or shutil.which("ffmpeg.exe")
    if not ffmpeg:
        return []
    try:
        proc = subprocess.run(
            [
                ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(source_path),
                "-vn", "-ac", "1", "-ar", str(sample_rate), "-f", "s16le", "pipe:1",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=240,
        )
        if proc.returncode != 0 or not proc.stdout:
            raise RuntimeError(proc.stderr.decode("utf-8", errors="replace")[-400:])
        samples = array("h")
        samples.frombytes(proc.stdout)
        if sys.byteorder != "little":
            samples.byteswap()
        db_values = []
        for offset in range(0, len(samples), sample_rate):
            chunk = samples[offset:offset + sample_rate]
            if not chunk:
                continue
            mean_square = sum(float(value) * float(value) for value in chunk) / len(chunk)
            rms = math.sqrt(mean_square) / 32768.0
            db_values.append(20.0 * math.log10(max(rms, 1e-5)))
        if not db_values:
            return []
        ordered = sorted(db_values)
        low = ordered[int((len(ordered) - 1) * 0.10)]
        high = ordered[int((len(ordered) - 1) * 0.90)]
        span = max(4.0, high - low)
        timeline = [
            {
                "second": index,
                "db": round(value, 2),
                "score": bounded_score(20 + (value - low) / span * 76, 20, 96),
            }
            for index, value in enumerate(db_values)
        ]
        if cache_path:
            write_json_file(
                cache_path,
                {
                    "schema": 1,
                    "source_size": source_size,
                    "source_mtime": source_mtime,
                    "sample_rate": sample_rate,
                    "timeline": timeline,
                    "created_at": datetime.now().isoformat(),
                },
            )
        return timeline
    except Exception as exc:
        emit("log", stage="audio evidence", message=f"Audio activity fallback ke transcript: {exc}")
        return []


def audio_evidence_between(timeline, start, end):
    if not timeline:
        return {}
    start_index = max(0, int(float(start or 0)))
    end_index = min(len(timeline), max(start_index + 1, int(math.ceil(float(end or start_index + 1)))))
    values = [float(item.get("score") or 0) for item in timeline[start_index:end_index]]
    if not values:
        return {}
    mean = sum(values) / len(values)
    peak = max(values)
    variation = math.sqrt(sum((value - mean) ** 2 for value in values) / len(values))
    activity = bounded_score(mean * 0.65 + peak * 0.20 + min(15, variation) * 1.0, 20, 96)
    return {
        "audio_activity": activity,
        "audio_mean": round(mean, 2),
        "audio_peak": round(peak, 2),
        "audio_variation": round(variation, 2),
    }


def remove_cached_source(cache_dir):
    for path in Path(cache_dir).glob("source.*"):
        try:
            if path.is_file():
                path.unlink()
        except Exception as exc:
            emit("log", stage="cache", message=f"Gagal menghapus cache source lama {path}: {exc}")


def cleanup_partial_source_files(cache_dir):
    for path in Path(cache_dir).glob("source.*"):
        if not path.name.lower().endswith((".part", ".ytdl", ".tmp", ".temp")):
            continue
        try:
            path.unlink()
            emit("log", stage="cache", message=f"Partial download lama dibersihkan: {path}")
        except Exception as exc:
            emit("log", stage="cache", message=f"Gagal menghapus partial download {path}: {exc}")


def source_download_base_opts(source_template, progress_hook):
    return {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "merge_output_format": "mp4",
        "outtmpl": source_template,
        "continuedl": True,
        "overwrites": False,
        "retries": 5,
        "fragment_retries": 10,
        "extractor_retries": 2,
        "file_access_retries": 3,
        "socket_timeout": 45,
        "http_chunk_size": 1 * 1024 * 1024,
        "concurrent_fragment_downloads": 1,
        "progress_hooks": [progress_hook],
        "postprocessor_args": ["-movflags", "+faststart"],
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.youtube.com/",
        },
        **youtube_runtime_options(),
    }


def source_download_formats():
    return [
        (
            "1080p stable mp4",
            "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/best[height<=1080]/best",
            2,
        ),
        (
            "720p stable fallback",
            "bv*[height<=720][ext=mp4]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]/best[height<=720]/best",
            2,
        ),
        (
            "single file emergency fallback",
            "b[height<=1080]/best[height<=1080]/best",
            1,
        ),
    ]


def short_error_text(exc, limit=320):
    text = safe_text(exc).replace("\r", " ").replace("\n", " ")
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def fetch_https_bytes_with_retry(url, headers=None, timeout=30, attempts=3, stage="network", label="Koneksi HTTPS"):
    host = urllib.parse.urlsplit(str(url or "")).hostname or "sumber eksternal"
    request_headers = headers or {"User-Agent": "Mozilla/5.0"}
    for attempt in range(1, max(1, int(attempts)) + 1):
        try:
            request = urllib.request.Request(url, headers=request_headers)
            with urllib.request.urlopen(request, timeout=max(3, float(timeout))) as response:
                return response.read()
        except Exception as exc:
            retryable = is_retryable_network_error(exc)
            if not retryable or attempt >= max(1, int(attempts)):
                if retryable:
                    raise RuntimeError(
                        f"NETWORK_TLS_TIMEOUT: {label} dari {host} timeout setelah {attempt} percobaan."
                    ) from exc
                raise
            wait_seconds = min(8, attempt * 2)
            emit(
                "log",
                stage=stage,
                message=f"{label} dari {host} timeout, retry {attempt + 1}/{attempts} dalam {wait_seconds}s.",
            )
            time.sleep(wait_seconds)


def run_source_download_with_resume(yt_dlp, base_opts, url, cookie_path, formats=None):
    last_exc = None
    for label, fmt, attempts in (formats or source_download_formats()):
        opts = dict(base_opts)
        opts["format"] = fmt
        for attempt in range(1, attempts + 1):
            try:
                emit(
                    "log",
                    stage="cache",
                    message=f"Download source mode={label} attempt {attempt}/{attempts} (resume aktif)",
                )
                return extract_info_with_cookie_retry(yt_dlp, opts, url, cookie_path, download=True)
            except Exception as exc:
                last_exc = exc
                error_class = download_error_class(exc)
                reason = classify_download_error(exc)
                emit(
                    "log",
                    stage="cache",
                    message=f"Download source gagal mode={label} attempt {attempt}/{attempts}: {reason}. {short_error_text(exc)}",
                )
                if needs_cookies_error(exc):
                    raise
                if error_class in {"RATE_LIMITED", "GEO_RESTRICTED", "VIDEO_RESTRICTED"}:
                    raise
                if error_class in {"FORMAT_UNAVAILABLE", "HTTP_403"}:
                    break
                if attempt < attempts:
                    wait_seconds = min(12, 2 + attempt * 2)
                    emit(
                        "progress",
                        stage="cache",
                        progress=72,
                        message=f"Koneksi putus, resume download dalam {wait_seconds}s",
                    )
                    time.sleep(wait_seconds)
        emit("log", stage="cache", message=f"Fallback download source: mode {label} belum berhasil.")
    final_class = download_error_class(last_exc)
    if final_class == "NETWORK_ERROR":
        raise RuntimeError(
            "NETWORK_ERROR: Koneksi download YouTube terputus setelah retry dan fallback format. "
            "File .part tetap disimpan agar dapat dilanjutkan. "
            f"Detail: {short_error_text(last_exc)}"
        ) from last_exc
    raise RuntimeError(
        f"{classify_download_error(last_exc)}. Semua fallback format yang aman sudah dicoba. "
        f"Detail: {short_error_text(last_exc)}"
    ) from last_exc


def make_source_progress_hook():
    last_emit = {"time": 0.0}

    def hook(status):
        now = time.time()
        if now - last_emit["time"] < 0.8 and status.get("status") != "finished":
            return
        last_emit["time"] = now
        state = status.get("status")
        downloaded = float(status.get("downloaded_bytes") or 0)
        total = float(status.get("total_bytes") or status.get("total_bytes_estimate") or 0)
        if state == "downloading":
            ratio = downloaded / total if total else 0
            progress = 72 + min(8, ratio * 8)
            speed = status.get("speed") or 0
            eta = status.get("eta")
            speed_text = f"{speed / 1024 / 1024:.1f} MB/s" if speed else "-"
            eta_text = f" ETA {format_duration_short(eta)}" if eta else ""
            emit(
                "progress",
                stage="cache",
                progress=round(progress, 2),
                message=f"Download/cache source video {int(ratio * 100) if total else 0}% {speed_text}{eta_text}",
                speed=speed_text,
                eta=eta,
            )
        elif state == "finished":
            emit("progress", stage="cache", progress=80, message="Source download finished, merging audio/video")

    return hook


def format_duration_short(seconds):
    try:
        seconds = max(0, int(seconds or 0))
    except Exception:
        seconds = 0
    minutes, rest = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{rest:02d}"
    return f"{minutes:02d}:{rest:02d}"


def download_thumbnail(url, path):
    if not url or path.exists():
        return
    try:
        data = fetch_https_bytes_with_retry(
            url,
            timeout=20,
            attempts=2,
            stage="thumbnail",
            label="Thumbnail",
        )
        if data:
            path.write_bytes(data)
    except Exception as exc:
        emit("log", stage="thumbnail", message=f"Thumbnail cache dilewati: {short_error_text(exc, 180)}")


def write_cache_files(cache_dir, info, transcript=None, subtitle_language=None):
    metadata = {
        "id": info.get("id"),
        "title": info.get("title"),
        "channel": info.get("channel") or info.get("uploader"),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "webpage_url": info.get("webpage_url"),
        "subtitle_language": subtitle_language,
        "cached_at": datetime.now().isoformat(),
    }
    (cache_dir / "metadata.json").write_text(json_dumps(metadata, indent=2), encoding="utf-8")
    if transcript is not None:
        (cache_dir / "transcript.json").write_text(
            json_dumps(
                {
                    "language": subtitle_language,
                    "segments": transcript,
                    "cached_at": datetime.now().isoformat(),
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        try:
            segments = build_semantic_segments(info, transcript, float(info.get("duration") or 0))
            (cache_dir / "segments.json").write_text(
                json_dumps({"segments": segments, "cached_at": datetime.now().isoformat()}, indent=2),
                encoding="utf-8",
            )
        except Exception as exc:
            emit("log", stage="cache", message=f"segments.json cache dilewati: {exc}")
    download_thumbnail(info.get("thumbnail"), cache_dir / "thumbnail.jpg")


def classify_content_profile(title, channel, text, speakers=None, lyric_marker_ratio=0.0):
    """Classify editing intent from deterministic source evidence.

    Order matters: explicit music metadata wins over generic words, while
    strong newsroom metadata wins over incidental [Music] caption markers.
    """
    speakers = speakers or []
    title_lower = clean_text(title).lower()
    channel_lower = clean_text(channel).lower()
    metadata_text = f"{title_lower} {channel_lower}"
    transcript_lower = clean_text(text[:5000]).lower()
    haystack = f"{metadata_text} {transcript_lower}"
    music_title = any(keyword in title_lower for keyword in [
        " cover", "cover ", "official music", "official video", "live performance",
        "karaoke", "acoustic", "akustik", "music video", "lyric video",
    ])
    product_terms = [
        "produk", "unboxing", "review produk", "spesifikasi", "harga", "kamera",
        "baterai", "laptop", "smartphone", "handphone", "hp ", "gadget", "skincare",
        "makanan", "fitur", "kelebihan", "kekurangan",
    ]
    review_intent = any(keyword in title_lower for keyword in ["review", "ulasan", "unboxing", "hands on", "tes "])
    news_title_terms = [
        "berita", "breaking news", "kabar hari ini", "update terkini", "headline",
        "konferensi pers", "press conference", "presiden", "menteri", "pemerintah",
        "kapolres", "dandim", "kapolri", "panglima", "dpr", "sidang", "rapat",
        "kebijakan", "pemilu", "pilkada", "korupsi", "anggaran negara",
        "hakim", "kejaksaan", "tersangka", "praperadilan", "komisi yudisial",
    ]
    news_channel_terms = [
        "news", "berita", "kompas", "detik", "merdekadotcom", "cnn indonesia",
        "tempo", "tribun", "liputan6", "kumparan", "sindonews", "antara tv",
        "metrotv", "tvone",
    ]
    news_transcript_terms = [
        "reporter", "narasumber", "siaran berita", "konferensi pers",
        "pemerintah", "presiden", "menteri", "dpr", "polisi", "tni",
    ]
    news_transcript_hits = sum(1 for keyword in news_transcript_terms if keyword in transcript_lower)
    explicit_music_metadata = music_title or any(
        keyword in title_lower for keyword in ["lagu", "musik", "song", "konser", "band"]
    )
    strong_news_metadata = (
        any(keyword in title_lower for keyword in news_title_terms)
        or any(keyword in channel_lower for keyword in news_channel_terms)
    )
    if strong_news_metadata and not explicit_music_metadata:
        return "news", "current-affairs"
    if explicit_music_metadata or lyric_marker_ratio >= 0.35:
        return "music", "performance"
    if any(keyword in haystack for keyword in ["gameplay", "gaming", "mobile legends", "minecraft", "valorant"]):
        return "gaming", "gameplay"
    if review_intent and any(keyword in haystack for keyword in product_terms):
        return "review", "product"
    if news_transcript_hits >= 2:
        return "news", "current-affairs"

    if any(keyword in title_lower for keyword in ["podcast", "interview", "bincang", "ngobrol", "talkshow"]):
        subtype = "interview" if "interview" in title_lower or "wawancara" in haystack else "conversation"
        return "podcast", subtype
    if any(keyword in title_lower for keyword in ["vlog", "daily", "travel", "perjalanan"]) or "vlog" in haystack:
        return "vlog", "lifestyle"
    story_title = any(keyword in title_lower for keyword in ["kisah", "cerita", "story", "pengalaman", "kronologi"])
    story_signals = sum(haystack.count(keyword) for keyword in ["awalnya", "kemudian", "setelah itu", "akhirnya"])
    if story_title:
        return "storytelling", "narrative"

    tutorial_title_terms = [
        "tutorial", "cara ", "how to", "panduan", "belajar", "langkah-langkah",
        "tips ", "trik ",
    ]
    if any(keyword in title_lower for keyword in tutorial_title_terms):
        return "tutorial", "instructional"
    if len(speakers) >= 2:
        return "podcast", "conversation"
    if story_signals >= 3:
        return "storytelling", "narrative"

    instructional_terms = [
        "langkah pertama", "langkah kedua", "selanjutnya", "ikuti langkah",
        "klik menu", "pilih menu", "caranya adalah", "tutorial ini",
        "pertama-tama", "setelah itu klik",
    ]
    instructional_hits = sum(1 for keyword in instructional_terms if keyword in transcript_lower)
    if instructional_hits >= 2:
        return "tutorial", "instructional"
    return "general", "talking"


def profile_topic_terms(title, text, limit=8):
    """Return grounded topic terms without adding another AI request."""
    counts = {}
    title_words = normalize_words(title)
    body_words = normalize_words(text[:12000])
    for word in title_words + body_words:
        normalized = clean_text(word).lower()
        if (
            len(normalized) < 4
            or normalized in STOPWORDS_ID
            or normalized.isdigit()
        ):
            continue
        counts[normalized] = counts.get(normalized, 0) + (
            4 if normalized in title_words else 1
        )
    return [
        word
        for word, _count in sorted(
            counts.items(), key=lambda item: (-item[1], item[0])
        )[: max(1, int(limit or 1))]
    ]


def profile_signal_samples(transcript, markers=None, predicate=None, limit=4):
    """Collect short timestamped evidence samples for the content profile."""
    samples = []
    markers = [str(marker).lower() for marker in (markers or [])]
    for item in transcript or []:
        text = clean_text(item.get("text") or "")
        lower = text.lower()
        if not text:
            continue
        matched = bool(markers and any(marker in lower for marker in markers))
        if callable(predicate):
            matched = matched or bool(predicate(text, lower))
        if not matched:
            continue
        samples.append(
            {
                "start": round(float(item.get("start") or 0.0), 2),
                "end": round(float(item.get("end") or item.get("start") or 0.0), 2),
                "text": " ".join(text.split()[:32]),
            }
        )
        if len(samples) >= max(1, int(limit or 1)):
            break
    return samples


def detect_profile_language(text, configured_language=None):
    configured = clean_text(configured_language or "").lower()
    if configured and configured not in {"auto", "unknown", "und"}:
        return configured
    words = normalize_words(text[:8000])
    if not words:
        return "auto"
    indonesian = sum(
        1 for word in words
        if word in {
            "yang", "dan", "dengan", "untuk", "karena", "tetapi", "jadi",
            "saya", "kamu", "mereka", "adalah", "tidak", "bisa", "sudah",
            "ini", "pada", "belum", "baru", "dari", "akan", "juga", "lebih",
        }
    )
    english = sum(
        1 for word in words
        if word in {
            "the", "and", "with", "for", "because", "but", "so", "you",
            "they", "this", "that", "not", "can", "have", "was",
        }
    )
    minimum_evidence = 2 if len(words) < 80 else 3
    if indonesian >= max(minimum_evidence, english * 1.4):
        return "id"
    if english >= max(minimum_evidence, indonesian * 1.4):
        return "en"
    return "auto"


def build_content_profile(info, transcript=None, payload=None, subtitle_language=None):
    """Build a deterministic, cached editing profile from real source evidence."""
    payload = payload or {}
    transcript = transcript or []
    title = clean_text(info.get("title") or "")
    channel = clean_text(info.get("channel") or info.get("uploader") or "")
    text = clean_text(" ".join(item.get("text") or "" for item in transcript))
    haystack = f"{title} {channel} {text[:4000]}".lower()
    lyric_markers = sum(
        text.lower().count(marker)
        for marker in ["[bernyanyi]", "[musik]", "[music]", "♪", "lirik", "chorus"]
    )
    lyric_marker_ratio = lyric_markers / max(1, len(transcript))
    duration = max(0.0, float(info.get("duration") or 0.0))
    word_count = len(text.split())
    words_per_minute = round(word_count * 60 / duration, 1) if duration > 0 and word_count else 0.0
    speakers = sorted({
        clean_text(item.get("speaker") or item.get("speaker_label") or "")
        for item in transcript if clean_text(item.get("speaker") or item.get("speaker_label") or "")
    })
    video_type, subtype = classify_content_profile(title, channel, text, speakers, lyric_marker_ratio)
    transcript_lower = text.lower()
    title_lower = title.lower()
    question_count = text.count("?") + sum(
        transcript_lower.count(marker)
        for marker in ["kenapa ", "bagaimana ", "gimana ", "apa yang ", "menurut kamu", "menurut anda"]
    )
    turn_markers = sum(
        transcript_lower.count(marker)
        for marker in [
            "iya ", "betul ", "nah ", "kalau menurut", "tapi kalau", "jadi kamu",
            "pertanyaannya", "jawabannya", "ceritain", "waktu itu",
        ]
    )
    conversation_title = any(
        marker in title_lower
        for marker in ["episode", "eps ", "ep.", "part ", "bersama ", "ft.", "feat.", "tamu"]
    )
    conversation_score = (
        (2 if duration >= 20 * 60 else 1 if duration >= 8 * 60 else 0)
        + (2 if len(speakers) >= 2 else 0)
        + (2 if question_count >= 4 else 1 if question_count >= 2 else 0)
        + (2 if turn_markers >= 8 else 1 if turn_markers >= 4 else 0)
        + (1 if conversation_title else 0)
        + (1 if words_per_minute >= 85 else 0)
    )
    if (
        video_type == "general"
        and conversation_score >= 5
    ) or (
        video_type == "storytelling"
        and conversation_title
        and question_count >= 4
        and turn_markers >= 6
        and conversation_score >= 6
    ):
        video_type, subtype = "podcast", "conversation"
    pace = "fast" if words_per_minute >= 165 else "calm" if words_per_minute and words_per_minute < 105 else "balanced"
    emphasis_count = sum(text.lower().count(marker) for marker in ["!", "?", "banget", "serius", "gila", "wow"])
    energy = "high" if emphasis_count >= max(5, word_count // 45) else "calm" if words_per_minute and words_per_minute < 105 else "medium"
    speaker_count = max(1, len(speakers))
    questions = profile_signal_samples(
        transcript,
        ["kenapa ", "bagaimana ", "gimana ", "apa yang ", "siapa "],
        predicate=lambda source, _lower: "?" in source,
    )
    answers = profile_signal_samples(
        transcript,
        ["jawabannya", "karena ", "alasannya", "menurut saya", "jadi "],
    )
    surprises = profile_signal_samples(
        transcript,
        ["ternyata", "tidak menyangka", "nggak nyangka", "mendadak", "rahasia"],
    )
    conflicts = profile_signal_samples(
        transcript,
        ["masalah", "konflik", "debat", "ditolak", "bohong", "marah", "kontroversi"],
    )
    emotional_peaks = profile_signal_samples(
        transcript,
        ["kaget", "sedih", "nangis", "ketawa", "ngakak", "takut", "kecewa", "merinding"],
    )
    humor = profile_signal_samples(
        transcript,
        ["lucu", "ketawa", "ngakak", "kocak", "bercanda"],
    )
    reactions = profile_signal_samples(
        transcript,
        ["wah", "wow", "serius", "masa sih", "benarkah", "beneran"],
    )
    payoffs = profile_signal_samples(
        transcript,
        ["akhirnya", "hasilnya", "jawabannya", "solusinya", "intinya", "kesimpulannya", "terbukti"],
    )
    key_claims = profile_signal_samples(
        transcript,
        ["adalah", "merupakan", "harus", "faktanya", "berdasarkan", "artinya"],
        predicate=lambda _source, lower: bool(re.search(r"\b\d+(?:[.,]\d+)?\b", lower)),
        limit=6,
    )
    topic_terms = profile_topic_terms(title, text, 9)
    educational_hits = sum(
        transcript_lower.count(marker)
        for marker in ["cara ", "langkah", "tips", "solusi", "contoh", "pelajaran", "fakta"]
    )
    narrative_hits = sum(
        transcript_lower.count(marker)
        for marker in ["awalnya", "kemudian", "setelah itu", "akhirnya"]
    )
    if question_count >= 2 and answers:
        story_structure = "question-answer"
    elif conflicts and payoffs:
        story_structure = "problem-solution"
    elif video_type == "storytelling" or narrative_hits >= 3:
        story_structure = "narrative-arc"
    elif video_type == "tutorial":
        story_structure = "step-by-step"
    elif video_type == "music":
        story_structure = "performance"
    else:
        story_structure = "topic-explainer"
    audience = {
        "tutorial": "learners",
        "review": "buyers",
        "news": "general-current-affairs",
        "gaming": "gaming-community",
        "music": "music-audience",
        "podcast": "conversation-audience",
        "storytelling": "story-audience",
    }.get(video_type, "general-audience")
    tone = (
        "humorous" if humor
        else "tense" if conflicts and energy == "high"
        else "emotional" if emotional_peaks
        else "informative" if educational_hits >= 2 or video_type in {"news", "tutorial", "review"}
        else "conversational" if video_type == "podcast"
        else "neutral"
    )
    return {
        "schema": 2,
        "created_at": datetime.now().isoformat(),
        "videoType": video_type,
        "subtype": subtype,
        "language": detect_profile_language(
            text, subtitle_language or payload.get("subtitleLang")
        ),
        "topic": " ".join(term.title() for term in topic_terms[:3]) or title,
        "subtopics": topic_terms[3:9],
        "duration": round(duration, 3),
        "speakerCount": speaker_count,
        "speakers": speakers,
        "tone": tone,
        "pace": pace,
        "wordsPerMinute": words_per_minute,
        "energy": energy,
        "audience": audience,
        "storyStructure": story_structure,
        "keyClaims": key_claims,
        "questions": questions,
        "answers": answers,
        "surprises": surprises,
        "conflicts": conflicts,
        "emotionalPeaks": emotional_peaks,
        "educationalValue": bounded_score(35 + educational_hits * 8, 20, 96),
        "humor": humor,
        "reactions": reactions,
        "payoffs": payoffs,
        "sceneStyle": (
            "performance-stage" if video_type == "music"
            else "product-detail" if video_type == "review"
            else "stable-broadcast" if video_type == "news"
            else "multi-speaker" if speaker_count >= 2
            else "single-subject"
        ),
        "cameraStyle": (
            "speaker-cuts" if video_type == "podcast"
            else "stage-wide" if video_type == "music"
            else "object-and-presenter" if video_type == "review"
            else "stable-medium" if video_type == "news"
            else "narrative-cuts" if video_type == "storytelling"
            else "stable-subject"
        ),
        "subtitleStyle": payload.get("captionStyle") or ("lyric-karaoke" if video_type == "music" else "TikTok style"),
        "zoomStyle": "beat-aware" if video_type == "music" else "restrained",
        "transitionStyle": "hard-cut" if video_type == "podcast" else "beat-cut" if video_type == "music" else "minimal-cut",
        "colorProfile": "adaptive-natural",
        "qualityProfile": payload.get("outputQualityProfile") or "balanced",
        "recommendedClipDuration": round(min(max(float(payload.get("targetDuration") or 60), 25), 90), 1),
        "confidence": round(min(0.98, 0.35 + (0.3 if transcript else 0) + (0.2 if duration else 0) + min(0.13, len(speakers) * 0.04)), 2),
        "evidence": {
            "lyricMarkers": lyric_markers,
            "lyricMarkerRatio": round(lyric_marker_ratio, 3),
            "title": title,
            "channel": channel,
            "questionCount": question_count,
            "turnMarkers": turn_markers,
            "conversationScore": conversation_score,
            "topicTerms": topic_terms,
            "signalCounts": {
                "claims": len(key_claims),
                "questions": len(questions),
                "answers": len(answers),
                "surprises": len(surprises),
                "conflicts": len(conflicts),
                "emotionalPeaks": len(emotional_peaks),
                "humor": len(humor),
                "reactions": len(reactions),
                "payoffs": len(payoffs),
            },
        },
    }


def load_content_profile(cache_dir):
    path = Path(cache_dir) / "content_profile.json"
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8", errors="replace"))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def classify_story_map_event(text, position_ratio=0.0):
    """Classify a transcript event from observable language evidence."""
    cleaned = clean_text(text)
    lower = cleaned.lower()
    if not cleaned:
        return "context", []
    rules = [
        ("question", ["?", "kenapa ", "bagaimana ", "gimana ", "apa yang ", "siapa "]),
        ("payoff", ["akhirnya", "hasilnya", "jawabannya", "solusinya", "intinya", "kesimpulannya", "terbukti"]),
        ("surprise", ["ternyata", "tidak menyangka", "nggak nyangka", "mendadak", "rahasia"]),
        ("conflict", ["masalah", "konflik", "debat", "ditolak", "bohong", "marah", "kontroversi"]),
        ("reaction", ["wah", "wow", "serius", "kaget", "ketawa", "ngakak", "merinding"]),
        ("lesson", ["pelajarannya", "tips", "caranya", "langkah", "harus", "jangan"]),
        ("answer", ["jawabannya", "karena ", "alasannya", "menurut saya", "jadi "]),
        ("explanation", ["artinya", "maksudnya", "contohnya", "berdasarkan", "sebabnya"]),
    ]
    for event_type, markers in rules:
        matched = [marker.strip() for marker in markers if marker in lower]
        if matched:
            return event_type, matched[:4]
    if position_ratio <= 0.08:
        return "intro", ["opening_position"]
    if any(marker in lower for marker in ["awalnya", "dulu", "waktu itu", "ketika itu"]):
        return "setup", ["setup_marker"]
    return "context", []


def build_story_map(info, transcript, content_profile=None):
    """Build and cache the source story map used by Moment AI discovery."""
    content_profile = content_profile or {}
    duration = max(
        0.0,
        float(info.get("duration") or (transcript[-1].get("end") if transcript else 0) or 0),
    )
    stories = []
    if callable(external_build_story_timeline):
        try:
            stories = external_build_story_timeline(transcript, {}) or []
        except Exception:
            stories = []
    if not stories and transcript:
        source_text = clean_text(" ".join(item.get("text") or "" for item in transcript))
        stories = [{
            "story_id": 1,
            "start": round(float(transcript[0].get("start") or 0.0), 2),
            "end": round(float(transcript[-1].get("end") or duration), 2),
            "duration": round(duration, 2),
            "text": source_text,
            "topic": content_profile.get("topic") or "Pembahasan utama",
            "summary": " ".join(source_text.split()[:42]),
        }]

    def story_for_interval(start, end):
        best = None
        best_overlap = 0.0
        for story in stories:
            story_start = float(story.get("start", start) if story.get("start") is not None else start)
            story_end = float(story.get("end", end) if story.get("end") is not None else end)
            overlap = max(
                0.0,
                min(end, story_end) - max(start, story_start),
            )
            if overlap > best_overlap:
                best = story
                best_overlap = overlap
        return best or (stories[0] if stories else {})

    events = []
    for item in transcript or []:
        start = float(item.get("start") or 0.0)
        end = float(item.get("end") or start)
        text = clean_text(item.get("text") or "")
        if not text or end <= start:
            continue
        event_type, evidence = classify_story_map_event(
            text, start / max(duration, 1.0)
        )
        story = story_for_interval(start, end)
        story_id = int(story.get("story_id") or 1)
        if (
            events
            and events[-1]["type"] == event_type
            and events[-1]["storyId"] == story_id
            and start - events[-1]["end"] <= 2.5
            and end - events[-1]["start"] <= 75.0
        ):
            events[-1]["end"] = round(end, 2)
            events[-1]["text"] = clean_text(f"{events[-1]['text']} {text}")
            events[-1]["evidence"] = list(dict.fromkeys(events[-1]["evidence"] + evidence))[:6]
            continue
        events.append({
            "id": len(events) + 1,
            "type": event_type,
            "start": round(start, 2),
            "end": round(end, 2),
            "storyId": story_id,
            "topic": story.get("topic") or content_profile.get("topic") or "Pembahasan utama",
            "text": text,
            "evidence": evidence,
        })
    event_counts = {}
    for event in events:
        event_counts[event["type"]] = event_counts.get(event["type"], 0) + 1
    return {
        "schema": 1,
        "createdAt": datetime.now().isoformat(),
        "duration": round(duration, 2),
        "contentProfileSchema": content_profile.get("schema"),
        "stories": stories,
        "events": events,
        "summary": {
            "storyCount": len(stories),
            "eventCount": len(events),
            "eventTypes": event_counts,
        },
    }


def write_moments_cache(cache_dir, moments):
    try:
        (Path(cache_dir) / "moments.json").write_text(
            json_dumps({"moments": moments or [], "cached_at": datetime.now().isoformat()}, indent=2),
            encoding="utf-8",
        )
    except Exception as exc:
        emit("log", stage="cache", message=f"moments.json cache dilewati: {exc}")


def write_json_file(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json_dumps(data, indent=2), encoding="utf-8")
    return path


def clip_artifact_identity(source_path, start, duration, transcript, clip_index=0):
    """Build a stable identity for all per-clip render and subtitle artifacts."""
    source = Path(str(source_path or "")).expanduser()
    source_signature = {"path": str(source.resolve()) if source.exists() else str(source)}
    try:
        stat = source.stat()
        source_signature.update({"size": stat.st_size, "mtime_ns": stat.st_mtime_ns})
    except Exception:
        pass
    source_hash = hashlib.sha256(
        json_dumps(source_signature, sort_keys=True, separators=(",", ":")).encode("utf-8", errors="replace")
    ).hexdigest()[:16]
    transcript_hash = hashlib.sha256(
        json_dumps(transcript or [], sort_keys=True, separators=(",", ":")).encode("utf-8", errors="replace")
    ).hexdigest()[:16]
    identity_payload = {
        "schema": 4,
        "clip_index": int(clip_index or 0),
        "source_hash": source_hash,
        "start_ms": int(round(float(start or 0.0) * 1000)),
        "duration_ms": int(round(float(duration or 0.0) * 1000)),
        "transcript_hash": transcript_hash,
    }
    artifact_hash = hashlib.sha256(
        json_dumps(identity_payload, sort_keys=True, separators=(",", ":")).encode("utf-8", errors="replace")
    ).hexdigest()[:16]
    return {**identity_payload, "artifact_hash": artifact_hash}


def cpu_thread_count():
    cores = os.cpu_count() or 2
    return max(1, min(8, int(max(1, cores * 0.65))))


def load_cached_transcript(cache_dir):
    path = Path(cache_dir) / "transcript.json"
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
        segments = data.get("segments") if isinstance(data, dict) else data
        return segments if isinstance(segments, list) else []
    except Exception as exc:
        emit("log", stage="auto cut", message=f"Transcript cache tidak bisa dibaca: {exc}")
        return []


def auto_cut_from_transcript(moment, transcript, min_duration=5.0):
    start = float(moment.get("start") or 0)
    end = float(moment.get("end") or (start + float(moment.get("duration") or 30)))
    relevant = []
    for segment in transcript or []:
        try:
            seg_start = float(segment.get("start") or 0)
            seg_end = float(segment.get("end") or seg_start)
        except Exception:
            continue
        if seg_end <= start or seg_start >= end:
            continue
        if clean_text(segment.get("text") or ""):
            relevant.append((seg_start, seg_end))
    if not relevant:
        return start, max(min_duration, end - start), False
    new_start = max(0.0, min(item[0] for item in relevant) - 0.25)
    new_end = max(item[1] for item in relevant) + 0.35
    new_start = max(start, new_start)
    new_end = min(end, new_end)
    if new_end - new_start < min_duration:
        return start, max(min_duration, end - start), False
    return new_start, new_end - new_start, abs(new_start - start) > 0.05 or abs(new_end - end) > 0.05


def ensure_source_cached(yt_dlp, info, url, payload, cookie_path=None):
    cache_dir = source_cache_dir(payload, info, url)
    existing = cached_source_file(cache_dir)
    if existing:
        probe = probe_media_file(existing)
        if not probe.get("valid"):
            emit("log", stage="cache", message=f"Cached source tidak valid, download ulang: {probe.get('reason')}")
            remove_cached_source(cache_dir)
        elif not probe.get("hasAudio", True):
            emit("log", stage="audio", message=f"Cached source tidak punya audio stream, download ulang: {existing}")
            remove_cached_source(cache_dir)
        else:
            emit("progress", stage="cache", progress=80, message="Using cached source")
            emit("log", stage="cache", message=f"Using cached source: {existing}")
            write_source_cache_manifest(cache_dir, info, url, existing, probe, "cached")
            return existing, cache_dir, False
    emit("progress", stage="cache", progress=72, message="Download/cache source video")
    source_template = str(cache_dir / "source.%(ext)s")
    ydl_opts = source_download_base_opts(source_template, make_source_progress_hook())
    run_source_download_with_resume(yt_dlp, ydl_opts, url, cookie_path)
    cleanup_partial_source_files(cache_dir)
    source = cached_source_file(cache_dir)
    if source is None:
        raise RuntimeError("Source cache gagal dibuat. File video lokal tidak ditemukan.")
    probe = probe_media_file(source)
    if not probe.get("valid"):
        emit("log", stage="cache", message=f"Source hasil download tidak valid: {probe.get('reason')}. Retry fallback format.")
        remove_cached_source(cache_dir)
        run_source_download_with_resume(yt_dlp, ydl_opts, url, cookie_path)
        cleanup_partial_source_files(cache_dir)
        source = cached_source_file(cache_dir)
        if source is None:
            raise RuntimeError("Source cache fallback gagal dibuat. File video lokal tidak ditemukan.")
        probe = probe_media_file(source)
        if not probe.get("valid"):
            raise RuntimeError(f"Source cache tetap tidak valid setelah retry: {probe.get('reason')}")
    if not probe.get("hasAudio", True):
        emit("log", stage="audio", message="Source hasil download tidak punya audio stream. Retry format single-file best untuk memastikan audio ikut.")
        remove_cached_source(cache_dir)
        fallback_opts = dict(ydl_opts)
        single_file_formats = [("single file audio fallback", "b[height<=1080]/best[height<=1080]/best", 3)]
        run_source_download_with_resume(yt_dlp, fallback_opts, url, cookie_path, formats=single_file_formats)
        cleanup_partial_source_files(cache_dir)
        source = cached_source_file(cache_dir)
        if source is None:
            raise RuntimeError("Source cache fallback gagal dibuat. File video lokal tidak ditemukan.")
        probe = probe_media_file(source)
        if not probe.get("valid"):
            raise RuntimeError(f"Source cache fallback tidak valid: {probe.get('reason')}")
        if not probe.get("hasAudio", True):
            emit("log", stage="audio", message="Source fallback tetap tidak punya audio stream. Render lanjut tanpa audio jika video sumber memang silent.")
    emit("progress", stage="cache", progress=82, message="Source cache ready")
    write_source_cache_manifest(cache_dir, info, url, source, probe, "downloaded")
    return source, cache_dir, True


def require_yt_dlp():
    try:
        import yt_dlp

        return yt_dlp
    except Exception as exc:
        raise RuntimeError("yt-dlp belum tersedia. Install dengan: python -m pip install yt-dlp") from exc


def ai_provider_name(provider_type):
    names = {
        "cloud": "Cliper Cloud",
        "openai": "OpenAI",
        "groq": "Groq",
        "ytclip": "YTClip AI",
        "deepseek": "DeepSeek",
        "gemini": "Google Gemini",
        "custom": "Custom AI",
        "local": "Local Heuristic",
    }
    return names.get(provider_type, provider_type or "AI Provider")


def is_ai_enabled(payload):
    if not payload:
        return False
    provider_type = str(payload.get("providerType") or "local").lower()
    if provider_type == "local":
        return False
    credential = payload.get("cloudAccessToken") if provider_type == "cloud" else payload.get("apiKey")
    return bool(credential and payload.get("baseUrl") and (payload.get("highlightModel") or payload.get("model")))


def is_ai_feature_enabled(payload, feature):
    if not is_ai_enabled(payload):
        return False
    if bool_payload(payload, "_renderOnly", False) and not bool_payload(payload, "_allowRenderAi", False):
        return False
    features = payload.get("aiFeatures") if isinstance(payload, dict) else {}
    if isinstance(features, dict) and feature in features:
        return bool(features.get(feature))
    legacy_map = {
        "highlight": "useHighlightAI",
        "hook": "useHookAI",
        "caption": "useCaptionAI",
        "title": "useTitleAI",
        "tts": "useTtsAI",
    }
    key = legacy_map.get(feature)
    if key and key in payload:
        return bool_payload(payload, key, True)
    return True


def mask_api_key(value):
    key = str(value or "").strip()
    if not key:
        return ""
    if len(key) <= 8:
        return f"{key[:3]}..."
    return f"{key[:6]}...{key[-4:]}"


def preview_raw(value, limit=1800):
    try:
        if isinstance(value, (dict, list)):
            text = json_dumps(value)
        else:
            text = str(value or "")
    except Exception:
        text = ""
    return text[:limit]


def add_ai_debug_event(
    payload,
    endpoint,
    result=None,
    parsed_content="",
    parser_used="",
    error="",
    fallback_used=False,
    attempt=1,
    retry_count=0,
    latency_seconds=0.0,
    request_chars=0,
    fallback_reason="",
):
    event = {
        "provider": ai_provider_name(str((payload or {}).get("providerType") or "openai")),
        "provider_type": str((payload or {}).get("providerType") or "openai"),
        "module": str((payload or {}).get("_aiModule") or "AI"),
        "base_url": str((payload or {}).get("baseUrl") or ""),
        "model": str((payload or {}).get("highlightModel") or (payload or {}).get("model") or ""),
        "endpoint_final": endpoint,
        "api_key": mask_api_key((payload or {}).get("apiKey")),
        "http_status": (result or {}).get("__http_status") if isinstance(result, dict) else None,
        "raw_response_preview": (result or {}).get("__raw_preview") if isinstance(result, dict) else preview_raw(result),
        "parsed_content": str(parsed_content or "")[:1200],
        "parser_used": parser_used,
        "error": str(error or "")[:800],
        "fallback_used": bool(fallback_used),
        "fallback_reason": str(fallback_reason or "")[:320],
        "attempt": int(attempt or 1),
        "retry_count": int(retry_count or 0),
        "latency_ms": int(max(0.0, float(latency_seconds or 0.0)) * 1000),
        "request_chars": int(max(0, request_chars or 0)),
        "created_at": datetime.now().isoformat(),
    }
    AI_DEBUG_EVENTS.append(event)
    return event


def ai_log_path(payload):
    cache_root = payload.get("cacheRoot") if isinstance(payload, dict) else ""
    if cache_root:
        return Path(str(cache_root)).parent / "logs" / "ai_requests.log"
    return Path.cwd() / "logs" / "ai_requests.log"


def usage_numbers(usage):
    usage = usage or {}
    input_tokens = int(usage.get("prompt_tokens") or usage.get("input_tokens") or usage.get("totalPromptTokens") or 0)
    output_tokens = int(usage.get("completion_tokens") or usage.get("output_tokens") or usage.get("totalOutputTokens") or 0)
    if not input_tokens and not output_tokens and usage.get("total_tokens"):
        total = int(usage.get("total_tokens") or 0)
        input_tokens = total
    return input_tokens, output_tokens


def record_ai_usage(payload, module, status, latency_seconds=0.0, usage=None, error=""):
    input_tokens, output_tokens = usage_numbers(usage)
    if status.lower() == "success":
        AI_USAGE["requests"] += 1
        AI_USAGE["input_tokens"] += input_tokens
        AI_USAGE["output_tokens"] += output_tokens
    else:
        AI_USAGE["errors"] += 1
    try:
        path = ai_log_path(payload)
        path.parent.mkdir(parents=True, exist_ok=True)
        line = (
            f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
            f"Provider: {ai_provider_name(str((payload or {}).get('providerType') or 'local'))}\n"
            f"Model: {(payload or {}).get('highlightModel') or (payload or {}).get('model') or '-'}\n"
            f"Module: {module}\n"
            f"Status: {status}\n"
            f"Latency: {latency_seconds:.2f}s\n"
            f"Input Tokens: {input_tokens}\n"
            f"Output Tokens: {output_tokens}\n"
            f"Error: {safe_text(error)[:280] if error else '-'}\n\n"
        )
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line)
    except Exception:
        pass


def fetch_json(url, data=None, headers=None, timeout=30):
    headers = headers or {}
    method = "GET" if data is None else "POST"
    body = None
    if data is not None:
        body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            text = response.read().decode("utf-8", errors="replace")
            status = getattr(response, "status", 200)
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(text)
        except Exception:
            data = {"raw": text}
        if isinstance(data, dict):
            data.setdefault("error", data.get("error") or f"HTTP {exc.code}")
            data["__http_status"] = exc.code
            data["__raw_preview"] = text[:1800]
        return data
    try:
        parsed = json.loads(text)
    except Exception:
        parsed = {"raw": text}
    if isinstance(parsed, dict):
        parsed["__http_status"] = status
        parsed["__raw_preview"] = text[:1800]
    return parsed


def ai_error_details(result):
    if not isinstance(result, dict):
        return None, safe_text(result)
    status = result.get("__http_status")
    error_value = result.get("error")
    if isinstance(error_value, dict):
        message = error_value.get("message") or error_value.get("detail") or error_value.get("type")
    else:
        message = error_value
    message = message or result.get("message") or result.get("detail") or ""
    try:
        status = int(status) if status is not None else None
    except Exception:
        status = None
    return status, clean_text(safe_text(message))


def retryable_ai_failure(value, status=None):
    text = safe_text(value).lower()
    if status in {408, 409, 425, 429, 500, 502, 503, 504}:
        return True
    return any(
        marker in text
        for marker in [
            "timed out",
            "timeout",
            "handshake operation",
            "temporarily unavailable",
            "connection reset",
            "connection aborted",
            "remote end closed",
            "try again",
            "rate limit",
            "too many requests",
            "server error",
            "bad gateway",
            "service unavailable",
            "gateway timeout",
        ]
    )


def unsupported_ai_parameter(value):
    text = safe_text(value).lower()
    return any(
        marker in text
        for marker in [
            "unsupported parameter",
            "unknown parameter",
            "unrecognized field",
            "extra inputs are not permitted",
            "thinking is not allowed",
            "temperature is not supported",
            "max_tokens is not supported",
        ]
    )


def ai_diagnostics_summary():
    events = list(AI_DEBUG_EVENTS)
    successful = [item for item in events if item.get("parsed_content") and not item.get("error")]
    failed = [item for item in events if item.get("error")]
    modules = sorted({str(item.get("module") or "AI") for item in events})
    return {
        "ai_used": bool(successful),
        "provider": successful[-1].get("provider") if successful else (events[-1].get("provider") if events else "Local Heuristic"),
        "model": successful[-1].get("model") if successful else (events[-1].get("model") if events else ""),
        "requests": int(AI_USAGE.get("requests") or 0),
        "errors": int(AI_USAGE.get("errors") or 0),
        "cache_hits": int(AI_USAGE.get("cache_hits") or 0),
        "cache_misses": int(AI_USAGE.get("cache_misses") or 0),
        "debug_events": len(events),
        "retry_count": sum(int(item.get("retry_count") or 0) for item in events),
        "fallback_events": sum(1 for item in events if item.get("fallback_used")),
        "last_fallback_reason": next((str(item.get("fallback_reason") or item.get("error") or "") for item in reversed(failed)), ""),
        "modules": modules,
    }


def ai_module_key(module):
    text = str(module or "").lower()
    if "rank" in text or "review" in text or "director" in text:
        return "ranking"
    if "story" in text or "segment" in text:
        return "story"
    if "highlight" in text or "moment" in text:
        return "highlight"
    if "caption" in text or "subtitle" in text:
        return "caption"
    if "hook" in text:
        return "hook"
    if "title" in text or "metadata" in text or "upload" in text:
        return "title"
    if "tts" in text or "voice" in text:
        return "tts"
    if "test" in text:
        return "test"
    return "default"


def ai_prompt_version(module):
    module_key = ai_module_key(module)
    return AI_PROMPT_VERSIONS.get(module_key, AI_PROMPT_VERSIONS["default"])


def ai_response_cache_identity(payload, prompt, module):
    payload = payload or {}
    module_key = ai_module_key(module)
    prompt_text = str(prompt or "")
    identity = {
        "schema": 1,
        "provider": str(payload.get("providerType") or "openai").lower(),
        "base_url": str(payload.get("baseUrl") or "").rstrip("/").lower(),
        "model": str(payload.get("highlightModel") or payload.get("model") or "").strip(),
        "module": module_key,
        "prompt_version": ai_prompt_version(module),
        "prompt_hash": hashlib.sha256(prompt_text.encode("utf-8")).hexdigest(),
        "prompt_chars": len(prompt_text),
    }
    canonical = json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest(), identity


def ai_response_cache_path(payload, prompt, module):
    payload = payload or {}
    if bool_payload(payload, "disableAiCache", False) or ai_module_key(module) == "test":
        return None, None
    cache_root = payload.get("cacheRoot")
    if not cache_root:
        return None, None
    digest, identity = ai_response_cache_identity(payload, prompt, module)
    return Path(str(cache_root)) / "ai-responses" / identity["module"] / f"{digest}.json", identity


def read_ai_response_cache(payload, prompt, module):
    path, identity = ai_response_cache_path(payload, prompt, module)
    if path is None or not path.exists():
        return None
    try:
        max_age_days = max(1, min(365, int((payload or {}).get("aiCacheMaxAgeDays") or 30)))
        if time.time() - path.stat().st_mtime > max_age_days * 86400:
            return None
        data = json.loads(path.read_text(encoding="utf-8", errors="replace") or "{}")
        response = str(data.get("response") or "").strip()
        if not response or data.get("identity") != identity:
            return None
        return {
            "response": response,
            "usage": {},
            "raw": {},
            "parser": "local-ai-cache",
            "cached": True,
            "cache_key": path.stem,
            "prompt_version": identity["prompt_version"],
        }
    except Exception:
        return None


def write_ai_response_cache(payload, prompt, module, result):
    path, identity = ai_response_cache_path(payload, prompt, module)
    response = str((result or {}).get("response") or "").strip()
    if path is None or not response:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "schema": 1,
            "identity": identity,
            "response": response,
            "parser": str((result or {}).get("parser") or ""),
            "created_at": datetime.now().isoformat(),
        }
        temporary = path.with_name(f"{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
        temporary.write_text(json_dumps(data, indent=2), encoding="utf-8")
        temporary.replace(path)
    except Exception as exc:
        emit("log", stage="ai cache", message=f"AI cache write dilewati: {short_error_text(exc, 180)}")


def normalize_ai_timeout_seconds(value, default=45):
    try:
        timeout = float(value)
    except Exception:
        timeout = float(default)
    # Renderer configuration uses milliseconds; older worker payloads used
    # seconds. Support both without turning 90,000 ms into a 180-second cap.
    if timeout > 1000:
        timeout /= 1000.0
    return int(max(10, min(180, round(timeout))))


def payload_for_ai_module(payload, module):
    next_payload = dict(payload or {})
    module_key = ai_module_key(module)
    next_payload["_aiModule"] = str(module or "AI")
    next_payload["_aiModuleKey"] = module_key
    provider_type = str(next_payload.get("providerType") or "").lower()
    module_models = next_payload.get("moduleModels")
    if isinstance(module_models, dict):
        selected_model = module_models.get(module_key) or module_models.get("default")
        if selected_model:
            next_payload["model"] = str(selected_model).strip()
            next_payload["highlightModel"] = str(selected_model).strip()
    ytclip_default_budgets = {
        "test": 160,
        "highlight": 820,
        "ranking": 900,
        "title": 220,
        "hook": 160,
        "caption": 140,
        "tts": 180,
        "default": 260,
    }
    default_budgets = {
        "test": 240,
        "highlight": 1600,
        "ranking": 1400,
        "title": 480,
        "hook": 420,
        "caption": 700,
        "tts": 260,
        "default": 420,
    }
    hard_caps = ytclip_default_budgets if provider_type == "ytclip" else default_budgets
    selected_tokens = hard_caps.get(module_key, hard_caps["default"])
    max_tokens_by_module = next_payload.get("maxTokensByModule")
    if isinstance(max_tokens_by_module, dict):
        configured_tokens = max_tokens_by_module.get(module_key) or max_tokens_by_module.get("default")
        try:
            if configured_tokens:
                selected_tokens = int(configured_tokens)
        except Exception:
            pass
    else:
        try:
            if next_payload.get("maxTokens"):
                selected_tokens = int(next_payload.get("maxTokens"))
        except Exception:
            pass
    cap = hard_caps.get(module_key, hard_caps["default"])
    floor = 64 if module_key not in ["hook", "test"] else 48
    next_payload["maxTokens"] = int(max(floor, min(cap, selected_tokens)))
    timeout_defaults = {
        "test": 30,
        "highlight": 90,
        "ranking": 90,
        "title": 45,
        "hook": 45,
        "caption": 45,
        "tts": 45,
        "default": 45,
    }
    timeout_value = timeout_defaults.get(module_key, timeout_defaults["default"])
    timeout_by_module = next_payload.get("timeoutMsByModule")
    if isinstance(timeout_by_module, dict):
        configured_timeout = timeout_by_module.get(module_key) or timeout_by_module.get("default")
        try:
            if configured_timeout:
                timeout_value = int(configured_timeout)
        except Exception:
            pass
    next_payload["timeoutMs"] = normalize_ai_timeout_seconds(timeout_value, timeout_defaults.get(module_key, 45))
    retry_defaults = {"highlight": 3, "ranking": 2, "title": 2, "hook": 2, "caption": 2, "test": 2, "default": 2}
    retry_value = retry_defaults.get(module_key, retry_defaults["default"])
    retry_by_module = next_payload.get("aiRetryByModule")
    if isinstance(retry_by_module, dict):
        configured_retry = retry_by_module.get(module_key) or retry_by_module.get("default")
        try:
            if configured_retry:
                retry_value = int(configured_retry)
        except Exception:
            pass
    next_payload["aiRetry"] = int(max(1, min(5, retry_value)))
    return next_payload


def ai_content_text(value):
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        return str(value.get("text") or value.get("content") or value.get("output_text") or "").strip()
    if isinstance(value, list):
        parts = [ai_content_text(item) for item in value]
        return " ".join(item for item in parts if item).strip()
    return ""


def parse_ai_content(result):
    if not isinstance(result, dict):
        return str(result or "").strip(), "non_dict"
    choices = result.get("choices") or []
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            message = first.get("message")
            if isinstance(message, dict) and message.get("content"):
                content = ai_content_text(message.get("content"))
                if content:
                    return content, "choices[0].message.content"
            if isinstance(message, dict) and message.get("reasoning_content"):
                reasoning = str(message.get("reasoning_content") or "").strip()
                # Reasoning prose is not a final answer. Only accept it when
                # the provider actually placed a JSON result inside the field.
                if ("[" in reasoning and "]" in reasoning) or ("{" in reasoning and "}" in reasoning):
                    return reasoning, "choices[0].message.reasoning_content.json"
            if first.get("text"):
                return str(first.get("text") or "").strip(), "choices[0].text"
    top_message = result.get("message")
    if isinstance(top_message, dict):
        content = ai_content_text(top_message.get("content"))
        if content:
            return content, "message.content"
    output = result.get("output")
    if isinstance(output, list):
        output_text = " ".join(
            ai_content_text(item.get("content") if isinstance(item, dict) else item)
            for item in output
        ).strip()
        if output_text:
            return output_text, "output[].content"
    for key in ["output_text", "content", "response", "text", "raw"]:
        if result.get(key):
            content = ai_content_text(result.get(key)) or str(result.get(key) or "").strip()
            if content:
                return content, key
    data = result.get("data")
    if isinstance(data, dict) and data.get("content"):
        return ai_content_text(data.get("content")), "data.content"
    return "", "empty"


def openai_compatible_endpoint(base_url):
    endpoint = str(base_url or "").strip().rstrip("/")
    if not endpoint:
        return ""
    if endpoint.lower().endswith(("/chat/completions", "/responses")):
        return endpoint
    return f"{endpoint}/chat/completions"


def cliper_cloud_endpoint(base_url, route):
    root = str(base_url or "").strip().rstrip("/")
    root = re.sub(r"/(?:chat/completions|responses)$", "", root, flags=re.IGNORECASE)
    if not root:
        raise RuntimeError("Base URL Cliper Cloud kosong.")
    return f"{root}/{str(route or '').lstrip('/')}"


def cloud_json_compatible(value):
    """Normalize a Cloud request to the JSON shape verified by the Node API.

    Python serializes an integral float as ``352.0`` while JSON.stringify on
    the API serializes the parsed value as ``352``. The desktop session HMAC
    covers the body hash, so those two valid JSON representations must be
    normalized before the request is signed and sent.
    """
    if isinstance(value, dict):
        return {str(key): cloud_json_compatible(item) for key, item in value.items()}
    if isinstance(value, list):
        return [cloud_json_compatible(item) for item in value]
    if isinstance(value, tuple):
        return [cloud_json_compatible(item) for item in value]
    if isinstance(value, float):
        if not math.isfinite(value):
            raise RuntimeError("Payload Cliper Cloud berisi angka yang tidak valid.")
        return int(value) if value.is_integer() else value
    return value


def cloud_analysis_job_input(payload, request_id):
    """Build the small, media-free billing request sent to Cliper Cloud.

    Download paths, source URLs, frames, audio, transcript, and render plans
    remain on the creator's machine.  Cloud only needs a non-reversible source
    reference plus the selected duration/count to reserve and settle wallet funds.
    """
    source_value = str((payload or {}).get("url") or (payload or {}).get("localVideoPath") or "")
    source_id = hashlib.sha256(source_value.encode("utf-8", errors="replace")).hexdigest()[:24] if source_value else str(request_id)
    return {
        "requestId": str(request_id),
        "sourceId": source_id,
        "sourceDurationSeconds": float((payload or {}).get("videoDuration") or (payload or {}).get("sourceDuration") or 0),
        "requestedClipCount": int((payload or {}).get("clipCount") or 0),
    }


_CLOUD_LOCAL_PATH_PATTERN = re.compile(r"(?i)(?:file:///{1,3}[^\s\"<>]+|(?:[a-z]:[\\/]|\\\\)[^\s\"<>]+)")
_CLOUD_MEDIA_DATA_PATTERN = re.compile(r"(?i)data:(?:image|audio|video)/[^,\s]+,[a-z0-9+/=_-]+")
_CLOUD_EDITORIAL_MAX_PROMPT_CHARS = 48_000


def prepare_cloud_editorial_prompt(prompt):
    """Keep Cloud requests to compact editorial evidence, never local media."""
    text = str(prompt or "")
    text = _CLOUD_MEDIA_DATA_PATTERN.sub("[local-media-redacted]", text)
    text = _CLOUD_LOCAL_PATH_PATTERN.sub("[local-path-redacted]", text)
    if len(text) > _CLOUD_EDITORIAL_MAX_PROMPT_CHARS:
        raise RuntimeError(
            "Brief editorial untuk Cliper Cloud terlalu besar. "
            "Desktop harus mengirim shortlist/ringkasan, bukan transcript penuh atau media."
        )
    return text


def cloud_signed_headers(payload, endpoint, data):
    access_token = str(payload.get("cloudAccessToken") or "").strip()
    signing_secret = str(payload.get("cloudSigningSecret") or "").strip()
    if not access_token or len(signing_secret) < 32:
        raise RuntimeError("Sesi Cliper Cloud belum aktif. Hubungkan ulang API key dari Settings.")
    timestamp = str(int(time.time() * 1000))
    nonce = secrets.token_urlsafe(18)
    body_text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    content_hash = hashlib.sha256(body_text.encode("utf-8")).hexdigest()
    path = urllib.parse.urlsplit(endpoint).path or "/"
    canonical = "\n".join(["POST", path, timestamp, nonce, content_hash])
    signature = hmac.new(signing_secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()
    return {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "X-Cliper-Timestamp": timestamp,
        "X-Cliper-Nonce": nonce,
        "X-Cliper-Content-SHA256": content_hash,
        "X-Cliper-Signature": signature,
    }


def cloud_job_request(payload, route, data):
    endpoint = cliper_cloud_endpoint(payload.get("baseUrl"), route)
    request_data = cloud_json_compatible(data)
    headers = cloud_signed_headers(payload, endpoint, request_data)
    timeout = normalize_ai_timeout_seconds(payload.get("timeoutMs"), 45)
    result = fetch_json(endpoint, data=request_data, headers=headers, timeout=timeout)
    if not isinstance(result, dict):
        raise RuntimeError("Response job Cliper Cloud tidak valid.")
    if result.get("error") or int(result.get("__http_status") or 200) >= 400:
        _status, message = ai_error_details(result)
        raise RuntimeError(message or "Cliper Cloud job request gagal.")
    verify_cloud_response(payload, endpoint, result)
    return {
        key: value
        for key, value in result.items()
        if key not in {"integrity", "__http_status", "__raw_preview"}
    }


def start_cloud_analysis_job(payload):
    if str(payload.get("providerType") or "").lower() != "cloud":
        return None
    if bool_payload(payload, "metadataOnly", False) or is_local_source_mode(payload):
        return None
    request_id = str(payload.get("analysisRequestId") or f"analysis-{int(time.time() * 1000)}").strip()
    result = cloud_job_request(
        payload,
        "/jobs/start",
        cloud_analysis_job_input(payload, request_id),
    )
    payload["_cloudJobId"] = result.get("id")
    payload["_cloudJobReservedUsd"] = result.get("reservedUsd")
    emit(
        "log",
        stage="billing",
        message=f"Cliper Cloud job aktif: reserve estimasi US${float(result.get('reservedUsd') or 0):.4f}",
    )
    return result


def complete_cloud_analysis_job(payload, moments):
    job_id = str(payload.get("_cloudJobId") or "").strip()
    if not job_id:
        return None
    scores = [
        max(0.0, min(100.0, float(moment.get("score") or 0)))
        for moment in (moments or [])
        if isinstance(moment, dict)
    ]
    result = cloud_job_request(
        payload,
        "/jobs/complete",
        {
            "jobId": job_id,
            "clipScores": scores,
            "usableResult": bool(scores),
        },
    )
    emit(
        "log",
        stage="billing",
        message=(
            f"Billing selesai: US${float(result.get('finalChargeUsd') or 0):.4f}; "
            f"release US${float(result.get('releasedUsd') or 0):.4f}; "
            f"saldo tersedia US${float(result.get('spendableUsd') or 0):.4f}"
        ),
    )
    return result


def fail_cloud_analysis_job(payload, reason):
    job_id = str(payload.get("_cloudJobId") or "").strip()
    if not job_id:
        return None
    try:
        result = cloud_job_request(
            payload,
            f"/jobs/{urllib.parse.quote(job_id)}/fail",
            {"reason": short_error_text(reason, 280)},
        )
        emit(
            "log",
            stage="billing",
            message=f"Analysis gagal; reservation US${float(result.get('releasedUsd') or 0):.4f} dilepas.",
        )
        return result
    except Exception as exc:
        emit("log", stage="billing", message=f"Gagal melepas reservation job: {exc}")
        return None


def verify_cloud_response(payload, endpoint, result):
    if not isinstance(result, dict) or result.get("error"):
        return
    integrity = result.get("integrity")
    signing_secret = str(payload.get("cloudSigningSecret") or "").strip()
    if not isinstance(integrity, dict) or len(signing_secret) < 32:
        raise RuntimeError("Response Cliper Cloud tidak memiliki signature yang valid.")
    signed_payload = {
        key: value
        for key, value in result.items()
        if key not in {"integrity", "__http_status", "__raw_preview"}
    }
    body_text = json.dumps(signed_payload, ensure_ascii=False, separators=(",", ":"))
    checksum = hashlib.sha256(body_text.encode("utf-8")).hexdigest()
    if not hmac.compare_digest(checksum, str(integrity.get("checksum") or "")):
        raise RuntimeError("Checksum response Cliper Cloud tidak cocok.")
    path = urllib.parse.urlsplit(endpoint).path or "/"
    canonical = "\n".join([
        "RESPONSE",
        path,
        str(integrity.get("timestamp") or ""),
        "response",
        checksum,
    ])
    expected = hmac.new(signing_secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, str(integrity.get("signature") or "")):
        raise RuntimeError("Signature response Cliper Cloud tidak cocok.")


def minimal_ai_request(data, responses_api=False):
    if responses_api:
        return {
            "model": data.get("model"),
            "input": data.get("input"),
            "max_output_tokens": data.get("max_output_tokens"),
            "module": data.get("module"),
            "metadata": data.get("metadata"),
        }
    return {
        "model": data.get("model"),
        "messages": data.get("messages"),
        "max_tokens": data.get("max_tokens"),
        "module": data.get("module"),
        "metadata": data.get("metadata"),
    }


def call_openai_compatible(payload, prompt):
    base_url = str(payload.get("baseUrl") or "").rstrip("/")
    if not base_url:
        raise RuntimeError("Base URL AI kosong.")
    provider_type = str(payload.get("providerType") or "").lower()
    if provider_type == "cloud":
        prompt = prepare_cloud_editorial_prompt(prompt)
    model = str(payload.get("highlightModel") or payload.get("model") or "").strip()
    is_deepseek_request = (
        provider_type == "deepseek"
        or "api.deepseek.com" in base_url.lower()
        or model.lower().startswith("deepseek-")
    )
    if is_deepseek_request and base_url.lower().rstrip("/") == "https://api.deepseek.com/v1":
        base_url = "https://api.deepseek.com"
    endpoint = openai_compatible_endpoint(base_url)
    if not model:
        raise RuntimeError("Model AI kosong.")
    api_key = str(payload.get("cloudAccessToken") if provider_type == "cloud" else payload.get("apiKey") or "").strip()
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    messages = [
        {"role": "system", "content": "You are a video clipping assistant. Follow the requested output format exactly."},
        {"role": "user", "content": prompt},
    ]
    responses_api = endpoint.lower().endswith("/responses")
    if responses_api:
        data = {
            "model": model,
            "input": messages,
            "temperature": 0.3,
            "max_output_tokens": int(payload.get("maxTokens") or 1000),
        }
    else:
        data = {
            "model": model,
            "messages": messages,
            "temperature": 0.3,
            "max_tokens": int(payload.get("maxTokens") or 1000),
        }
    if provider_type == "cloud":
        module_key = str(payload.get("_aiModuleKey") or "default")
        data["module"] = module_key
        data["metadata"] = {
            "requestId": f"{payload.get('analysisRequestId') or 'analysis'}-{module_key}-{secrets.token_hex(6)}",
            "module": module_key,
            "jobId": str(payload.get("_cloudJobId") or ""),
            "clipCount": int(payload.get("clipCount") or 0),
        }
    if is_deepseek_request:
        # DeepSeek V4 defaults to thinking mode. For short JSON/title/caption
        # calls, reasoning can consume the whole token budget and return empty
        # assistant content. Disable thinking for production clipping modules.
        data["thinking"] = {"type": "disabled"}
    timeout = normalize_ai_timeout_seconds(payload.get("timeoutMs"), 45)
    attempts = max(1, min(5, int(payload.get("aiRetry") or 2)))
    retry_delay = max(0.0, min(8.0, float(payload.get("aiRetryDelayMs") or 800) / 1000.0))
    text = ""
    parser_used = ""
    last_result = None
    last_error = ""
    compatibility_downgraded = False
    for attempt in range(1, attempts + 1):
        attempt_started = time.time()
        request_data = cloud_json_compatible(data) if provider_type == "cloud" else data
        request_chars = len(json_dumps(request_data))
        try:
            request_headers = cloud_signed_headers(payload, endpoint, request_data) if provider_type == "cloud" else dict(headers)
            result = fetch_json(endpoint, data=request_data, headers=request_headers, timeout=timeout)
        except Exception as exc:
            last_error = safe_text(exc)
            retryable = retryable_ai_failure(exc)
            add_ai_debug_event(
                payload,
                endpoint,
                error=last_error,
                fallback_used=True,
                fallback_reason="network_retry" if retryable else "network_error",
                attempt=attempt,
                retry_count=max(0, attempt - 1),
                latency_seconds=time.time() - attempt_started,
                request_chars=request_chars,
            )
            if retryable and attempt < attempts:
                wait_seconds = min(8.0, retry_delay * (2 ** (attempt - 1)))
                emit("log", message=f"AI network timeout/error, retry {attempt + 1}/{attempts} dalam {wait_seconds:.1f}s")
                time.sleep(wait_seconds)
                continue
            raise RuntimeError(f"AI network error: {last_error}") from exc
        last_result = result
        if not isinstance(result, dict):
            last_error = "Invalid response object"
            add_ai_debug_event(
                payload, endpoint, result=result, error=last_error, fallback_used=True,
                fallback_reason="invalid_response", attempt=attempt, retry_count=max(0, attempt - 1),
                latency_seconds=time.time() - attempt_started, request_chars=request_chars,
            )
            if attempt < attempts:
                emit("log", message=f"AI invalid response, retrying ({attempt}/{attempts})")
                time.sleep(min(8.0, retry_delay * (2 ** (attempt - 1))))
                continue
            raise RuntimeError("Invalid response dari AI provider.")
        if provider_type == "cloud":
            verify_cloud_response(payload, endpoint, result)
        if result.get("error"):
            status, message = ai_error_details(result)
            last_error = message or f"HTTP {status or '-'}"
            can_downgrade = status == 400 and unsupported_ai_parameter(last_error) and not compatibility_downgraded
            retryable = retryable_ai_failure(last_error, status)
            add_ai_debug_event(
                payload, endpoint, result=result, error=last_error, fallback_used=True,
                fallback_reason="compatibility_retry" if can_downgrade else ("provider_retry" if retryable else "provider_error"),
                attempt=attempt, retry_count=max(0, attempt - 1),
                latency_seconds=time.time() - attempt_started, request_chars=request_chars,
            )
            if can_downgrade and attempt < attempts:
                data = minimal_ai_request(data, responses_api)
                compatibility_downgraded = True
                emit("log", message=f"Provider menolak parameter opsional; retry payload kompatibilitas minimal ({attempt + 1}/{attempts})")
                continue
            if retryable and attempt < attempts:
                wait_seconds = min(8.0, retry_delay * (2 ** (attempt - 1)))
                emit("log", message=f"AI provider HTTP {status or '-'}, retry {attempt + 1}/{attempts} dalam {wait_seconds:.1f}s")
                time.sleep(wait_seconds)
                continue
            raise RuntimeError(last_error or "AI request gagal")
        text, parser_used = parse_ai_content(result)
        if text:
            add_ai_debug_event(
                payload, endpoint, result=result, parsed_content=text, parser_used=parser_used,
                attempt=attempt, retry_count=max(0, attempt - 1),
                latency_seconds=time.time() - attempt_started, request_chars=request_chars,
            )
            break
        last_error = "Empty response from provider"
        add_ai_debug_event(
            payload, endpoint, result=result, parser_used=parser_used, error=last_error, fallback_used=True,
            fallback_reason="empty_response", attempt=attempt, retry_count=max(0, attempt - 1),
            latency_seconds=time.time() - attempt_started, request_chars=request_chars,
        )
        if attempt < attempts:
            emit("log", message=f"AI response kosong, mencoba ulang ({attempt}/{attempts}) model={model}")
            token_key = "max_output_tokens" if responses_api else "max_tokens"
            data[token_key] = min(int(data.get(token_key, 1000)) * 2, 4000)
            if "temperature" in data:
                data["temperature"] = max(0.0, float(data.get("temperature", 0.3)) - 0.1)
            time.sleep(min(8.0, retry_delay * (2 ** (attempt - 1))))
            continue
    if not text:
        error = (
            f"AI response kosong. endpoint={endpoint} model={model} "
            f"status={(last_result or {}).get('__http_status')} raw={str((last_result or {}).get('__raw_preview',''))[:260]}"
        )
        raise RuntimeError(error)
    usage = result.get("usage") or {}
    return {
        "response": str(text).strip(),
        "usage": usage,
        "raw": result,
        "parser": parser_used,
        "endpoint": endpoint,
        "retry_count": max(0, attempt - 1),
        "compatibility_mode": "minimal" if compatibility_downgraded else "standard",
    }


def call_gemini(payload, prompt):
    base_url = str(payload.get("baseUrl") or "").rstrip("/")
    if not base_url:
        raise RuntimeError("Base URL AI kosong.")
    model = str(payload.get("highlightModel") or payload.get("model") or "").strip()
    if not model:
        raise RuntimeError("Model AI kosong.")
    api_key = str(payload.get("apiKey") or "").strip()
    endpoint = f"{base_url}/models/{urllib.parse.quote(model)}:generateContent"
    if api_key and not api_key.startswith("Bearer "):
        endpoint = f"{endpoint}?key={urllib.parse.quote(api_key)}"
    headers = {"Content-Type": "application/json"}
    if api_key.startswith("Bearer "):
        headers["Authorization"] = api_key
    data = {
        "generationConfig": {
            "temperature": 0.25,
            "maxOutputTokens": int(payload.get("maxTokens") or 320),
            "candidateCount": 1,
        },
        "contents": [
            {
                "role": "user",
                "parts": [{"text": prompt}],
            }
        ],
    }
    timeout = normalize_ai_timeout_seconds(payload.get("timeoutMs"), 45)
    result = fetch_json(endpoint, data=data, headers=headers, timeout=timeout)
    if not isinstance(result, dict):
        add_ai_debug_event(payload, endpoint, result=result, error="Invalid Gemini response", fallback_used=True)
        raise RuntimeError("Invalid response dari Gemini.")
    if result.get("error"):
        error_value = result.get("error", {})
        message = error_value.get("message") if isinstance(error_value, dict) else str(error_value)
        add_ai_debug_event(payload, endpoint, result=result, error=message or "AI request gagal", fallback_used=True)
        raise RuntimeError(message or "AI request gagal")
    response_text = ""
    if isinstance(result.get("candidates"), list) and result["candidates"]:
        candidate = result["candidates"][0]
        content = candidate.get("content") or {}
        parts = content.get("parts") if isinstance(content, dict) else None
        if isinstance(parts, list):
            response_text = " ".join(str(part.get("text") or "") for part in parts if isinstance(part, dict)).strip()
        if not response_text:
            response_text = content.get("text") if isinstance(content, dict) else str(content or "")
    if not response_text and result.get("output"):
        response_text = result["output"].get("generatedText") or result["output"].get("content", {}).get("text", "")
    if not response_text:
        add_ai_debug_event(payload, endpoint, result=result, parser_used="gemini", error="Gemini tidak mengembalikan konten.", fallback_used=True)
        raise RuntimeError("Gemini tidak mengembalikan konten.")
    add_ai_debug_event(payload, endpoint, result=result, parsed_content=response_text, parser_used="gemini.candidates")
    return {"response": str(response_text).strip(), "usage": {}, "raw": result, "parser": "gemini.candidates"}


def provider_request(payload, prompt, module="AI"):
    payload = payload_for_ai_module(payload, module)
    provider_type = str(payload.get("providerType") or "openai").lower()
    provider_name = ai_provider_name(provider_type)
    model = str(payload.get("highlightModel") or payload.get("model") or "-")
    max_tokens = int(payload.get("maxTokens") or 1000)
    cached_result = read_ai_response_cache(payload, prompt, module)
    if cached_result is not None:
        AI_USAGE["cache_hits"] = int(AI_USAGE.get("cache_hits") or 0) + 1
        emit(
            "log",
            stage="ai cache",
            message=(
                f"AI cache hit module={ai_module_key(module)} "
                f"prompt={cached_result.get('prompt_version')} model={model}"
            ),
        )
        add_ai_debug_event(
            payload,
            f"local-cache://{cached_result.get('cache_key')}",
            parsed_content=cached_result.get("response"),
            parser_used="local-ai-cache",
        )
        return cached_result
    cache_path, _cache_identity = ai_response_cache_path(payload, prompt, module)
    if cache_path is not None:
        AI_USAGE["cache_misses"] = int(AI_USAGE.get("cache_misses") or 0) + 1
    emit("log", message=f"AI request sent to {provider_name} ({module}) model={model} max_tokens={max_tokens}")
    started = time.time()
    try:
        if provider_type == "gemini":
            result = call_gemini(payload, prompt)
        else:
            result = call_openai_compatible(payload, prompt)
        record_ai_usage(payload, module, "Success", time.time() - started, result.get("usage") or {})
        result["prompt_version"] = ai_prompt_version(module)
        write_ai_response_cache(payload, prompt, module, result)
        return result
    except Exception as exc:
        record_ai_usage(payload, module, "Error", time.time() - started, {}, str(exc))
        raise


def parse_simple_listed_titles(text):
    lines = [line.strip() for line in str(text).splitlines() if line.strip()]
    parsed = []
    for line in lines:
        match = re.match(r"^\s*\d+\)?[\.:\-]?\s*(.+)$", line)
        if match:
            parsed.append(match.group(1).strip())
        else:
            parsed.append(line)
    return parsed


FYP_POWER_WORDS = [
    "Ternyata", "Akhirnya", "Gara-Gara", "Rahasia", "Alasan", "Momen",
    "Bikin Kaget", "Tidak Disangka", "Paling Penting", "Jarang Dibahas",
]

AUTO_RENDER_MIN_SCORE = 65
AUTO_SELECT_MIN_SCORE = 70
EDITORIAL_MIN_OVERLAP = 0.12

BANNED_GENERIC_HOOKS = [
    "jawaban ini bikin penasaran",
    "konflik ini akhirnya terungkap",
    "konflik ini terungkap",
    "hal ini mengejutkan",
    "hal ini bikin penasaran",
    "moment terbaik",
    "momen terbaik",
    "bagian ini wajib kamu lihat",
    "ternyata endingnya tidak terduga",
    "cerita yang bikin orang berhenti scroll",
    "jadi bagian paling menarik",
    "yang baru terlihat di clip ini",
    "yang paling kuat dibahas",
    "membuat obrolan berubah",
]

LOW_VALUE_HOOK_SIGNATURES = {
    "template:poin penting yang akhirnya terungkap",
    "template:jadi pembahasan serius",
    "template:begini lanjutan ceritanya",
    "template:yang tidak disangka",
    "template:alasan ceritanya jadi penting",
    "template:cerita di balik momen ini",
    "template:mulai jadi perhatian",
    "template:mengubah arah pembahasan",
    "template:sudut yang belum banyak dibahas",
    "template:yang membuatnya berbeda",
    "template:jadi pembahasan utama",
    "template:bagian yang tidak disangka",
}

STOPWORDS_ID = {
    "yang", "dan", "atau", "dengan", "untuk", "dari", "jadi", "nah", "gitu",
    "banget", "sama", "kalau", "kalo", "karena", "terus", "tapi", "dalam",
    "pada", "ini", "itu", "ada", "saya", "aku", "gue", "gua", "kamu", "mereka",
    "kita", "dia", "bisa", "tidak", "nggak", "enggak", "kan", "lah", "tuh",
    "musik", "tertawa", "tolong", "dong", "mah", "teh", "pak", "bu", "bro",
    "ya", "oh", "baru", "nyadar", "kono", "era", "beli", "anu", "kah", "bae",
    "mendi", "lakone", "sindene", "arep", "mari", "kayang",
    "ingin", "tanpa", "lebih", "semua", "orang", "bagian", "paling",
}


def compact_text_for_ai(text, limit=900):
    text = clean_text(text)
    if len(text) <= limit:
        return text
    head = text[: int(limit * 0.55)].rsplit(" ", 1)[0]
    tail = text[-int(limit * 0.35):].split(" ", 1)[-1]
    return clean_text(f"{head} ... {tail}")


@lru_cache(maxsize=1024)
def clean_highlight_source_text(text):
    text = clean_text(text)
    text = re.sub(r"\[[^\]]{1,48}\]", " ", text, flags=re.IGNORECASE)
    clauses = [clean_text(part) for part in re.split(r"(?<=[.!?…])\s+", text) if clean_text(part)]
    unique_clauses = []
    recent_clause_keys = []
    for clause in clauses:
        key = " ".join(normalize_words(clause))
        if key and key in recent_clause_keys[-8:]:
            continue
        unique_clauses.append(clause)
        if key:
            recent_clause_keys.append(key)
    text = clean_text(" ".join(unique_clauses)) if unique_clauses else text
    words = text.split()
    # YouTube auto captions often repeat a rolling phrase two or three times.
    # Collapse adjacent repeated n-grams before any scoring/title generation.
    collapsed = []
    index = 0
    while index < len(words):
        repeated = False
        remaining = len(words) - index
        for size in range(min(12, remaining // 2), 2, -1):
            left = [re.sub(r"\W+", "", word.lower()) for word in words[index:index + size]]
            right = [re.sub(r"\W+", "", word.lower()) for word in words[index + size:index + size * 2]]
            if left == right:
                collapsed.extend(words[index:index + size])
                index += size * 2
                while index + size <= len(words):
                    following = [re.sub(r"\W+", "", word.lower()) for word in words[index:index + size]]
                    if following != left:
                        break
                    index += size
                repeated = True
                break
        if not repeated:
            collapsed.append(words[index])
            index += 1
    words = collapsed
    cleaned = []
    last = ""
    repeat_count = 0
    for word in words:
        bare = re.sub(r"[^\wÀ-ÖØ-öø-ÿĀ-ž\u0100-\u024F\u1E00-\u1EFF'-]", "", word.lower(), flags=re.UNICODE)
        if bare == last:
            repeat_count += 1
            if repeat_count > 1:
                continue
        else:
            repeat_count = 0
        last = bare
        cleaned.append(word)
    return clean_text(" ".join(cleaned))


def is_generic_template(text):
    lower = clean_text(text).lower()
    if not lower:
        return True
    if any(pattern in lower for pattern in BANNED_GENERIC_HOOKS):
        return True
    generic_words = set(normalize_words(lower))
    if len(generic_words - {"jawaban", "konflik", "hal", "ini", "itu", "bikin", "penasaran", "terungkap", "mengejutkan"}) <= 2:
        return True
    return False


def extract_specific_terms(text, limit=8):
    words = normalize_words(clean_highlight_source_text(text))
    candidates = []
    seen = set()
    for word in words:
        if len(word) < 4 or word in STOPWORDS_ID or word in seen:
            continue
        seen.add(word)
        candidates.append(word)
    return candidates[:limit]


def first_strong_phrase(text, max_words=9):
    text = clean_highlight_source_text(text)
    parts = [part.strip(" ,.-") for part in re.split(r"(?<=[.!?…])\s+|,\s+|\s+-\s+", text) if part.strip()]
    for part in parts:
        words = [word for word in part.split() if word.strip()]
        useful = [word for word in words if word.lower() not in STOPWORDS_ID]
        if 4 <= len(words) <= max_words and len(useful) >= 2:
            return " ".join(words[:max_words])
    words = text.split()
    return " ".join(words[:max_words]).strip(" ,.-")


def representative_phrase(text, max_words=10):
    """Select the most concrete spoken phrase for local titles and hooks."""
    cleaned = clean_highlight_source_text(text)
    parts = [
        clean_text(part).strip(" ,.-")
        for part in re.split(r"(?<=[.!?…])\s+|[,;:]\s+", cleaned)
        if clean_text(part).strip(" ,.-")
    ]
    scored = []
    for order, part in enumerate(parts[:24]):
        words = part.split()
        while words:
            leading = re.sub(r"[^\w'-]", "", words[0].lower())
            if leading not in STOPWORDS_ID and leading not in {"or", "iya", "yah", "eee", "emm"}:
                break
            words.pop(0)
        for size in range(4, 1, -1):
            cursor = 0
            while cursor + size * 2 <= len(words):
                left = [word.lower() for word in words[cursor:cursor + size]]
                right = [word.lower() for word in words[cursor + size:cursor + size * 2]]
                if left == right:
                    del words[cursor + size:cursor + size * 2]
                else:
                    cursor += 1
        if len(words) < 4:
            continue
        phrase = " ".join(words[:max_words]).strip(" ,.-")
        normalized = normalize_words(phrase)
        useful = [word for word in normalized if word not in STOPWORDS_ID and len(word) >= 4]
        if len(useful) < 2:
            continue
        specificity = len(set(useful)) * 4
        signal = keyword_hits(
            phrase.lower(),
            ["kenapa", "ternyata", "akhirnya", "karena", "ditolak", "rahasia", "masalah", "cara", "alasan", "tidak", "nggak"],
        ) * 5
        repeated_penalty = max(0, len(normalized) - len(set(normalized))) * 4
        filler_penalty = 8 if normalized and normalized[0] in STOPWORDS_ID else 0
        scored.append((specificity + signal - repeated_penalty - filler_penalty - order * 0.15, phrase))
    if scored:
        scored.sort(key=lambda item: item[0], reverse=True)
        return scored[0][1]
    return first_strong_phrase(cleaned, max_words)


def specific_phrase_label(text, max_words=4):
    phrase = representative_phrase(text, 10)
    token_pairs = []
    for raw_word in phrase.split():
        display = re.sub(r"[^\wÀ-ÖØ-öø-ÿĀ-ž\u0100-\u024F\u1E00-\u1EFF'-]", "", raw_word, flags=re.UNICODE)
        normalized = display.lower()
        if len(normalized) < 3 or normalized in STOPWORDS_ID:
            continue
        token_pairs.append((display, normalized))

    # Acronyms usually carry the concrete subject (MBG, BGN, KPK, AI). Keep
    # the closest meaningful context instead of blindly taking sentence-openers.
    label_auxiliaries = {"akan", "bisa", "boleh", "dapat", "sudah", "belum", "semua"}
    for acronym_index, (display, _normalized) in enumerate(token_pairs):
        if 2 <= len(display) <= 8 and display.isupper():
            context = [
                pair for pair in token_pairs[:acronym_index]
                if pair[1] not in label_auxiliaries
            ][-min(2, max(1, max_words - 1)):]
            selected_pairs = context + [(display, display.lower())]
            return " ".join(
                word if word.isupper() else normalized.capitalize()
                for word, normalized in selected_pairs
            )

    selected = []
    for _display, normalized in token_pairs:
        selected.append(normalized.capitalize())
        if len(selected) >= max_words:
            break
    return " ".join(selected)


def hook_signature(text):
    lower = clean_text(text).lower()
    suffix_families = [
        "poin penting yang akhirnya terungkap",
        "jadi pembahasan serius",
        "begini lanjutan ceritanya",
        "yang tidak disangka",
        "alasan ceritanya jadi penting",
        "cerita di balik momen ini",
        "mulai jadi perhatian",
        "mengubah arah pembahasan",
        "sudut yang belum banyak dibahas",
        "yang membuatnya berbeda",
        "jadi pembahasan utama",
        "bagian yang tidak disangka",
    ]
    for family in suffix_families:
        if family in lower:
            return f"template:{family}"
    prefix_families = [
        "sisi lain", "pengakuan", "momen", "bagian", "alasan", "ternyata",
        "cerita", "kenapa", "rahasia", "sudut baru",
    ]
    for family in prefix_families:
        if lower.startswith(family + " ") or lower == family:
            return f"template:{family}"
    words = normalize_words(text)
    important = [word for word in words if word not in STOPWORDS_ID][:4]
    return " ".join(important[:3]) or " ".join(words[:3])


EDITORIAL_CLAIM_FAMILIES = (
    ("proof", {"bukti", "membuktikan", "terbukti"}),
    ("certainty", {"dipastikan", "memastikan", "terkonfirmasi", "terverifikasi"}),
    ("confession", {"mengaku", "mengakui", "pengakuan"}),
    ("official", {"resmi", "ditetapkan", "diumumkan"}),
    ("legal", {"pelaku", "tersangka", "bersalah", "korupsi"}),
    ("deception", {"penipuan", "skandal", "bohong", "hoaks"}),
    ("revelation", {"terungkap", "mengungkap", "ungkap"}),
)


def unsupported_editorial_claims(candidate, source_text):
    """Return assertion families introduced without support in source evidence."""
    candidate_words = set(normalize_words(clean_highlight_source_text(candidate)))
    source_words = set(normalize_words(clean_highlight_source_text(source_text)))
    unsupported = []
    for family, terms in EDITORIAL_CLAIM_FAMILIES:
        if candidate_words.intersection(terms) and not source_words.intersection(terms):
            unsupported.append(family)
    return unsupported


def editorial_claim_is_grounded(candidate, source_text):
    return not unsupported_editorial_claims(candidate, source_text)


def hook_quality_score(hook, source_text, used_signatures=None):
    hook = seo_clean_title(hook, "")
    source_text = clean_text(source_text)
    used_signatures = set(used_signatures or [])
    if not hook or is_generic_template(hook) or not editorial_claim_is_grounded(hook, source_text):
        return 0
    words = hook.split()
    if len(words) > 12:
        return 0
    lower = hook.lower()
    normalized_words = normalize_words(hook)
    filler_words = {"ee", "eee", "eh", "emm", "em", "hmm", "anu"}
    if any(word in filler_words for word in normalized_words):
        return 0
    if lower.startswith(("ya ", "oh ", "tolong ", "jadi pas itu", "baru nyadar", "tertawa ")):
        return 0
    source_words = set(extract_specific_terms(source_text, 18))
    hook_words = {word for word in normalize_words(hook) if word not in STOPWORDS_ID}
    overlap = len(hook_words & source_words)
    curiosity = 55 + keyword_hits(lower, ["ternyata", "pengakuan", "bagian", "cerita", "kenapa", "siapa", "kok", "akhirnya"]) * 8
    specificity = 40 + min(40, overlap * 12) + min(14, len(hook_words) * 1.5)
    emotion = 45 + keyword_hits(lower + " " + source_text.lower(), ["merinding", "hening", "kaget", "diam", "lucu", "ngakak", "panas", "sedih", "takut"]) * 8
    uniqueness = 78
    signature = hook_signature(hook)
    if signature in used_signatures:
        uniqueness -= 35
    if signature in LOW_VALUE_HOOK_SIGNATURES:
        uniqueness -= 18
    if lower.startswith(("jawaban ini", "konflik ini", "hal ini", "momen ini")):
        uniqueness -= 40
    if lower.startswith("pengakuan") and "pengakuan" not in source_text.lower():
        uniqueness -= 32
    normalized_hook = " ".join(normalize_words(hook))
    normalized_source = " ".join(normalize_words(source_text))
    normalized_hook = re.sub(r"\bmeriksa\b", "memeriksa", normalized_hook)
    normalized_source = re.sub(r"\bmeriksa\b", "memeriksa", normalized_source)
    grounded_phrase_bonus = 8 if len(normalized_hook.split()) >= 4 and normalized_hook in normalized_source else 0
    intent_words = [
        "kenapa", "kok", "siapa", "apa", "ternyata", "akhirnya", "karena",
        "tetapi", "namun", "berubah", "kejutan", "ditolak", "berhasil",
        "gagal", "rahasia", "masalah", "kesempatan", "ditelepon",
    ]
    has_editorial_intent = "?" in hook or keyword_hits(lower, intent_words) > 0
    score = curiosity * 0.40 + specificity * 0.20 + emotion * 0.20 + uniqueness * 0.20 + grounded_phrase_bonus
    if not has_editorial_intent:
        score = min(score, 56)
    return bounded_score(score, 0, 99)


def title_quality_score(title, source_text, used_signatures=None):
    title = seo_clean_title(title, "")
    if not title or is_generic_template(title):
        return 0
    if title.lower().startswith(("ya ", "oh ", "tolong ", "jadi pas itu", "baru nyadar", "tertawa ")):
        return 0
    length_score = 92 if 35 <= len(title) <= 70 else 72
    score = hook_quality_score(title, source_text, used_signatures) * 0.72 + length_score * 0.28
    if hook_signature(title).startswith("template:"):
        score -= 14
    return bounded_score(score, 0, 99)


def local_hook_candidates(text):
    text = clean_highlight_source_text(text)
    terms = extract_specific_terms(text, 6)
    phrase = representative_phrase(text, 8)
    phrase = re.sub(r"\bmeriksa\b", "memeriksa", phrase, flags=re.IGNORECASE)
    phrase = re.sub(r"\s+(?:saudara|teman-teman|guys|bro)$", "", phrase, flags=re.IGNORECASE).strip()
    main = specific_phrase_label(text, 3) or (" ".join(term.capitalize() for term in terms[:2]) if terms else phrase)
    if not main:
        main = "Cerita Ini"
    candidates = [
        f"{phrase}..." if phrase else "",
        f"Kenapa {main} Jadi Pembahasan Utama?",
        f"{main}: Hal yang Tidak Disangka",
        f"Apa yang Sebenarnya Terjadi dengan {main}?",
    ]
    cleaned = []
    seen = set()
    for item in candidates:
        item = seo_clean_title(item, "")
        if not item or item.lower() in seen:
            continue
        seen.add(item.lower())
        cleaned.append(item)
    return cleaned


def local_title_candidates(text, index=1):
    text = clean_highlight_source_text(text)
    terms = extract_specific_terms(text, 6)
    phrase = representative_phrase(text, 10)
    main = specific_phrase_label(text, 4) or (" ".join(term.capitalize() for term in terms[:3]) if terms else phrase)
    if not main:
        main = f"Clip Pilihan {index}"
    candidates = [
        phrase,
        f"Kenapa {main} Jadi Pembahasan Serius",
        f"Alasan {main} Tidak Bisa Dianggap Sepele",
        f"{main}: Hal Penting yang Sering Terlewat",
        f"Apa yang Sebenarnya Terjadi dengan {main}",
    ]
    return candidates


def profile_source_text(text, payload=None):
    profile = (payload or {}).get("_contentProfile") if isinstance((payload or {}).get("_contentProfile"), dict) else {}
    source_title = clean_text((profile.get("evidence") or {}).get("title") or "")
    clip_text = clean_text(text)
    return clean_text(f"{clip_text}. Sumber: {source_title}") if source_title else clip_text


def content_aware_local_hook_candidates(text, payload=None):
    source = profile_source_text(text, payload)
    video_type, _rule, source_title = content_profile_prompt_rules((payload or {}).get("_contentProfile"))
    label_source = source_title if video_type == "music" else clean_text(text) or source_title or source
    label = specific_phrase_label(label_source, 4) or "Momen Ini"
    specialized = {
        "music": [
            f"Bagian Vokal {label} Ini Paling Mengena",
            f"{label} Masuk ke Bagian Paling Emosional",
        ],
        "review": [
            f"Hasil Uji {label} yang Perlu Dilihat",
            f"Apakah {label} Benar-Benar Layak Dipilih?",
        ],
        "news": [
            f"Kenapa {label} Perlu Diperhatikan?",
            f"Apa Dampak {label}?",
        ],
        "vlog": [
            f"Momen {label} Mengubah Perjalanan Ini",
        ],
        "storytelling": [
            f"Di Sini Cerita {label} Mulai Berubah",
        ],
        "tutorial": [
            f"Langkah {label} Ini Sering Terlewat",
        ],
    }.get(video_type, [])
    return specialized + local_hook_candidates(source)


def content_aware_local_title_candidates(text, payload=None, index=1):
    source = profile_source_text(text, payload)
    video_type, _rule, source_title = content_profile_prompt_rules((payload or {}).get("_contentProfile"))
    label = specific_phrase_label(source_title or source, 5) or f"Clip Pilihan {index}"
    specialized = {
        "music": [
            f"{label}: Bagian Vokal Paling Kuat",
            f"Penampilan {label} di Bagian Paling Emosional",
        ],
        "review": [
            f"Review {label}: Hasil Uji dan Kesimpulan",
            f"Kelebihan dan Kekurangan {label} Setelah Diuji",
        ],
        "news": [
            f"{label}: Poin Utama dan Dampaknya",
        ],
        "vlog": [
            f"Momen {label} yang Mengubah Perjalanan",
        ],
        "storytelling": [
            f"Kisah {label} Sampai Titik Baliknya",
        ],
        "tutorial": [
            f"Cara {label} dengan Langkah yang Tepat",
        ],
    }.get(video_type, [])
    return specialized + local_title_candidates(source, index)


def pick_best_hook(candidates, source_text, used_signatures=None):
    scored = []
    for candidate in candidates or []:
        hook = seo_clean_title(candidate, "")
        score = hook_quality_score(hook, source_text, used_signatures)
        if score > 0:
            scored.append((score, hook))
    if not scored:
        fallback = local_hook_candidates(source_text)
        return pick_best_hook(fallback, source_text, used_signatures) if fallback else "Cerita Ini Punya Sisi Tak Terduga"
    used_signatures = set(used_signatures or [])
    unique_scored = [item for item in scored if hook_signature(item[1]) not in used_signatures]
    if unique_scored:
        scored = unique_scored
    scored.sort(key=lambda item: item[0], reverse=True)
    return scored[0][1]


def pick_best_title(candidates, source_text, index=1, used_signatures=None):
    scored = []
    for candidate in candidates or []:
        title = seo_clean_title(candidate, "")
        score = title_quality_score(title, source_text, used_signatures)
        if score > 0:
            scored.append((score, title))
    if not scored:
        fallback = local_title_candidates(source_text, index)
        return pick_best_title(fallback, source_text, index, used_signatures) if fallback else f"Clip Pilihan {index}"
    used_signatures = set(used_signatures or [])
    unique_scored = [item for item in scored if hook_signature(item[1]) not in used_signatures]
    if unique_scored:
        scored = unique_scored
    scored.sort(key=lambda item: item[0], reverse=True)
    return scored[0][1]


def parse_candidate_strings(response, keys):
    text = clean_text(response)
    parsed = extract_json_from_text(response)
    values = []
    if isinstance(parsed, dict):
        for key in keys:
            raw = parsed.get(key)
            if isinstance(raw, list):
                values.extend(str(item) for item in raw if item)
            elif isinstance(raw, str):
                values.append(raw)
    elif isinstance(parsed, list):
        for item in parsed:
            if isinstance(item, str):
                values.append(item)
            elif isinstance(item, dict):
                for key in keys:
                    if item.get(key):
                        values.append(str(item.get(key)))
    if not values:
        values = parse_simple_listed_titles(text)
    cleaned = []
    seen = set()
    for item in values:
        item = seo_clean_title(item, "")
        key = item.lower()
        if item and key not in seen:
            seen.add(key)
            cleaned.append(item)
    return cleaned


def relevance_ok(candidate, source_text, min_overlap=0.08):
    candidate_words = set(normalize_words(clean_text(candidate)))
    source_words = set(normalize_words(clean_text(source_text)))
    candidate_words = {word for word in candidate_words if len(word) > 3}
    source_words = {word for word in source_words if len(word) > 3}
    if not candidate_words or not source_words:
        return False
    overlap = len(candidate_words & source_words) / max(len(candidate_words), 1)
    return overlap >= min_overlap


def seo_clean_title(value, fallback="Moment Paling Menarik"):
    text = clean_text(value)
    text = re.sub(r"#\w+", "", text)
    text = re.sub(r"[\U00010000-\U0010FFFF]", "", text)
    text = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", " ", text)
    text = re.sub(r"\s+", " ", text).strip(" ._-")
    if not text:
        text = fallback
    deduped_words = []
    previous_word = ""
    for word in text.split():
        normalized = re.sub(r"[^\wÀ-ÖØ-öø-ÿĀ-ž'-]", "", word.lower(), flags=re.UNICODE)
        if normalized and normalized == previous_word:
            continue
        deduped_words.append(word)
        previous_word = normalized
    text = " ".join(deduped_words)
    words = text.split()
    if len(words) > 11:
        text = " ".join(words[:11])
    text = text[:72].strip(" ._-")
    if text and text == text.lower():
        small_words = {"dan", "di", "ke", "dari", "yang", "untuk", "atau"}
        text = " ".join(word if word in small_words else word[:1].upper() + word[1:] for word in text.split())
    if text:
        text = text[:1].upper() + text[1:]
    if len(text) < 18 and fallback:
        text = f"{text} Yang Bikin Penasaran".strip()
    return text


def fyp_title_from_text(text, index=1):
    direct = seo_clean_title(representative_phrase(text, 10), "")
    if direct and 24 <= len(direct) <= 72 and relevance_ok(direct, text, 0.08):
        return direct
    return pick_best_title(local_title_candidates(text, index), text, index)


def fyp_hook_from_text(text):
    return pick_best_hook(local_hook_candidates(text), text)


def context_overlay_from_moment(moment):
    category = clean_text(moment.get("category") or moment.get("segment_type") or "")
    reason = clean_text(moment.get("reason") or "")
    text = clean_text(moment.get("transcript") or moment.get("text") or moment.get("title") or "")
    lower = text.lower()
    if reason:
        seed = reason
    elif category and category.lower() not in {"insight", "ai", "timeline"}:
        seed = f"Cuplikan ini membahas {category.lower()}"
    elif any(word in lower for word in ["bullying", "konflik", "masalah", "ditolak", "ribut"]):
        seed = "Cuplikan ini memberi konteks konflik yang sedang dibahas"
    elif any(word in lower for word in ["cara", "tips", "strategi", "tutorial", "belajar"]):
        seed = "Cuplikan ini merangkum poin penting dari pembahasan"
    elif any(word in lower for word in ["ketawa", "ngakak", "lucu", "kocak"]):
        seed = "Cuplikan ini menyorot momen reaksi paling lucu"
    elif any(word in lower for word in ["kenapa", "kok", "gimana", "apa"]):
        seed = "Cuplikan ini menjelaskan pertanyaan utama pembahasan"
    else:
        seed = "Cuplikan ini telah dirangkum dari pembahasan utama"
    words = clean_text(seed).split()
    return " ".join(words[:14]) or "Cuplikan ini telah dirangkum"


def ai_generate_upload_title(moment, payload):
    try:
        transcript = compact_text_for_ai(moment.get("transcript") or moment.get("text") or "", 850)
        video_type, profile_rule, source_title = content_profile_prompt_rules(payload.get("_contentProfile"))
        prompt = (
            "Buat 3 kandidat judul MP4 SEO/FYP untuk clip pendek ini.\n"
            f"Profil: {video_type}. Judul sumber: {source_title or '-'}.\n"
            f"Aturan domain: {profile_rule}\n"
            "Rules: Bahasa Indonesia natural, 35-70 karakter, title case, tanpa emoji, tanpa hashtag, tanpa karakter Windows / : * ? \" < > |, "
            "curiosity gap ringan, harus spesifik dan relevan dengan transcript.\n"
            "Jangan mengubah dugaan, pertanyaan, atau surat viral menjadi bukti/fakta/kepastian. "
            "Klaim kuat hanya boleh dipakai bila dinyatakan jelas dalam transcript.\n"
            "DILARANG pakai template generik: Jawaban Ini Bikin Penasaran, Konflik Ini Terungkap, Hal Ini Mengejutkan.\n"
            "Output JSON valid saja: {\"titles\":[\"...\",\"...\",\"...\"]}\n\n"
            f"Hook: {moment.get('hook') or ''}\n"
            f"Title: {moment.get('titleSuggestion') or moment.get('title') or ''}\n"
            f"Transcript: {transcript}"
        )
        result = provider_request(payload, prompt, module="Title Generator")
        if result.get("response"):
            source = profile_source_text(transcript or moment.get("title") or "", payload)
            candidates = parse_candidate_strings(result["response"], ["titles", "title"])
            result["candidates"] = candidates
            result["response"] = pick_best_title(candidates + content_aware_local_title_candidates(source, payload), source)
        return result
    except Exception as exc:
        emit("log", message=f"AI upload title generator gagal: {exc}")
        return {"ok": False, "error": str(exc)}


def ai_generate_hook(moment, payload):
    try:
        transcript = compact_text_for_ai(moment.get("transcript") or moment.get("text") or moment.get("title") or "", 520)
        video_type, profile_rule, source_title = content_profile_prompt_rules(payload.get("_contentProfile"))
        prompt = (
            "Anda adalah editor TikTok dan Facebook Reels.\n"
            "Buat 5 kandidat hook terbaik berdasarkan transcript.\n"
            f"Profil: {video_type}. Judul sumber: {source_title or '-'}.\n"
            f"Aturan domain: {profile_rule}\n"
            "Rules: maksimal 12 kata, memancing penasaran, relevan, tidak clickbait berlebihan, Bahasa Indonesia natural, tanpa emoji/hashtag.\n"
            "Hook wajib kalimat utuh, bukan fragmen transcript, dan harus bebas filler ee/eee/emm/anu.\n"
            "Jangan menaikkan tingkat kepastian. Dugaan tetap dugaan; pertanyaan tetap pertanyaan. "
            "Jangan menulis bukti, terbukti, dipastikan, resmi, pengakuan, tersangka, korupsi, atau terungkap "
            "bila istilah itu tidak ada dalam transcript.\n"
            "DILARANG pakai template: Jawaban Ini Bikin Penasaran, Konflik Ini Terungkap, Hal Ini Mengejutkan, Bagian Ini Wajib Kamu Lihat.\n"
            f"Judul scene: {moment.get('titleSuggestion') or moment.get('title') or ''}\n"
            f"Transcript: {transcript}\n"
            "Output JSON valid saja: {\"hooks\":[\"...\",\"...\",\"...\",\"...\",\"...\"]}"
        )
        result = provider_request(payload, prompt, module="Hook Maker")
        if result.get("response"):
            source = profile_source_text(transcript or moment.get("title") or "", payload)
            candidates = parse_candidate_strings(result["response"], ["hooks", "hook"])
            result["candidates"] = candidates
            result["response"] = pick_best_hook(candidates + content_aware_local_hook_candidates(source, payload), source)
        return result
    except Exception as exc:
        emit("log", message=f"AI hook generator gagal: {exc}")
        return {"ok": False, "error": str(exc)}


def ai_clean_caption(text, payload):
    try:
        clean_input = compact_text_for_ai(text, 360)
        if len(clean_input.split()) <= 3:
            return {"response": clean_input, "usage": {}, "parser": "local-short-caption"}
        prompt = (
            "Bersihkan 1 subtitle phrase tanpa mengubah arti.\n"
            "Hapus filler/ulang berlebihan, tetap natural.\n"
            f"Teks: {clean_input}\n"
            "Jawab hanya teks bersih, maksimal 14 kata."
        )
        return provider_request(payload, prompt, module="Caption Cleaner")
    except Exception as exc:
        emit("log", message=f"AI caption cleanup gagal: {exc}")
        return {"ok": False, "error": str(exc)}


def test_provider_request(payload):
    AI_DEBUG_EVENTS.clear()
    AI_USAGE.update({"input_tokens": 0, "output_tokens": 0, "requests": 0, "errors": 0, "cache_hits": 0, "cache_misses": 0})
    try:
        if str(payload.get("providerType") or "local").lower() == "local":
            return {
                "ok": True,
                "status": "Local heuristic active",
                "provider": "Local Heuristic",
                "model": payload.get("highlightModel") or payload.get("model") or "local-heuristic",
                "response": "OK",
                "usage": {},
            }
        simple = provider_request(payload, "Reply only: OK", module="API Test")
        title = provider_request(
            payload,
            "Buat satu judul SEO Bahasa Indonesia maksimal 55 karakter untuk transcript: 'banyak orang gagal karena mulai tanpa strategi'. Jawab hanya judul.",
            module="Title Generator",
        )
        highlight = provider_request(
            payload,
            "Balas hanya JSON array valid untuk test parser: [{\"source_id\":1,\"score\":91,\"title\":\"Strategi Anti Gagal\",\"hook\":\"Kenapa banyak orang gagal?\",\"reason\":\"Hook jelas\"}]",
            module="Highlight Finder",
        )
        caption = provider_request(
            payload,
            "Rapikan caption ini menjadi 2 phrase natural, maksimal 7 kata per phrase, pisahkan dengan baris baru: 'hari ini saya ingin membahas kenapa banyak orang gagal padahal peluangnya besar'",
            module="Caption Cleaner",
        )
        parsed = extract_json_from_text(highlight.get("response") or "")
        if not isinstance(parsed, list) or not parsed:
            raise RuntimeError("AI JSON response parsing gagal.")
        response = simple.get("response") or "OK"
        return {
            "ok": True,
            "status": "Connected ✓",
            "provider": ai_provider_name(str(payload.get("providerType") or "openai")),
            "model": payload.get("highlightModel") or payload.get("model"),
            "response": response.strip(),
            "checks": {
                "simple_prompt": response.strip(),
                "title_generation": clean_text(title.get("response") or "")[:120],
                "highlight_json_items": len(parsed),
                "caption_phrase": clean_text(caption.get("response") or "")[:160],
            },
            "usage": simple.get("usage") or {},
            "usage_total": dict(AI_USAGE),
            "ai_log_path": str(ai_log_path(payload)),
        }
    except Exception as exc:
        return {"ok": False, "status": str(exc), "error": str(exc)}


def parse_ai_refined_titles(raw_text):
    titles = parse_simple_listed_titles(raw_text)
    return [title for title in titles if title]


def parse_ai_refined_moment_metadata(raw_text):
    try:
        parsed = extract_json_from_text(raw_text)
        if isinstance(parsed, dict):
            parsed = parsed.get("items") or parsed.get("moments") or parsed.get("clips") or []
        if isinstance(parsed, list):
            return [item for item in parsed if isinstance(item, dict)]
    except Exception:
        pass
    titles = parse_ai_refined_titles(raw_text)
    return [{"title": title} for title in titles]


def extract_json_from_text(raw_text):
    text = str(raw_text or "").strip()
    if not text:
        raise ValueError("AI response kosong.")
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, flags=re.IGNORECASE | re.DOTALL)
    if fenced:
        text = fenced.group(1).strip()
    try:
        return json.loads(text)
    except Exception:
        start = text.find("[")
        end = text.rfind("]")
        if start >= 0 and end > start:
            return json.loads(text[start:end + 1])
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            return json.loads(text[start:end + 1])
        raise


def clamp_score(value, default=75):
    try:
        return int(max(1, min(100, round(float(value)))))
    except Exception:
        return int(default)


AI_HIGHLIGHT_METRIC_KEYS = [
    "hook",
    "emotion",
    "conflict",
    "surprise",
    "payoff",
    "story_complete",
    "retention_predictor",
    "dialogue",
    "virality",
    "filler_ratio",
    "audio_activity",
    "audio_variation",
    "duration_fit",
    "heatmap_score",
    "heatmap_supported",
]


def compact_ai_highlight_candidate(item):
    metrics = item.get("metrics") if isinstance(item.get("metrics"), dict) else {}
    compact_metrics = {key: metrics.get(key) for key in AI_HIGHLIGHT_METRIC_KEYS if metrics.get(key) is not None}
    return {
        "id": item.get("id"),
        "start": round(float(item.get("start") or 0), 2),
        "end": round(float(item.get("end") or 0), 2),
        "duration": round(float(item.get("duration") or 0), 2),
        "local_score": clamp_score(item.get("score"), 50),
        "metrics": compact_metrics,
        "category": item.get("category") or item.get("segment_type") or "Insight",
        "reason": clean_text(item.get("reason") or "")[:120],
        "text": compact_text_for_ai(item.get("text") or item.get("transcript") or "", 300),
        "story_id": item.get("story_id"),
        "candidate_sources": list(item.get("candidate_sources") or []),
        "topic": clean_text(item.get("topic") or "")[:80],
        "story_summary": clean_text(item.get("story_summary") or "")[:140],
    }


def build_ai_highlight_shortlist(candidates, target_count):
    target_count = max(1, int(target_count or 1))
    ranked = sorted(candidates or [], key=lambda item: item.get("score", 0), reverse=True)
    pool_limit = min(len(ranked), max(36, target_count * 8))
    pool = ranked[:pool_limit]
    groups = {}
    for item in pool:
        story_id = item.get("story_id")
        if story_id is not None:
            key = f"story:{story_id}"
        else:
            key = f"timeline:{int(float(item.get('start') or 0) // 300)}"
        groups.setdefault(key, []).append(item)
    shortlist = []
    shortlist_limit = min(30, max(14, target_count * 5))
    while len(shortlist) < shortlist_limit:
        added = False
        for key in list(groups.keys()):
            bucket = groups.get(key) or []
            if not bucket:
                continue
            candidate = bucket.pop(0)
            if candidate not in shortlist:
                shortlist.append(candidate)
                added = True
            if len(shortlist) >= shortlist_limit:
                break
        if not added:
            break
    return shortlist


def build_ai_highlight_batches(candidates, target_count, batch_size=10):
    shortlist = build_ai_highlight_shortlist(candidates, target_count)
    batch_size = max(6, min(12, int(batch_size or 10)))
    return [shortlist[index:index + batch_size] for index in range(0, len(shortlist), batch_size)]


def content_profile_prompt_rules(content_profile):
    profile = content_profile if isinstance(content_profile, dict) else {}
    video_type = str(profile.get("videoType") or "general").lower()
    rules = {
        "music": (
            "Ini video musik/performance. Cari bagian vokal/refrain/emosi atau perubahan energi paling kuat. "
            "Jangan memaksakan konflik, berita, atau fakta dari lirik; hook harus menggambarkan penampilan nyata."
        ),
        "review": (
            "Ini review produk. Utamakan masalah pengguna, fitur yang diuji, bukti/hasil tes, perbandingan, lalu verdict. "
            "Jangan menyimpulkan produk bagus/buruk bila transcript belum memberi bukti."
        ),
        "news": (
            "Ini berita. Utamakan peristiwa, konteks, dampak, dan pernyataan yang lengkap. "
            "Jangan menambah nama, angka, tuduhan, atau kepastian yang tidak ada pada transcript."
        ),
        "vlog": (
            "Ini vlog. Pilih tindakan atau kejadian konkret yang memiliki reaksi dan hasil, bukan percakapan acak."
        ),
        "storytelling": (
            "Ini storytelling. Kandidat harus memuat setup, perubahan/masalah, dan payoff atau penutup yang natural."
        ),
        "podcast": (
            "Ini percakapan/podcast. Cari pertanyaan atau klaim yang langsung diikuti penjelasan, reaksi, atau jawaban utuh."
        ),
        "tutorial": (
            "Ini tutorial. Pilih satu masalah dan langkah/solusi yang dapat dipahami tanpa bagian video lain."
        ),
        "gaming": (
            "Ini gaming. Utamakan keputusan, aksi penting, perubahan keadaan, dan reaksi; hindari bagian menunggu."
        ),
    }
    source_title = clean_text((profile.get("evidence") or {}).get("title") or "")
    return video_type, rules.get(video_type, "Pilih satu ide yang lengkap, spesifik, dan dapat dipahami tanpa konteks palsu."), source_title


def highlight_batch_prompt(candidate_payload, target_count, min_duration, max_duration, score_mode, batch_index, batch_count, content_profile=None):
    video_type, profile_rule, source_title = content_profile_prompt_rules(content_profile)
    return (
        "Kamu adalah editor short-form profesional. Nilai kandidat dalam batch kecil ini berdasarkan isi nyata, bukan panjang transcript.\n"
        f"Profil video: {video_type}. Judul sumber: {source_title or '-'}.\n"
        f"Aturan domain: {profile_rule}\n"
        "Prioritas: hook kuat pada pembuka, konflik/emosi/komedi/value, setup jelas, payoff selesai, dan retention.\n"
        "heatmap_score adalah bukti Most Replayed tambahan saja. Jangan pilih kandidat yang ramai tetapi konteks/payoff-nya lemah.\n"
        "Jangan pilih scene menggantung, filler tinggi, topik kabur, atau kandidat yang hanya ramai tanpa makna.\n"
        f"Batch {batch_index}/{batch_count}. Pilih maksimal {target_count} kandidat terbaik dari batch ini.\n"
        f"Durasi: punchline 25-65 detik, tutorial 45-110 detik, storytelling maksimal {int(min(max_duration, 145))} detik; minimum {int(min_duration)} detik.\n"
        f"Mode: {score_mode or 'Random Viral Mix'}. Score 78-100 hanya bila benar-benar layak auto-render; 65-77 optional.\n"
        "Title Bahasa Indonesia 4-9 kata dan hook 6-10 kata harus spesifik pada transcript. Jangan mengarang nama, angka, konflik, atau fakta.\n"
        "Balas HANYA JSON array valid tanpa markdown. Format:\n"
        "[{\"source_id\":1,\"score\":88,\"title\":\"...\",\"hook\":\"...\",\"reason\":\"maksimal 12 kata\",\"start_anchor\":\"4-12 kata persis dari transcript awal\",\"end_anchor\":\"4-12 kata persis dari payoff transcript\",\"layout\":\"single|split\"}]\n"
        f"Kandidat:\n{json_dumps(candidate_payload)}"
    )


def review_ai_highlight_candidates(candidates, payload, target_count):
    """Run one independent quality review over the primary provider shortlist."""
    if not candidates or str(payload.get("providerType") or "").lower() != "cloud":
        return candidates, False
    routing_mode = str(payload.get("aiRoutingMode") or "balanced").strip().lower()
    if routing_mode in {"economy", "single", "primary-only", "off"}:
        return candidates, False

    review_pool = sorted(candidates, key=lambda item: item.get("initial_score", item.get("score", 0)), reverse=True)
    review_pool = review_pool[: min(10, max(6, int(target_count or 1) * 2))]
    video_type, profile_rule, source_title = content_profile_prompt_rules(payload.get("_contentProfile"))
    review_items = []
    for item in review_pool:
        metrics = item.get("metrics") if isinstance(item.get("metrics"), dict) else {}
        review_items.append({
            "source_id": item.get("_source_candidate_id") or item.get("id"),
            "local_score": item.get("local_score"),
            "primary_score": item.get("primary_score", item.get("ai_score")),
            "evidence_gate": bool(item.get("ai_evidence_gate")),
            "metrics": {key: metrics.get(key) for key in AI_HIGHLIGHT_METRIC_KEYS if metrics.get(key) is not None},
            "title": clean_text(item.get("titleSuggestion") or item.get("title") or "")[:90],
            "hook": clean_text(item.get("hook") or "")[:90],
            "text": compact_text_for_ai(item.get("text") or item.get("transcript") or "", 340),
        })
    prompt = (
        "Anda adalah final editorial reviewer untuk short-form video.\n"
        "Review shortlist dari provider pertama secara independen. Jangan meloloskan kandidat hanya karena score awal tinggi.\n"
        f"Profil: {video_type}. Judul sumber: {source_title or '-'}.\n"
        f"Aturan domain: {profile_rule}\n"
        "Nilai kelengkapan konteks, hook nyata, payoff, clarity, natural ending, dan bukti audio/visual yang tersedia.\n"
        "Score 90+ harus sangat langka. Kandidat tanpa payoff atau menggantung harus turun. Jangan mengarang fakta.\n"
        "Title dan hook harus spesifik pada teks kandidat, berbeda antarclip, maksimal 12 kata, tanpa template generik.\n"
        "Alasan maksimal 10 kata. Balas HANYA JSON array valid, satu item per source_id:\n"
        "[{\"source_id\":1,\"score\":78,\"approve\":true,\"title\":\"...\",\"hook\":\"...\",\"reason\":\"...\"}]\n"
        f"Shortlist:\n{json_dumps(review_items)}"
    )

    def parse_reviews(response_text):
        parsed = extract_json_from_text(response_text or "")
        if isinstance(parsed, dict):
            parsed = parsed.get("items") or parsed.get("moments") or parsed.get("clips") or []
        if not isinstance(parsed, list):
            raise ValueError("Reviewer response bukan JSON array.")
        reviews = {}
        for item in parsed:
            if not isinstance(item, dict):
                continue
            try:
                source_id = int(item.get("source_id") or item.get("id"))
            except Exception:
                continue
            reviews[source_id] = item
        if not reviews:
            raise ValueError("Reviewer tidak mengembalikan source_id yang valid.")
        return reviews

    def compact_review_prompt(items):
        compact_items = [
            {
                "source_id": item["source_id"],
                "local_score": item["local_score"],
                "primary_score": item["primary_score"],
                "title": item["title"],
                "hook": item["hook"],
                "text": compact_text_for_ai(item["text"], 240),
            }
            for item in items
        ]
        return (
            "Review setiap kandidat short video secara ketat. Nilai konteks, hook nyata, payoff, dan ending. "
            "Wajib kembalikan tepat satu item untuk SETIAP source_id yang diberikan. "
            "Score 90+ sangat langka. Jangan mengarang fakta. "
            "Balas HANYA JSON array ringkas tanpa markdown dan tanpa penjelasan tambahan: "
            "[{\"source_id\":1,\"score\":78,\"approve\":true,\"title\":\"...\",\"hook\":\"...\"}]\n"
            f"Kandidat:\n{json_dumps(compact_items)}"
        )

    def mark_reviewer_unavailable():
        reviewed = []
        for candidate in candidates:
            local_score = clamp_score(candidate.get("local_score"), 50)
            evidence_bonus = 10 if candidate.get("ai_evidence_gate") else 2
            primary_score = min(
                clamp_score(candidate.get("primary_score", candidate.get("ai_score")), local_score),
                local_score + evidence_bonus,
            )
            fallback_score = clamp_score(local_score * 0.60 + primary_score * 0.40, local_score)
            # Do not silently auto-render a weak local candidate after the
            # independent reviewer failed. Keep it visible for manual review.
            if local_score < 60 or not candidate.get("ai_evidence_gate"):
                fallback_score = min(fallback_score, AUTO_SELECT_MIN_SCORE - 1)
            candidate["score"] = fallback_score
            candidate["finalScore"] = fallback_score
            candidate["providerScores"] = {"local": local_score, "primary": primary_score}
            candidate["scoreProvenance"] = {
                "formula": "local*0.60 + capped_primary*0.40",
                "evidenceGate": bool(candidate.get("ai_evidence_gate")),
                "providerScoreCap": local_score + evidence_bonus,
                "reviewerRole": "unavailable_manual_review",
            }
            candidate["reviewer_status"] = "unavailable"
            candidate["manualReview"] = True
            candidate["auto_render"] = False
            reviewed.append(candidate)
        return reviewed

    try:
        review_attempts = 1
        result = provider_request(payload, prompt, module="Final Ranking Reviewer")
        try:
            reviews = parse_reviews(result.get("response") or "")
        except Exception as first_parse_error:
            emit(
                "log",
                stage="ai moments",
                message=f"JSON reviewer terpotong/tidak valid, mencoba satu respons ringkas: {short_error_text(first_parse_error, 140)}",
            )
            review_attempts += 1
            retry_result = provider_request(payload, compact_review_prompt(review_items), module="Final Ranking Reviewer")
            reviews = parse_reviews(retry_result.get("response") or "")

        expected_ids = {int(item["source_id"]) for item in review_items if item.get("source_id") is not None}
        missing_ids = expected_ids.difference(reviews)
        if missing_ids and review_attempts < 2:
            emit(
                "log",
                stage="ai moments",
                message=f"Reviewer melewatkan {len(missing_ids)} source_id, retry khusus kandidat yang belum direview.",
            )
            missing_items = [item for item in review_items if int(item["source_id"]) in missing_ids]
            try:
                review_attempts += 1
                retry_result = provider_request(
                    payload,
                    compact_review_prompt(missing_items),
                    module="Final Ranking Reviewer",
                )
                reviews.update(parse_reviews(retry_result.get("response") or ""))
            except Exception as missing_retry_error:
                emit(
                    "log",
                    stage="ai moments",
                    message=f"Retry reviewer parsial gagal; kandidat tanpa review masuk manual review: {short_error_text(missing_retry_error, 140)}",
                )

        reviewed = []
        for candidate in candidates:
            source_id = int(candidate.get("_source_candidate_id") or candidate.get("id") or 0)
            review = reviews.get(source_id)
            if not review:
                local_score = clamp_score(candidate.get("local_score"), 50)
                evidence_bonus = 10 if candidate.get("ai_evidence_gate") else 2
                primary_score = min(
                    clamp_score(candidate.get("primary_score", candidate.get("ai_score")), local_score),
                    local_score + evidence_bonus,
                )
                fallback_score = min(
                    clamp_score(local_score * 0.60 + primary_score * 0.40, local_score),
                    AUTO_SELECT_MIN_SCORE - 1,
                )
                candidate["score"] = fallback_score
                candidate["finalScore"] = fallback_score
                candidate["providerScores"] = {"local": local_score, "primary": primary_score}
                candidate["scoreProvenance"] = {
                    "formula": "local*0.60 + capped_primary*0.40",
                    "evidenceGate": bool(candidate.get("ai_evidence_gate")),
                    "providerScoreCap": local_score + evidence_bonus,
                    "reviewerRole": "missing_manual_review",
                }
                candidate["reviewer_status"] = "missing"
                candidate["manualReview"] = True
                candidate["auto_render"] = False
                reviewed.append(candidate)
                continue
            local_score = clamp_score(candidate.get("local_score"), 50)
            evidence_bonus = 10 if candidate.get("ai_evidence_gate") else 2
            provider_score_cap = local_score + evidence_bonus
            reviewer_score = min(
                clamp_score(review.get("score"), candidate.get("initial_score") or candidate.get("score") or 50),
                provider_score_cap,
            )
            primary_score = min(
                clamp_score(candidate.get("primary_score", candidate.get("ai_score")), local_score),
                provider_score_cap,
            )
            final_score = min(
                clamp_score(
                    local_score * 0.45 + primary_score * 0.30 + reviewer_score * 0.25,
                    local_score,
                ),
                provider_score_cap,
            )
            if not candidate.get("ai_evidence_gate"):
                final_score = min(final_score, AUTO_SELECT_MIN_SCORE - 1)
            candidate["review_score"] = reviewer_score
            candidate["score"] = final_score
            candidate["finalScore"] = final_score
            candidate["providerScores"] = {
                "local": local_score,
                "primary": primary_score,
                "reviewer": reviewer_score,
            }
            candidate["scoreProvenance"] = {
                "formula": "local*0.45 + capped_primary*0.30 + capped_reviewer*0.25",
                "evidenceGate": bool(candidate.get("ai_evidence_gate")),
                "providerScoreCap": provider_score_cap,
                "reviewerRole": "final_editorial_reviewer",
            }
            candidate["reviewer_status"] = "approved" if bool(review.get("approve", final_score >= AUTO_SELECT_MIN_SCORE)) else "rejected"
            candidate["manualReview"] = candidate["reviewer_status"] == "rejected" or final_score < AUTO_SELECT_MIN_SCORE
            source_text = profile_source_text(candidate.get("text") or candidate.get("transcript") or "", payload)
            if review.get("title"):
                title = seo_clean_title(review.get("title"), candidate.get("titleSuggestion") or candidate.get("title") or "")
                if not is_generic_template(title) and relevance_ok(title, source_text, EDITORIAL_MIN_OVERLAP):
                    candidate["title"] = title
                    candidate["titleSuggestion"] = title
            if review.get("hook"):
                hook = seo_clean_title(review.get("hook"), candidate.get("hook") or "")
                if len(hook.split()) <= 12 and not is_generic_template(hook) and relevance_ok(hook, source_text, EDITORIAL_MIN_OVERLAP):
                    candidate["hook"] = hook
            if review.get("reason"):
                candidate["review_reason"] = clean_text(review.get("reason"))[:240]
            reviewed.append(candidate)
        emit(
            "log",
            stage="ai moments",
            message=f"Final AI reviewer selesai: {len(expected_ids.intersection(reviews))}/{len(expected_ids)} kandidat memiliki review.",
        )
        return reviewed, True
    except Exception as exc:
        emit(
            "log",
            stage="ai moments",
            message=f"Final AI reviewer gagal; kandidat ditahan untuk review manual: {short_error_text(exc, 220)}",
        )
        return mark_reviewer_unavailable(), False


def ai_select_moments(candidates, payload, target_count, transcript, min_duration, max_duration):
    if not candidates or not is_ai_feature_enabled(payload, "highlight"):
        return []
    batches = build_ai_highlight_batches(candidates, target_count)
    shortlist = [item for batch in batches for item in batch]
    if not batches:
        return []
    try:
        emit("progress", stage="ai moments", progress=91, message="AI memilih moment terbaik")
        parsed = []
        failed_batches = []
        # A batch only contains a small, evidence-rich shortlist. Asking an
        # AI for more picks than its batch has candidates produces noisy JSON
        # and inflated scores on long "all recommendations" jobs.
        requested_batch_pick = max(2, math.ceil(target_count / max(1, len(batches))) + 1)
        for batch_index, batch in enumerate(batches, 1):
            batch_pick = min(len(batch), requested_batch_pick)
            prompt = highlight_batch_prompt(
                [compact_ai_highlight_candidate(item) for item in batch],
                batch_pick,
                min_duration,
                max_duration,
                payload.get("scoreMode"),
                batch_index,
                len(batches),
                payload.get("_contentProfile"),
            )
            try:
                result = provider_request(payload, prompt, module=f"Highlight Finder Batch {batch_index}/{len(batches)}")
                batch_items = extract_json_from_text(result.get("response") or "")
                if isinstance(batch_items, dict):
                    batch_items = batch_items.get("moments") or batch_items.get("clips") or batch_items.get("items") or []
                if not isinstance(batch_items, list):
                    raise ValueError("AI response bukan list JSON.")
                for batch_item in batch_items:
                    if isinstance(batch_item, dict):
                        batch_item = dict(batch_item)
                        batch_item["_ai_batch"] = batch_index
                        batch_item["_ai_retry_count"] = int(result.get("retry_count") or 0)
                        parsed.append(batch_item)
                emit("log", stage="ai moments", message=f"AI batch {batch_index}/{len(batches)} selesai: {len(batch_items)} pilihan")
            except Exception as batch_exc:
                failed_batches.append(f"batch {batch_index}: {short_error_text(batch_exc, 180)}")
                emit("log", stage="ai moments", message=f"AI batch {batch_index}/{len(batches)} gagal, batch lain tetap dilanjutkan: {short_error_text(batch_exc, 180)}")
        if not parsed:
            raise RuntimeError("Semua AI highlight batch gagal. " + "; ".join(failed_batches[:3]))
        by_id = {int(item.get("id")): item for item in shortlist if item.get("id") is not None}
        validated_candidates = []
        seen_source_ids = set()
        minimum_ai_score = AUTO_SELECT_MIN_SCORE if bool_payload(payload, "fullAutoMode", False) else AUTO_RENDER_MIN_SCORE
        for ai_item in parsed:
            if not isinstance(ai_item, dict):
                continue
            source_id = ai_item.get("source_id") or ai_item.get("id") or ai_item.get("candidate_id")
            try:
                source_id = int(source_id)
            except Exception:
                continue
            if source_id in seen_source_ids:
                continue
            base = by_id.get(source_id)
            if not base:
                continue
            seen_source_ids.add(source_id)
            candidate = dict(base)
            candidate["_source_candidate_id"] = source_id
            local_score = clamp_score(candidate.get("score"), 50)
            metrics = candidate.get("metrics") or {}
            profile_type = str(((payload.get("_contentProfile") or {}).get("videoType") or "general")).lower()
            evidence_quality = highlight_evidence_quality(
                candidate.get("text") or candidate.get("transcript") or ""
            )
            metrics.update(
                {
                    "hook_evidence": evidence_quality["hook_evidence"],
                    "payoff_evidence": evidence_quality["payoff_evidence"],
                    "specificity_count": evidence_quality["specificity_count"],
                    "repetition_ratio": evidence_quality["repetition_ratio"],
                    "dangling_start": evidence_quality["dangling_start"],
                    "dangling_end": evidence_quality["dangling_end"],
                }
            )
            candidate["metrics"] = metrics
            evidence_gate = candidate_evidence_gate(
                metrics,
                evidence_quality,
                profile_type,
                local_score,
            )
            candidate["ai_evidence_gate"] = evidence_gate
            provider_score_cap = min(97, local_score + (10 if evidence_gate else 2))
            ai_score = min(
                clamp_score(ai_item.get("score"), local_score),
                provider_score_cap,
            )
            # Providers rank semantic quality, but deterministic transcript
            # evidence remains the score anchor and hard upper bound.
            validated_score = local_score * 0.55 + ai_score * 0.45
            candidate["score"] = min(
                clamp_score(validated_score, local_score),
                provider_score_cap,
            )
            candidate["local_score"] = local_score
            candidate["ai_score"] = ai_score
            candidate["primary_score"] = ai_score
            candidate["initial_score"] = candidate["score"]
            candidate["providerScores"] = {"local": local_score, "primary": ai_score}
            candidate["scoreProvenance"] = {
                "formula": "local*0.55 + capped_primary*0.45",
                "evidenceGate": evidence_gate,
                "providerScoreCap": provider_score_cap,
            }
            candidate["score_validated"] = True
            raw_source_text = candidate.get("text") or candidate.get("transcript") or ""
            source_text = profile_source_text(raw_source_text, payload)
            if ai_item.get("title"):
                ai_title = seo_clean_title(
                    ai_item.get("title"),
                    pick_best_title(content_aware_local_title_candidates(raw_source_text, payload), source_text),
                )
                if not is_generic_template(ai_title) and relevance_ok(ai_title, source_text, EDITORIAL_MIN_OVERLAP):
                    candidate["title"] = ai_title
                    candidate["titleSuggestion"] = ai_title
            if ai_item.get("hook"):
                hook_value = seo_clean_title(
                    ai_item.get("hook"),
                    pick_best_hook(content_aware_local_hook_candidates(raw_source_text, payload), source_text),
                )
                if len(hook_value.split()) <= 12 and not is_generic_template(hook_value) and relevance_ok(hook_value, source_text, EDITORIAL_MIN_OVERLAP):
                    candidate["hook"] = hook_value
            if ai_item.get("reason"):
                candidate["reason"] = clean_text(ai_item.get("reason"))[:260]
            if str(ai_item.get("layout") or "").lower() == "split":
                candidate["layout_suggestion"] = "split"
            effective_min, effective_target, effective_max, duration_profile = candidate_duration_bounds(
                candidate.get("text") or candidate.get("transcript") or "",
                min_duration,
                min(max_duration, max(min_duration, (float(min_duration) + float(max_duration)) / 2)),
                max_duration,
                payload.get("_contentProfile"),
            )
            anchored_start, anchored_end, anchor_evidence = align_ai_boundary_anchors(
                candidate.get("start", 0),
                min(float(candidate.get("end", 0)), float(candidate.get("start", 0)) + effective_max),
                transcript,
                ai_item.get("start_anchor") or ai_item.get("opening_anchor"),
                ai_item.get("end_anchor") or ai_item.get("payoff_anchor"),
                effective_max,
            )
            improved_start, improved_end, improved_text = improve_story_boundaries(
                anchored_start,
                anchored_end,
                transcript,
                effective_min,
                effective_target,
                effective_max,
            )
            candidate["start"] = improved_start
            candidate["end"] = improved_end
            candidate["duration"] = round(improved_end - improved_start, 2)
            candidate.setdefault("metrics", {})["duration_profile"] = duration_profile
            candidate["metrics"]["boundary_anchor"] = anchor_evidence
            if improved_text:
                candidate["text"] = improved_text
                candidate["transcript"] = improved_text[:700]
            # The provider proposes semantic anchors only. Re-score the final,
            # locally aligned clip so the original window never retains a score
            # after its actual start/end have changed.
            final_local = score_moment_candidate(
                candidate,
                payload,
                source_id,
                effective_min,
                effective_max,
            )
            candidate.update(final_local)
            candidate.setdefault("metrics", {})["duration_profile"] = duration_profile
            candidate["metrics"]["boundary_anchor"] = anchor_evidence
            final_local_score = clamp_score(final_local.get("score"), 50)
            final_evidence = highlight_evidence_quality(candidate.get("text") or candidate.get("transcript") or "")
            final_metrics = candidate.get("metrics") or {}
            final_gate = candidate_evidence_gate(final_metrics, final_evidence, profile_type, final_local_score)
            # A custom-provider fallback can legitimately run without a local
            # transcript (for example an already prepared external candidate).
            # In that case there is no changed boundary to re-score; preserve
            # its original deterministic evidence rather than dropping it.
            if not transcript:
                final_local_score = local_score
                final_metrics = metrics
                final_gate = evidence_gate
            final_provider_cap = min(97, final_local_score + (10 if final_gate else 2))
            final_primary_score = min(clamp_score(candidate.get("ai_score"), final_local_score), final_provider_cap)
            final_score = min(
                clamp_score(final_local_score * 0.55 + final_primary_score * 0.45, final_local_score),
                final_provider_cap,
            )
            if not final_gate:
                final_score = min(final_score, AUTO_SELECT_MIN_SCORE - 1)
            candidate["local_score"] = final_local_score
            candidate["ai_score"] = final_primary_score
            candidate["primary_score"] = final_primary_score
            candidate["ai_evidence_gate"] = final_gate
            candidate["score"] = final_score
            candidate["finalScore"] = final_score
            candidate["grade"] = score_grade(final_score)
            candidate["auto_render"] = final_score >= AUTO_SELECT_MIN_SCORE and final_gate
            candidate["render_eligible"] = final_score >= AUTO_RENDER_MIN_SCORE
            candidate["providerScores"] = {"local": final_local_score, "primary": final_primary_score}
            candidate["scoreProvenance"] = {
                "formula": "final_local*0.55 + capped_primary*0.45",
                "evidenceGate": final_gate,
                "providerScoreCap": final_provider_cap,
                "boundaryRevalidated": True,
            }
            if final_score < 55:
                continue
            candidate["ai_selected"] = True
            candidate["segment_type"] = "AI"
            candidate["ai_source"] = f"{ai_provider_name(payload.get('providerType'))} AI"
            candidate["ai_batch"] = int(ai_item.get("_ai_batch") or 1)
            candidate["ai_retry_count"] = int(ai_item.get("_ai_retry_count") or 0)
            validated_candidates.append(candidate)
        validated_candidates, reviewer_used = review_ai_highlight_candidates(
            validated_candidates,
            payload,
            target_count,
        )
        selected = []
        for candidate in sorted(validated_candidates, key=lambda item: item.get("score", 0), reverse=True):
            if candidate.get("reviewer_status") == "rejected" or candidate.get("score", 0) < minimum_ai_score:
                continue
            if overlaps_any(candidate, selected):
                continue
            if any(text_similarity(candidate.get("text"), previous.get("text")) > 0.62 for previous in selected):
                continue
            selected.append(candidate)
            if len(selected) >= target_count:
                break
        if selected:
            ordered = sorted(selected[:target_count], key=lambda item: item["start"])
            for index, item in enumerate(ordered, 1):
                item["id"] = index
                item["time"] = f"{seconds_to_stamp(item['start'])} - {seconds_to_stamp(item['end'])}"
                item["duration"] = round(float(item["end"]) - float(item["start"]), 2)
            emit(
                "log",
                message=(
                    f"AI moment selector aktif: {len(ordered)} clip dipilih oleh {ai_provider_name(payload.get('providerType'))} "
                    f"dari {len(batches)} batch; reviewer={'aktif' if reviewer_used else 'fallback primary'}; "
                    f"batch_gagal={len(failed_batches)}"
                ),
            )
            return ordered

        # A strict automatic threshold must not make reviewed, evidence-backed
        # candidates disappear. Keep them in the manual-review lane without
        # raising their score or making them eligible for automatic rendering.
        reviewed_optional = [
            candidate
            for candidate in validated_candidates
            if candidate.get("reviewer_status") != "rejected"
            and bool(candidate.get("ai_evidence_gate"))
            and clamp_score(candidate.get("score"), 0) >= 60
        ]
        transcript_duration = max(
            [
                float(item.get("end") or 0.0)
                for item in (transcript or [])
                if isinstance(item, dict)
            ]
            or [0.0]
        )
        manual_fallback = select_review_fallback_moments(
            reviewed_optional,
            target_count,
            transcript_duration,
        )
        if manual_fallback:
            emit(
                "log",
                message=(
                    f"Tidak ada kandidat AI score {minimum_ai_score}+ untuk auto-render. "
                    f"{len(manual_fallback)} kandidat yang sudah direview tetap ditampilkan sebagai Optional tanpa menaikkan score."
                ),
            )
            return manual_fallback
    except Exception as exc:
        emit("log", message=f"AI moment selector gagal: {exc}. Fallback local ranking dipakai.")
    return []


def revise_moments_with_ai(moments, payload):
    if not moments or payload.get("providerType") == "local" or not is_ai_feature_enabled(payload, "title"):
        return moments

    sample = []
    for idx, item in enumerate(moments[: min(8, len(moments))]):
        sample.append(
            {
                "id": idx + 1,
                "score": item.get("score"),
                "category": item.get("category"),
                "title": item.get("titleSuggestion") or item.get("title"),
                "hook": item.get("hook"),
                "text": compact_text_for_ai(item.get("transcript") or item.get("text") or item.get("title") or "", 420),
            }
        )
    video_type, profile_rule, source_title = content_profile_prompt_rules(payload.get("_contentProfile"))
    prompt = (
        "Rewrite title dan hook untuk clip pendek agar lebih SEO/FYP tapi tetap relevan dengan transcript.\n"
        f"Profil video: {video_type}. Judul sumber: {source_title or '-'}.\n"
        f"Aturan domain: {profile_rule}\n"
        "Rules: Bahasa Indonesia natural, tanpa emoji, tanpa hashtag. Title 4-9 kata, hook 6-10 kata, jangan bohong.\n"
        "Hook wajib berupa kalimat utuh yang bisa berdiri sendiri, tanpa filler ucapan seperti ee/eee/emm/anu, "
        "dan harus membawa pertanyaan, kejutan, konflik, perubahan, atau janji payoff yang memang ada di transcript.\n"
        "Setiap clip wajib memiliki sudut spesifik yang berbeda; jangan mengulang pola judul atau hook antar clip.\n"
        "Balas hanya JSON array: [{\"id\":1,\"title\":\"...\",\"hook\":\"...\"}]\n"
        f"Segments: {json_dumps(sample)}"
    )
    try:
        result = provider_request(payload, prompt, module="Title Generator")
        items = parse_ai_refined_moment_metadata(result.get("response") or "")
        if items:
            by_id = {int(item.get("id") or index + 1): item for index, item in enumerate(items)}
            for index, moment in enumerate(moments[: len(items)]):
                item = by_id.get(index + 1) or items[index]
                raw_text = moment.get("transcript") or moment.get("text") or moment.get("title") or ""
                text = profile_source_text(raw_text, payload)
                if item.get("title"):
                    title = seo_clean_title(item.get("title"), pick_best_title(content_aware_local_title_candidates(raw_text, payload, index + 1), text, index + 1))
                    if not is_generic_template(title) and relevance_ok(title, text, EDITORIAL_MIN_OVERLAP):
                        moment["titleSuggestion"] = title
                        moment["title"] = title
                if item.get("hook"):
                    hook = seo_clean_title(item.get("hook"), pick_best_hook(content_aware_local_hook_candidates(raw_text, payload), text))
                    if len(hook.split()) <= 12 and not is_generic_template(hook) and relevance_ok(hook, text, EDITORIAL_MIN_OVERLAP):
                        moment["hook"] = hook
            emit("log", message=f"AI highlight refinement berhasil, provider={ai_provider_name(payload.get('providerType'))}")
    except Exception as exc:
        emit("log", message=f"AI highlight refinement gagal: {exc}. Fallback local heuristic aktif.")
    return moments


def parse_duration_target(value):
    if not value:
        return 35, 50
    numbers = [int(item) for item in re.findall(r"\d+", str(value))]
    if len(numbers) >= 2:
        return numbers[0], numbers[1]
    if len(numbers) == 1:
        return max(10, numbers[0] - 8), numbers[0] + 8
    return 35, 50


def parse_duration_settings(payload):
    try:
        minimum = float(payload.get("minDuration") or 30)
        target = float(payload.get("targetDuration") or 75)
        maximum = float(payload.get("maxDuration") or 180)
    except Exception:
        minimum, target, maximum = 30.0, 75.0, 180.0
    if not payload.get("minDuration") and not payload.get("targetDuration") and not payload.get("maxDuration"):
        legacy_min, legacy_max = parse_duration_target(payload.get("durationTarget"))
        minimum = float(legacy_min)
        maximum = float(legacy_max)
        target = min(max((minimum + maximum) / 2, minimum), maximum)
    minimum = max(20.0, min(minimum, 180.0))
    maximum = max(minimum, min(maximum, 180.0))
    target = max(minimum, min(target, maximum))
    return minimum, target, maximum


def parse_timeline_ranges(payload, video_duration=0):
    mode = str(payload.get("selectionMode") or "full").lower()
    video_duration = max(0.0, float(video_duration or 0.0))
    ranges = []

    def add_range(start_value, end_value):
        try:
            start = float(start_value)
        except Exception:
            start = timestamp_to_seconds(str(start_value or "0"))
        try:
            end = float(end_value)
        except Exception:
            end = timestamp_to_seconds(str(end_value or "0")) if str(end_value or "").strip() else video_duration
        if video_duration:
            start = max(0.0, min(start, video_duration))
            end = max(0.0, min(end, video_duration))
        if end > start:
            ranges.append((float(start), float(end)))

    if mode == "range":
        provided = payload.get("analysisRanges")
        if isinstance(provided, list) and provided:
            first = provided[0]
            if isinstance(first, (list, tuple)) and len(first) >= 2:
                add_range(first[0], first[1])
            elif isinstance(first, dict):
                add_range(first.get("start"), first.get("end"))
        else:
            add_range(payload.get("rangeStart"), payload.get("rangeEnd"))
    elif mode == "multiple":
        provided = payload.get("analysisRanges")
        if isinstance(provided, list) and provided:
            for item in provided:
                if isinstance(item, (list, tuple)) and len(item) >= 2:
                    add_range(item[0], item[1])
                elif isinstance(item, dict):
                    add_range(item.get("start"), item.get("end"))
        else:
            raw = str(payload.get("multipleRanges") or "")
            for item in re.split(r"[\n,]+", raw):
                item = item.strip()
                if not item or "-" not in item:
                    continue
                left, right = item.split("-", 1)
                add_range(left.strip(), right.strip())

    merged = []
    for start, end in sorted(ranges):
        if not merged or start > merged[-1][1]:
            merged.append([start, end])
        else:
            merged[-1][1] = max(merged[-1][1], end)
    return [(round(start, 2), round(end, 2)) for start, end in merged]


def interval_overlaps_ranges(start, end, ranges, minimum_overlap=0.001):
    if not ranges:
        return True
    start = float(start or 0.0)
    end = float(end or start)
    if end <= start:
        return False
    return any(
        max(0.0, min(end, range_end) - max(start, range_start)) >= float(minimum_overlap)
        for range_start, range_end in ranges
    )


def clamp_interval_to_ranges(start, end, ranges):
    start = float(start or 0.0)
    end = float(end or start)
    if not ranges:
        return (start, end) if end > start else None
    overlaps = []
    for range_start, range_end in ranges:
        clipped_start = max(start, float(range_start))
        clipped_end = min(end, float(range_end))
        overlap = clipped_end - clipped_start
        if overlap > 0:
            overlaps.append((overlap, clipped_start, clipped_end))
    if not overlaps:
        return None
    _overlap, clipped_start, clipped_end = max(overlaps, key=lambda item: item[0])
    return round(clipped_start, 3), round(clipped_end, 3)


def candidate_in_ranges(start, end, ranges):
    if not ranges:
        return True
    start = float(start or 0.0)
    end = float(end or start)
    return any(
        start >= float(range_start) - 0.01 and end <= float(range_end) + 0.01
        for range_start, range_end in ranges
    )


def filter_transcript_by_ranges(transcript, ranges):
    if not ranges:
        return transcript or []
    filtered = []
    for segment in transcript or []:
        try:
            seg_start = float(segment.get("start") or 0.0)
            seg_end = float(segment.get("end") or seg_start)
        except Exception:
            continue
        for range_start, range_end in ranges:
            clipped_start = max(seg_start, float(range_start))
            clipped_end = min(seg_end, float(range_end))
            if clipped_end <= clipped_start:
                continue
            clipped = dict(segment)
            clipped["start"] = clipped_start
            clipped["end"] = clipped_end
            words = []
            for word in segment.get("words") or []:
                try:
                    word_start = float(word.get("start") or 0.0)
                    word_end = float(word.get("end") or word_start)
                except Exception:
                    continue
                if word_end <= clipped_start or word_start >= clipped_end:
                    continue
                words.append(
                    {
                        **word,
                        "start": max(clipped_start, word_start),
                        "end": min(clipped_end, word_end),
                    }
                )
            if words:
                clipped["words"] = words
                word_text = clean_text(" ".join(str(word.get("word") or "") for word in words))
                if word_text:
                    clipped["text"] = word_text
            filtered.append(clipped)
    return filtered


def analysis_duration_from_ranges(video_duration, ranges):
    if ranges:
        return sum(max(0.0, float(end) - float(start)) for start, end in ranges)
    return max(0.0, float(video_duration or 0.0))


def timeline_clip_capacity(video_duration, ranges, minimum_duration):
    minimum_duration = max(0.001, float(minimum_duration or 0.001))
    spans = ranges or [(0.0, max(0.0, float(video_duration or 0.0)))]
    return sum(
        max(0, int((max(0.0, float(end) - float(start)) + 1e-6) // minimum_duration))
        for start, end in spans
    )


def all_recommended_clips_requested(payload):
    """Return whether the creator requested every qualified recommendation.

    `clipCount=0` is intentionally a first-class wire contract. It means
    "all qualified", not "use a hidden default". The result remains bounded
    by the selected video timeline, duration rules, quality gates, and
    overlap/deduplication checks.
    """
    if bool_payload(payload, "allRecommendedClips", False):
        return True
    raw_value = payload.get("clipCount")
    if isinstance(raw_value, str) and raw_value.strip().lower() in {"all", "all-qualified", "all_recommended"}:
        return True
    try:
        return float(raw_value) <= 0
    except Exception:
        return False


def configured_clip_limit(payload, default=20):
    raw_value = payload.get("clipCount")
    if raw_value is None or str(raw_value).strip() == "":
        return max(1, int(default))
    if all_recommended_clips_requested(payload):
        return 0
    try:
        configured_limit = int(float(raw_value))
    except Exception:
        configured_limit = default
    # There is deliberately no arbitrary UI cap. A positive number is a
    # creator's explicit request; quality and timeline capacity stay in force.
    return max(1, configured_limit)


def optional_review_limit(payload, target_count):
    if all_recommended_clips_requested(payload):
        return max(0, int(target_count or 0))
    return min(
        configured_clip_limit(payload),
        max(int(target_count) + 3, int(target_count) * 2),
    )


def resolve_target_clip_count(payload, effective_duration, transcript, minimum_duration, ranges=None):
    configured_limit = configured_clip_limit(payload)
    capacity = timeline_clip_capacity(effective_duration, ranges, minimum_duration)
    if all_recommended_clips_requested(payload):
        requested = capacity
    elif bool_payload(payload, "autoClipCount", False):
        requested = min(configured_limit, auto_target_clip_count(effective_duration, transcript))
    else:
        requested = configured_limit
    return max(0, min(requested, capacity))


def enforce_moments_in_timeline_ranges(moments, ranges, transcript, minimum_duration=0.0):
    if not ranges:
        return list(moments or [])
    validated = []
    for moment in moments or []:
        clipped = clamp_interval_to_ranges(moment.get("start"), moment.get("end"), ranges)
        if not clipped:
            continue
        start, end = clipped
        if end - start < float(minimum_duration or 0.0):
            continue
        next_moment = dict(moment)
        next_moment["start"] = round(start, 2)
        next_moment["end"] = round(end, 2)
        next_moment["duration"] = round(end - start, 2)
        next_moment["time"] = f"{seconds_to_stamp(start)} - {seconds_to_stamp(end)}"
        clipped_text = transcript_text_between(transcript, start, end)
        if clipped_text:
            next_moment["text"] = clipped_text
            next_moment["transcript"] = clipped_text[:700]
        validated.append(next_moment)
    for index, moment in enumerate(validated, 1):
        moment["id"] = index
    return validated


def subtitle_language_options(info):
    options = []
    seen = set()
    label_map = {
        "id": "Indonesian",
        "id-id": "Indonesian",
        "en": "English",
        "en-us": "English",
        "en-orig": "English",
    }

    def add_options(pool, kind):
        for key in sorted((pool or {}).keys()):
            normalized = key.lower()
            if key in seen:
                continue
            seen.add(key)
            base = label_map.get(normalized, key)
            label = f"Auto-generated {base}" if kind == "auto" else base
            options.append({"value": key, "label": label, "kind": kind})

    add_options(info.get("subtitles") or {}, "manual")
    add_options(info.get("automatic_captions") or {}, "auto")
    return options


def clean_text(text):
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"&lt;", "<", text)
    text = re.sub(r"&gt;", ">", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def timestamp_to_seconds(value):
    value = value.strip().replace(",", ".")
    parts = value.split(":")
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
        if len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
        return float(parts[0])
    except ValueError:
        return 0.0


def clamp_interval_to_duration(start, end, duration, minimum_duration=0.0):
    """Clamp a media interval to the real source duration.

    When a minimum is requested and enough source remains, move the start
    backwards instead of extending the end beyond the source.
    """
    duration = max(0.0, float(duration or 0.0))
    start = max(0.0, min(float(start or 0.0), duration))
    end = max(start, min(float(end or start), duration))
    minimum_duration = max(0.0, float(minimum_duration or 0.0))
    if minimum_duration and duration >= minimum_duration and end - start < minimum_duration:
        start = max(0.0, min(start, duration - minimum_duration))
        end = min(duration, max(end, start + minimum_duration))
    return start, end


def merge_rolling_caption_segments(segments):
    """Collapse YouTube rolling-caption cues into non-cumulative phrases."""
    merged = []
    for source in sorted(segments or [], key=lambda item: (float(item.get("start") or 0), float(item.get("end") or 0))):
        text = clean_text(source.get("text") or "")
        start = float(source.get("start") or 0.0)
        end = float(source.get("end") or start)
        if not text or end <= start:
            continue
        item = {"start": start, "end": end, "text": text}
        if not merged or start > float(merged[-1]["end"]) + 0.12:
            merged.append(item)
            continue

        previous = merged[-1]
        left = clean_text(previous["text"]).split()
        right = text.split()
        left_keys = [re.sub(r"[^\w'-]", "", token.lower(), flags=re.UNICODE) for token in left]
        right_keys = [re.sub(r"[^\w'-]", "", token.lower(), flags=re.UNICODE) for token in right]
        overlap = 0
        for size in range(min(len(left_keys), len(right_keys)), 0, -1):
            if left_keys[-size:] == right_keys[:size]:
                overlap = size
                break
        micro_cue = (float(previous["end"]) - float(previous["start"]) < 0.08) or (end - start < 0.08)
        if overlap >= 2 or (overlap >= 1 and micro_cue):
            previous["text"] = clean_text(" ".join(left + right[overlap:]))
            previous["end"] = max(float(previous["end"]), end)
            continue
        merged.append(item)
    return merged


def parse_vtt(text):
    segments = []
    current_time = None
    current_lines = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line == "WEBVTT" or line.startswith("Kind:") or line.startswith("Language:"):
            if current_time and current_lines:
                segments.append(
                    {
                        "start": current_time[0],
                        "end": current_time[1],
                        "text": clean_text(" ".join(current_lines)),
                    }
                )
            current_time = None
            current_lines = []
            continue
        if "-->" in line:
            if current_time and current_lines:
                segments.append(
                    {
                        "start": current_time[0],
                        "end": current_time[1],
                        "text": clean_text(" ".join(current_lines)),
                    }
                )
            start_raw, end_raw = line.split("-->", 1)
            end_raw = end_raw.split()[0]
            current_time = (timestamp_to_seconds(start_raw), timestamp_to_seconds(end_raw))
            current_lines = []
        elif current_time:
            current_lines.append(line)
    if current_time and current_lines:
        segments.append(
            {
                "start": current_time[0],
                "end": current_time[1],
                "text": clean_text(" ".join(current_lines)),
            }
        )
    deduped = []
    seen = set()
    for item in segments:
        key = (round(item["start"], 1), item["text"])
        if item["text"] and key not in seen:
            seen.add(key)
            deduped.append(item)
    return merge_rolling_caption_segments(deduped)


def pick_caption_track(info, preferred_lang):
    preferred = (preferred_lang or "id").split("-")[0].lower()
    pools = [info.get("subtitles") or {}, info.get("automatic_captions") or {}]
    language_order = [preferred, "id", "en"]
    for pool in pools:
        for language in language_order:
            for key, tracks in pool.items():
                if key.lower().startswith(language) and tracks:
                    vtt = next((item for item in tracks if item.get("ext") == "vtt"), tracks[0])
                    return key, vtt.get("url")
    for pool in pools:
        for key, tracks in pool.items():
            if tracks:
                vtt = next((item for item in tracks if item.get("ext") == "vtt"), tracks[0])
                return key, vtt.get("url")
    return None, None


def fetch_transcript(info, preferred_lang):
    language, url = pick_caption_track(info, preferred_lang)
    if not url:
        return language, []
    text = fetch_https_bytes_with_retry(
        url,
        timeout=30,
        attempts=3,
        stage="subtitle",
        label="Subtitle YouTube",
    ).decode("utf-8", errors="replace")
    return language, parse_vtt(text)


def enrich_transcript_speakers(transcript):
    if not transcript:
        return []
    if SpeakerEngine is None:
        return transcript
    try:
        return SpeakerEngine().assign_transcript_speakers(transcript)
    except Exception as exc:
        emit("log", stage="speaker", message=f"Speaker heuristic dilewati: {exc}")
        return transcript


def seconds_to_stamp(seconds):
    seconds = max(0, int(seconds))
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


def normalize_words(text):
    return [word for word in re.findall(r"\w+", str(text).lower()) if len(word) > 1]


def text_similarity(a, b):
    a_words = set(normalize_words(a))
    b_words = set(normalize_words(b))
    if not a_words or not b_words:
        return 0.0
    return len(a_words & b_words) / len(a_words | b_words)


def overlap_ratio(a, b):
    start = max(a["start"], b["start"])
    end = min(a["end"], b["end"])
    if end <= start:
        return 0.0
    intersection = end - start
    union = max(a["end"], b["end"]) - min(a["start"], b["start"])
    return intersection / union


def overlap_portion(a, b):
    start = max(a["start"], b["start"])
    end = min(a["end"], b["end"])
    if end <= start:
        return 0.0
    intersection = end - start
    shortest = min(max(a["end"] - a["start"], 1), max(b["end"] - b["start"], 1))
    return intersection / shortest


def has_timeline_overlap(a, b, tolerance=0.35):
    start = max(float(a.get("start") or 0), float(b.get("start") or 0))
    end = min(float(a.get("end") or 0), float(b.get("end") or 0))
    return (end - start) > float(tolerance)


def overlaps_any(candidate, selected, tolerance=0.35):
    return any(has_timeline_overlap(candidate, previous, tolerance=tolerance) for previous in selected)


def build_exclusion_windows(selected):
    windows = []
    for moment in selected:
        radius = max(4, min(14, moment["duration"] * 0.32))
        windows.append(
            {
                "start": max(0, moment["start"] - radius),
                "end": moment["end"] + radius,
            }
        )
    return windows


def is_in_exclusion(candidate, exclusion_windows):
    for window in exclusion_windows:
        overlap = max(0, min(candidate["end"], window["end"]) - max(candidate["start"], window["start"]))
        if overlap / max(candidate["duration"], 1) > 0.2:
            return True
    return False


def choose_category(text, payload):
    lower = text.lower()
    categories = [
        ("Kontroversi", ["kontrovers", "debat", "berbeda", "konflik", "rusuh"]),
        ("Edukasi", ["cara", "tutorial", "belajar", "tips", "penjelasan", "prinsip"]),
        ("Komedi", ["lucu", "ketawa", "tertawa", "gak nyangka", "ngakak"]),
        ("Emosi", ["sedih", "marah", "tersentuh", "haru", "menangis"]),
        ("Inspirasi", ["motivasi", "inspirasi", "bangkit", "mimpi", "kejar"]),
        ("Storytelling", ["cerita", "kisah", "menceritakan", "tahun lalu", "dulu"]),
    ]
    for label, keywords in categories:
        if any(word in lower for word in keywords):
            return label
    if "random" in str(payload.get("scoreMode") or "").lower():
        return "Random Viral"
    if "hook" in str(payload.get("scoreMode") or "").lower():
        return "Hook"
    return "Insight"


def hook_strength(text):
    lower = text.lower()
    score = 0
    score += text.count("?") * 6
    score += text.count("!") * 3
    score += sum(1 for keyword in ["kenapa", "mengapa", "jangan", "dilarang", "rahasia", "trik", "terungkap", "rahasia"] if keyword in lower) * 5
    score += sum(1 for keyword in ["wow", "gila", "tidak percaya", "tidak nyangka", "kecewa", "paling"] if keyword in lower) * 4
    score += 6 if any(question in lower for question in ["kenapa", "mengapa", "apa", "bagaimana", "siapa", "kapan", "dimana"]) else 0
    score += 5 if any(word in lower for word in ["tawa", "ketawa", "haha", "lol"]) else 0
    score += 4 if any(word in lower for word in ["bertanya", "pertanyaan", "curiga", "serius"]) else 0
    return min(100, score)


def retention_score(text, duration, min_duration, max_duration):
    density = len(normalize_words(text)) / max(duration, 1)
    duration_bonus = duration_fit_score(duration, min_duration, (min_duration + max_duration) / 2, max_duration)
    return min(100, max(0, density * 6 + duration_bonus * 0.35))


def duration_fit_score(duration, min_duration, target_duration, max_duration):
    duration = float(duration or 0)
    min_duration = float(min_duration or 20)
    target_duration = float(target_duration or 75)
    max_duration = float(max_duration or 180)
    if duration < min_duration * 0.85:
        return bounded_score(45 - (min_duration - duration) * 0.6, 20, 62)
    if duration <= target_duration:
        return bounded_score(82 + (duration - min_duration) / max(target_duration - min_duration, 1) * 13, 72, 95)
    if duration <= max_duration:
        # Longer clips are fine when the story needs room, but we taper the bonus
        # so short punchy moments still win when quality is equal.
        return bounded_score(95 - (duration - target_duration) / max(max_duration - target_duration, 1) * 13, 78, 95)
    return bounded_score(58 - (duration - max_duration) * 0.25, 25, 72)


def story_quality(text):
    lower = text.lower()
    connectors = sum(1 for keyword in ["lalu", "kemudian", "selanjutnya", "setelah", "sebelum", "akhirnya", "karena", "jadi"] if keyword in lower)
    structure = 5 if any(punct in text for punct in [".", "?", "!"]) else 0
    return min(100, connectors * 8 + structure * 10)


def emotion_score(text):
    lower = text.lower()
    return min(100, sum(1 for keyword in ["sedih", "marah", "senang", "terharu", "gugup", "takut", "bangga", "terkejut", "kecewa"] if keyword in lower) * 8)


def shareability_score(text):
    lower = text.lower()
    return min(100, sum(1 for keyword in ["viral", "rahasia", "terungkap", "terbaik", "mustahil", "wow", "gila"] if keyword in lower) * 9)


def bounded_score(value, floor=0, ceiling=100):
    try:
        return int(max(floor, min(ceiling, round(float(value)))))
    except Exception:
        return int(floor)


def keyword_hits(lower_text, keywords):
    return sum(1 for keyword in keywords if keyword in lower_text)


def keyword_occurrences(lower_text, keywords):
    return sum(len(re.findall(rf"(?<!\w){re.escape(keyword)}(?!\w)", lower_text)) for keyword in keywords)


def keyword_score(lower_text, weighted_keywords):
    score = 0
    for keyword, weight in weighted_keywords:
        if re.search(rf"(?<!\w){re.escape(keyword)}(?!\w)", lower_text):
            score += weight
    return score


def punctuation_energy(text):
    text = str(text or "")
    return min(18, text.count("?") * 5 + text.count("!") * 4 + len(re.findall(r"\b(ha+|wkwk+|hehe+|haha+)\b", text.lower())) * 6)


def dialogue_intensity_score(lower_text, words, duration):
    pronouns = keyword_occurrences(
        lower_text,
        ["gue", "gua", "aku", "saya", "lu", "lo", "kamu", "dia", "kita", "mereka"],
    )
    speech_verbs = keyword_occurrences(
        lower_text,
        ["bilang", "ngomong", "jawab", "tanya", "nanya", "respon", "reaksi", "debat", "sahut"],
    )
    turn_markers = keyword_occurrences(lower_text, ["nah", "tapi", "kok", "masa", "emang"])
    density = len(words) / max(float(duration or 1), 1.0)
    # Normalize evidence to a 45 second window. Long clips used to collect
    # enough pronouns to report Dialogue 99 even when the conversation was
    # repetitive and low energy.
    duration_scale = min(1.0, 45.0 / max(float(duration or 1), 1.0))
    evidence = pronouns * 1.35 + speech_verbs * 4.2 + turn_markers * 2.5
    density_fit = max(0.0, 18.0 - abs(density - 2.15) * 11.0)
    return bounded_score(26 + evidence * duration_scale + density_fit, 20, 94)


def emotion_intensity_score(lower_text, raw_text):
    emotion_words = [
        ("ketawa", 9), ("ngakak", 11), ("lucu", 8), ("kocak", 8), ("sedih", 9),
        ("marah", 10), ("takut", 9), ("merinding", 12), ("kaget", 10), ("panik", 9),
        ("haru", 8), ("nangis", 10), ("kesal", 8), ("malu", 7), ("senang", 6),
        ("diam", 6), ("hening", 8), ("serius", 7), ("parah", 8), ("gila", 9),
        ("wah", 6), ("astaga", 9), ("anjir", 8), ("kasihan", 8), ("kecewa", 9),
    ]
    return bounded_score(24 + keyword_score(lower_text, emotion_words) + punctuation_energy(raw_text), 20, 96)


def surprise_score(lower_text, raw_text):
    surprise_words = [
        ("ternyata", 14), ("kok", 9), ("masa", 8), ("nggak nyangka", 16),
        ("enggak nyangka", 16), ("gak nyangka", 16), ("baru tahu", 14),
        ("aneh", 10), ("rahasia", 11), ("terungkap", 12), ("mendadak", 10),
        ("tiba-tiba", 10), ("langsung", 6), ("diam", 7), ("hening", 9),
    ]
    return bounded_score(23 + keyword_score(lower_text, surprise_words) + min(12, raw_text.count("?") * 4), 20, 96)


def knowledge_value_score(lower_text, words):
    value_words = [
        ("cara", 12), ("tips", 11), ("strategi", 12), ("alasan", 10), ("kenapa", 10),
        ("solusi", 11), ("pelajaran", 10), ("belajar", 9), ("fakta", 10),
        ("data", 8), ("contoh", 8), ("langkah", 10), ("penting", 9), ("harus", 6),
        ("jangan", 8), ("kesimpulan", 10), ("makna", 8), ("prinsip", 9),
    ]
    specificity = min(14, len({word for word in words if len(word) >= 6}) * 0.7)
    return bounded_score(26 + keyword_score(lower_text, value_words) + specificity, 20, 96)


def conflict_score_from_text(lower_text):
    conflict_words = [
        ("konflik", 13), ("ribut", 12), ("debat", 12), ("ditolak", 13), ("masalah", 9),
        ("marah", 10), ("salah", 7), ("bohong", 10), ("curiga", 9), ("takut", 8),
        ("bullying", 13), ("musuh", 10), ("benci", 10), ("terancam", 11),
        ("nggak setuju", 11), ("gak setuju", 11), ("aneh", 7), ("kontroversi", 12),
    ]
    return bounded_score(22 + keyword_score(lower_text, conflict_words), 20, 96)


STRONG_PAYOFF_MARKERS = [
    "akhirnya",
    "akhire",
    "ternyata",
    "nyatane",
    "makanya",
    "mulane",
    "kesimpulannya",
    "kesimpulan",
    "intinya",
    "intine",
    "jawabannya",
    "jawabane",
    "hasilnya",
    "hasile",
    "solusinya",
    "akibatnya",
    "karena itu",
    "sejak itu",
]

RESOLUTION_MARKERS = [
    "berhasil",
    "terbukti",
    "terjawab",
    "selesai",
    "memutuskan",
    "diputuskan",
    "memilih",
    "dipilih",
    "menang",
    "kalah",
    "ketemu",
    "menemukan",
    "sadar",
    "paham",
    "berubah",
]


def highlight_evidence_quality(text):
    """Measure transcript evidence without trusting provider-assigned scores."""
    cleaned = clean_text(text)
    lower = cleaned.lower()
    words = normalize_words(cleaned)
    first_words = " ".join(words[:28])
    last_words = " ".join(words[-32:])
    specific_count = len(extract_specific_terms(cleaned, 10))
    curiosity_hits = keyword_hits(
        first_words,
        [
            "kenapa",
            "kok",
            "ngapa",
            "gimana",
            "bagaimana",
            "siapa",
            "sapa",
            "ternyata",
            "rahasia",
            "aneh",
            "serius",
            "masa",
        ],
    )
    question_signal = cleaned[:220].count("?") + keyword_hits(
        first_words,
        ["apa", "kenapa", "ngapa", "bagaimana", "gimana", "siapa", "sapa"],
    )
    strong_payoff_hits = keyword_hits(last_words, STRONG_PAYOFF_MARKERS)
    resolution_hits = keyword_hits(last_words, RESOLUTION_MARKERS)
    answer_signal = keyword_hits(
        last_words,
        ["jawab", "sebabnya", "alasannya", "yang benar", "yang terjadi", "terbukti"],
    )
    opening_text = re.sub(r"^(?:\s*\[[^\]]+\]\s*)+", "", cleaned).strip() or cleaned
    opening_lower = opening_text.lower()
    opening_words = normalize_words(opening_text)
    leading_word = opening_words[0] if opening_words else ""
    opening_sentence = re.split(r"[.!?…]", opening_text, maxsplit=1)[0].strip()
    opening_sentence_words = normalize_words(opening_sentence)
    connector_start = bool(
        re.match(
            r"^(dan|atau|yang|karena|terus|lalu|tapi|kalau|soalnya|padahal)\b",
            opening_lower,
        )
    )
    dependent_openers = {
        "sama", "kan", "apalagi", "bahkan", "sementara", "kemudian",
        "padahal", "sehingga", "sedangkan", "malah", "juga",
    }
    first_alpha = next((character for character in opening_text if character.isalpha()), "")
    lowercase_fragment = (
        bool(first_alpha)
        and first_alpha.islower()
        and any(character.isupper() for character in opening_text[1:])
    )
    vague_opening_terms = {
        "oke", "ok", "iya", "ya", "nah", "jadi", "terus", "itu", "ini",
        "aja", "saja", "jawaban", "gitu", "begitu", "saya", "aku", "gue",
        "gua", "kita", "dia", "mereka", "beliau", "tadi", "tersebut",
    }
    opening_topic_terms = [
        word
        for word in opening_sentence_words[:24]
        if len(word) >= 5 and word not in vague_opening_terms
    ]
    opening_question_signal = (
        opening_sentence.count("?")
        + keyword_hits(
            " ".join(opening_sentence_words[:24]),
            ["apa", "kenapa", "ngapa", "bagaimana", "gimana", "siapa", "sapa"],
        )
    )
    opening_context_clear = (
        opening_question_signal > 0
        or len(set(opening_topic_terms)) >= 2
    )
    generic_acknowledgement = bool(
        re.match(r"^(oke|ok|iya|ya|nah|jadi|terus)\b", opening_lower)
    )
    generic_opening_unresolved = (
        generic_acknowledgement and not opening_context_clear
    )
    context_dependent_start = (
        (connector_start and not opening_context_clear)
        or (leading_word in dependent_openers and not opening_context_clear)
        or lowercase_fragment
        or generic_opening_unresolved
    )
    dangling_start = context_dependent_start
    dangling_end = bool(
        words
        and words[-1]
        in {
            "dan",
            "atau",
            "yang",
            "karena",
            "terus",
            "lalu",
            "tapi",
            "kalau",
            "soalnya",
            "dengan",
        }
    )
    generic_opening = bool(
        re.match(r"^(jadi|nah|terus|oke|ok|iya|ya|aku|saya|gue|gua|kita|ini|itu)\b", opening_lower)
    )
    trigrams = [
        tuple(words[index : index + 3])
        for index in range(max(0, len(words) - 2))
    ]
    repetition_ratio = (
        max(0.0, 1.0 - len(set(trigrams)) / max(1, len(trigrams)))
        if trigrams
        else 0.0
    )
    clean_end = bool(re.search(r"[.!?…]$", cleaned))

    hook_evidence = (
        28
        + min(20, curiosity_hits * 8)
        + min(18, question_signal * 7)
        + min(18, specific_count * 2)
    )
    if generic_opening:
        hook_evidence -= 10
    if dangling_start:
        hook_evidence -= 12
    if repetition_ratio > 0.32:
        hook_evidence -= min(18, (repetition_ratio - 0.32) * 50)

    payoff_evidence = (
        24
        + min(42, strong_payoff_hits * 14)
        + min(24, resolution_hits * 8)
        + min(12, answer_signal * 6)
        + (4 if clean_end else 0)
    )
    if question_signal and (strong_payoff_hits or resolution_hits or answer_signal):
        payoff_evidence += 8
    if not strong_payoff_hits and not resolution_hits and not answer_signal:
        payoff_evidence = min(payoff_evidence, 46)
    if dangling_end:
        payoff_evidence -= 16
    if repetition_ratio > 0.38:
        payoff_evidence -= min(16, (repetition_ratio - 0.38) * 42)

    return {
        "hook_evidence": bounded_score(hook_evidence, 20, 94),
        "payoff_evidence": bounded_score(payoff_evidence, 20, 94),
        "specificity_count": specific_count,
        "strong_payoff_hits": strong_payoff_hits,
        "resolution_hits": resolution_hits,
        "question_signal": question_signal,
        "repetition_ratio": round(repetition_ratio, 4),
        "generic_opening": generic_opening,
        "generic_opening_unresolved": generic_opening_unresolved,
        "opening_topic_anchor_count": len(set(opening_topic_terms)),
        "opening_context_clear": opening_context_clear,
        "context_dependent_start": context_dependent_start,
        "dangling_start": dangling_start,
        "dangling_end": dangling_end,
        "clean_end": clean_end,
    }


def payoff_depth_score(lower_text, words, raw_text):
    evidence = highlight_evidence_quality(raw_text)
    return evidence["payoff_evidence"]


def editor_retention_predictor(metrics, filler_ratio=0.0):
    score = (
        metrics.get("hook", 0) * 0.20
        + metrics.get("surprise", 0) * 0.08
        + metrics.get("emotion", 0) * 0.08
        + metrics.get("dialogue", 0) * 0.08
        + metrics.get("payoff", 0) * 0.20
        + metrics.get("story_complete", 0) * 0.20
        + metrics.get("duration_fit", 0) * 0.10
        + metrics.get("flow", 0) * 0.06
    )
    if filler_ratio > 0.08:
        score -= min(16, (filler_ratio - 0.08) * 100)
    return bounded_score(score, 35, 99)


def editor_scene_metrics(text, duration, min_duration, max_duration, index=0):
    """
    Local editor brain for Shorts/Reels/TikTok style scene selection.
    The goal is not to fake AI scores, but to approximate what a human editor
    notices: hook, conversation flow, value, emotion, trend potential, and a
    clean beginning/ending.
    """
    text = clean_text(text)
    lower = text.lower()
    words = normalize_words(text)
    word_count = len(words)
    duration = max(1.0, float(duration or 1.0))
    density = word_count / duration
    opening_text = " ".join(clean_text(text).split()[:36])
    opening_lower = opening_text.lower()
    first_words = " ".join(words[:24])
    last_words = " ".join(words[-24:])
    sentence_count = max(1, len([part for part in re.split(r"[.!?]+", text) if part.strip()]))

    curiosity = keyword_hits(
        opening_lower,
        [
            "kenapa", "kok", "gimana", "bagaimana", "apa", "siapa", "ternyata", "tapi",
            "padahal", "bayangin", "coba", "jangan", "rahasia", "aneh", "gila",
            "serius", "kaget", "masa", "bener", "nggak nyangka", "enggak nyangka",
        ],
    )
    hook = 34 + curiosity * 8 + min(18, opening_text.count("?") * 7 + opening_text.count("!") * 3)
    if any(word in first_words for word in ["tapi", "kenapa", "kok", "gimana", "jangan", "ternyata", "bayangin"]):
        hook += 10

    connector_hits = keyword_hits(
        lower,
        ["jadi", "karena", "terus", "lalu", "akhirnya", "tapi", "makanya", "nah", "setelah", "sebelum"],
    )
    flow = 50 + min(28, connector_hits * 5) + min(14, sentence_count * 2) + min(12, max(0, density - 1.2) * 8)
    target_duration = (float(min_duration) + float(max_duration)) / 2
    duration_score = duration_fit_score(duration, min_duration, target_duration, max_duration)
    if duration < min_duration * 0.9 or duration > max_duration * 1.08:
        flow -= 12

    value_hits = keyword_hits(
        lower,
        [
            "cara", "tips", "strategi", "pelajaran", "belajar", "solusi", "alasan", "makna",
            "penting", "harus", "jangan", "bisa", "contoh", "masalah", "jawaban",
        ],
    )
    value = 46 + value_hits * 8 + min(16, max(0, word_count - 35) * 0.35)

    emotion = emotion_intensity_score(lower, text)

    trend_hits = keyword_hits(
        lower,
        [
            "viral", "trend", "bullying", "sekolah", "teman", "keluarga", "uang", "cinta",
            "kerja", "bisnis", "konten", "youtube", "tiktok", "facebook", "sosial",
        ],
    )
    trend = 44 + trend_hits * 7 + min(12, curiosity * 2)

    conversation = dialogue_intensity_score(lower, words, duration)
    surprise = surprise_score(lower, text)
    knowledge = knowledge_value_score(lower, words)
    conflict = conflict_score_from_text(lower)
    evidence_quality = highlight_evidence_quality(text)
    payoff = payoff_depth_score(lower, words, text)

    cut_quality = 58
    if text and text[0].islower():
        cut_quality -= 8
    if word_count < 18:
        cut_quality -= 12
    if word_count > 120:
        cut_quality -= 6
    if 0.95 <= duration / max(float(min_duration), 1.0) <= max_duration / max(float(min_duration), 1.0):
        cut_quality += 8

    novelty = 52 + min(24, len(set(words)) / max(word_count, 1) * 30) + min(8, curiosity * 2)
    story_complete, story_reasons = story_completeness_score(text, duration, min_duration, max_duration)
    hook = min(
        bounded_score(hook, 20, 96),
        bounded_score(evidence_quality["hook_evidence"] + 8, 20, 96),
    )
    metrics = {
        "hook": bounded_score(hook, 20, 96),
        "flow": bounded_score(flow, 20, 96),
        "value": bounded_score(value, 20, 96),
        "emotion": bounded_score(emotion, 20, 96),
        "surprise": bounded_score(surprise, 20, 96),
        "knowledge": bounded_score(knowledge, 20, 96),
        "conflict": bounded_score(conflict, 20, 96),
        "trend": bounded_score(trend, 20, 96),
        "conversation": bounded_score(conversation, 20, 96),
        "dialogue": bounded_score(conversation, 20, 96),
        "payoff": bounded_score(payoff, 20, 96),
        "cut": bounded_score(cut_quality, 25, 96),
        "novelty": bounded_score(novelty, 35, 96),
        "duration_fit": duration_score,
        "story_complete": story_complete,
        **evidence_quality,
    }
    filler = highlight_filler_ratio(text) if callable(highlight_filler_ratio) else 0.0
    metrics["filler_ratio"] = round(float(filler), 3)
    metrics["retention_predictor"] = editor_retention_predictor(metrics, filler)
    metrics["virality"] = bounded_score(
        metrics["hook"] * 0.22
        + metrics["surprise"] * 0.18
        + metrics["emotion"] * 0.16
        + metrics["conflict"] * 0.14
        + metrics["payoff"] * 0.14
        + metrics["trend"] * 0.10
        + metrics["novelty"] * 0.06,
        35,
        96,
    )
    metrics["editor_confidence"] = bounded_score(
        metrics["retention_predictor"] * 0.45
        + metrics["story_complete"] * 0.25
        + metrics["cut"] * 0.15
        + metrics["duration_fit"] * 0.15,
        35,
        96,
    )
    if callable(score_highlight_v2):
        weighted = score_highlight_v2(metrics)
    else:
        weighted = (
            metrics["hook"] * 0.17
            + metrics["emotion"] * 0.13
            + metrics["conflict"] * 0.11
            + metrics["surprise"] * 0.11
            + metrics["payoff"] * 0.16
            + metrics["story_complete"] * 0.14
            + metrics["retention_predictor"] * 0.12
            + metrics["duration_fit"] * 0.06
        )
    if filler > 0.08:
        weighted -= min(12, (filler - 0.08) * 85)
    if story_complete < 48:
        weighted -= 8
    if metrics["cut"] < 45:
        weighted -= 5
    if metrics["retention_predictor"] < 58:
        weighted -= 6
    if metrics["payoff"] < 52:
        weighted -= 5
    score = bounded_score(weighted, 25, 97)
    metrics["story_reasons"] = ", ".join(story_reasons[:3])
    return metrics, score


def score_grade(score):
    score = bounded_score(score, 0, 100)
    if score >= 92:
        return "A"
    if score >= 80:
        return "B"
    if score >= 70:
        return "C"
    if score >= 60:
        return "LOW"
    return "REJECT"


def score_priority(score):
    score = bounded_score(score, 0, 100)
    if score >= 90:
        return "A"
    if score >= 80:
        return "B"
    if score >= 70:
        return "C"
    if score >= 60:
        return "LOW"
    return "REJECT"


def content_weighted_highlight_score(metrics, video_type="general"):
    """Score a moment from observable evidence using a content-aware profile.

    Ranking may order candidates, but it must never manufacture score points.
    Keeping the weights and adjustments in the returned provenance makes every
    displayed score explainable in QA artifacts and the Moment AI UI.
    """
    video_type = str(video_type or "general").strip().lower()
    if video_type == "interview":
        video_type = "podcast"

    audio_variation = bounded_score(
        35 + float(metrics.get("audio_variation") or 0) * 6,
        20,
        96,
    )
    components = {
        "hook": bounded_score(metrics.get("hook"), 20, 96),
        "story": bounded_score(metrics.get("story_complete"), 20, 96),
        "payoff": bounded_score(metrics.get("payoff"), 20, 96),
        "retention": bounded_score(metrics.get("retention_predictor"), 20, 96),
        "emotion": bounded_score(metrics.get("emotion"), 20, 96),
        "conflict": bounded_score(metrics.get("conflict"), 20, 96),
        "surprise": bounded_score(metrics.get("surprise"), 20, 96),
        "dialogue": bounded_score(metrics.get("dialogue"), 20, 96),
        "value": bounded_score(metrics.get("value"), 20, 96),
        "knowledge": bounded_score(metrics.get("knowledge"), 20, 96),
        "novelty": bounded_score(metrics.get("novelty"), 20, 96),
        "visual": bounded_score(metrics.get("visual_activity"), 20, 96),
        "audio": bounded_score(metrics.get("audio_activity"), 20, 96),
        "audio_variation": audio_variation,
        "duration": bounded_score(metrics.get("duration_fit"), 20, 96),
        "cut": bounded_score(metrics.get("cut"), 20, 96),
    }
    profiles = {
        "music": {
            "audio": 0.24,
            "audio_variation": 0.12,
            "emotion": 0.14,
            "retention": 0.13,
            "visual": 0.10,
            "duration": 0.10,
            "hook": 0.09,
            "cut": 0.08,
        },
        "review": {
            "value": 0.18,
            "knowledge": 0.15,
            "hook": 0.13,
            "payoff": 0.15,
            "retention": 0.14,
            "story": 0.10,
            "cut": 0.08,
            "visual": 0.07,
        },
        "news": {
            "knowledge": 0.18,
            "value": 0.15,
            "story": 0.16,
            "payoff": 0.13,
            "retention": 0.13,
            "hook": 0.10,
            "cut": 0.08,
            "visual": 0.07,
        },
        "vlog": {
            "hook": 0.15,
            "emotion": 0.16,
            "novelty": 0.13,
            "visual": 0.13,
            "story": 0.12,
            "retention": 0.14,
            "payoff": 0.09,
            "cut": 0.08,
        },
        "storytelling": {
            "story": 0.20,
            "payoff": 0.18,
            "emotion": 0.15,
            "hook": 0.15,
            "retention": 0.15,
            "surprise": 0.10,
            "cut": 0.07,
        },
        "tutorial": {
            "value": 0.20,
            "knowledge": 0.18,
            "story": 0.14,
            "payoff": 0.16,
            "retention": 0.12,
            "hook": 0.10,
            "cut": 0.10,
        },
        "podcast": {
            "story": 0.18,
            "payoff": 0.17,
            "hook": 0.15,
            "retention": 0.15,
            "dialogue": 0.12,
            "emotion": 0.10,
            "cut": 0.08,
            "novelty": 0.05,
        },
        "gaming": {
            "visual": 0.18,
            "audio": 0.14,
            "surprise": 0.16,
            "emotion": 0.12,
            "retention": 0.16,
            "hook": 0.10,
            "cut": 0.08,
            "novelty": 0.06,
        },
        "general": {
            "hook": 0.16,
            "story": 0.16,
            "payoff": 0.16,
            "retention": 0.15,
            "emotion": 0.11,
            "value": 0.10,
            "cut": 0.08,
            "novelty": 0.08,
        },
    }
    weights = profiles.get(video_type, profiles["general"])
    base_score = sum(components[name] * weight for name, weight in weights.items())
    adjustments = []

    filler_ratio = max(0.0, float(metrics.get("filler_ratio") or 0))
    filler_limit = 0.35 if video_type == "music" else 0.14
    if filler_ratio > filler_limit:
        penalty = round(min(12.0, (filler_ratio - filler_limit) * 45.0), 2)
        base_score -= penalty
        adjustments.append({"reason": "excess_filler", "value": -penalty})

    if components["duration"] < 45:
        base_score -= 6
        adjustments.append({"reason": "poor_duration_fit", "value": -6})

    if video_type == "music":
        if components["audio"] < 50:
            base_score -= 8
            adjustments.append({"reason": "weak_audio_activity", "value": -8})
        if float(metrics.get("audio_variation") or 0) < 4:
            base_score -= 5
            adjustments.append({"reason": "flat_audio_dynamics", "value": -5})
    else:
        if components["story"] < 45:
            base_score -= 8
            adjustments.append({"reason": "weak_story_boundary", "value": -8})
        if components["payoff"] < 52:
            base_score -= 5
            adjustments.append({"reason": "weak_payoff", "value": -5})
        if (
            components["story"] >= 78
            and components["payoff"] >= 62
            and components["retention"] >= 60
        ):
            completeness_bonus = 8 if components["hook"] >= 58 else 4
            base_score += completeness_bonus
            adjustments.append(
                {
                    "reason": "verified_story_arc",
                    "value": completeness_bonus,
                }
            )

    score = bounded_score(base_score, 25, 97)
    provenance = {
        "mode": "content_evidence",
        "profile": video_type,
        "weights": weights,
        "components": {name: round(value, 2) for name, value in components.items()},
        "adjustments": adjustments,
        "final": score,
    }
    return score, provenance


def editor_reason(metrics):
    labels = [
        ("Hook", metrics.get("hook", 0)),
        ("Retention", metrics.get("retention_predictor", metrics.get("flow", 0))),
        ("Payoff", metrics.get("payoff", 0)),
        ("Surprise", metrics.get("surprise", 0)),
        ("Dialog", metrics.get("dialogue", metrics.get("conversation", 0))),
        ("Value", metrics.get("value", 0)),
        ("Viral", metrics.get("virality", metrics.get("trend", 0))),
    ]
    top = sorted(labels, key=lambda item: item[1], reverse=True)[:3]
    return "; ".join(f"{name} {value}" for name, value in top)


def story_completeness_score(text, duration, min_duration, max_duration):
    lower = clean_text(text).lower()
    words = normalize_words(lower)
    if not words:
        return 20, ["transcript kosong"]
    first_words = " ".join(words[:22])
    last_words = " ".join(words[-32:])
    evidence = highlight_evidence_quality(text)
    setup = bool(
        evidence["question_signal"]
        or keyword_hits(
            first_words,
            [
                "awalnya",
                "dulu",
                "waktu",
                "ketika",
                "masalahnya",
                "ceritanya",
                "kenapa",
                "kok",
                "bagaimana",
                "gimana",
            ],
        )
    )
    development = keyword_hits(
        lower,
        [
            "karena",
            "kemudian",
            "lalu",
            "setelah",
            "sebelum",
            "ketika",
            "sampai",
            "padahal",
            "tetapi",
            "tapi",
            "akhirnya",
            "jawab",
            "tanya",
        ],
    )
    payoff = evidence["payoff_evidence"] >= 52
    clean_end = evidence["clean_end"]
    duration_fit = min_duration * 0.85 <= float(duration or 0) <= max_duration * 1.08
    score = 26
    reasons = []
    if setup:
        score += 16
        reasons.append("setup jelas")
    if development:
        score += min(24, development * 6)
        reasons.append("alur berkembang")
    if payoff:
        score += 24
        reasons.append("ending punya payoff")
    if clean_end:
        score += 4
        reasons.append("ending rapi")
    if duration_fit:
        score += 6
        reasons.append("durasi pas")
    if evidence["dangling_start"]:
        score -= 14
        reasons.append("awal terasa menggantung")
    if evidence["dangling_end"]:
        score -= 16
        reasons.append("ending menggantung")
    if evidence["repetition_ratio"] > 0.38:
        score -= min(18, int((evidence["repetition_ratio"] - 0.38) * 55))
        reasons.append("transcript repetitif")
    if len(words) < 22:
        score -= 10
        reasons.append("konteks pendek")
    if not payoff:
        score = min(score, 66)
        reasons.append("payoff belum terbukti")
    if not setup:
        score = min(score, 72)
    if not setup and not payoff:
        score = min(score, 54)
    return bounded_score(score, 20, 96), reasons


def smart_boundary_start(start, transcript):
    if not transcript:
        return start
    boundary = start
    for item in transcript:
        if item["start"] <= start <= item["end"]:
            boundary = item["start"]
            break
        if 0 <= start - item["start"] <= 2:
            boundary = min(boundary, item["start"])
    return boundary


def smart_boundary_end(end, transcript):
    if not transcript:
        return end
    boundary = end
    for item in transcript:
        if item["start"] <= end <= item["end"]:
            boundary = item["end"]
            break
        if 0 <= item["end"] - end <= 2:
            boundary = max(boundary, item["end"])
    return boundary


def smart_boundary_end_in_range(preferred_end, transcript, minimum_end, maximum_end):
    """Choose a transcript boundary inside a valid clip-duration range.

    When a source segment is longer than the maximum clip duration, shifting
    the start forward to preserve the old end creates a mid-sentence opening.
    Prefer the nearest natural end boundary instead. A caller may still fall
    back to a strict timestamp when no usable transcript boundary exists.
    """
    try:
        preferred = float(preferred_end)
        minimum = float(minimum_end)
        maximum = float(maximum_end)
    except (TypeError, ValueError):
        return float(preferred_end or 0.0)
    if maximum < minimum:
        maximum = minimum
    candidates = []
    for item in transcript or []:
        try:
            segment_end = float(item.get("end") or 0.0)
        except (AttributeError, TypeError, ValueError):
            continue
        if minimum - 0.001 <= segment_end <= maximum + 0.001:
            candidates.append(segment_end)
    if not candidates:
        return min(max(preferred, minimum), maximum)
    return min(candidates, key=lambda value: (abs(value - preferred), -value))


def clip_transcript_segment_text(text, segment_start, segment_end, window_start, window_end):
    if callable(external_clip_segment_text):
        return external_clip_segment_text(text, segment_start, segment_end, window_start, window_end)
    text = clean_text(text)
    words = text.split()
    segment_start = float(segment_start)
    segment_end = float(segment_end)
    if not words or segment_end <= segment_start:
        return text
    overlap_start = max(segment_start, float(window_start))
    overlap_end = min(segment_end, float(window_end))
    if overlap_end <= overlap_start:
        return ""
    if overlap_start <= segment_start and overlap_end >= segment_end:
        return text
    span = segment_end - segment_start
    first = max(0, min(len(words) - 1, int(math.floor(((overlap_start - segment_start) / span) * len(words)))))
    last = max(first + 1, min(len(words), int(math.ceil(((overlap_end - segment_start) / span) * len(words)))))
    return clean_text(" ".join(words[first:last]))


def transcript_segments_between(transcript, start, end):
    result = []
    for item in transcript or []:
        try:
            seg_start = float(item.get("start") or 0.0)
            seg_end = float(item.get("end") or seg_start)
        except Exception:
            continue
        if seg_end < start or seg_start > end:
            continue
        text = clip_transcript_segment_text(item.get("text") or "", seg_start, seg_end, start, end)
        if text:
            result.append({
                "start": max(seg_start, float(start)),
                "end": min(seg_end, float(end)),
                "text": text,
            })
    return result


def has_payoff_boundary(text):
    lower = clean_text(text).lower()
    if not lower:
        return False
    last_words = " ".join(normalize_words(lower)[-28:])
    strong_boundary = any(word in last_words for word in STRONG_PAYOFF_MARKERS + RESOLUTION_MARKERS)
    clean_sentence = bool(re.search(r"[.!?…]$", lower)) and not highlight_evidence_quality(text)["dangling_end"]
    return strong_boundary or clean_sentence


def improve_story_boundaries(start, end, transcript, min_duration, target_duration, max_duration):
    if not transcript:
        return float(start), float(end), ""
    external_text = ""
    if callable(external_extend_story_boundary):
        try:
            resolved = external_extend_story_boundary(
                transcript,
                start,
                end,
                min_duration=min_duration,
                target_duration=target_duration,
                max_duration=max_duration,
                ending_buffer=2.5,
            )
            if isinstance(resolved, (list, tuple)) and len(resolved) >= 2:
                start, end = resolved[0], resolved[1]
                if len(resolved) >= 3:
                    external_text = clean_text(resolved[2] or "")
        except Exception:
            pass
    start = smart_boundary_start(float(start), transcript)
    end = smart_boundary_end(float(end), transcript)
    max_end = start + float(max_duration)
    minimum_end = start + float(min_duration)
    if end - start > float(max_duration):
        end = smart_boundary_end_in_range(
            max_end, transcript, minimum_end, max_end
        )
    target_end = start + float(target_duration)
    selected_segments = transcript_segments_between(transcript, start, end)
    text = clean_text(" ".join(item["text"] for item in selected_segments)) or external_text

    # Extend through nearby transcript segments until the scene has a clean
    # ending. This is the main guard against stiff 45-60s clips that cut before
    # the payoff.
    for item in transcript or []:
        try:
            seg_start = float(item.get("start") or 0.0)
            seg_end = float(item.get("end") or seg_start)
        except Exception:
            continue
        if seg_end <= end or seg_start < start:
            continue
        if seg_start - end > 4.5:
            break
        if seg_end > max_end + 0.001:
            break
        candidate_end = seg_end
        candidate_text = clean_text(f"{text} {item.get('text') or ''}")
        story_score, _ = story_completeness_score(candidate_text, candidate_end - start, min_duration, max_duration)
        should_stop = (
            candidate_end >= target_end
            and story_score >= 68
            and has_payoff_boundary(candidate_text)
        )
        end = candidate_end
        text = candidate_text
        if should_stop or end >= max_end - 0.2:
            break

    if end - start < float(min_duration):
        end = smart_boundary_end_in_range(
            min(max_end, start + float(target_duration)),
            transcript,
            minimum_end,
            max_end,
        )
        text = transcript_text_between(transcript, start, end) or text
    if end - start > float(max_duration):
        end = smart_boundary_end_in_range(
            max_end, transcript, minimum_end, max_end
        )
        text = transcript_text_between(transcript, start, end) or text
    return round(start, 2), round(end, 2), clean_text(text)


def story_arc_evidence(text, duration, min_duration, max_duration):
    """Return conservative Hook -> progression -> payoff evidence."""
    cleaned = clean_text(text)
    words = normalize_words(cleaned)
    if not words:
        return {
            "setup": 20,
            "progression": 20,
            "peak": 20,
            "payoff": 20,
            "standalone": 20,
            "story_integrity": 20,
            "retention_proxy": 20,
            "candidate_score": 20,
            "complete": False,
        }

    lower = cleaned.lower()
    first_words = " ".join(words[:28])
    middle_start = max(0, len(words) // 3)
    middle_end = max(middle_start + 1, (len(words) * 2) // 3)
    middle_words = " ".join(words[middle_start:middle_end])
    evidence = highlight_evidence_quality(cleaned)
    measured_story, _ = story_completeness_score(
        cleaned, duration, min_duration, max_duration
    )
    setup_markers = keyword_hits(
        first_words,
        [
            "awalnya", "dulu", "waktu", "ketika", "masalahnya",
            "ceritanya", "kenapa", "kok", "bagaimana", "gimana",
        ],
    )
    turn_markers = keyword_hits(
        middle_words or lower,
        [
            "karena", "tetapi", "tapi", "lalu", "kemudian", "setelah",
            "sebelum", "padahal", "berubah", "memutuskan", "menemukan",
            "sampai",
        ],
    )
    peak_markers = keyword_hits(
        lower,
        [
            "ternyata", "kaget", "marah", "takut", "lucu", "ketawa",
            "debat", "ditolak", "rahasia", "penting", "gila", "serius",
        ],
    )
    specificity = min(10, int(evidence.get("specificity_count") or 0))
    duration_fit = duration_fit_score(
        duration,
        min_duration,
        (float(min_duration) + float(max_duration)) / 2.0,
        max_duration,
    )

    setup = 28 + min(32, setup_markers * 10) + min(18, specificity * 2)
    if evidence.get("question_signal"):
        setup += 12
    if evidence.get("dangling_start"):
        setup -= 18
    elif setup_markers == 0 and not evidence.get("question_signal"):
        setup = min(setup, 54)

    progression = 28 + min(50, turn_markers * 10) + min(12, specificity * 1.5)
    if turn_markers == 0:
        progression = min(progression, 52)
    payoff = bounded_score(evidence.get("payoff_evidence"), 20, 96)
    peak = bounded_score(
        28 + min(44, peak_markers * 8) + min(16, specificity * 1.5),
        20,
        96,
    )
    standalone = 42
    if not evidence.get("dangling_start"):
        standalone += 16
    if evidence.get("clean_end"):
        standalone += 20
    if not evidence.get("dangling_end"):
        standalone += 14
    if len(words) >= 24:
        standalone += 6
    if payoff < 48:
        standalone = min(standalone, 70)

    setup = bounded_score(setup, 20, 96)
    progression = bounded_score(progression, 20, 96)
    standalone = bounded_score(standalone, 20, 96)
    story_integrity = bounded_score(
        measured_story * 0.44
        + setup * 0.16
        + progression * 0.18
        + payoff * 0.17
        + standalone * 0.05,
        20,
        96,
    )
    pacing = bounded_score(
        100
        - float(evidence.get("repetition_ratio") or 0.0) * 100
        - (14 if float(evidence.get("repetition_ratio") or 0.0) > 0.30 else 0),
        20,
        96,
    )
    retention_proxy = bounded_score(
        setup * 0.20
        + progression * 0.18
        + payoff * 0.28
        + peak * 0.14
        + duration_fit * 0.12
        + pacing * 0.08,
        20,
        96,
    )
    candidate_score = bounded_score(
        story_integrity * 0.52
        + setup * 0.16
        + payoff * 0.18
        + retention_proxy * 0.14,
        20,
        96,
    )
    complete = (
        story_integrity >= 64
        and payoff >= 48
        and not evidence.get("dangling_start")
        and not evidence.get("dangling_end")
    )
    return {
        "setup": setup,
        "progression": progression,
        "peak": peak,
        "payoff": payoff,
        "standalone": standalone,
        "story_integrity": story_integrity,
        "retention_proxy": retention_proxy,
        "candidate_score": candidate_score,
        "complete": complete,
    }


def editorial_quality_scorecard(
    metrics, evidence_quality, text, duration, min_duration, max_duration
):
    """Calculate an explainable 40/30/20/10 score without inflating a clip."""
    arc = story_arc_evidence(text, duration, min_duration, max_duration)
    story_integrity = bounded_score(
        arc["story_integrity"] * 0.58
        + float(metrics.get("story_complete") or 0) * 0.42,
        20,
        96,
    )
    emotional_peak = max(
        float(metrics.get("emotion") or 0),
        float(metrics.get("conflict") or 0),
        float(metrics.get("surprise") or 0),
        float(arc.get("peak") or 0),
    )
    editorial_power = bounded_score(
        float(metrics.get("hook") or 0) * 0.34
        + emotional_peak * 0.24
        + max(
            float(metrics.get("value") or 0),
            float(metrics.get("knowledge") or 0),
        ) * 0.22
        + max(
            float(metrics.get("dialogue") or 0),
            float(metrics.get("novelty") or 0),
        ) * 0.20,
        20,
        96,
    )
    pacing = bounded_score(
        100
        - float(evidence_quality.get("repetition_ratio") or 0.0) * 100
        - float(metrics.get("filler_ratio") or 0.0) * 55,
        20,
        96,
    )
    retention_science = bounded_score(
        float(metrics.get("retention_predictor") or 0) * 0.40
        + float(arc.get("retention_proxy") or 0) * 0.24
        + float(metrics.get("payoff") or 0) * 0.18
        + float(metrics.get("hook") or 0) * 0.10
        + pacing * 0.08,
        20,
        96,
    )
    context_clarity = bounded_score(
        float(arc.get("standalone") or 0) * 0.62
        + float(arc.get("setup") or 0) * 0.38
        - (12 if evidence_quality.get("dangling_start") else 0),
        20,
        96,
    )
    boundary_quality = bounded_score(
        float(metrics.get("cut") or 0) * 0.45
        + float(arc.get("standalone") or 0) * 0.30
        + float(metrics.get("duration_fit") or 0) * 0.25
        - (
            14
            if evidence_quality.get("dangling_start")
            or evidence_quality.get("dangling_end")
            else 0
        ),
        20,
        96,
    )
    visual_quality = bounded_score(metrics.get("visual_activity") or 45, 20, 96)
    audio_quality = bounded_score(metrics.get("audio_activity") or 45, 20, 96)
    originality = bounded_score(metrics.get("novelty") or 45, 20, 96)
    information_value = bounded_score(
        max(metrics.get("value") or 0, metrics.get("knowledge") or 0),
        20,
        96,
    )
    platform_suitability = bounded_score(
        float(metrics.get("duration_fit") or 0) * 0.35
        + float(metrics.get("retention_predictor") or 0) * 0.35
        + float(metrics.get("hook") or 0) * 0.30,
        20,
        96,
    )
    confidence = bounded_score(
        38
        + min(24, int(evidence_quality.get("specificity_count") or 0) * 4)
        + (12 if arc.get("complete") else 0)
        + (8 if evidence_quality.get("clean_end") else 0)
        + (8 if not evidence_quality.get("dangling_start") else -8),
        20,
        96,
    )
    technical_quality = bounded_score(
        boundary_quality * 0.35
        + float(metrics.get("duration_fit") or 0) * 0.25
        + visual_quality * 0.20
        + audio_quality * 0.20,
        20,
        96,
    )
    raw_final = bounded_score(
        story_integrity * 0.40
        + editorial_power * 0.30
        + retention_science * 0.20
        + technical_quality * 0.10,
        20,
        96,
    )
    caps = []
    final = raw_final
    if story_integrity < 54:
        final = min(final, 67)
        caps.append("story_integrity_below_gate")
    if float(arc.get("payoff") or 0) < 48:
        final = min(final, 70)
        caps.append("payoff_not_proven")
    if evidence_quality.get("dangling_start") or evidence_quality.get("dangling_end"):
        final = min(final, 68)
        caps.append("incomplete_boundary")
    dimensions = {
        "hookPotential": bounded_score(metrics.get("hook") or 0, 20, 96),
        "storyCompleteness": story_integrity,
        "contextClarity": context_clarity,
        "payoffStrength": bounded_score(arc.get("payoff") or metrics.get("payoff") or 0, 20, 96),
        "retentionPotential": retention_science,
        "emotionalStrength": bounded_score(emotional_peak, 20, 96),
        "informationValue": information_value,
        "visualQuality": visual_quality,
        "audioQuality": audio_quality,
        "boundaryQuality": boundary_quality,
        "originality": originality,
        "platformSuitability": platform_suitability,
        "confidence": confidence,
    }
    return {
        "schema": 3,
        "weights": {
            "storyIntegrity": 0.40,
            "editorialPower": 0.30,
            "retentionScience": 0.20,
            "technicalQuality": 0.10,
        },
        "groups": {
            "storyIntegrity": story_integrity,
            "editorialPower": editorial_power,
            "retentionScience": retention_science,
            "technicalQuality": technical_quality,
        },
        "dimensions": dimensions,
        "arc": arc,
        "pacing": pacing,
        "rawFinal": raw_final,
        "final": bounded_score(final, 20, 96),
        "caps": caps,
    }


def explain_editorial_score(scorecard):
    """Return evidence-backed strengths and weaknesses for the review UI."""
    labels = {
        "hookPotential": "Hook langsung menarik perhatian",
        "storyCompleteness": "Cerita memiliki alur yang utuh",
        "contextClarity": "Konteks dapat dipahami tanpa video penuh",
        "payoffStrength": "Payoff atau jawaban terasa selesai",
        "retentionPotential": "Pacing mendukung retention",
        "emotionalStrength": "Ada emosi yang jelas",
        "informationValue": "Informasi atau insight bernilai",
        "visualQuality": "Bukti visual cukup kuat",
        "audioQuality": "Bukti audio cukup jelas",
        "boundaryQuality": "Awal dan akhir berada di batas alami",
        "originality": "Sudut pembahasan cukup spesifik",
        "platformSuitability": "Durasi dan struktur cocok untuk video pendek",
        "confidence": "Bukti pemilihan memiliki confidence tinggi",
    }
    weakness_labels = {
        "hookPotential": "Hook pembuka masih lemah",
        "storyCompleteness": "Alur cerita belum sepenuhnya utuh",
        "contextClarity": "Konteks pembuka masih bergantung pada bagian sebelumnya",
        "payoffStrength": "Payoff atau jawaban belum kuat",
        "retentionPotential": "Pacing berisiko kehilangan penonton",
        "emotionalStrength": "Daya emosi terbatas",
        "informationValue": "Nilai informasi terbatas",
        "visualQuality": "Pergerakan visual terbatas",
        "audioQuality": "Bukti kualitas audio terbatas",
        "boundaryQuality": "Boundary perlu ditinjau",
        "originality": "Topik kurang spesifik atau repetitif",
        "platformSuitability": "Durasi atau struktur belum ideal untuk format pendek",
        "confidence": "Confidence evidence masih terbatas",
    }
    dimensions = dict((scorecard or {}).get("dimensions") or {})
    strongest = sorted(
        dimensions.items(), key=lambda item: float(item[1] or 0), reverse=True
    )
    weakest = sorted(
        dimensions.items(), key=lambda item: float(item[1] or 0)
    )
    strengths = [labels[key] for key, value in strongest if value >= 68 and key in labels][:4]
    weaknesses = [weakness_labels[key] for key, value in weakest if value < 62 and key in weakness_labels][:3]
    for cap in (scorecard or {}).get("caps") or []:
        cap_message = {
            "story_integrity_below_gate": "Story integrity belum melewati quality gate",
            "payoff_not_proven": "Payoff belum terbukti dari transcript",
            "incomplete_boundary": "Awal atau ending masih belum lengkap",
        }.get(cap)
        if cap_message and cap_message not in weaknesses:
            weaknesses.append(cap_message)
    if not strengths:
        strengths = ["Kandidat memiliki bukti lokal yang dapat ditinjau"]
    if not weaknesses:
        weaknesses = ["Tidak ada kelemahan kritis yang terdeteksi"]
    return {"strengths": strengths[:4], "weaknesses": weaknesses[:4]}

def build_semantic_segments(info, transcript, duration):
    segments = []
    chapters = info.get("chapters") or []
    if chapters:
        for chapter in chapters:
            start = float(chapter.get("start_time") or 0)
            end = float(chapter.get("end_time") or min(duration, start + 120))
            text = " ".join(
                item.get("text", "") for item in transcript if item["start"] >= start and item["end"] <= end
            )
            segments.append(
                {
                    "start": start,
                    "end": max(end, start + 5),
                    "text": text or chapter.get("title") or "Segmen chapter",
                    "type": "Chapter",
                }
            )
    if not segments:
        current = None
        for item in transcript:
            if not item.get("text"):
                continue
            if current is None:
                current = {"start": item["start"], "end": item["end"], "text": item["text"], "type": "Auto"}
                continue
            gap = item["start"] - current["end"]
            if gap > 3 or re.search(r"[\.!\?]$", current["text"]):
                segments.append(current)
                current = {"start": item["start"], "end": item["end"], "text": item["text"], "type": "Auto"}
            else:
                current["end"] = item["end"]
                current["text"] += " " + item["text"]
        if current:
            segments.append(current)
    if not segments:
        if duration > 0:
            step = max(15, min(60, duration / 6))
            position = 0
            while position < duration:
                segments.append(
                    {
                        "start": position,
                        "end": min(duration, position + step),
                        "text": "Segmen otomatis",
                        "type": "Auto",
                    }
                )
                position += step
    return segments


def classify_segment_type(text):
    lower = clean_text(text or "").lower()
    if any(word in lower for word in ["gue", "gua", "lo", "lu", "kamu", "kita", "dia", "mereka", "temen", "teman", "ngomong", "bilang", "jawab", "tanya"]):
        return "Conversation"
    if any(word in lower for word in ["cara", "tips", "tutorial", "belajar", "penjelasan", "strategi", "solusi"]):
        return "Edukasi"
    if any(word in lower for word in ["lucu", "ketawa", "ngakak", "reaksi", "gila", "wow"]):
        return "Komedi"
    if any(word in lower for word in ["motivasi", "inspirasi", "mimpi", "bangkit", "semangat"]):
        return "Inspirasi"
    return "Story"


def split_segment_into_story_units(segment, min_duration, max_duration):
    seg_text = clean_text(segment.get("text") or "")
    if not seg_text:
        return []
    seg_start = float(segment["start"])
    seg_end = float(segment["end"])
    length = seg_end - seg_start
    if length <= max_duration:
        return [{"start": seg_start, "end": seg_end, "text": seg_text, "segment_type": segment.get("type") or classify_segment_type(seg_text)}]

    sentences = [sentence.strip() for sentence in re.split(r"(?<=[.!?…])\s+", seg_text) if sentence.strip()]
    if len(sentences) <= 1:
        return [{"start": seg_start, "end": seg_end, "text": seg_text, "segment_type": segment.get("type") or classify_segment_type(seg_text)}]

    total_length = sum(len(sentence) for sentence in sentences)
    if total_length <= 0:
        total_length = len(sentences)

    units = []
    cursor = seg_start
    for sentence in sentences:
        proportion = len(sentence) / total_length if total_length else 1 / len(sentences)
        target_chunks = max(1, round(length * proportion / max(1, min_duration)))
        chunk_duration = max(min_duration, min(max_duration, length * proportion))
        unit_end = min(seg_end, cursor + chunk_duration)
        if unit_end - cursor >= min_duration:
            units.append({"start": cursor, "end": unit_end, "text": sentence, "segment_type": segment.get("type") or classify_segment_type(seg_text)})
            cursor = unit_end
        if cursor >= seg_end:
            break
    if cursor < seg_end and units:
        units[-1]["end"] = seg_end
    return units


def build_candidate_windows_from_segments(segments, target_count, min_duration, max_duration):
    windows = []
    for segment in segments:
        seg_start = segment["start"]
        seg_end = segment["end"]
        seg_text = clean_text(segment.get("text") or "")
        seg_type = segment.get("type") or classify_segment_type(seg_text)
        length = seg_end - seg_start
        if length < min_duration:
            continue
        if length <= max_duration:
            windows.append({"start": seg_start, "end": seg_end, "text": seg_text, "segment_type": seg_type})
            continue
        story_units = split_segment_into_story_units(segment, min_duration, max_duration)
        for unit in story_units:
            if unit["end"] - unit["start"] >= min_duration:
                windows.append(unit)
        step = max(min_duration, max_duration * 0.75)
        position = seg_start
        while position + min_duration <= seg_end and len(windows) < target_count * 8:
            window_end = min(seg_end, position + max_duration)
            windows.append(
                {
                    "start": position,
                    "end": window_end,
                    "text": seg_text,
                    "segment_type": seg_type,
                }
            )
            position += step
    return windows


def build_story_units(info, transcript, min_duration, max_duration):
    duration = float(info.get("duration") or 0)
    segments = build_semantic_segments(info, transcript, duration)
    units = []
    for segment in segments:
        units.extend(split_segment_into_story_units(segment, min_duration, max_duration))
    return units


def candidate_generation_budget(video_duration, target_count):
    """Scale the evidence search without fabricating extra recommendations."""
    duration = max(0.0, float(video_duration or 0.0))
    target = max(1, int(target_count or 1))
    if duration < 900:
        minimum, maximum = 24, 96
    elif duration < 1800:
        minimum, maximum = 32, 112
    elif duration < 3600:
        minimum, maximum = 48, 144
    elif duration < 7200:
        minimum, maximum = 64, 176
    else:
        minimum, maximum = 80, 208
    minimum = min(maximum, max(minimum, min(96, target * 4)))
    maximum = min(240, max(maximum, target * 10))
    return {"min_candidates": minimum, "max_candidates": maximum}


def build_story_arc_candidates(
    transcript, target_count, min_duration, target_duration, max_duration
):
    """Find compact local windows with setup, progression, and payoff.

    The search keeps one strongest window per ending segment, then preserves
    both the best evidence and broad timeline coverage. It never creates a
    candidate from a gap in the transcript.
    """
    segments = []
    for item in transcript or []:
        try:
            start = float(item.get("start") or 0.0)
            end = float(item.get("end") or start)
        except Exception:
            continue
        text = clean_text(item.get("text") or "")
        if end > start and text:
            segments.append({"start": start, "end": end, "text": text})
    segments.sort(key=lambda item: (item["start"], item["end"]))
    if len(segments) < 2:
        return []

    candidates = []
    for end_index, end_segment in enumerate(segments):
        best = None
        text_parts = []
        for start_index in range(end_index, -1, -1):
            current = segments[start_index]
            if start_index < end_index:
                following = segments[start_index + 1]
                if following["start"] - current["end"] > 5.0:
                    break
            text_parts.insert(0, current["text"])
            start = current["start"]
            end = end_segment["end"]
            duration = end - start
            if duration > float(max_duration):
                break
            if duration < float(min_duration):
                continue
            text = clean_text(" ".join(text_parts))
            arc = story_arc_evidence(
                text, duration, min_duration, max_duration
            )
            if arc["story_integrity"] < 54 or arc["payoff"] < 42:
                continue
            duration_distance = abs(duration - float(target_duration)) / max(
                float(target_duration), 1.0
            )
            quality = float(arc["candidate_score"]) - min(
                8.0, duration_distance * 7.0
            )
            if not best or quality > best["quality"]:
                best = {
                    "start": round(start, 2),
                    "end": round(end, 2),
                    "text": text,
                    "duration": round(duration, 2),
                    "segment_type": "Story Arc",
                    "candidate_source": "story_arc",
                    "candidate_sources": ["story_arc"],
                    "story_arc": arc,
                    "metrics": {
                        "hook": arc["setup"],
                        "story_complete": arc["story_integrity"],
                        "payoff": arc["payoff"],
                        "retention_predictor": arc["retention_proxy"],
                    },
                    "score": arc["candidate_score"],
                    "quality": quality,
                }
        if best:
            best.pop("quality", None)
            candidates.append(best)

    if not candidates:
        return []
    candidate_cap = max(
        32, min(180, max(int(target_count or 1) * 14, 56))
    )
    if len(candidates) <= candidate_cap:
        return candidates
    ranked = sorted(
        candidates, key=lambda item: float(item.get("score") or 0), reverse=True
    )
    primary_count = int(candidate_cap * 0.72)
    selected = ranked[:primary_count]
    selected_ids = {id(item) for item in selected}
    timeline = sorted(
        (item for item in candidates if id(item) not in selected_ids),
        key=lambda item: float(item.get("start") or 0),
    )
    remaining = candidate_cap - len(selected)
    if timeline and remaining > 0:
        stride = max(1.0, len(timeline) / remaining)
        for index in range(remaining):
            selected.append(
                timeline[min(len(timeline) - 1, int(index * stride))]
            )
    return selected[:candidate_cap]


def build_story_map_candidates(
    story_map, transcript, min_duration, target_duration, max_duration, content_profile=None
):
    """Turn high-intent Story Map events into natural-boundary candidates."""
    if not isinstance(story_map, dict):
        return []
    priority = {
        "payoff": 10,
        "surprise": 9,
        "question": 8,
        "answer": 8,
        "conflict": 8,
        "lesson": 7,
        "reaction": 7,
        "explanation": 6,
        "setup": 5,
    }
    events = [
        event for event in (story_map.get("events") or [])
        if str(event.get("type") or "") in priority
    ]
    events.sort(
        key=lambda event: (
            -priority.get(str(event.get("type") or ""), 0),
            float(event.get("start") or 0.0),
        )
    )
    candidates = []
    seen = set()
    for event in events[:160]:
        event_type = str(event.get("type") or "context")
        event_start = float(event.get("start") or 0.0)
        event_end = max(event_start, float(event.get("end") or event_start))
        event_text = clean_text(event.get("text") or "")
        effective_min, effective_target, effective_max, duration_profile = candidate_duration_bounds(
            event_text,
            min_duration,
            target_duration,
            max_duration,
            content_profile,
        )
        if event_type in {"payoff", "answer", "surprise", "reaction"}:
            preferred_start = max(0.0, event_start - effective_target * 0.68)
            preferred_end = min(event_end + effective_target * 0.12, preferred_start + effective_max)
        else:
            preferred_start = max(0.0, event_start - effective_target * 0.18)
            preferred_end = min(event_end + effective_target * 0.72, preferred_start + effective_max)
        start, end, text = improve_story_boundaries(
            preferred_start,
            max(preferred_end, preferred_start + effective_min),
            transcript,
            effective_min,
            effective_target,
            effective_max,
        )
        key = (round(start, 1), round(end, 1))
        if key in seen or end - start < effective_min:
            continue
        seen.add(key)
        candidates.append({
            "start": start,
            "end": end,
            "duration": round(end - start, 2),
            "text": text,
            "segment_type": "Story Map",
            "candidate_source": f"story_map:{event_type}",
            "candidate_sources": ["story_map", event_type],
            "story_id": event.get("storyId"),
            "topic": event.get("topic"),
            "story_event": event_type,
            "story_event_evidence": list(event.get("evidence") or []),
            "duration_profile": duration_profile,
        })
    return candidates


def build_editorial_candidate_windows(info, transcript, target_count, min_duration, target_duration, max_duration):
    duration = float(info.get("duration") or 0)
    evidence_budget = candidate_generation_budget(duration, target_count)
    candidates = []
    story_map = info.get("_story_map") if isinstance(info.get("_story_map"), dict) else {}
    stories = list(story_map.get("stories") or [])
    if not stories and callable(external_build_story_timeline):
        try:
            stories = external_build_story_timeline(transcript, {"min_duration": min_duration, "max_duration": max_duration})
            emit("log", stage="story detection", message=f"Story Detection: {len(stories)} story ditemukan")
        except Exception as exc:
            emit("log", stage="story detection", message=f"Story Engine fallback: {exc}")
    story_map_candidates = build_story_map_candidates(
        story_map,
        transcript,
        min_duration,
        target_duration,
        max_duration,
        info.get("_content_profile"),
    )
    if story_map_candidates:
        candidates.extend(story_map_candidates)
        emit(
            "log",
            stage="story map",
            message=(
                f"Story Map: {len(story_map_candidates)} kandidat beralasan "
                "dari question, answer, conflict, reaction, dan payoff."
            ),
        )
    if callable(external_story_candidates):
        try:
            story_windows = external_story_candidates(
                transcript,
                {"durations": [min_duration, target_duration, min(max_duration, target_duration * 1.35)]},
            )
            candidates.extend(story_windows)
        except Exception as exc:
            emit("log", stage="story detection", message=f"Story candidate fallback: {exc}")
    story_arc_candidates = build_story_arc_candidates(
        transcript,
        target_count,
        min_duration,
        target_duration,
        max_duration,
    )
    if story_arc_candidates:
        candidates.extend(story_arc_candidates)
        emit(
            "log",
            stage="story detection",
            message=(
                f"Story Arc: {len(story_arc_candidates)} kandidat "
                "Hook -> perkembangan -> payoff ditemukan."
            ),
        )

    if callable(external_generate_highlight_candidates):
        try:
            evidence_candidates = external_generate_highlight_candidates(
                transcript,
                metadata={
                    "duration": duration,
                    "title": info.get("title"),
                    "story_candidates": stories,
                },
                config=evidence_budget,
            )
            for item in evidence_candidates:
                candidates.append({**item, "segment_type": "Evidence"})
            emit(
                "log",
                stage="candidate",
                message=(
                    f"Candidate Generator: {len(evidence_candidates)} evidence candidate "
                    f"(budget {evidence_budget['min_candidates']}-{evidence_budget['max_candidates']})."
                ),
            )
        except Exception as exc:
            emit("log", stage="candidate", message=f"Evidence candidate fallback: {exc}")
    heatmap_peaks = list(info.get("_heatmap_peaks") or [])
    if heatmap_peaks and callable(story_bound_heatmap_candidates):
        try:
            heatmap_candidates = story_bound_heatmap_candidates(
                heatmap_peaks,
                stories,
                transcript,
                min_duration,
                (min_duration + max_duration) / 2.0,
                max_duration,
            )
            candidates.extend(heatmap_candidates)
            emit(
                "log",
                stage="heatmap evidence",
                message=(
                    f"YouTube Most Replayed: {len(heatmap_peaks)} peak menjadi "
                    f"{len(heatmap_candidates)} kandidat berbatas cerita."
                ),
            )
        except Exception as exc:
            emit("log", stage="heatmap evidence", message=f"Heatmap candidate fallback: {exc}")
    segments = build_semantic_segments(info, transcript, duration)
    candidates.extend(build_candidate_windows_from_segments(segments, target_count, min_duration, max_duration))
    candidates.extend(
        build_windows_from_transcript(
            transcript,
            target_duration=target_duration,
            max_duration=max_duration,
            min_duration=min_duration,
            target_count=target_count * 4,
        )
    )
    unique = []
    seen = {}
    for item in candidates:
        text_key = clean_text(item.get("text") or "")[:180]
        key = (round(float(item.get("start") or 0), 1), round(float(item.get("end") or 0), 1), text_key)
        if not text_key:
            continue
        if callable(heatmap_evidence_for_interval):
            heatmap_metrics = heatmap_evidence_for_interval(
                float(item.get("start") or 0),
                float(item.get("end") or 0),
                heatmap_peaks,
            )
            if heatmap_metrics.get("supported"):
                item["heatmap_metrics"] = heatmap_metrics
                item["candidate_sources"] = sorted(
                    set(
                        list(item.get("candidate_sources") or [])
                        + [str(item.get("candidate_source") or item.get("segment_type") or "local"), "youtube_most_replayed"]
                    )
                )
        if key in seen:
            existing = seen[key]
            existing_sources = list(existing.get("candidate_sources") or [])
            if existing.get("candidate_source"):
                existing_sources.append(str(existing.get("candidate_source")))
            new_sources = list(item.get("candidate_sources") or [])
            if item.get("candidate_source"):
                new_sources.append(str(item.get("candidate_source")))
            existing["candidate_sources"] = sorted(set(existing_sources + new_sources))
            current_heatmap = existing.get("heatmap_metrics") or {}
            new_heatmap = item.get("heatmap_metrics") or {}
            if float(new_heatmap.get("score") or 0) > float(current_heatmap.get("score") or 0):
                existing["heatmap_metrics"] = new_heatmap
            current_arc = existing.get("story_arc") or {}
            new_arc = item.get("story_arc") or {}
            if float(new_arc.get("candidate_score") or 0) > float(current_arc.get("candidate_score") or 0):
                existing["story_arc"] = new_arc
                if isinstance(item.get("metrics"), dict):
                    existing["metrics"] = item["metrics"]
            continue
        seen[key] = item
        unique.append(item)
    max_pool = max(
        240,
        min(
            420,
            max(int(target_count or 1) * 56, int(evidence_budget["max_candidates"]) * 2),
        ),
    )
    if len(unique) > max_pool:
        def rough_signal(item):
            text = clean_text(item.get("text") or "")
            opening = " ".join(text.split()[:32]).lower()
            ending = " ".join(text.split()[-28:]).lower()
            existing = float(item.get("score") or 0)
            source_bonus = 8 if item.get("candidate_source") in {"story", "story_arc"} or item.get("segment_type") in {"Story", "Story Arc"} else 0
            heatmap_bonus = min(6.0, float((item.get("heatmap_metrics") or {}).get("score") or 0) * 6.0)
            opening_signal = keyword_hits(opening, ["kenapa", "kok", "ternyata", "jangan", "rahasia", "gimana", "bagaimana"]) * 7
            ending_signal = keyword_hits(ending, ["akhirnya", "hasilnya", "makanya", "intinya", "jawabannya", "berhasil"]) * 7
            specificity = min(16, len(extract_specific_terms(text, 8)) * 2)
            return existing + source_bonus + heatmap_bonus + opening_signal + ending_signal + specificity

        ranked = sorted(unique, key=rough_signal, reverse=True)
        quality_count = int(max_pool * 0.72)
        reduced = ranked[:quality_count]
        reduced_ids = {id(item) for item in reduced}
        timeline_candidates = sorted((item for item in unique if id(item) not in reduced_ids), key=lambda item: float(item.get("start") or 0))
        needed = max_pool - len(reduced)
        if timeline_candidates and needed > 0:
            stride = max(1, len(timeline_candidates) / needed)
            for index in range(needed):
                reduced.append(timeline_candidates[min(len(timeline_candidates) - 1, int(index * stride))])
        unique = reduced[:max_pool]
    emit("log", stage="candidate", message=f"Candidate Pool: {len(unique)} candidate sebelum ranking")
    analysis_cache = info.get("_analysis_cache_dir")
    if analysis_cache:
        try:
            transcript_digest = hashlib.sha256(json_dumps(transcript).encode("utf-8", errors="replace")).hexdigest()
            write_json_file(Path(str(analysis_cache)) / "story_timeline.json", {"schema": 3, "transcript_hash": transcript_digest, "stories": stories, "created_at": datetime.now().isoformat()})
            write_json_file(Path(str(analysis_cache)) / "candidate_pool.json", {"schema": 3, "transcript_hash": transcript_digest, "count": len(unique), "candidates": unique, "created_at": datetime.now().isoformat()})
        except Exception as exc:
            emit("log", stage="cache", message=f"Story/candidate cache dilewati: {exc}")
    return unique


def build_windows_from_transcript(transcript, target_duration=45.0, max_duration=60.0, min_duration=20.0, target_count=4):
    """
    Build non-overlapping candidate windows from transcript segments.
    Returns list of dict:
    {
      "start": float,
      "end": float,
      "duration": float,
      "text": str,
      "segments": list
    }
    """
    if not transcript:
        return []

    items = []
    for entry in transcript:
        try:
            start = float(entry.get("start") or 0.0)
            end = float(entry.get("end") or start)
        except Exception:
            continue
        if end <= start:
            continue
        text = clean_text(entry.get("text") or entry.get("text") or "")
        if not text:
            continue
        items.append({"start": start, "end": end, "text": text, "duration": end - start})

    if not items:
        return []

    items.sort(key=lambda el: el["start"])
    target_window = max(float(min_duration), min(float(max_duration), float(target_duration or 45.0)))
    target_count = max(1, int(target_count or 4))
    windows = []
    index = 0
    while index < len(items):
        start_item = items[index]
        current = {
            "start": float(start_item["start"]),
            "end": float(start_item["end"]),
            "text": start_item["text"],
            "segments": [start_item],
        }
        cursor = index + 1
        while cursor < len(items):
            next_item = items[cursor]
            gap = float(next_item["start"]) - float(current["end"])
            proposed_end = max(float(current["end"]), float(next_item["end"]))
            proposed_duration = proposed_end - float(current["start"])
            ends_sentence = bool(re.search(r"[.!?…]$", clean_text(current["text"])))
            if gap > 3.0 or proposed_duration > max_duration:
                break
            if proposed_duration >= target_window and ends_sentence:
                break
            current["end"] = proposed_end
            current["text"] = clean_text(f"{current['text']} {next_item['text']}")
            current["segments"].append(next_item)
            cursor += 1
            if proposed_duration >= target_window and bool(re.search(r"[.!?…]$", clean_text(next_item["text"]))):
                break

        duration_seconds = float(current["end"]) - float(current["start"])
        if duration_seconds >= min_duration:
            if duration_seconds > max_duration:
                current["end"] = float(current["start"]) + float(max_duration)
                current["segments"] = [seg for seg in current["segments"] if float(seg["end"]) <= current["end"]]
                current["text"] = clean_text(" ".join(seg["text"] for seg in current["segments"])) or current["text"]
                duration_seconds = float(current["end"]) - float(current["start"])
            windows.append(
                {
                    "start": float(current["start"]),
                    "end": float(current["end"]),
                    "duration": float(duration_seconds),
                    "text": clean_text(current["text"]),
                    "segments": current["segments"],
                }
            )

        next_index = max(index + 1, cursor)
        while next_index < len(items) and items[next_index]["start"] < current["end"] - 1.0:
            next_index += 1
        index = next_index

    final_windows = []
    seen_text = set()
    for window in sorted(windows, key=lambda item: (item["start"], -len(item.get("text") or ""))):
        text_key = " ".join(normalize_words(window.get("text", ""))[:18])
        if text_key and text_key in seen_text:
            continue
        if overlaps_any(window, final_windows):
            continue
        seen_text.add(text_key)
        final_windows.append(window)

    return final_windows[: max(1, target_count * 4)]


def score_moment_candidate(candidate, payload, index, min_duration, max_duration):
    text = clean_highlight_source_text(candidate.get("text") or "")
    duration = max(min_duration, min(max_duration, candidate["end"] - candidate["start"]))
    metrics, _editor_score = editor_scene_metrics(text, duration, min_duration, max_duration, index)
    evidence_quality = highlight_evidence_quality(text)
    metrics.update(evidence_quality)
    profile = candidate_duration_profile(text, payload.get("_contentProfile"))
    metrics["duration_profile"] = profile.get("type", "general")
    evidence = candidate.get("candidate_metrics") if isinstance(candidate.get("candidate_metrics"), dict) else {}
    for key in ["hook", "emotion", "conflict", "surprise", "payoff", "story_complete", "retention_predictor", "dialogue", "novelty", "virality"]:
        if key in evidence:
            metrics[key] = bounded_score(metrics.get(key, 0) * 0.68 + float(evidence.get(key) or 0) * 0.32, 20, 96)
    audio_metrics = candidate.get("audio_metrics") if isinstance(candidate.get("audio_metrics"), dict) else {}
    if audio_metrics:
        audio_activity = bounded_score(audio_metrics.get("audio_activity"), 20, 96)
        metrics["audio_activity"] = audio_activity
        metrics["audio_peak"] = audio_metrics.get("audio_peak")
        metrics["audio_variation"] = audio_metrics.get("audio_variation")
        metrics["dialogue"] = bounded_score(metrics.get("dialogue", 0) * 0.76 + audio_activity * 0.24, 20, 96)
        metrics["conversation"] = metrics["dialogue"]
        metrics["retention_predictor"] = bounded_score(metrics.get("retention_predictor", 0) * 0.86 + audio_activity * 0.14, 20, 96)
    hook_text = fyp_hook_from_text(text)
    opening_text = " ".join(text.split()[:36])
    hook = bounded_score(
        min(
            max(hook_strength(opening_text), metrics["hook"]),
            evidence_quality["hook_evidence"] + 8,
        ),
        20,
        96,
    )
    metrics["hook"] = hook
    conflict = max(
        metrics.get("conflict", 0),
        bounded_score(keyword_hits(text.lower(), ["konflik", "ribut", "ditolak", "masalah", "debat", "bullying", "marah"]) * 14 + 24, 20, 96),
    )
    retention_components = {
        "content_prediction": bounded_score(
            metrics.get("retention_predictor", 0), 20, 96
        ),
        "speech_density": bounded_score(
            retention_score(text, duration, min_duration, max_duration), 20, 96
        ),
        "narrative_flow": bounded_score(metrics.get("flow", 0), 20, 96),
    }
    # A single ideal-duration or connector-heavy signal must not manufacture a
    # near-perfect retention score. Keep the prediction content-led, then use
    # measurable speech density and narrative flow only as supporting evidence.
    retention = bounded_score(
        retention_components["content_prediction"] * 0.70
        + retention_components["speech_density"] * 0.10
        + retention_components["narrative_flow"] * 0.20,
        20,
        96,
    )
    metrics["emotion"] = bounded_score(max(emotion_score(text), metrics["emotion"]), 20, 96)
    metrics["conflict"] = bounded_score(conflict, 20, 96)
    metrics["retention_predictor"] = bounded_score(retention, 20, 96)
    metrics["retention_components"] = {
        **retention_components,
        "weights": {
            "content_prediction": 0.70,
            "speech_density": 0.10,
            "narrative_flow": 0.20,
        },
        "final": metrics["retention_predictor"],
    }
    metrics["payoff"] = bounded_score(
        min(
            metrics.get("payoff", 0),
            evidence_quality["payoff_evidence"] + 6,
        ),
        20,
        96,
    )
    measured_story, measured_story_reasons = story_completeness_score(
        text,
        duration,
        min_duration,
        max_duration,
    )
    metrics["story_complete"] = bounded_score(
        min(metrics.get("story_complete", measured_story), measured_story),
        20,
        96,
    )
    metrics["story_reasons"] = ", ".join(measured_story_reasons[:4])
    metrics["speaker_energy"] = bounded_score(metrics.get("dialogue", metrics.get("conversation", 45)), 20, 96)
    metrics["visual_activity"] = bounded_score(candidate.get("visual_activity", 45), 20, 96)
    metrics["seo_potential"] = bounded_score(metrics.get("knowledge", metrics.get("value", 45)), 20, 96)
    category = choose_category(text, payload)
    video_type = str(((payload.get("_contentProfile") or {}).get("videoType") or "general")).lower()
    score, score_provenance = content_weighted_highlight_score(metrics, video_type)
    scorecard = editorial_quality_scorecard(
        metrics,
        evidence_quality,
        text,
        duration,
        min_duration,
        max_duration,
    )
    metrics["scorecard"] = scorecard
    score_provenance["scorecard"] = scorecard
    moment_scoring_v2 = feature_flag_enabled(payload, "momentScoringV2", False)
    score_provenance["momentScoringV2"] = moment_scoring_v2
    if video_type != "music" and moment_scoring_v2:
        profile_score = score
        score = bounded_score(
            profile_score * 0.60 + scorecard["final"] * 0.40,
            25,
            97,
        )
        reconciliation = round(score - profile_score, 2)
        if reconciliation:
            score_provenance["adjustments"].append(
                {
                    "reason": "story_editorial_retention_reconciliation",
                    "value": reconciliation,
                }
            )
        score_provenance["formula"] = "content_profile_60_scorecard_40"
    elif video_type == "music":
        # Music retains the specialist audio-first profile. The scorecard is
        # still recorded for diagnostics but cannot inject story-only points.
        score_provenance["formula"] = "content_profile_audio_first"
    else:
        score_provenance["formula"] = "content_profile_only"
    if video_type != "music" and evidence_quality["specificity_count"] < 2:
        score = bounded_score(score - 7, 25, 97)
        score_provenance["adjustments"].append({"reason": "low_specificity", "value": -7})
    if evidence_quality["dangling_start"]:
        score = bounded_score(score - 6, 25, 97)
        score_provenance["adjustments"].append({"reason": "dangling_opening", "value": -6})
    if evidence_quality["dangling_end"]:
        score = bounded_score(score - 9, 25, 97)
        score_provenance["adjustments"].append({"reason": "dangling_ending", "value": -9})
    if evidence_quality["repetition_ratio"] > 0.32:
        repetition_penalty = round(
            min(12.0, (evidence_quality["repetition_ratio"] - 0.32) * 42.0),
            2,
        )
        score = bounded_score(score - repetition_penalty, 25, 97)
        score_provenance["adjustments"].append(
            {"reason": "repetitive_transcript", "value": -repetition_penalty}
        )
    if is_generic_template(hook_text):
        score = bounded_score(score - 10, 25, 97)
        score_provenance["adjustments"].append({"reason": "generic_hook", "value": -10})
    heatmap_metrics = candidate.get("heatmap_metrics") if isinstance(candidate.get("heatmap_metrics"), dict) else {}
    heatmap_score = max(0.0, min(1.0, float(heatmap_metrics.get("score") or 0.0)))
    heatmap_bonus = 0.0
    heatmap_coherent = (
        bool(heatmap_metrics.get("supported"))
        and score >= 55
        and metrics.get("story_complete", 0) >= 55
        and evidence_quality["payoff_evidence"] >= 40
        and evidence_quality["specificity_count"] >= 1
        and not evidence_quality["dangling_end"]
    )
    if heatmap_coherent:
        # Engagement is corroborating evidence, never the main score. The cap
        # prevents a popular but contextless moment from passing quality gates.
        heatmap_bonus = round(min(5.0, heatmap_score * 5.0), 2)
        score = bounded_score(score + heatmap_bonus, 25, 97)
        score_provenance["adjustments"].append(
            {
                "reason": "youtube_most_replayed_support",
                "value": heatmap_bonus,
                "peak_time": heatmap_metrics.get("peak_time"),
            }
        )
    metrics["heatmap_score"] = round(heatmap_score * 100.0, 2)
    metrics["heatmap_supported"] = bool(heatmap_metrics.get("supported"))
    metrics["heatmap_bonus"] = heatmap_bonus
    score_provenance["final"] = score
    metrics["score_breakdown"] = {
        "hook": metrics.get("hook", 0),
        "story": metrics.get("story_complete", 0),
        "payoff": metrics.get("payoff", 0),
        "retention": metrics.get("retention_predictor", 0),
        "emotion": metrics.get("emotion", 0),
        "conflict": metrics.get("conflict", 0),
        "surprise": metrics.get("surprise", 0),
        "dialogue": metrics.get("dialogue", 0),
        "audio_activity": metrics.get("audio_activity"),
        "heatmap": metrics.get("heatmap_score"),
        "heatmap_bonus": heatmap_bonus,
        "filler_ratio": metrics.get("filler_ratio", 0),
        "hook_evidence": evidence_quality["hook_evidence"],
        "payoff_evidence": evidence_quality["payoff_evidence"],
        "specificity_count": evidence_quality["specificity_count"],
        "repetition_ratio": evidence_quality["repetition_ratio"],
    }
    metrics["score_provenance"] = score_provenance
    explanation = explain_editorial_score(scorecard)
    metrics["quality_dimensions"] = dict(scorecard.get("dimensions") or {})
    confidence = bounded_score(
        (
            metrics["hook"]
            + metrics["flow"]
            + metrics["value"]
            + metrics["trend"]
            + metrics["cut"]
            + metrics.get("editor_confidence", metrics["story_complete"])
        )
        / 6,
        35,
        99,
    )
    priority = score_priority(score)
    return {
        "score": score,
        "confidence": confidence,
        "grade": score_grade(score),
        "priority": priority,
        "auto_render": score >= AUTO_SELECT_MIN_SCORE,
        "render_eligible": score >= AUTO_RENDER_MIN_SCORE,
        "category": category,
        "metrics": metrics,
        "scoreProvenance": score_provenance,
        "reason": "; ".join(explanation["strengths"][:3]),
        "selectionReasons": explanation["strengths"],
        "weaknesses": explanation["weaknesses"],
        "qualityDimensions": dict(scorecard.get("dimensions") or {}),
        "hook": hook_text,
    }


def candidate_evidence_gate(metrics, evidence_quality, video_type="general", raw_score=0):
    """Apply one content-aware quality gate across local and AI ranking."""
    video_type = str(video_type or "general").lower()
    specificity = int(evidence_quality.get("specificity_count") or 0)
    repetition = float(evidence_quality.get("repetition_ratio") or 0.0)
    filler = float(metrics.get("filler_ratio") or 0.0)
    retention = float(metrics.get("retention_predictor") or 0.0)
    story = float(metrics.get("story_complete") or 0.0)
    payoff = float(metrics.get("payoff") or 0.0)
    payoff_evidence = float(evidence_quality.get("payoff_evidence") or 0.0)
    hook_evidence = float(evidence_quality.get("hook_evidence") or 0.0)
    dialogue = float(metrics.get("dialogue") or metrics.get("conversation") or 0.0)
    value = float(metrics.get("value") or metrics.get("knowledge") or 0.0)
    emotion = float(metrics.get("emotion") or 0.0)
    visual_activity = float(metrics.get("visual_activity") or 0.0)
    audio_activity = float(metrics.get("audio_activity") or 0.0)
    audio_variation = float(metrics.get("audio_variation") or 0.0)

    if (
        float(raw_score or 0) < 48
        or repetition > 0.38
        or evidence_quality.get("dangling_start")
        or evidence_quality.get("dangling_end")
    ):
        return False

    if video_type == "music":
        return (
            retention >= 55
            and filler <= 0.35
            and audio_activity >= 58
            and audio_variation >= 4
            and float(metrics.get("duration_fit") or 0.0) >= 55
        )

    if filler > 0.18 or retention < 60 or specificity < 2:
        return False

    if video_type in {"tutorial", "review", "news"}:
        return (
            value >= 58
            and story >= 50
            and (payoff >= 44 or payoff_evidence >= 46)
            and (hook_evidence >= 42 or retention >= 70)
        )

    if video_type in {"gaming", "vlog"}:
        activity = max(emotion, visual_activity, audio_activity)
        return (
            activity >= 58
            and story >= 48
            and (payoff >= 42 or payoff_evidence >= 42)
            and (hook_evidence >= 42 or retention >= 70)
        )

    if video_type in {"podcast", "interview", "storytelling"}:
        coherent_answer = (
            story >= 62
            and dialogue >= 58
            and specificity >= 3
            and retention >= 68
            and payoff_evidence >= 42
        )
        explicit_payoff = story >= 58 and payoff >= 48 and payoff_evidence >= 50
        return (coherent_answer or explicit_payoff) and (hook_evidence >= 44 or retention >= 72)

    return (
        story >= 58
        and payoff >= 48
        and payoff_evidence >= 50
        and specificity >= 3
        and (hook_evidence >= 48 or retention >= 72)
    )



def candidate_quality_tier(candidate):
    """Classify a final candidate without letting a raw score bypass evidence."""
    source = candidate if isinstance(candidate, dict) else {}
    score = clamp_score(source.get("score"), 0)
    reviewer_status = clean_text(source.get("reviewer_status") or "").lower()
    manual_review = bool(
        source.get("manual_review_candidate")
        or source.get("manualReview")
        or reviewer_status in {"missing", "unavailable"}
    )
    if bool(source.get("rejected")) or reviewer_status == "rejected" or score < 60:
        return "reject"
    if "ai_evidence_gate" in source:
        evidence_gate = bool(source.get("ai_evidence_gate"))
    else:
        evidence_gate = bool(source.get("evidence_gate"))
    if manual_review or not evidence_gate:
        return "review"
    if score >= 80:
        return "strong"
    if score >= AUTO_SELECT_MIN_SCORE:
        return "good"
    return "review"

def revalidate_candidate_after_boundary(
    candidate, payload, index, min_duration, max_duration
):
    """Re-score a candidate after its final transcript boundary is known."""
    previous_score = clamp_score(candidate.get("score"), 0)
    previous_start = float(candidate.get("start") or 0.0)
    previous_end = float(candidate.get("end") or previous_start)
    rescored = score_moment_candidate(
        candidate, payload, index, min_duration, max_duration
    )
    candidate.update(rescored)
    metrics = candidate.get("metrics") or {}
    evidence = highlight_evidence_quality(
        candidate.get("text") or candidate.get("transcript") or ""
    )
    video_type = str(
        ((payload.get("_contentProfile") or {}).get("videoType") or "general")
    ).lower()
    evidence_gate = candidate_evidence_gate(
        metrics, evidence, video_type, candidate.get("score")
    )
    reviewer_status = clean_text(candidate.get("reviewer_status") or "").lower()
    manual_review = bool(
        candidate.get("manual_review_candidate")
        or candidate.get("manualReview")
        or (reviewer_status and reviewer_status != "approved")
    )
    candidate["evidence_gate"] = evidence_gate
    candidate["auto_render"] = (
        clamp_score(candidate.get("score"), 0) >= AUTO_SELECT_MIN_SCORE
        and evidence_gate
        and not manual_review
    )
    candidate["render_eligible"] = (
        clamp_score(candidate.get("score"), 0) >= AUTO_RENDER_MIN_SCORE
        or manual_review
    )
    candidate["boundary_revalidated"] = True
    candidate["boundaryRevalidation"] = {
        "scoreBefore": previous_score,
        "scoreAfter": clamp_score(candidate.get("score"), 0),
        "start": round(float(candidate.get("start") or previous_start), 2),
        "end": round(float(candidate.get("end") or previous_end), 2),
        "evidenceGate": evidence_gate,
    }
    candidate["quality_tier"] = candidate_quality_tier(candidate)
    return candidate

def calibrate_candidate_scores(candidates, content_profile=None):
    """Record candidate percentile without changing its evidence score."""
    if not candidates:
        return candidates
    ranked = sorted(candidates, key=lambda item: float(item.get("score") or 0), reverse=True)
    denominator = max(1, len(ranked) - 1)
    for rank, candidate in enumerate(ranked):
        raw_score = clamp_score(candidate.get("score"), 0)
        metrics = candidate.get("metrics") or {}
        percentile = 1.0 - rank / denominator
        evidence_quality = highlight_evidence_quality(
            candidate.get("text") or candidate.get("transcript") or ""
        )
        specificity = evidence_quality["specificity_count"]
        metrics.update(
            {
                "hook_evidence": evidence_quality["hook_evidence"],
                "payoff_evidence": evidence_quality["payoff_evidence"],
                "specificity_count": specificity,
                "repetition_ratio": evidence_quality["repetition_ratio"],
                "dangling_start": evidence_quality["dangling_start"],
                "dangling_end": evidence_quality["dangling_end"],
            }
        )
        candidate["metrics"] = metrics
        candidate_profile = (
            candidate.get("content_profile")
            if isinstance(candidate.get("content_profile"), dict)
            else content_profile if isinstance(content_profile, dict) else {}
        )
        video_type = str((candidate_profile.get("videoType") or "general")).lower()
        evidence_gate = candidate_evidence_gate(
            metrics,
            evidence_quality,
            video_type,
            raw_score,
        )
        calibrated = raw_score
        candidate["raw_score"] = raw_score
        candidate["score"] = calibrated
        candidate["score_percentile"] = round(percentile * 100, 1)
        candidate["score_calibrated"] = True
        candidate["evidence_gate"] = evidence_gate
        candidate["calibration"] = {
            "mode": "evidence_only",
            "rank": rank + 1,
            "candidate_count": len(ranked),
            "rank_bonus": 0,
        }
        candidate["grade"] = score_grade(calibrated)
        candidate["priority"] = score_priority(calibrated)
        candidate["auto_render"] = calibrated >= AUTO_SELECT_MIN_SCORE and evidence_gate
        candidate["render_eligible"] = calibrated >= AUTO_RENDER_MIN_SCORE
        candidate["quality_tier"] = candidate_quality_tier(candidate)
    return candidates


def candidate_can_auto_render(moment, score=None):
    """Require measured content evidence and preserve reviewer safety gates."""
    score = clamp_score(moment.get("score"), 0) if score is None else clamp_score(score, 0)
    reviewer_status = clean_text(moment.get("reviewer_status") or "").lower()
    if reviewer_status and reviewer_status != "approved":
        return False
    if bool(moment.get("manual_review_candidate")) or bool(moment.get("manualReview")):
        return False
    evidence_gate = (
        bool(moment.get("ai_evidence_gate"))
        if "ai_evidence_gate" in moment
        else bool(moment.get("evidence_gate"))
    )
    return score >= AUTO_SELECT_MIN_SCORE and evidence_gate


def apply_title_hook_diversity(moments, payload=None):
    used_hook_signatures = set()
    used_title_signatures = set()
    refined = []
    for index, item in enumerate(moments or [], 1):
        moment = dict(item)
        raw_source = clean_text(moment.get("transcript") or moment.get("text") or moment.get("title") or "")
        source = profile_source_text(raw_source, payload)

        hook = clean_text(moment.get("hook") or "")
        signature = hook_signature(hook)
        if (
            not hook
            or is_generic_template(hook)
            or signature in LOW_VALUE_HOOK_SIGNATURES
            or signature in used_hook_signatures
            or not editorial_claim_is_grounded(hook, source)
            or hook_quality_score(hook, source, used_hook_signatures) < 58
        ):
            hook = pick_best_hook(content_aware_local_hook_candidates(raw_source, payload), source, used_hook_signatures)
        if hook_signature(hook) in used_hook_signatures:
            phrase = first_strong_phrase(source, 8)
            forced_hooks = [
                f"{phrase}..." if phrase else "",
                f"Kenapa {specific_phrase_label(source, 3)} Jadi Penting?",
                f"Apa yang Terjadi dengan {specific_phrase_label(source, 3)}?",
            ]
            hook = pick_best_hook(forced_hooks + local_hook_candidates(source), source, used_hook_signatures)
        moment["hook"] = hook
        moment["hook_score"] = hook_quality_score(hook, source, used_hook_signatures)
        used_hook_signatures.add(hook_signature(hook))

        title = clean_text(moment.get("titleSuggestion") or moment.get("title") or "")
        if (
            not title
            or is_generic_template(title)
            or hook_signature(title) in used_title_signatures
            or not editorial_claim_is_grounded(title, source)
            or title_quality_score(title, source, used_title_signatures) < 58
        ):
            title = pick_best_title(content_aware_local_title_candidates(raw_source, payload, index), source, index, used_title_signatures)
        if hook_signature(title) in used_title_signatures:
            phrase = first_strong_phrase(source, 9)
            specific_label = specific_phrase_label(source, 4)
            forced_titles = [
                f"{specific_label}: Sudut yang Belum Banyak Dibahas" if specific_label else "",
                f"{specific_label} dan Hal yang Membuatnya Berbeda" if specific_label else "",
                f"{phrase}: Momen yang Mulai Terlihat" if phrase else "",
            ]
            title = pick_best_title(forced_titles + local_title_candidates(source, index), source, index, used_title_signatures)
        if hook_is_duplicate_caption(title, hook):
            phrase = first_strong_phrase(source, 9)
            terms = extract_specific_terms(source, 5)
            main = " ".join(term.capitalize() for term in terms[:3]) if terms else phrase
            alternate_titles = [
                f"Alasan {main} Jadi Pembahasan Serius" if main else "",
                f"{main}: Hal Penting yang Sering Terlewat" if main else "",
                f"Apa yang Sebenarnya Terjadi dengan {main}" if main else "",
            ]
            title = pick_best_title(alternate_titles + local_title_candidates(source, index), source, index, used_title_signatures)
            if hook_is_duplicate_caption(title, hook):
                title = seo_clean_title(
                    representative_phrase(source, 10),
                    f"Moment Pilihan {index}",
                )
        moment["title"] = title
        moment["titleSuggestion"] = title
        used_title_signatures.add(hook_signature(title))

        score = clamp_score(moment.get("score"), 0)
        reviewer_status = clean_text(moment.get("reviewer_status") or "").lower()
        manual_review = (
            bool(moment.get("manual_review_candidate"))
            or bool(moment.get("manualReview"))
            or reviewer_status in {"rejected", "missing", "unavailable"}
        )
        moment["priority"] = "OPTIONAL" if manual_review else score_priority(score)
        moment["grade"] = score_grade(score)
        moment["auto_render"] = candidate_can_auto_render(moment, score)
        moment["render_eligible"] = score >= AUTO_RENDER_MIN_SCORE or manual_review
        if score < 60:
            moment["low_quality"] = True
            moment["auto_render"] = False
            if manual_review:
                moment["rejected"] = False
                moment["priority"] = "OPTIONAL"
                moment["reason"] = clean_text(f"{moment.get('reason') or ''}; Confidence rendah, wajib review manual").strip("; ")
            else:
                moment["rejected"] = True
                moment["reject_reason"] = "Score di bawah 60"
        elif score < AUTO_RENDER_MIN_SCORE:
            moment["low_quality"] = True
            moment["reason"] = clean_text(f"{moment.get('reason') or ''}; Score rendah, review manual disarankan").strip("; ")
        moment["quality_tier"] = candidate_quality_tier(moment)
        refined.append(moment)
    return refined


def select_review_fallback_moments(candidates, target_count, video_duration=0.0):
    """Return honest low-confidence candidates instead of an empty Moment page.

    Scores are never raised. These clips are visible and manually selectable,
    but remain excluded from automatic render selection. A fallback candidate
    still needs a complete transcript boundary; Optional must not become a
    back door for clips that begin or end mid-thought.
    """
    def has_complete_boundary(candidate):
        metrics = candidate.get("metrics") if isinstance(candidate.get("metrics"), dict) else {}
        return not metrics.get("dangling_start") and not metrics.get("dangling_end")

    ranked = sorted(
        [candidate for candidate in (candidates or []) if has_complete_boundary(candidate)],
        key=lambda item: float(item.get("score") or 0),
        reverse=True,
    )
    if not ranked:
        return []
    target_count = max(1, min(int(target_count or 1), len(ranked)))
    bucket_size = max(120.0, float(video_duration or 0.0) / max(target_count, 1))
    selected = []
    used_buckets = set()

    def acceptable(candidate, enforce_bucket=True):
        if overlaps_any(candidate, selected, tolerance=0.35):
            return False
        if any(text_similarity(candidate.get("text"), previous.get("text")) > 0.64 for previous in selected):
            return False
        bucket = int(float(candidate.get("start") or 0.0) / bucket_size)
        if enforce_bucket and bucket in used_buckets:
            return False
        return True

    for enforce_bucket in [True, False]:
        for candidate in ranked:
            if len(selected) >= target_count:
                break
            if candidate in selected or not acceptable(candidate, enforce_bucket=enforce_bucket):
                continue
            review = dict(candidate)
            review["manual_review_candidate"] = True
            review["auto_render"] = False
            review["render_eligible"] = True
            review["rejected"] = False
            review["priority"] = "OPTIONAL"
            review["quality_tier"] = "review"
            review["reason"] = clean_text(
                f"{review.get('reason') or ''}; Kandidat terbaik tersedia untuk review manual, score tidak dinaikkan"
            ).strip("; ")
            selected.append(review)
            used_buckets.add(int(float(review.get("start") or 0.0) / bucket_size))
        if len(selected) >= target_count:
            break
    return sorted(selected, key=lambda item: float(item.get("start") or 0.0))


def supplement_with_optional_review_candidates(selected, candidates, result_limit, video_duration=0.0):
    """Fill a shortfall with distinct manual-review candidates only.

    This never changes a score or turns an Optional candidate into an
    automatic render. It merely keeps valid, evidence-derived alternatives
    visible when the strict automatic set is shorter than the requested goal.
    """
    supplemented = list(selected or [])
    result_limit = max(0, int(result_limit or 0))
    if len(supplemented) >= result_limit:
        return supplemented[:result_limit]
    review_candidates = select_review_fallback_moments(
        candidates,
        result_limit,
        video_duration,
    )
    for candidate in review_candidates:
        if len(supplemented) >= result_limit:
            break
        if overlaps_any(candidate, supplemented):
            continue
        if any(
            text_similarity(candidate.get("text"), previous.get("text")) > 0.62
            for previous in supplemented
        ):
            continue
        supplemented.append(candidate)
    return sorted(supplemented[:result_limit], key=lambda item: float(item.get("start") or 0.0))


CONTENT_DURATION_PROFILES = {
    "music": {"type": "music", "min": 25, "target": 50, "max": 85},
    "podcast": {"type": "podcast", "min": 40, "target": 75, "max": 120},
    "interview": {"type": "interview", "min": 40, "target": 75, "max": 120},
    "news": {"type": "news", "min": 35, "target": 60, "max": 90},
    "review": {"type": "review", "min": 40, "target": 70, "max": 110},
    "vlog": {"type": "vlog", "min": 30, "target": 60, "max": 90},
    "storytelling": {"type": "storytelling", "min": 55, "target": 95, "max": 145},
    "tutorial": {"type": "tutorial", "min": 45, "target": 75, "max": 110},
    "gaming": {"type": "gaming", "min": 25, "target": 50, "max": 80},
}


def candidate_duration_profile(text, content_profile=None):
    video_type = str((content_profile or {}).get("videoType") or "").strip().lower()
    if video_type in CONTENT_DURATION_PROFILES:
        return dict(CONTENT_DURATION_PROFILES[video_type])
    if callable(dynamic_duration_profile):
        return dynamic_duration_profile(text)
    return {"type": "general", "min": 30, "target": 60, "max": 90}


def candidate_duration_bounds(text, minimum, target, maximum, content_profile=None):
    profile = candidate_duration_profile(text, content_profile)
    profile_min = float(profile.get("min") or minimum)
    profile_target = float(profile.get("target") or target)
    profile_max = float(profile.get("max") or maximum)
    effective_min = max(float(minimum), min(profile_min, float(maximum)))
    effective_target = max(effective_min, min(float(target), profile_target, float(maximum)))
    effective_max = max(effective_target, min(float(maximum), profile_max))
    return effective_min, effective_target, effective_max, str(profile.get("type") or "general")


def candidate_topic_key(candidate):
    explicit = clean_text(candidate.get("topic") or "").lower()
    if explicit and explicit != "pembahasan utama":
        return " ".join(normalize_words(explicit)[:4])
    words = [
        word for word in normalize_words(
            candidate.get("text") or candidate.get("transcript") or ""
        )
        if len(word) >= 4 and word not in STOPWORDS_ID
    ]
    return " ".join(list(dict.fromkeys(words))[:4]) or "general"


def candidate_duration_class(duration, minimum, target, maximum):
    duration = float(duration or 0.0)
    short_ceiling = float(minimum) + (float(target) - float(minimum)) * 0.58
    long_floor = float(target) + (float(maximum) - float(target)) * 0.42
    if duration <= short_ceiling:
        return "short"
    if duration >= long_floor:
        return "long"
    return "medium"


def select_diverse_moments(candidates, target_count, transcript, min_duration, target_duration, max_duration, payload, video_duration=0.0):
    candidates = sorted(candidates, key=lambda item: item["score"], reverse=True)
    selected = []
    timeline_ranges = list(payload.get("_timelineRanges") or [])
    exclusion_windows = []
    bucket_size = max(float(max_duration), float(video_duration or 0) / max(int(target_count or 1), 1))
    bucket_counts = {}
    category_counts = {}
    topic_counts = {}
    duration_class_counts = {}
    min_gap = max(float(min_duration) * 0.65, min(float(max_duration), bucket_size * 0.32))
    minimum_score = AUTO_SELECT_MIN_SCORE if bool_payload(payload, "fullAutoMode", False) else AUTO_RENDER_MIN_SCORE

    def too_close_to_selected(candidate):
        center = (candidate["start"] + candidate["end"]) / 2
        for previous in selected:
            previous_center = (previous["start"] + previous["end"]) / 2
            if abs(center - previous_center) < min_gap:
                return True
        return False

    def try_add(candidate, strict_bucket=True, allow_text_repeat=False, allow_nearby=False):
        if len(selected) >= target_count:
            return False
        effective_min, effective_target, effective_max, duration_profile = candidate_duration_bounds(
            candidate.get("text") or candidate.get("transcript") or "",
            min_duration,
            target_duration,
            max_duration,
            payload.get("_contentProfile"),
        )
        improved_start, improved_end, improved_text = improve_story_boundaries(
            candidate["start"],
            min(float(candidate["end"]), float(candidate["start"]) + effective_max),
            transcript,
            effective_min,
            effective_target,
            effective_max,
        )
        candidate["start"] = improved_start
        candidate["end"] = improved_end
        if timeline_ranges:
            clipped = clamp_interval_to_ranges(candidate["start"], candidate["end"], timeline_ranges)
            if not clipped:
                return False
            candidate["start"], candidate["end"] = clipped
            improved_text = transcript_text_between(transcript, candidate["start"], candidate["end"]) or improved_text
        if improved_text:
            candidate["text"] = improved_text
            candidate["transcript"] = improved_text[:700]
        candidate["duration"] = max(5.0, round(candidate["end"] - candidate["start"], 2))
        candidate["time"] = f"{seconds_to_stamp(candidate['start'])} - {seconds_to_stamp(candidate['end'])}"
        candidate.setdefault("metrics", {})["duration_profile"] = duration_profile
        if candidate["duration"] > effective_max:
            candidate["end"] = round(candidate["start"] + float(effective_max), 2)
            candidate["duration"] = round(candidate["end"] - candidate["start"], 2)
            candidate["time"] = f"{seconds_to_stamp(candidate['start'])} - {seconds_to_stamp(candidate['end'])}"
        if candidate["duration"] < effective_min:
            return False
        final_text = transcript_text_between(
            transcript, candidate["start"], candidate["end"]
        )
        if final_text:
            candidate["text"] = final_text
            candidate["transcript"] = final_text[:700]
        revalidate_candidate_after_boundary(
            candidate,
            payload,
            len(selected),
            effective_min,
            effective_max,
        )
        if clamp_score(candidate.get("score"), 0) < minimum_score:
            candidate["rejected"] = True
            candidate["low_quality"] = True
            candidate["render_eligible"] = False
            candidate["auto_render"] = False
            candidate["reject_reason"] = f"Score di bawah {minimum_score}"
            return False
        if bool_payload(payload, "fullAutoMode", False) and not candidate.get("evidence_gate"):
            candidate["rejected"] = True
            candidate["low_quality"] = True
            candidate["render_eligible"] = False
            candidate["auto_render"] = False
            candidate["reject_reason"] = "Evidence gate tidak terpenuhi"
            return False

        metrics = candidate.get("metrics") or {}
        if not allow_nearby and metrics.get("story_complete", 70) < 45:
            return False
        if not allow_nearby and is_in_exclusion(candidate, exclusion_windows):
            return False
        if not allow_nearby and too_close_to_selected(candidate):
            return False
        if overlaps_any(candidate, selected):
            return False
        if not allow_text_repeat and any(text_similarity(candidate.get("text"), prev.get("text")) > 0.58 for prev in selected):
            return False
        category = candidate.get("category") or candidate.get("segment_type") or "Auto"
        category_limit = max(1, math.ceil(target_count / 2))
        if strict_bucket and category_counts.get(category, 0) >= category_limit:
            return False
        topic_key = candidate_topic_key(candidate)
        topic_limit = max(1, math.ceil(target_count / 3))
        if strict_bucket and topic_counts.get(topic_key, 0) >= topic_limit:
            return False
        duration_class = candidate_duration_class(
            candidate["duration"], effective_min, effective_target, effective_max
        )
        duration_limit = max(1, math.ceil(target_count / 2))
        if strict_bucket and duration_class_counts.get(duration_class, 0) >= duration_limit:
            return False
        bucket = int(candidate["start"] / max(bucket_size, 1.0))
        if strict_bucket and bucket_counts.get(bucket, 0) >= 1:
            return False
        selected.append(candidate)
        bucket_counts[bucket] = bucket_counts.get(bucket, 0) + 1
        category_counts[category] = category_counts.get(category, 0) + 1
        topic_counts[topic_key] = topic_counts.get(topic_key, 0) + 1
        duration_class_counts[duration_class] = duration_class_counts.get(duration_class, 0) + 1
        candidate["diversity"] = {
            "topicKey": topic_key,
            "durationClass": duration_class,
            "timelineBucket": bucket,
        }
        candidate.setdefault("selectionReasons", []).append(
            f"Variasi {duration_class} pada topik {topic_key}"
        )
        exclusion_windows.extend(build_exclusion_windows([candidate]))
        return True

    for candidate in candidates:
        try_add(candidate, strict_bucket=True)
        if len(selected) >= target_count:
            break

    if len(selected) < target_count:
        for candidate in candidates:
            if candidate in selected:
                continue
            try_add(candidate, strict_bucket=False)
            if len(selected) >= target_count:
                break

    if len(selected) < target_count:
        for candidate in candidates:
            if candidate in selected:
                continue
            try_add(candidate, strict_bucket=False, allow_text_repeat=False, allow_nearby=True)
            if len(selected) >= target_count:
                break

    ordered = sorted(selected[:target_count], key=lambda item: item["start"])
    for index, item in enumerate(ordered, 1):
        item["id"] = index
    return ordered


def auto_target_clip_count(video_duration, transcript=None):
    duration = max(0.0, float(video_duration or 0.0))
    if duration <= 0:
        return 3
    speech_segments = len(transcript or [])
    density_bonus = 1 if speech_segments > duration / 4 else 0
    if duration < 300:
        base = 1
    elif duration < 900:
        base = 2
    elif duration < 1800:
        base = 3
    elif duration < 3600:
        base = 6
    elif duration < 5400:
        base = 10
    elif duration < 7200:
        base = 14
    elif duration < 14400:
        base = 18
    else:
        base = 16
    return max(1, min(20, base + density_bonus))


def find_moments(info, transcript, payload):
    min_duration, target_duration, max_duration = parse_duration_settings(payload)
    duration = float(info.get("duration") or 0)
    selection_mode = str(payload.get("selectionMode") or "full").lower()
    timeline_ranges = parse_timeline_ranges(payload, duration)
    payload["_timelineRanges"] = timeline_ranges
    if selection_mode in {"range", "multiple"} and not timeline_ranges:
        emit("log", stage="timeline", message="Selected range tidak valid atau berada di luar durasi video. Analisa dibatalkan tanpa fallback ke full video.")
        return []
    working_transcript = filter_transcript_by_ranges(transcript, timeline_ranges)
    if not working_transcript:
        if timeline_ranges:
            message = "Selected range tidak memiliki transcript. Tidak ada moment di luar area pilihan yang dianalisis."
            stage = "timeline"
        else:
            message = "Transkrip belum tersedia. Rekomendasi generik dihentikan agar score dan highlight tidak menjadi palsu."
            stage = "transcript"
        emit("log", stage=stage, message=message)
        return []
    effective_analysis_duration = analysis_duration_from_ranges(duration, timeline_ranges)
    target_count = resolve_target_clip_count(
        payload,
        effective_analysis_duration,
        working_transcript,
        min_duration,
        timeline_ranges,
    )
    if target_count <= 0:
        emit(
            "log",
            stage="timeline",
            message=(
                f"Area analisa tidak memiliki rentang kontinu minimal {int(min_duration)} detik. "
                "Perpanjang selected range atau turunkan minimum duration."
            ),
        )
        return []
    if timeline_ranges:
        area_text = ", ".join(
            f"{seconds_to_stamp(start)}-{seconds_to_stamp(end)}"
            for start, end in timeline_ranges
        )
        result_limit = (
            optional_review_limit(payload, target_count)
            if bool_payload(payload, "fullAutoMode", False)
            else target_count
        )
        emit(
            "log",
            stage="timeline",
            message=(
                f"Selected area dikunci: {area_text}; total={seconds_to_stamp(effective_analysis_duration)}; "
                f"target utama={target_count} clip; batas hasil termasuk Optional={result_limit} clip."
            ),
        )
    if all_recommended_clips_requested(payload):
        emit(
            "log",
            stage="highlight",
            message=(
                f"Mode semua rekomendasi layak: kapasitas timeline {target_count} clip; "
                "quality gate, anti-overlap, dan diversity tetap aktif."
            ),
        )
    elif bool_payload(payload, "autoClipCount", False):
        area_label = (
            f"selected range {seconds_to_stamp(effective_analysis_duration)} dari video {seconds_to_stamp(duration)}"
            if timeline_ranges
            else f"durasi video {seconds_to_stamp(duration)}"
        )
        emit("log", stage="highlight", message=f"Full AI Auto Mode: target clip dinamis {target_count} berdasarkan {area_label}")
    heatmap_result = {
        "status": "not_checked",
        "reason": "Heatmap belum diperiksa untuk analisa ini.",
        "available": False,
        "origin": "unavailable",
        "marker_count": 0,
        "peak_count": 0,
    }
    if callable(load_or_fetch_heatmap):
        try:
            analysis_cache = info.get("_analysis_cache_dir")
            configured_heatmap_cache = info.get("_heatmap_cache_path")
            cache_path = (
                Path(str(configured_heatmap_cache))
                if configured_heatmap_cache
                else Path(str(analysis_cache)) / "youtube-heatmap.json"
                if analysis_cache
                else None
            )
            heatmap_result = load_or_fetch_heatmap(
                info.get("heatmap"),
                info.get("webpage_url") or info.get("original_url") or payload.get("url") or "",
                cache_path=cache_path,
                ranges=timeline_ranges,
            )
            info["_heatmap_peaks"] = list(heatmap_result.get("peaks") or [])
            if heatmap_result.get("available"):
                emit(
                    "log",
                    stage="heatmap evidence",
                    message=(
                        f"YouTube Most Replayed tersedia: {heatmap_result.get('marker_count', 0)} marker, "
                        f"{heatmap_result.get('peak_count', 0)} peak relevan. "
                        f"{heatmap_result.get('reason') or 'Peak dipakai sebagai evidence, bukan batas potong.'}"
                    ),
                )
            else:
                emit(
                    "log",
                    stage="heatmap evidence",
                    message=(
                        f"YouTube Most Replayed tidak dipakai: "
                        f"{heatmap_result.get('reason') or 'data tidak tersedia'}. "
                        "Story/Audio/Visual pipeline tetap berjalan normal."
                    ),
                )
        except Exception as exc:
            warning = (
                "NETWORK_TLS_TIMEOUT"
                if "timeout" in str(exc).lower() or "handshake" in str(exc).lower()
                else "HEATMAP_RUNTIME_ERROR"
            )
            heatmap_result = {
                "status": "network_unavailable" if warning == "NETWORK_TLS_TIMEOUT" else "unavailable",
                "reason": "Most Replayed dilewati untuk sesi ini. Analisa tetap memakai bukti transcript, audio, dan visual.",
                "available": False,
                "origin": "unavailable",
                "marker_count": 0,
                "peak_count": 0,
                "warning": warning,
            }
            info["_heatmap_peaks"] = []
            emit(
                "log",
                stage="heatmap evidence",
                message=f"Heatmap dilewati tanpa menggagalkan analisa: {warning}.",
            )
    else:
        info["_heatmap_peaks"] = []
    info["_heatmap"] = heatmap_result
    segments = build_semantic_segments(info, working_transcript, duration)
    windows = build_editorial_candidate_windows(info, working_transcript, target_count, min_duration, target_duration, max_duration)
    emit("log", stage="ranking", message=f"Ranking Engine: {len(windows)} candidate dianalisis untuk target maksimal {target_count} clip")
    audio_cache = info.get("_audio_cache_dir") or info.get("_analysis_cache_dir")
    audio_timeline = build_audio_activity_timeline(info.get("_source_path"), audio_cache)
    if audio_timeline:
        emit("log", stage="audio evidence", message=f"Audio Evidence: {len(audio_timeline)} detik activity timeline siap")
    if timeline_ranges:
        windows = [item for item in windows if interval_overlaps_ranges(item.get("start"), item.get("end"), timeline_ranges)]

    moments = []
    used_keys = set()
    scoring_total = max(1, len(windows))
    scoring_started = time.perf_counter()
    for index, item in enumerate(windows):
        if index == 0 or (index + 1) % 25 == 0 or index + 1 == scoring_total:
            scoring_progress = min(84.0, 54.0 + ((index + 1) / scoring_total) * 30.0)
            emit(
                "progress",
                stage="quality scoring",
                progress=round(scoring_progress, 1),
                message=(
                    f"Menilai kandidat {index + 1}/{scoring_total} berdasarkan story, hook, payoff, "
                    "dan standalone evidence."
                ),
            )
        start, end = clamp_interval_to_duration(
            item["start"],
            max(float(item["start"]) + min_duration, float(item["end"])),
            duration,
            min_duration,
        )
        key = (round(start, 1), round(end, 1))
        if key in used_keys:
            continue
        used_keys.add(key)
        text = clean_text(item.get("text") or "")
        effective_min, effective_target, effective_max, duration_profile = candidate_duration_bounds(
            text,
            min_duration,
            target_duration,
            max_duration,
            payload.get("_contentProfile"),
        )
        end = min(end, start + effective_max)
        start, end, improved_text = improve_story_boundaries(start, end, working_transcript, effective_min, effective_target, effective_max)
        start, end = clamp_interval_to_duration(start, end, duration, effective_min)
        if improved_text:
            text = transcript_text_between(working_transcript, start, end) or improved_text
        if timeline_ranges:
            clipped = clamp_interval_to_ranges(start, end, timeline_ranges)
            if not clipped:
                continue
            start, end = clipped
            text = transcript_text_between(working_transcript, start, end) or text
        if end <= start:
            continue
        duration_seconds = min(effective_max, end - start)
        if duration_seconds < effective_min:
            continue
        end = min(duration, start + duration_seconds)
        duration_seconds = end - start
        if duration_seconds < effective_min:
            continue
        generated_title = make_title(text, len(moments) + 1, payload)
        moment = {
            "id": len(moments) + 1,
            "title": generated_title,
            "start": round(start, 2),
            "end": round(end, 2),
            "duration": round(duration_seconds, 2),
            "time": f"{seconds_to_stamp(start)} - {seconds_to_stamp(end)}",
            "transcript": text[:420] or "Tidak ada transcript untuk segmen ini.",
            "titleSuggestion": generated_title,
            "segment_type": item.get("segment_type", "Auto"),
            "text": text,
            "story_id": item.get("story_id"),
            "topic": item.get("topic"),
            "story_summary": item.get("summary"),
            "candidate_source": item.get("candidate_source") or item.get("segment_type"),
            "candidate_sources": list(item.get("candidate_sources") or []),
            "candidate_metrics": item.get("metrics") if isinstance(item.get("metrics"), dict) else {},
            "audio_metrics": audio_evidence_between(audio_timeline, start, end),
            "heatmap_metrics": item.get("heatmap_metrics") if isinstance(item.get("heatmap_metrics"), dict) else {},
            "content_profile": dict(payload.get("_contentProfile") or {}),
        }
        moment.update(score_moment_candidate(moment, payload, index, effective_min, effective_max))
        moment.setdefault("metrics", {})["duration_profile"] = duration_profile
        if isinstance(item.get("metrics"), dict):
            moment["evidence_metrics"] = item.get("metrics")
        moments.append(moment)

    emit(
        "log",
        stage="quality scoring",
        message=(
            f"Quality scoring selesai: {len(moments)} kandidat dievaluasi dalam "
            f"{time.perf_counter() - scoring_started:.1f} detik."
        ),
    )
    moments = calibrate_candidate_scores(moments, payload.get("_contentProfile"))
    ai_selections = ai_select_moments(moments, payload, target_count, working_transcript, min_duration, max_duration)
    if ai_selections:
        full_auto = bool_payload(payload, "fullAutoMode", False)
        output_limit = target_count
        if len(ai_selections) < target_count and not full_auto:
            local_fill = select_diverse_moments(
                moments,
                target_count * 2,
                working_transcript,
                min_duration,
                target_duration,
                max_duration,
                payload,
                effective_analysis_duration,
            )
            for candidate in local_fill:
                if len(ai_selections) >= target_count:
                    break
                if overlaps_any(candidate, ai_selections):
                    continue
                if clamp_score(candidate.get("score"), 0) < AUTO_RENDER_MIN_SCORE:
                    continue
                filled = dict(candidate)
                filled["ai_selected"] = False
                filled["score"] = clamp_score(filled.get("score"), 0)
                filled["grade"] = score_grade(filled["score"])
                filled["reason"] = filled.get("reason") or "Dipakai sebagai pelengkap lokal karena AI mengembalikan pilihan kurang dari target."
                ai_selections.append(filled)
            if len(ai_selections) < target_count and duration >= min_duration and len(ai_selections) == 0:
                ai_selections = fill_missing_timeline_moments(
                    ai_selections,
                    info,
                    working_transcript,
                    payload,
                    target_count,
                    min_duration,
                    target_duration,
                    max_duration,
                    duration,
                )
        elif full_auto:
            if all_recommended_clips_requested(payload):
                # AI directs the strongest candidates; the local evidence
                # engine fills any remaining qualified, diverse moments.
                # Optional/weak moments are not silently promoted in this
                # mode, but remain available on a later manual run.
                quality_fill = select_diverse_moments(
                    moments,
                    target_count,
                    working_transcript,
                    min_duration,
                    target_duration,
                    max_duration,
                    payload,
                    effective_analysis_duration,
                )
                for candidate in quality_fill:
                    if len(ai_selections) >= output_limit:
                        break
                    if overlaps_any(candidate, ai_selections):
                        continue
                    if any(text_similarity(candidate.get("text"), selected.get("text")) > 0.62 for selected in ai_selections):
                        continue
                    ai_selections.append(candidate)
                before_optional = len(ai_selections)
                ai_selections = supplement_with_optional_review_candidates(
                    ai_selections,
                    moments,
                    output_limit,
                    effective_analysis_duration,
                )
                optional_count = len(ai_selections) - before_optional
                emit(
                    "log",
                    stage="final selection",
                    message=(
                        f"Mode semua: {len(ai_selections)} rekomendasi setelah AI, evidence, diversity, dan anti-overlap "
                        f"({optional_count} Optional untuk review manual)."
                    ),
                )
            else:
                output_limit = optional_review_limit(payload, target_count)
                before_optional = len(ai_selections)
                ai_selections = supplement_with_optional_review_candidates(
                    ai_selections,
                    moments,
                    output_limit,
                    effective_analysis_duration,
                )
                optional_count = len(ai_selections) - before_optional
                emit(
                    "log",
                    stage="fallback selection",
                    message=(
                        f"AI memilih kurang dari target; hasil dilengkapi menjadi {len(ai_selections)} kandidat "
                        f"dengan {optional_count} Optional evidence lokal."
                    ),
                )
        ordered_ai = sorted(ai_selections[:output_limit], key=lambda item: item["start"])
        for index, item in enumerate(ordered_ai, 1):
            item["id"] = index
            item["score"] = clamp_score(item.get("score"), 75 if item.get("ai_selected") else 0)
            item["grade"] = score_grade(item["score"])
            item["duration"] = round(float(item["end"]) - float(item["start"]), 2)
            item["time"] = f"{seconds_to_stamp(item['start'])} - {seconds_to_stamp(item['end'])}"
        ordered_ai = enforce_moments_in_timeline_ranges(
            ordered_ai,
            timeline_ranges,
            working_transcript,
            min_duration,
        )
        final_ai = apply_title_hook_diversity(revise_moments_with_ai(ordered_ai, payload), payload)
        final_ai = enforce_moments_in_timeline_ranges(
            final_ai,
            timeline_ranges,
            working_transcript,
            min_duration,
        )
        emit("log", stage="final selection", message=f"Final Selection: {len(final_ai)} clip AI tanpa overlap")
        return final_ai

    selections = select_diverse_moments(
        moments,
        target_count,
        working_transcript,
        min_duration,
        target_duration,
        max_duration,
        payload,
        effective_analysis_duration,
    )
    full_auto = bool_payload(payload, "fullAutoMode", False)
    if not selections and moments:
        if full_auto:
            review_target = optional_review_limit(payload, target_count)
            selections = select_review_fallback_moments(
                moments,
                review_target,
                effective_analysis_duration,
            )
            if selections:
                emit(
                    "log",
                    stage="fallback selection",
                    message=(
                        f"Tidak ada kandidat automatic yang lolos evidence gate. Menampilkan {len(selections)} "
                        "kandidat terbaik sebagai Optional tanpa menaikkan score."
                    ),
                )
        else:
            selections = [
                item
                for item in moments
                if clamp_score(item.get("score"), 0) >= AUTO_RENDER_MIN_SCORE
            ][:target_count]
    if full_auto and moments:
        review_target = optional_review_limit(payload, target_count)
        before_optional = len(selections)
        selections = supplement_with_optional_review_candidates(
            selections,
            moments,
            review_target,
            effective_analysis_duration,
        )
        optional_count = len(selections) - before_optional
        if optional_count:
            emit(
                "log",
                stage="fallback selection",
                message=(
                    f"Hasil automatic dilengkapi {optional_count} kandidat Optional yang berbeda dan "
                    "tetap membutuhkan review manual."
                ),
            )
    if (
        not full_auto
        and len(selections) < target_count
        and duration >= min_duration
        and len(selections) == 0
    ):
        selections = fill_missing_timeline_moments(
            selections,
            info,
            working_transcript,
            payload,
            target_count,
            min_duration,
            target_duration,
            max_duration,
            duration,
        )
    selections = enforce_moments_in_timeline_ranges(
        selections,
        timeline_ranges,
        working_transcript,
        min_duration,
    )
    final_local = apply_title_hook_diversity(revise_moments_with_ai(selections, payload), payload)
    final_local = enforce_moments_in_timeline_ranges(
        final_local,
        timeline_ranges,
        working_transcript,
        min_duration,
    )
    emit("log", stage="final selection", message=f"Final Selection: {len(final_local)} clip lokal tanpa overlap")
    return final_local


def transcript_text_between(transcript, start, end):
    return clean_text(" ".join(
        item["text"] for item in transcript_segments_between(transcript, start, end)
    ))


def fill_missing_timeline_moments(selected, info, transcript, payload, target_count, min_duration, target_duration, max_duration, video_duration):
    selected = list(selected)
    if len(selected) >= target_count:
        return selected[:target_count]
    timeline_ranges = list(payload.get("_timelineRanges") or [])
    effective_duration = sum(max(0.0, end - start) for start, end in timeline_ranges) if timeline_ranges else float(video_duration)
    if effective_duration >= (target_count * min_duration * 0.9):
        selected = []
    clip_duration = min(float(max_duration), max(float(min_duration), min(float(target_duration), float(effective_duration) / max(target_count, 1))))
    if clip_duration * target_count > effective_duration:
        clip_duration = max(float(min_duration), float(effective_duration) / max(target_count, 1) * 0.92)
    step = max(clip_duration, float(effective_duration) / max(target_count, 1))
    attempts = []
    if timeline_ranges:
        for range_start, range_end in timeline_ranges:
            range_duration = max(0.0, float(range_end) - float(range_start))
            if range_duration < min_duration:
                continue
            local_step = max(clip_duration, range_duration / max(target_count, 1))
            cursor = float(range_start)
            while cursor < float(range_end) and len(attempts) < target_count * 4:
                start = max(float(range_start), cursor)
                end = min(float(range_end), start + clip_duration)
                if end - start >= min_duration:
                    attempts.append((start, end))
                cursor += local_step
    else:
        cursor = 0.0
        while cursor < video_duration and len(attempts) < target_count * 3:
            start = max(0.0, cursor)
            end = min(float(video_duration), start + clip_duration)
            if end - start >= min_duration:
                attempts.append((start, end))
            cursor += step
    if len(attempts) < target_count:
        if timeline_ranges:
            for range_start, range_end in timeline_ranges:
                end = min(float(range_end), float(range_start) + clip_duration)
                if end - float(range_start) >= min_duration:
                    attempts.append((float(range_start), end))
        else:
            for index in range(target_count):
                start = max(0.0, (float(video_duration) - clip_duration) * index / max(target_count - 1, 1))
                end = min(float(video_duration), start + clip_duration)
                attempts.append((start, end))

    for start, end in attempts:
        if len(selected) >= target_count:
            break
        raw_start, raw_end = start, end
        improved_start, improved_end, improved_text = improve_story_boundaries(start, end, transcript, min_duration, target_duration, max_duration)
        candidate = {
            "start": improved_start,
            "end": improved_end,
        }
        if candidate["end"] - candidate["start"] > float(max_duration) * 1.02:
            candidate["start"] = raw_start
            candidate["end"] = min(float(video_duration), raw_end)
        if candidate["end"] - candidate["start"] > max_duration:
            candidate["end"] = candidate["start"] + float(max_duration)
        if timeline_ranges:
            clipped = clamp_interval_to_ranges(candidate["start"], candidate["end"], timeline_ranges)
            if not clipped:
                continue
            candidate["start"], candidate["end"] = clipped
            improved_text = transcript_text_between(transcript, candidate["start"], candidate["end"]) or improved_text
        candidate["duration"] = round(candidate["end"] - candidate["start"], 2)
        if candidate["duration"] < min_duration:
            continue
        if overlaps_any(candidate, selected):
            continue
        text = improved_text or transcript_text_between(transcript, candidate["start"], candidate["end"])
        if not text:
            text = clean_text(info.get("title") or "Moment lokal dari source cache")
        generated_title = make_title(text, len(selected) + 1, payload)
        moment = {
            "id": len(selected) + 1,
            "title": generated_title,
            "start": round(candidate["start"], 2),
            "end": round(candidate["end"], 2),
            "duration": candidate["duration"],
            "time": f"{seconds_to_stamp(candidate['start'])} - {seconds_to_stamp(candidate['end'])}",
            "transcript": text[:420],
            "titleSuggestion": generated_title,
            "segment_type": "Timeline",
            "text": text,
        }
        moment.update(score_moment_candidate(moment, payload, len(selected), min_duration, max_duration))
        selected.append(moment)

    ordered = sorted(selected[:target_count], key=lambda item: item["start"])
    for index, item in enumerate(ordered, 1):
        item["id"] = index
    return ordered


def make_title(text, index, payload=None):
    # Candidate generation can produce hundreds of windows. Keep their titles
    # deterministic and local; only the quality-gated final set is sent once
    # to revise_moments_with_ai.
    text = clean_text(text)
    lower = text.lower()
    if lower:
        return fyp_title_from_text(text, index)
    words = text.split()
    if len(words) >= 5:
        title = " ".join(words[:9]).strip(" ,.-")
        if len(title) < 26 and len(words) > 9:
            title = " ".join(words[:12]).strip(" ,.-")
        return seo_clean_title(title, f"Moment FYP Pilihan #{index}")
    return f"Moment FYP Pilihan #{index}"


def local_hook_from_text(text):
    return fyp_hook_from_text(text)


def local_hashtags(text, category=None):
    lower = clean_text(text).lower()
    tags = ["shorts", "viral", "fyp"]
    mapping = [
        ("tutorial", ["cara", "tips", "tutorial", "belajar", "step"]),
        ("edukasi", ["kenapa", "penjelasan", "fakta", "ilmu"]),
        ("komedi", ["lucu", "ngakak", "ketawa", "reaksi"]),
        ("motivasi", ["motivasi", "inspirasi", "bangkit"]),
        ("podcast", ["podcast", "cerita", "ngobrol"]),
        ("storytime", ["cerita", "kisah", "dulu"]),
    ]
    for tag, keywords in mapping:
        if any(keyword in lower for keyword in keywords):
            tags.append(tag)
    if category:
        tags.append(safe_filename(str(category)).lower().replace("-", ""))
    result = []
    for tag in tags:
        tag = re.sub(r"[^a-z0-9_]", "", str(tag).lower())
        if tag and tag not in result:
            result.append(tag)
    return result[:8]


def build_clip_metadata(moment, source_info, payload, has_hook=False, has_captions=False, has_watermark=False):
    title = clean_text(moment.get("titleSuggestion") or moment.get("title") or "Clip terbaik")
    transcript = clean_text(moment.get("transcript") or moment.get("text") or "")
    hook_text = make_hook_text(moment, payload) if has_hook else clean_text(moment.get("hook") or title)
    context_text = context_overlay_from_moment(moment) if bool_payload(payload, "introContext", False) or bool_payload(payload, "transformativeMode", False) else ""
    hashtags = local_hashtags(transcript or title, moment.get("category"))
    keywords = []
    for value in extract_specific_terms(transcript or title, 14) + hashtags:
        keyword = clean_text(str(value).replace("_", " "))
        if keyword and keyword.lower() not in {item.lower() for item in keywords}:
            keywords.append(keyword)
    description_seed = transcript[:180] if transcript else title
    youtube_description = f"{description_seed}\n\n" + " ".join(f"#{tag}" for tag in hashtags)
    source_title = source_info.get("title")
    source_channel = source_info.get("channel") or source_info.get("uploader")
    source_url = source_info.get("webpage_url")
    source_credit = clean_text(payload.get("sourceCreditText") or (f"Source: {source_channel}" if source_channel else "Source: user-provided video"))
    if source_credit:
        youtube_description += f"\n\n{source_credit}"
    if bool_payload(payload, "editorialDisclaimer", False):
        youtube_description += "\n\nCuplikan ini diedit dan dirangkum untuk memberi konteks, komentar, dan nilai tambah."
    start_seconds = float(moment.get("start") or 0)
    end_seconds = float(moment.get("end") or (start_seconds + float(moment.get("duration") or 0)))
    score = moment.get("score")
    grade = moment.get("grade")
    ai_assisted = bool(is_ai_enabled(payload) or moment.get("ai_selected"))
    return {
        "metadata_version": "2.1",
        "title": title,
        "hook_text": hook_text,
        "context_text": context_text,
        "start_time": srt_time(start_seconds),
        "end_time": srt_time(end_seconds),
        "duration_seconds": round(max(0, end_seconds - start_seconds), 2),
        "has_hook": bool(has_hook),
        "has_captions": bool(has_captions),
        "has_watermark": bool(has_watermark),
        "transformative_mode": bool_payload(payload, "transformativeMode", False),
        "no_reupload_mode": bool_payload(payload, "noReuploadMode", False),
        "editorial_disclaimer": bool_payload(payload, "editorialDisclaimer", False),
        "youtube_title": title[:95],
        "youtube_description": youtube_description,
        "youtube_tags": hashtags,
        "seo": {
            "title": title[:95],
            "description": youtube_description,
            "hashtags": hashtags,
            "keywords": keywords[:20],
            "category": moment.get("category") or classify_text(transcript or title),
        },
        "source_title": source_title,
        "source_channel": source_channel,
        "source_url": source_url,
        "source_credit": source_credit,
        "score": score,
        "grade": grade,
        "quality": {
            "score": score,
            "grade": grade,
            "score_source": "ai_assisted_editor_metrics" if ai_assisted else "local_editor_metrics",
            "score_is_estimate": True,
            "fake_score": False,
            "auto_render_eligible": bool(moment.get("auto_render")),
            "render_eligible": bool(moment.get("render_eligible", True)),
        },
        "rights": {
            "copyright_status": "not_verified",
            "source_credit": source_credit,
            "user_review_required": True,
            "monetization_guarantee": False,
            "note": "Cliper Studio Plus membantu editing, clipping, subtitle, reframing, dan metadata suggestion. Hak penggunaan konten tetap perlu dicek oleh pengguna sebelum upload.",
        },
        "content_safety": {
            "metadata_fake": False,
            "copyright_claimed": False,
            "removes_original_watermark": False,
            "adds_transformative_elements": bool(has_hook or has_captions or has_watermark or context_text),
            "enhancements": {
                "hook": bool(has_hook),
                "captions": bool(has_captions),
                "watermark": bool(has_watermark),
                "context": bool(context_text),
            },
        },
        "metrics": moment.get("metrics") or {},
        "category": moment.get("category"),
        "speaker": moment.get("speaker") or moment.get("speaker_id") or "auto",
        "aspect_ratio": payload.get("formatProfile") or "9:16 YouTube Shorts",
        "transcript": transcript,
        "keywords": keywords[:20],
        "language": source_info.get("subtitle_language") or payload.get("subtitleLang") or "auto",
        "scene_id": moment.get("scene_id") or moment.get("id"),
        "timestamp": {
            "start_seconds": start_seconds,
            "end_seconds": end_seconds,
            "start": srt_time(start_seconds),
            "end": srt_time(end_seconds),
        },
        "created_at": datetime.now().isoformat(),
    }


def classify_text(text):
    lower = text.lower()
    if any(word in lower for word in ["cara", "how", "tips", "step"]):
        return "Tutorial"
    if any(word in lower for word in ["kenapa", "why", "rahasia", "secret"]):
        return "Hook"
    if any(word in lower for word in ["hasil", "result", "before", "after"]):
        return "Before after"
    return "Insight"


def is_local_source_mode(payload):
    return str((payload or {}).get("sourceMode") or "").lower() == "local"


def local_video_paths(payload):
    paths = []
    for item in payload.get("localVideos") or []:
        if isinstance(item, dict):
            value = item.get("path") or item.get("source_path")
        else:
            value = item
        if value:
            paths.append(str(value))
    if payload.get("localVideoPath"):
        paths.insert(0, str(payload.get("localVideoPath")))
    seen = set()
    result = []
    for value in paths:
        try:
            path = Path(value).expanduser().resolve()
        except Exception:
            continue
        key = str(path).lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(path)
    return result


def local_cache_dir(payload, source_path):
    root = Path(payload.get("cacheRoot") or (Path.home() / ".cliper-studio-plus" / "cache"))
    try:
        stat = Path(source_path).stat()
        cache_key = hashlib.sha1(f"{source_path}|{stat.st_size}|{stat.st_mtime}".encode("utf-8", errors="replace")).hexdigest()[:16]
    except Exception:
        cache_key = hashlib.sha1(str(source_path).encode("utf-8", errors="replace")).hexdigest()[:16]
    folder = root / "local-sources" / cache_key
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def local_video_info(source_path):
    source_path = Path(source_path).expanduser().resolve()
    if not source_path.exists():
        raise RuntimeError(f"Video lokal tidak ditemukan: {source_path}")
    if source_path.suffix.lower() not in {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}:
        raise RuntimeError("Format video lokal belum didukung. Gunakan mp4, mov, mkv, webm, avi, atau m4v.")
    probe = probe_media_file(source_path)
    if not probe.get("valid"):
        raise RuntimeError(f"Video lokal tidak valid: {probe.get('reason')}")
    title = clean_text(source_path.stem.replace("_", " ").replace("-", " ")) or source_path.stem
    info = {
        "id": hashlib.sha1(str(source_path).encode("utf-8", errors="replace")).hexdigest()[:12],
        "title": title_case_upload(title),
        "channel": "Local Video",
        "uploader": "Local Video",
        "duration": float(probe.get("duration") or 0),
        "thumbnail": "",
        "webpage_url": source_path.as_uri(),
        "source_path": str(source_path),
        "ext": source_path.suffix.lower().lstrip("."),
        "probe": probe,
    }
    return info


def parse_srt_timestamp(value):
    match = re.match(r"(\d+):(\d+):(\d+)[,.](\d+)", str(value or "").strip())
    if not match:
        return 0.0
    hours, minutes, seconds, millis = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + int(seconds) + int(millis[:3].ljust(3, "0")) / 1000.0


def load_sidecar_srt(source_path, preferred_language=None):
    source_path = Path(source_path)
    preferred = (str(preferred_language or "") or "").lower()
    candidates = [source_path.with_suffix(".srt")]
    if preferred and preferred.startswith("id"):
        candidates += [source_path.with_suffix(".id.srt")]
    elif preferred and preferred.startswith("en"):
        candidates += [source_path.with_suffix(".en.srt")]
    candidates += [source_path.with_suffix(".id.srt"), source_path.with_suffix(".en.srt")]
    seen = set()
    for path in candidates:
        if not path.exists():
            continue
        key = str(path).lower()
        if key in seen:
            continue
        seen.add(key)
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
            segments = []
            blocks = re.split(r"\n\s*\n", text.replace("\r\n", "\n").replace("\r", "\n"))
            for block in blocks:
                lines = [line.strip() for line in block.split("\n") if line.strip()]
                time_line = next((line for line in lines if "-->" in line), "")
                if not time_line:
                    continue
                left, right = [part.strip() for part in time_line.split("-->", 1)]
                caption = " ".join(line for line in lines if line != time_line and not line.isdigit())
                caption = clean_text(re.sub(r"<[^>]+>", "", caption))
                if caption:
                    start = parse_srt_timestamp(left)
                    end = parse_srt_timestamp(right)
                    if end > start:
                        segments.append({"start": start, "end": end, "text": caption})
            if segments:
                return segments, str(path)
        except Exception as exc:
            emit("log", stage="subtitle", message=f"Sidecar SRT gagal dibaca {path}: {exc}")
    return [], ""


def local_caption_segments(info, payload, source_path):
    sidecar, sidecar_path = load_sidecar_srt(source_path, payload.get("subtitleLang") or payload.get("localSubtitleLang"))
    if sidecar:
        return sidecar, sidecar_path
    text = clean_text(payload.get("localCaptionText") or "")
    if not text:
        return [], ""
    duration = max(1.0, float(info.get("duration") or 0))
    return [{"start": 0.25, "end": max(1.0, min(duration, duration - 0.2)), "text": text}], ""


def local_quick_moment(info, payload, index=1, transcript=None):
    duration = max(1.0, float(info.get("duration") or 0))
    text = clean_text(payload.get("localCaptionText") or " ".join((seg.get("text") or "") for seg in (transcript or [])[:4]) or info.get("title") or "")
    title = title_case_upload(clean_text(info.get("title") or f"Quick Editor Clip {index}"))
    if not title or is_generic_template(title):
        title = pick_best_title(local_title_candidates(text or info.get("title"), index), text or info.get("title"), index)
    hook = pick_best_hook(local_hook_candidates(text or info.get("title")), text or info.get("title"))
    return {
        "id": index,
        "title": title,
        "titleSuggestion": title,
        "hook": hook,
        "reason": "Quick Editor: video lokal sudah dipotong, pipeline fokus finishing short.",
        "start": 0.0,
        "end": duration,
        "duration": duration,
        "time": f"{seconds_to_stamp(0)} - {seconds_to_stamp(duration)}",
        "score": 95,
        "grade": "A",
        "priority": "A",
        "auto_render": True,
        "render_eligible": True,
        "type": "Quick Editor",
        "category": "Local clip",
        "speaker": "Auto speaker",
        "layout": "auto",
        "transcript": text or title,
        "transcript_segments": transcript or [],
        "source_path": info.get("source_path"),
        "source_info": info,
        "metrics": {"hook": 92, "flow": 90, "value": 88, "trend": 86, "cut": 95},
    }


def analyze_local(payload):
    paths = local_video_paths(payload)
    if not paths:
        raise RuntimeError("Pilih minimal 1 video lokal untuk Quick Editor.")
    emit("progress", stage="metadata", progress=8, message="Membaca metadata video lokal")
    moments = []
    transcript_first = []
    first_info = None
    for index, path in enumerate(paths, start=1):
        info = local_video_info(path)
        if first_info is None:
            first_info = info
        transcript, sidecar_path = local_caption_segments(info, payload, path)
        transcript = enrich_transcript_speakers(transcript)
        if index == 1:
            transcript_first = transcript
        cache_dir = local_cache_dir(payload, path)
        write_source_cache_manifest(cache_dir, info, info.get("webpage_url"), path, info.get("probe"), "local")
        write_cache_files(cache_dir, info, transcript, "sidecar" if sidecar_path else "manual/local")
        moment = local_quick_moment(info, payload, index, transcript)
        if sidecar_path:
            moment["subtitle_sidecar"] = sidecar_path
        moments.append(moment)
        emit("log", stage="quick editor", message=f"Local video ready {index}/{len(paths)}: {path}")
    result = {
        "video": {
            "title": first_info.get("title"),
            "channel": "Local Video",
            "duration": first_info.get("duration"),
            "thumbnail": "",
            "webpage_url": first_info.get("webpage_url"),
            "subtitle_language": "sidecar/manual",
            "transcript_segments": len(transcript_first),
            "used_cookies": False,
            "cache_dir": str(local_cache_dir(payload, paths[0])),
            "source_path": first_info.get("source_path"),
            "cache_status": "local",
            "source_mode": "local",
        },
        "moments": moments,
        "transcript": transcript_first,
        "dependencies": check_dependencies(),
        "ai_usage": dict(AI_USAGE),
        "ai_diagnostics": ai_diagnostics_summary(),
        "ai_log_path": str(ai_log_path(payload)),
    }
    emit("progress", stage="done", progress=100, message="Quick Editor siap")
    emit("done", result=result)


def public_heatmap_status(heatmap):
    """Return a small, non-sensitive heatmap summary for the desktop UI."""
    source = heatmap if isinstance(heatmap, dict) else {}
    status = str(source.get("status") or "unavailable").strip().lower()
    allowed_statuses = {
        "available",
        "available_outside_selection",
        "available_no_distinct_peak",
        "not_youtube",
        "not_public",
        "network_unavailable",
        "not_checked",
        "unavailable",
    }
    if status not in allowed_statuses:
        status = "unavailable"
    origin = str(source.get("origin") or "unavailable").strip().lower()
    allowed_origins = {"yt_dlp", "cache", "youtube_watch_page", "not_youtube", "unavailable"}
    if origin not in allowed_origins:
        origin = "unavailable"
    try:
        marker_count = max(0, int(source.get("marker_count") or 0))
    except (TypeError, ValueError):
        marker_count = 0
    try:
        peak_count = max(0, int(source.get("peak_count") or 0))
    except (TypeError, ValueError):
        peak_count = 0
    reason = clean_text(source.get("reason") or "Bukti Most Replayed belum tersedia untuk analisa ini.")[:240]
    return {
        "status": status,
        "reason": reason,
        "available": bool(source.get("available")),
        "origin": origin,
        "markerCount": marker_count,
        "peakCount": peak_count,
    }


def analyze(payload):
    payload = normalize_renderer_settings(payload)
    AI_DEBUG_EVENTS.clear()
    AI_USAGE.update({"input_tokens": 0, "output_tokens": 0, "requests": 0, "errors": 0, "cache_hits": 0, "cache_misses": 0})
    if is_local_source_mode(payload):
        analyze_local(payload)
        return
    yt_dlp = require_yt_dlp()
    url = payload.get("url")
    if not url:
        raise RuntimeError("YouTube URL kosong.")
    emit("progress", stage="metadata", progress=5, message="Mengambil metadata YouTube")
    ydl_opts: Any = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        **youtube_runtime_options(),
    }
    cookie_path = payload.get("cookiesPath")
    info, used_cookies = extract_info_with_cookie_retry(yt_dlp, ydl_opts, url, cookie_path, download=False)

    if bool_payload(payload, "metadataOnly", False):
        language_options = subtitle_language_options(info)
        subtitle_languages = [item["value"] for item in language_options]
        preferred_subtitle = next(
            (language for language in ["id", "id-ID", "en", "en-orig", "en-US"] if language in subtitle_languages),
            subtitle_languages[0] if subtitle_languages else None,
        )
        result = {
            "video": {
                "title": info.get("title"),
                "channel": info.get("channel") or info.get("uploader"),
                "duration": info.get("duration"),
                "thumbnail": info.get("thumbnail"),
                "webpage_url": info.get("webpage_url") or url,
                "subtitle_language": preferred_subtitle,
                "subtitle_languages": subtitle_languages,
                "subtitle_language_options": language_options,
                "transcript_segments": 0,
                "used_cookies": used_cookies,
            },
            "moments": [],
            "dependencies": check_dependencies(),
        }
        emit("progress", stage="done", progress=100, message="Metadata selesai")
        emit("done", result=result)
        return

    emit("progress", stage="subtitle", progress=28, message="Mengambil subtitle/transkrip")
    try:
        subtitle_language, transcript = fetch_transcript(info, payload.get("subtitleLang"))
        transcript = enrich_transcript_speakers(transcript)
    except Exception as exc:
        subtitle_language, transcript = None, []
        emit("log", message=f"Subtitle tidak bisa diambil: {exc}")

    source, cache_dir, downloaded = ensure_source_cached(yt_dlp, info, url, payload, cookie_path)
    info["_analysis_cache_dir"] = str(cache_dir)
    info["_source_path"] = str(source)
    if not transcript:
        analysis_audio_path = cache_dir / ".analysis-transcript.wav"
        emit(
            "progress",
            stage="transcript",
            progress=52,
            message="Subtitle YouTube tidak tersedia, membuat transkrip audio lokal",
        )
        try:
            analysis_payload = dict(payload)
            # The audio fallback is an analysis requirement even when the user
            # later chooses to turn burned captions off for a render.
            analysis_payload["addCaptions"] = True
            analysis_payload["regenerateSubtitlesFromAudio"] = True
            analysis_engine = RenderEngine(
                ffmpeg_path=payload.get("ffmpegPath") or payload.get("ffmpeg_path"),
                logger=emit,
            )
            transcript = transcribe_clip_audio_for_subtitles(
                analysis_engine,
                source,
                0.0,
                float(info.get("duration") or 0.0),
                analysis_audio_path,
                analysis_payload,
            )
            transcript = enrich_transcript_speakers(transcript)
            if transcript:
                subtitle_language = subtitle_language or subtitle_language_for_whisper(analysis_payload) or "auto"
                emit(
                    "log",
                    stage="transcript",
                    message=f"Transkrip audio lokal siap: {len(transcript)} segment. Analisa highlight memakai bukti percakapan.",
                )
            else:
                emit(
                    "log",
                    stage="transcript",
                    message="Transkrip audio lokal kosong. Highlight generik tidak akan dibuat.",
                )
        except Exception as exc:
            emit("log", stage="transcript", message=f"Fallback transkrip audio gagal: {exc}")
        finally:
            try:
                analysis_audio_path.unlink(missing_ok=True)
            except Exception:
                pass
    write_cache_files(cache_dir, info, transcript, subtitle_language)
    content_profile = build_content_profile(info, transcript, payload, subtitle_language)
    write_json_file(cache_dir / "content_profile.json", content_profile)
    payload["_contentProfile"] = content_profile
    story_map = build_story_map(info, transcript, content_profile)
    write_json_file(cache_dir / "story_map.json", story_map)
    payload["_storyMap"] = story_map
    info["_story_map"] = story_map
    info["_content_profile"] = content_profile
    emit(
        "log",
        stage="story map",
        message=(
            f"Story Map siap: {story_map['summary']['storyCount']} story dan "
            f"{story_map['summary']['eventCount']} event berbasis transcript."
        ),
    )
    emit("log", stage="cache", message=f"{'Cached new source' if downloaded else 'Using cached source'}: {source}")

    emit("progress", stage="moments", progress=88, message="Ranking moments dan hapus overlap")
    moments = find_moments(info, transcript, payload)
    write_moments_cache(cache_dir, moments)
    analysis_ranges = list(payload.get("_timelineRanges") or [])
    analysis_duration = analysis_duration_from_ranges(float(info.get("duration") or 0), analysis_ranges)
    analysis_ai_debug_path = Path(cache_dir) / "ai-debug-log.json"
    write_json_file(
        analysis_ai_debug_path,
        {
            "created_at": datetime.now().isoformat(),
            "diagnostics": ai_diagnostics_summary(),
            "usage": dict(AI_USAGE),
            "events": AI_DEBUG_EVENTS,
        },
    )
    result = {
        "video": {
            "title": info.get("title"),
            "channel": info.get("channel") or info.get("uploader"),
            "duration": info.get("duration"),
            "thumbnail": info.get("thumbnail"),
            "webpage_url": info.get("webpage_url") or url,
            "subtitle_language": subtitle_language,
            "transcript_segments": len(transcript),
            "used_cookies": used_cookies,
            "cache_dir": str(cache_dir),
            "source_path": str(source),
            "cache_status": "downloaded" if downloaded else "cached",
            "analysis_mode": str(payload.get("selectionMode") or "full").lower(),
            "analysis_ranges": analysis_ranges,
            "analysis_duration": round(analysis_duration, 2),
            "content_profile": content_profile,
            "content_profile_path": str(cache_dir / "content_profile.json"),
            "story_map": story_map.get("summary") or {},
            "story_map_path": str(cache_dir / "story_map.json"),
            "heatmap": public_heatmap_status(info.get("_heatmap")),
        },
        "moments": moments,
        "transcript": transcript,
        "dependencies": check_dependencies(),
        "ai_usage": dict(AI_USAGE),
        "ai_diagnostics": ai_diagnostics_summary(),
        "ai_log_path": str(ai_log_path(payload)),
        "ai_debug_path": str(analysis_ai_debug_path),
    }
    billing_result = complete_cloud_analysis_job(payload, moments)
    if billing_result:
        result["billing"] = billing_result
    emit("progress", stage="done", progress=100, message="Analisa selesai")
    emit("done", result=result)
    return result


def safe_filename(value):
    value = str(value or "").strip()
    value = re.sub(r"[\U00010000-\U0010FFFF]", "", value)
    value = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "", value)
    value = re.sub(r"\s+", "-", value)
    value = re.sub(r"[.]{2,}", ".", value)
    value = value.strip(" ._-")
    if len(value) > 80:
        value = value[:80].rstrip()
    if not value:
        return "clip_001"
    return value


def title_case_upload(value):
    small_words = {"dan", "di", "ke", "dari", "yang", "atau", "untuk", "dengan"}
    keep_upper = {"ai", "seo", "yt", "mp4", "ffmpeg", "api", "gpu", "cpu", "tiktok", "youtube"}
    words = clean_text(value).split()
    result = []
    for index, word in enumerate(words):
        stripped = re.sub(r"^[^\w]+|[^\w]+$", "", word, flags=re.UNICODE)
        if not stripped:
            continue
        lower = stripped.lower()
        if lower in keep_upper:
            result.append(lower.upper() if lower not in {"tiktok", "youtube"} else lower.title())
        elif index > 0 and lower in small_words:
            result.append(lower)
        else:
            result.append(lower[:1].upper() + lower[1:])
    return " ".join(result)


def seo_upload_title(moment, index=1, payload=None):
    ai_title = ""
    quick_editor = str(moment.get("type") or "").lower() == "quick editor" or bool(moment.get("source_path"))
    approved_title = clean_text(moment.get("titleSuggestion") or moment.get("title") or "")
    source_evidence = profile_source_text(
        moment.get("transcript") or moment.get("text") or moment.get("title") or "",
        payload,
    )
    approved_is_grounded = bool(
        approved_title
        and not is_generic_template(approved_title)
        and len(approved_title.split()) <= 12
        and relevance_ok(approved_title, source_evidence, EDITORIAL_MIN_OVERLAP)
        and editorial_claim_is_grounded(approved_title, source_evidence)
        and title_quality_score(approved_title, source_evidence) >= 58
    )
    if approved_is_grounded:
        emit("log", stage="ai title", message=f"Judul kandidat final dipakai kembali: {approved_title[:90]}")
    elif payload and is_ai_feature_enabled(payload, "title"):
        ai_result = ai_generate_upload_title(moment, payload)
        if ai_result.get("response"):
            generated_title = clean_text(ai_result["response"])
            if (
                not is_generic_template(generated_title)
                and relevance_ok(generated_title, source_evidence, EDITORIAL_MIN_OVERLAP)
                and editorial_claim_is_grounded(generated_title, source_evidence)
                and title_quality_score(generated_title, source_evidence) >= 58
            ):
                ai_title = generated_title
                emit("log", stage="ai title", message=f"AI SEO filename aktif: {ai_title[:90]}")
            else:
                emit("log", stage="ai title", message="Judul AI ditolak karena kurang relevan dengan bukti clip.")
        else:
            emit("log", stage="ai title", message=f"AI SEO filename fallback local: {ai_result.get('error') or 'empty response'}")
    source = (approved_title if approved_is_grounded else "") or ai_title or (
        fyp_title_from_text(moment.get("transcript") or moment.get("text") or "", index)
        or moment.get("hook")
        or approved_title
        or moment.get("transcript")
        or moment.get("text")
        or ""
    )
    source = re.sub(r"#\w+", "", clean_text(source))
    source = re.sub(r"[\U00010000-\U0010FFFF]", "", source)
    source = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", " ", source)
    source = re.sub(r"[^0-9A-Za-zÀ-ÖØ-öø-ÿĀ-ž\u0100-\u024F\u1E00-\u1EFF\s'-]", " ", source)
    source = re.sub(r"\s+", " ", source).strip(" ._-")
    if not source:
        source = f"Moment Terbaik {index}"
    words = source.split()
    title = " ".join(words[:12]) if approved_is_grounded else title_case_upload(" ".join(words[:12]))
    if len(title) < 25 and quick_editor:
        title = title_case_upload(f"{title} Short".strip())
    if len(title) < 25 and not quick_editor:
        transcript_words = clean_text(moment.get("transcript") or moment.get("text") or "").split()
        filler = title_case_upload(" ".join(transcript_words[:10]))
        title = title_case_upload(f"{title} {filler}".strip())
    if len(title) < 25:
        title = f"{title} Dari Video Ini".strip()
    if len(title) > 65:
        trimmed = []
        for word in title.split():
            if len(" ".join(trimmed + [word])) > 65:
                break
            trimmed.append(word)
        title = " ".join(trimmed) or title[:65].rstrip()
    title = FilenameSanitizer.safe_name(title, max_length=65)
    if len(title) < 25:
        title = FilenameSanitizer.safe_name(f"{title} Clip Viral", max_length=65)
    return title or f"Moment Terbaik {index}"


def unique_creator_path(folder, base_title, extension):
    folder = Path(folder)
    base = FilenameSanitizer.safe_name(base_title, max_length=65) or "Moment Terbaik"
    candidate = folder / f"{base}{extension}"
    counter = 2
    while candidate.exists():
        candidate = folder / f"{base} ({counter}){extension}"
        counter += 1
    return candidate


def creator_output_dirs(session_dir):
    labels = {
        "original": "Video Original",
        "clip": "Clip",
        "caption": "Caption",
        "metadata": "Metadata",
        "xml": "XML",
        "thumbnail": "Thumbnail",
    }
    dirs = {key: Path(session_dir) / label for key, label in labels.items()}
    for folder in dirs.values():
        folder.mkdir(parents=True, exist_ok=True)
    return dirs


def link_or_copy_original_source(source, original_dir, info):
    source = Path(source)
    if not source.exists():
        return None
    title = FilenameSanitizer.safe_name(info.get("title") or source.stem, max_length=65)
    target = unique_creator_path(original_dir, title or "Video Original", source.suffix or ".mp4")
    try:
        os.link(source, target)
        return target
    except Exception:
        try:
            shutil.copy2(source, target)
            return target
        except Exception as exc:
            emit("log", stage="source", message=f"Video original tidak bisa disalin ke output: {exc}")
            return None


def write_thumbnail_png(engine, clip_path, thumbnail_path):
    try:
        cmd = [
            engine.ffmpeg_path or "ffmpeg",
            "-y",
            "-ss",
            "00:00:01",
            "-i",
            str(clip_path),
            "-frames:v",
            "1",
            "-vf",
            "scale=540:-1",
            str(thumbnail_path),
        ]
        subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", timeout=30, check=True)
        return thumbnail_path if Path(thumbnail_path).exists() else None
    except Exception as exc:
        emit("log", stage="thumbnail", message=f"Thumbnail PNG gagal dibuat: {exc}")
        return None


def output_dimensions(format_profile, resolution_profile):
    fmt = (format_profile or "9:16").lower()
    res = (resolution_profile or "1080p").lower()
    portrait = {
        "720p": (720, 1280),
        "1080p": (1080, 1920),
        "2k": (1440, 2560),
        "4k": (2160, 3840),
    }
    landscape = {
        "720p": (1280, 720),
        "1080p": (1920, 1080),
        "2k": (2560, 1440),
        "4k": (3840, 2160),
    }
    square = {
        "720p": (720, 720),
        "1080p": (1080, 1080),
        "2k": (1440, 1440),
        "4k": (2160, 2160),
    }
    if "same" in res:
        return None
    if "1:1" in fmt:
        return square.get(res, square["1080p"])
    if "16:9" in fmt:
        return landscape.get(res, landscape["1080p"])
    return portrait.get(res, portrait["1080p"])


def fps_args(payload):
    value = str(payload.get("fpsProfile") or "").lower()
    if "30" in value:
        return ["-r", "30"]
    if "60" in value:
        return ["-r", "60"]
    return []


def bitrate_value(payload, key, fallback=None):
    value = str(payload.get(key) or "").strip()
    if not value:
        return fallback
    if re.match(r"^\d+(?:\.\d+)?[kKmM]?$", value):
        return value
    return fallback


def render_bitrate_settings(payload):
    return {
        "video_bitrate": bitrate_value(payload, "renderVideoBitrate"),
        "maxrate": bitrate_value(payload, "renderVideoMaxrate"),
        "bufsize": bitrate_value(payload, "renderVideoBufsize"),
        "audio_bitrate": bitrate_value(payload, "renderAudioBitrate", "160k"),
    }


def bool_payload(payload, key, default=False):
    value = payload.get(key, default)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.lower() in {"1", "true", "yes", "on", "checked"}
    return bool(value)


def ffmpeg_filter_path(path):
    value = str(path).replace("\\", "/").replace(":", "\\:")
    return value.replace("'", "\\'")


def ffmpeg_fontfile_option(font_path=None):
    if font_path:
        try:
            custom = Path(str(font_path)).expanduser()
            if custom.exists() and custom.suffix.lower() in {".ttf", ".otf"}:
                return f"fontfile='{ffmpeg_filter_path(custom)}'"
        except Exception:
            pass
    candidates = [
        Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "arial.ttf",
        Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "segoeui.ttf",
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        Path("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"),
    ]
    for path in candidates:
        if path.exists():
            return f"fontfile='{ffmpeg_filter_path(path)}'"
    return ""


def ffmpeg_color(value, fallback="white"):
    text = str(value or "").strip()
    if re.match(r"^#[0-9a-fA-F]{6}$", text):
        return "0x" + text[1:]
    if re.match(r"^[0-9a-fA-F]{6}$", text):
        return "0x" + text
    return fallback


def ass_color(value, fallback="#ffffff"):
    text = str(value or fallback).strip()
    if not re.match(r"^#[0-9a-fA-F]{6}$", text):
        text = fallback
    red = text[1:3]
    green = text[3:5]
    blue = text[5:7]
    return f"&H00{blue}{green}{red}&"


def subtitle_font_name(payload):
    font_path = payload.get("subtitleFontPath")
    if font_path:
        name = Path(str(font_path)).stem.strip()
        if name:
            return clean_text(name)
    return clean_text(payload.get("subtitleFontFamily") or "Arial Black") or "Arial Black"


def isolated_subtitle_fonts_dir(font_path):
    """Stage only the selected font so libass never scans unrelated files."""
    if not font_path:
        return None
    source = Path(str(font_path))
    if not source.exists() or not source.is_file():
        return None
    if source.suffix.lower() not in {".ttf", ".otf", ".ttc"}:
        return None
    try:
        stat = source.stat()
        identity = f"{source.resolve()}|{stat.st_size}|{stat.st_mtime_ns}"
        digest = hashlib.sha256(identity.encode("utf-8", errors="replace")).hexdigest()[:16]
        fonts_dir = Path(tempfile.gettempdir()) / "cliper-studio-fonts" / digest
        target = fonts_dir / source.name
        fonts_dir.mkdir(parents=True, exist_ok=True)
        if not target.exists() or target.stat().st_size != stat.st_size:
            shutil.copy2(source, target)
        return fonts_dir
    except Exception as exc:
        emit("log", stage="caption", message=f"Font subtitle khusus tidak dapat disiapkan: {exc}")
        return None


def resolve_logo_path(payload):
    for key in ["logoPath", "defaultLogoPath"]:
        value = payload.get(key)
        if not value:
            continue
        path = Path(str(value)).expanduser()
        if path.exists():
            return path
    app_root = payload.get("appRoot")
    if app_root:
        path = Path(str(app_root)) / "assets" / "icon-512.png"
        if path.exists():
            return path
    return None


def logo_overlay_width(payload):
    dims = output_dimensions(payload.get("formatProfile"), payload.get("resolutionProfile"))
    scale = max(8.0, min(60.0, float(payload.get("logoScale") or 18.0))) / 100.0
    if dims is None:
        return max(96, min(420, int(1080 * scale)))
    width, _height = dims
    return max(72, min(int(width * 0.72), int(width * scale)))


def pct_expr(value, total_expr, size_expr):
    """Place an overlay by its center percentage and keep it inside the frame.

    FFmpeg uses commas to separate filters, including inside a filter graph.
    The commas used by min()/max() must therefore stay escaped in the final
    expression.  Without this, a valid subtitle or watermark plan can fail at
    render time and incorrectly trigger an overlay-free fallback.
    """
    try:
        percent = max(0.0, min(100.0, float(value)))
    except Exception:
        percent = 50.0
    return f"max(0\\,min({total_expr}-{size_expr}\\,{total_expr}*{percent / 100:.4f}-{size_expr}/2))"


def required_output_overlays(payload, logo_path=None):
    """Return overlays the creator explicitly requires in the final MP4.

    These are a render contract, not cosmetic hints.  A fallback may simplify
    an encoder or enhancement chain, but it must never mark a clip successful
    after dropping a requested subtitle or watermark.
    """
    payload = payload or {}
    caption_required = bool_payload(payload, "addCaptions", False) and bool_payload(payload, "burnSubtitle", True)
    text_watermark_required = bool_payload(payload, "addWatermark", False) and bool(clean_text(payload.get("watermarkText") or ""))
    return {
        "captions": caption_required,
        "watermark": bool(logo_path) or text_watermark_required,
    }


def overlay_design_scale(payload):
    dims = output_dimensions(payload.get("formatProfile"), payload.get("resolutionProfile")) or (1080, 1920)
    return max(0.25, float(dims[0]) / 1080.0)


def subtitle_position_override(payload, width, height):
    try:
        x_percent = max(8.0, min(92.0, float(payload.get("subtitleX", 50))))
    except Exception:
        x_percent = 50.0
    try:
        y_percent = max(8.0, min(92.0, float(payload.get("subtitleY", 82))))
    except Exception:
        y_percent = 82.0
    x = int(round(width * x_percent / 100.0))
    y = int(round(height * y_percent / 100.0))
    return rf"{{\an5\pos({x},{y})}}"


def build_logo_overlay_command(engine, source, logo_path, start, duration, output_path, encoder, fps_args_value, video_filter, audio_filter_value, crf, payload):
    base_filter = video_filter or "null"
    opacity = max(0.10, min(1.0, float(payload.get("logoOpacity") or payload.get("watermarkOpacity") or 90) / 100))
    logo_width = logo_overlay_width(payload)
    logo_filter = f"scale={logo_width}:-1,format=rgba,colorchannelmixer=aa={opacity:.2f}"
    rotation = float(payload.get("logoRotation") or 0)
    if abs(rotation) > 0.2:
        radians = rotation * math.pi / 180.0
        logo_filter += f",rotate={radians:.5f}:c=none:ow=rotw(iw):oh=roth(ih)"
    overlay_x = pct_expr(payload.get("logoX", 84), "W", "w")
    overlay_y = pct_expr(payload.get("logoY", 12), "H", "h")
    filter_complex = (
        f"[0:v]{base_filter}[base];"
        f"[1:v]{logo_filter}[logo];"
        f"[base][logo]overlay={overlay_x}:{overlay_y}[v]"
    )
    logo_suffix = Path(str(logo_path)).suffix.lower()
    logo_input_args = ["-stream_loop", "-1", "-i", str(logo_path)] if logo_suffix in {".webm", ".gif", ".mp4", ".mov"} else ["-loop", "1", "-i", str(logo_path)]
    cmd = [
        engine.ffmpeg_path,
        "-y",
        "-ss",
        str(start),
        "-t",
        str(duration),
        "-i",
        str(source),
        *logo_input_args,
        "-filter_complex",
        filter_complex,
        "-map",
        "[v]",
        "-map",
        "0:a?",
        "-c:v",
        encoder,
    ]
    if encoder == "libx264":
        cmd.extend(["-preset", "veryfast"])
        if crf is not None:
            cmd.extend(["-crf", str(crf)])
        cmd.extend(["-threads", str(cpu_thread_count())])
        if bitrate_value(payload, "renderVideoBitrate"):
            cmd.extend(["-b:v", bitrate_value(payload, "renderVideoBitrate")])
    else:
        cmd.extend(["-quality", "balanced", "-b:v", bitrate_value(payload, "renderVideoBitrate", "8M")])
    if bitrate_value(payload, "renderVideoMaxrate"):
        cmd.extend(["-maxrate", bitrate_value(payload, "renderVideoMaxrate")])
    if bitrate_value(payload, "renderVideoBufsize"):
        cmd.extend(["-bufsize", bitrate_value(payload, "renderVideoBufsize")])
    cmd.extend(["-c:a", "aac", "-b:a", bitrate_value(payload, "renderAudioBitrate", "160k")])
    if audio_filter_value:
        cmd.extend(["-af", audio_filter_value])
    cmd.extend(fps_args_value or [])
    cmd.extend([
        "-pix_fmt", "yuv420p",
        "-colorspace", "bt709",
        "-color_primaries", "bt709",
        "-color_trc", "bt709",
        "-color_range", "tv",
        "-shortest", "-movflags", "+faststart", str(output_path),
    ])
    return cmd


def escape_drawtext(value):
    return (
        clean_text(value)
        .replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace(":", "\\:")
        .replace("'", "\\'")
        .replace(",", "\\,")
    )


def drawtext_filter(text, x, y, fontsize=42, color="white", box=True, enable=None, alpha=1.0, border_color="black", shadow=2, font_path=None, border_width=None):
    fontfile = ffmpeg_fontfile_option(font_path)
    parts = ["drawtext"]
    if fontfile:
        parts.append(fontfile)
    parts.extend(
        [
            f"text='{escape_drawtext(text)}'",
            f"x={x}",
            f"y={y}",
            f"fontsize={fontsize}",
            f"fontcolor={ffmpeg_color(color, color)}@{alpha:.2f}",
        ]
    )
    if box:
        parts.extend(["box=1", "boxcolor=black@0.36", "boxborderw=14"])
    resolved_border = max(0, int(border_width if border_width is not None else (2 if shadow else 1)))
    parts.extend([f"borderw={resolved_border}", f"bordercolor={ffmpeg_color(border_color, 'black')}@0.95"])
    if shadow:
        parts.extend([f"shadowx={shadow}", f"shadowy={shadow}", "shadowcolor=black@0.55"])
    if enable:
        parts.append(f"enable='{enable}'")
    return "drawtext=" + ":".join(parts[1:])


def ass_time(seconds):
    total_centis = max(0, int(round(float(seconds or 0.0) * 100)))
    hours, remainder = divmod(total_centis, 360000)
    minutes, remainder = divmod(remainder, 6000)
    secs, centis = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{secs:02d}.{centis:02d}"


def ass_escape(value):
    text = clean_text(value)
    text = text.replace("\\", "\\\\").replace("{", "").replace("}", "")
    return text


def ass_highlight_phrase(text, active_color="&H0000FFFF&", primary_color="&H00FFFFFF&"):
    words = ass_escape(text).split()
    if not words:
        return ""
    source_words = clean_highlight_source_text(text).split()
    active_index = 0
    best_weight = -1
    emphasis_words = {
        "ternyata", "kok", "kenapa", "siapa", "pengakuan", "ditolak", "nembak",
        "makhluk", "astral", "setan", "dingin", "kaget", "hening", "fisik",
        "anak", "bapaknya", "rahasia", "jawaban", "akhirnya", "serius",
    }
    for index, raw_word in enumerate(source_words[: len(words)]):
        normalized = re.sub(r"[^\wÀ-ÖØ-öø-ÿĀ-ž\u0100-\u024F\u1E00-\u1EFF'-]", "", raw_word.lower(), flags=re.UNICODE)
        if not normalized or normalized in STOPWORDS_ID:
            continue
        weight = len(normalized)
        if normalized in emphasis_words:
            weight += 16
        if index in {0, 1}:
            weight += 2
        if weight > best_weight:
            best_weight = weight
            active_index = min(index, len(words) - 1)
    line_break_index = None
    if len(" ".join(words)) > 18 and len(words) > 2:
        half = max(1, min(len(words) - 1, len(words) // 2))
        line_break_index = half
    parts = []
    for index, word in enumerate(words):
        prefix = r"\N" if line_break_index is not None and index == line_break_index else ""
        if index == active_index:
            parts.append(prefix + r"{\c" + active_color + r"\fscx110\fscy110}" + word + r"{\c" + primary_color + r"\fscx100\fscy100}")
        else:
            parts.append(prefix + word)
    return " ".join(parts)


def ass_hook_card_events(hook_text, hook_end, width, height, hook_font):
    """Build a centered safe-area hook card inspired by proven short-form layouts."""
    if not hook_text or float(hook_end or 0.0) <= 0:
        return []
    portrait = height >= width
    card_width = int(width * (0.84 if portrait else 0.64))
    card_height = int(max(hook_font * 3.0, height * (0.145 if portrait else 0.28)))
    card_height = min(card_height, int(height * 0.28))
    card_x = int((width - card_width) / 2)
    # Keep the hook out of the central face/action zone. Short-form portraits
    # commonly place a speaker's eyes around 30-45% of frame height; the old
    # 24.5% origin let a two-line card cover the eyes and mouth. The upper safe
    # area leaves breathing room for platform chrome while ending before that
    # central subject band.
    card_y = int(height * (0.085 if portrait else 0.10))
    accent = max(6, int(round(width * 0.009)))
    center_x = card_x + card_width // 2
    center_y = card_y + card_height // 2
    start = ass_time(0)
    end = ass_time(hook_end)

    def shape(layer, x, y, shape_width, shape_height, color, alpha="&H18&"):
        drawing = f"m 0 0 l {shape_width} 0 l {shape_width} {shape_height} l 0 {shape_height}"
        tags = (
            r"{\an7\pos(" + f"{x},{y}" + r")\p1\bord0\shad0\1c" + color
            + r"\1a" + alpha + r"}"
        )
        return f"Dialogue: {layer},{start},{end},HookBox,,0,0,0,,{tags}{drawing}"

    events = [
        shape(0, card_x - accent, card_y - accent, card_width, accent, "&H00E3D916&", "&H00&"),
        shape(0, card_x - accent, card_y - accent, accent, card_height, "&H00E3D916&", "&H00&"),
        shape(0, card_x + accent, card_y + card_height, card_width, accent, "&H005C38FF&", "&H00&"),
        shape(0, card_x + card_width, card_y + accent, accent, card_height, "&H005C38FF&", "&H00&"),
        shape(1, card_x, card_y, card_width, card_height, "&H00101010&", "&H08&"),
    ]
    formatted_text = ass_highlight_phrase(
        hook_text,
        active_color="&H0000DFFF&",
        primary_color="&H00FFFFFF&",
    )
    text_tags = r"{\an5\pos(" + f"{center_x},{center_y}" + r")\q2}"
    events.append(
        f"Dialogue: 3,{start},{end},Hook,,0,0,0,,{text_tags}{formatted_text}"
    )
    return events


def build_ass_karaoke_line(start, end, text, active_color="#19ff47", default_color="#ffffff", word_highlight=True):
    if not text:
        return ""
    if not word_highlight:
        return ass_highlight_phrase(text, active_color=active_color, primary_color=default_color)
    words = split_ass_tokens(text)
    if not words:
        return ass_escape(text)
    return build_word_highlight_ass_text(start, end, text, active_color=active_color, default_color=default_color, words=None)


def distribute_caption_words(start, end, text, words=None):
    valid = []
    for item in words or []:
        if not isinstance(item, dict):
            continue
        word = clean_text(item.get("word") or "")
        try:
            word_start = float(item.get("start") or 0.0)
            word_end = float(item.get("end") or word_start)
        except Exception:
            continue
        if word and word_end > word_start:
            valid.append({"word": word, "start": max(float(start), word_start), "end": min(float(end), word_end)})
    valid = [item for item in valid if item["end"] > item["start"]]
    if valid:
        return valid

    tokens = clean_text(text).split()
    if not tokens:
        return []
    weights = [max(1, len(re.sub(r"[^\w]", "", token, flags=re.UNICODE))) for token in tokens]
    total = max(1, sum(weights))
    cursor = float(start)
    distributed = []
    for index, token in enumerate(tokens):
        part = (float(end) - float(start)) * weights[index] / total
        token_end = float(end) if index == len(tokens) - 1 else min(float(end), cursor + max(0.08, part))
        distributed.append({"word": token, "start": cursor, "end": token_end})
        cursor = token_end
    return distributed


def subtitle_animation_name(payload_or_value=None):
    if isinstance(payload_or_value, dict):
        value = payload_or_value.get("subtitleAnimation")
    else:
        value = payload_or_value
    normalized = str(value or "Scale").strip().lower()
    aliases = {
        "pop": "pop",
        "fade": "fade",
        "scale": "scale",
        "bounce": "bounce",
        "typewriter": "typewriter",
        "none": "none",
    }
    return aliases.get(normalized, "scale")


def ass_active_word_phrase(words, active_index, active_color, primary_color, animation="Scale"):
    display = [clean_text(item.get("word") or "") for item in words or []]
    display = [word for word in display if word]
    if not display:
        return ""
    animation_name = subtitle_animation_name(animation)
    if animation_name == "typewriter":
        display = display[: max(1, min(len(display), int(active_index) + 1))]
        active_index = len(display) - 1
    line_break = None
    # Keep additional letter spacing inside the safe title area. Thirty
    # characters is conservative for condensed and non-condensed bold fonts.
    if len(" ".join(display)) > 30 and len(display) > 3:
        line_break = max(2, min(len(display) - 1, len(display) // 2))
    parts = []
    for index, raw_word in enumerate(display):
        prefix = r"\N" if line_break is not None and index == line_break else ""
        match = re.match(r"^(.*?)([,.!?;:]*)$", raw_word, flags=re.UNICODE)
        core = ass_escape(match.group(1) if match else raw_word)
        punctuation = ass_escape(match.group(2) if match else "")
        if index == active_index and core:
            animation_tags = {
                "none": r"\fscx100\fscy100",
                "fade": r"\fscx100\fscy100",
                "scale": r"\fscx96\fscy96\t(0,120,\fscx106\fscy106)\t(120,220,\fscx100\fscy100)",
                "pop": r"\fscx88\fscy88\t(0,75,\fscx112\fscy112)\t(75,165,\fscx100\fscy100)",
                "bounce": (
                    r"\fscx92\fscy92"
                    r"\t(0,70,\fscx116\fscy116)"
                    r"\t(70,135,\fscx96\fscy96)"
                    r"\t(135,205,\fscx106\fscy106)"
                    r"\t(205,280,\fscx100\fscy100)"
                ),
                "typewriter": r"\fscx100\fscy100",
            }[animation_name]
            styled = (
                r"{\c" + active_color
                + animation_tags
                + "}"
                + core
                + r"{\c" + primary_color + r"\fscx100\fscy100}"
                + punctuation
            )
        else:
            styled = r"{\c" + primary_color + r"\fscx100\fscy100}" + core + punctuation
        parts.append(prefix + styled)
    return " ".join(parts)


def caption_effect_prefix(payload, word_highlight=False):
    animation = subtitle_animation_name(payload)
    if animation == "fade":
        return r"{\fad(35,30)}" if word_highlight else r"{\fad(90,90)}"
    if word_highlight:
        # Pop, scale, and bounce are applied to the active word so the full
        # subtitle block stays anchored and never jitters between words.
        return ""
    if animation == "scale":
        return r"{\fscx96\fscy96\t(0,180,\fscx100\fscy100)}"
    if animation == "pop":
        return r"{\fad(30,45)\fscx90\fscy90\t(0,90,\fscx110\fscy110)\t(90,190,\fscx100\fscy100)}"
    if animation == "bounce":
        return (
            r"{\fad(25,40)\fscx92\fscy92"
            r"\t(0,80,\fscx114\fscy114)"
            r"\t(80,150,\fscx97\fscy97)"
            r"\t(150,230,\fscx104\fscy104)"
            r"\t(230,310,\fscx100\fscy100)}"
        )
    return ""


def phrase_chunks(words, size=5, max_chars=34):
    chunks = []
    current = []
    for word in words:
        proposed = current + [word]
        proposed_text = " ".join(proposed)
        if current and (len(proposed) > size or len(proposed_text) > max_chars):
            chunks.append(" ".join(current))
            current = [word]
        else:
            current = proposed
    if current:
        chunks.append(" ".join(current))
    return chunks


def subtitle_phrase_chunks(text, max_chars=42, max_words=7):
    text = clean_text(text)
    if not text:
        return []
    words = text.split()
    chunks = []
    current = []
    for raw_word in words:
        word = raw_word.strip()
        if not word:
            continue
        proposed = current + [word]
        proposed_text = " ".join(proposed)
        boundary = bool(re.search(r"[,.!?…:]$", word))
        if current and (len(proposed) > max_words or len(proposed_text) > max_chars):
            chunks.append(" ".join(current))
            current = [word]
        else:
            current = proposed
        if boundary and current:
            joined = " ".join(current)
            if len(joined) >= 8 or len(current) >= 3:
                chunks.append(joined)
                current = []
    if current:
        chunks.append(" ".join(current))
    # Merge very short fragments so the subtitle does not flicker.
    merged = []
    for chunk in chunks:
        if merged and len(chunk) < 9 and len(f"{merged[-1]} {chunk}") <= max_chars:
            merged[-1] = f"{merged[-1]} {chunk}"
        else:
            merged.append(chunk)
    return merged


def timed_chunks_for_segment(start, end, text, max_chars=42, max_words=7):
    chunks = subtitle_phrase_chunks(text, max_chars=max_chars, max_words=max_words)
    if not chunks:
        return []
    duration = max(0.35, float(end) - float(start))
    weights = [max(1, len(normalize_words(chunk))) for chunk in chunks]
    total_weight = max(1, sum(weights))
    cursor = float(start)
    result = []
    for index, chunk in enumerate(chunks):
        part = duration * (weights[index] / total_weight)
        min_part = 0.45 if len(chunk) <= 16 else 0.58
        chunk_end = float(end) if index == len(chunks) - 1 else min(float(end), cursor + max(min_part, part))
        if chunk_end <= cursor:
            chunk_end = min(float(end), cursor + 0.45)
        result.append((cursor, chunk_end, chunk))
        cursor = chunk_end
        if cursor >= float(end):
            break
    return result


def caption_sync_lead_seconds(payload=None):
    try:
        value = float((payload or {}).get("subtitleLeadSeconds") or 0.08)
    except Exception:
        value = 0.08
    return max(0.05, min(0.12, value))


def caption_sync_end_buffer(payload=None):
    try:
        value = float((payload or {}).get("subtitleEndBufferSeconds") or 0.04)
    except Exception:
        value = 0.04
    return max(0.03, min(0.08, value))


def normalized_caption_segments_for_clip(moment, transcript, duration, payload=None):
    """Return transcript segments relative to the rendered clip.

    YouTube captions are usually absolute to the source video, while local clip
    captions/sidecars can already be relative to the clip. Treating relative
    timestamps as absolute is the main reason burned subtitles appear late or
    disappear, so this function detects both formats before building ASS/SRT.
    """
    duration = max(0.1, float(duration or 0.1))
    clip_start = float(moment.get("start") or 0.0)
    clip_end = clip_start + duration
    raw_segments = []
    for segment in transcript or []:
        try:
            seg_start = float(segment.get("start") or 0.0)
            seg_end = float(segment.get("end") or seg_start)
        except Exception:
            continue
        text = clean_text(segment.get("text") or "")
        if seg_end <= seg_start or not text:
            continue
        raw_segments.append({"start": seg_start, "end": seg_end, "text": text})
    if not raw_segments:
        return []

    absolute_hits = [
        item for item in raw_segments
        if item["end"] > clip_start and item["start"] < clip_end
    ]
    max_raw_end = max(item["end"] for item in raw_segments)
    min_raw_start = min(item["start"] for item in raw_segments)
    looks_relative = max_raw_end <= duration + 8 and min_raw_start < max(duration, 12)
    use_relative = looks_relative and len(absolute_hits) < max(1, len(raw_segments) // 3)
    source_segments = raw_segments if use_relative else absolute_hits
    lead = caption_sync_lead_seconds(payload)
    end_buffer = caption_sync_end_buffer(payload)
    result = []
    for item in source_segments:
        if use_relative:
            source_rel_start = item["start"]
            source_rel_end = item["end"]
        else:
            source_rel_start = item["start"] - clip_start
            source_rel_end = item["end"] - clip_start
        visible_start = max(0.0, source_rel_start)
        visible_end = min(duration, source_rel_end)
        visible_text = clip_transcript_segment_text(
            item["text"],
            source_rel_start,
            source_rel_end,
            0.0,
            duration,
        )
        if visible_end <= visible_start or not visible_text:
            continue
        rel_start = max(0.0, visible_start - lead)
        rel_end = min(duration, max(rel_start + 0.28, visible_end + end_buffer))
        if rel_end <= 0 or rel_start >= duration:
            continue
        result.append((max(0.0, rel_start), min(duration, rel_end), visible_text))
    return sorted(result, key=lambda item: item[0])


def build_timed_caption_events(moment, transcript, payload, duration, hook_end):
    # A fixed 32-event cap made captions stop midway through long clips. Keep
    # the same timing algorithm, but size the event budget to clip duration.
    max_events = max(32, min(600, int(math.ceil(float(duration or 1.0) * 2.8))))
    if ProductionSubtitleEngine is not None:
        try:
            engine = ProductionSubtitleEngine(
                lead_seconds=caption_sync_lead_seconds(payload),
                end_pad_seconds=min(caption_sync_end_buffer(payload), 0.08),
            )
            built_events = engine.build_events(
                moment,
                transcript or [],
                duration,
                fallback_text=clean_text(moment.get("transcript") or moment.get("text") or ""),
                max_events=max_events,
            )
            events = []
            for item in built_events or []:
                clean_chunk = clean_text(item.get("text") or "")
                if not clean_chunk:
                    continue
                start = max(0.0, float(item.get("start") or 0.0))
                end = min(float(duration or 0.0), float(item.get("end") or start))
                if end - start < 0.20:
                    continue
                if events:
                    previous = events[-1]
                    same_timeline = (
                        clean_text(previous.get("text") or "").lower() == clean_chunk.lower()
                        and abs(float(previous.get("start") or 0.0) - start) <= 0.03
                        and abs(float(previous.get("end") or 0.0) - end) <= 0.03
                    )
                    if same_timeline:
                        continue
                events.append({
                    "start": start,
                    "end": end,
                    "text": clean_chunk,
                    "speaker_id": item.get("speaker_id") or "",
                    "words": distribute_caption_words(start, end, clean_chunk, item.get("words") or []),
                })
                if len(events) >= max_events:
                    break
            if events:
                return events
        except Exception as exc:
            emit("log", stage="caption", message=f"SubtitleEngine v4 fallback ke legacy timing: {exc}")

    events = []
    for rel_start, rel_end, text in normalized_caption_segments_for_clip(moment, transcript, duration, payload):
        if len(events) >= max_events:
            break
        if not text:
            continue
        if rel_end <= rel_start:
            continue
        for start, end, chunk in timed_chunks_for_segment(rel_start, rel_end, text, max_chars=42, max_words=7):
            clean_chunk = clean_text(chunk)
            if not clean_chunk:
                continue
            if end - start < 0.25:
                continue
            if events:
                previous = events[-1]
                same_timeline = (
                    clean_text(previous.get("text") or "").lower() == clean_chunk.lower()
                    and abs(float(previous.get("start") or 0.0) - float(start)) <= 0.03
                    and abs(float(previous.get("end") or 0.0) - float(end)) <= 0.03
                )
                if same_timeline:
                    continue
            events.append({"start": start, "end": end, "text": clean_chunk, "speaker_id": "", "words": distribute_caption_words(start, end, clean_chunk)})
            if len(events) >= max_events:
                break
    if events:
        return events

    # Production fallback: some videos/short local clips do not expose YouTube
    # subtitle segments, but the highlight engine still carries a transcript
    # excerpt on the moment. Use that excerpt as timed phrase captions instead
    # of silently producing a video with no subtitles.
    fallback_text = clean_text(moment.get("transcript") or moment.get("text") or "")
    if fallback_text:
        words = fallback_text.split()[:96]
        chunks = subtitle_phrase_chunks(" ".join(words), max_chars=42, max_words=7)
        if chunks:
            start_offset = 0.0
            usable = max(1.0, float(duration or 1.0) - start_offset)
            slice_len = max(0.65, usable / max(len(chunks), 1))
            fallback_events = []
            for index, chunk in enumerate(chunks[:max_events]):
                start = start_offset + index * slice_len
                end = min(float(duration), start + slice_len * 0.92)
                if end - start < 0.35:
                    continue
                clean_chunk = clean_text(chunk)
                fallback_events.append({"start": start, "end": end, "text": clean_chunk, "speaker_id": "", "words": distribute_caption_words(start, end, clean_chunk)})
            if fallback_events:
                emit("log", stage="caption", message="Caption dibuat dari transcript moment fallback karena subtitle segment tidak tersedia.")
                return fallback_events
    return []


def feature_flag_enabled(payload, name, fallback=False):
    flags = payload.get("featureFlags") if isinstance(payload.get("featureFlags"), dict) else {}
    return boolean_contract_value(flags.get(name), fallback)


def shift_caption_events(events, offset_seconds, output_duration):
    offset_seconds = max(0.0, float(offset_seconds or 0.0))
    output_duration = max(0.1, float(output_duration or 0.1))
    if offset_seconds <= 0:
        return events
    shifted = []
    for event in events or []:
        start = min(output_duration, max(0.0, float(event.get("start") or 0.0) + offset_seconds))
        end = min(output_duration, max(start, float(event.get("end") or start) + offset_seconds))
        if end - start < 0.20:
            continue
        words = []
        for word in event.get("words") or []:
            word_start = min(output_duration, max(start, float(word.get("start") or 0.0) + offset_seconds))
            word_end = min(output_duration, max(word_start, float(word.get("end") or word_start) + offset_seconds))
            if word_end > word_start:
                words.append({**word, "start": word_start, "end": word_end})
        shifted.append({**event, "start": start, "end": end, "words": words})
    return shifted


def hook_overlay_plan(moment, transcript, payload):
    cached = moment.get("_hookOverlayPlan") if isinstance(moment, dict) else None
    if isinstance(cached, dict):
        return cached
    requested = bool_payload(payload, "addHook", False)
    source_duration = max(0.1, float(moment.get("duration") or 0.1))
    hook_text = make_hook_text(moment, payload) if requested else ""
    preview_events = build_timed_caption_events(
        moment, transcript or [], payload, source_duration, 0.0
    )
    preview_text = " ".join(item.get("text") or "" for item in preview_events[:3])
    enabled = bool(
        requested
        and hook_text
        and not hook_is_duplicate_caption(hook_text, preview_text)
    )
    if requested and not enabled:
        emit(
            "log",
            stage="hook",
            message="Hook intro dilewati karena tidak punya nilai tambah dari dialog pembuka.",
        )
    timeline_v2 = bool(enabled and feature_flag_enabled(payload, "hookV2", False))
    visual_duration = float(hook_seconds(payload)) if timeline_v2 else min(
        float(hook_seconds(payload)), source_duration
    )
    tts_requested = bool(enabled and bool_payload(payload, "addTtsHook", False))
    tts_available = bool(feature_flag_enabled(payload, "ttsTimelineV2", False))
    plan = {
        "requested": requested,
        "enabled": enabled,
        "text": hook_text if enabled else "",
        "mode": "freeze_then_source" if timeline_v2 else "overlay_source",
        "visualDuration": round(visual_duration if enabled else 0.0, 3),
        "sourceOffset": round(visual_duration if timeline_v2 else 0.0, 3),
        "sourceDuration": round(source_duration, 3),
        "outputDuration": round(source_duration + (visual_duration if timeline_v2 else 0.0), 3),
        "ttsRequested": tts_requested,
        "ttsAvailable": tts_available,
        "ttsGenerated": False,
        "ttsDuration": 0.0,
        "ttsFallbackUsed": bool(tts_requested and not tts_available),
    }
    if isinstance(moment, dict):
        moment["_hookOverlayPlan"] = plan
    return plan


def build_ass_caption_file(moment, path, payload, transcript=None):
    source_duration = max(1.0, float(moment.get("duration") or 20))
    hook_plan = hook_overlay_plan(moment, transcript or [], payload)
    hook_enabled = bool(hook_plan.get("enabled"))
    hook_offset = float(hook_plan.get("sourceOffset") or 0.0)
    duration = source_duration + hook_offset
    caption_enabled = bool_payload(payload, "addCaptions", False) and bool_payload(payload, "burnSubtitle", True)
    context_enabled = (bool_payload(payload, "introContext", False) or bool_payload(payload, "transformativeMode", False)) and not hook_enabled and not caption_enabled
    if not hook_enabled and not caption_enabled and not context_enabled:
        return False

    width, height = output_dimensions(payload.get("formatProfile"), payload.get("resolutionProfile")) or (1080, 1920)
    hook_text = clean_text(hook_plan.get("text") or "")
    hook_end = float(hook_plan.get("visualDuration") or 0.0) if hook_enabled else 0.0
    caption_events = build_timed_caption_events(moment, transcript or [], payload, source_duration, 0.0) if caption_enabled else []
    caption_events = shift_caption_events(caption_events, hook_offset, duration)
    if caption_enabled and not caption_events:
        emit("log", stage="caption", message="Caption tidak dibakar karena transcript/SRT/manual caption tidak tersedia.")
        caption_enabled = False
    if not hook_enabled and not caption_enabled and not context_enabled:
        try:
            Path(path).unlink(missing_ok=True)
        except Exception:
            pass
        return False

    design_scale = max(0.25, float(width) / 1080.0)
    configured_caption_font = int(float(payload.get("subtitleFontSize") or 0) or 0)
    design_caption_font = configured_caption_font if configured_caption_font else 84
    caption_font = max(24, min(256, int(round(design_caption_font * design_scale))))
    hook_font = max(24, int(round(58 * design_scale)))
    context_font = max(18, int(round(34 * design_scale)))
    bottom_margin = 250 if height >= 1800 else 150
    top_margin = 72 if height >= 1800 else 42
    context_margin = 178 if height >= 1800 else 112
    font_name = subtitle_font_name(payload)
    primary_color = ass_color(payload.get("subtitlePrimaryColor"), "#ffffff")
    active_color = ass_color(payload.get("subtitleActiveColor"), "#19ff47")
    stroke_color = ass_color(payload.get("subtitleStrokeColor"), "#000000")
    design_shadow = max(0, min(8, int(float(payload.get("subtitleShadow") or 2))))
    shadow = max(0, min(16, int(round(design_shadow * design_scale))))
    outline = max(2, min(16, int(round(5 * design_scale))))
    try:
        configured_spacing = payload.get("subtitleLetterSpacing")
        if configured_spacing not in {None, ""}:
            caption_spacing = float(configured_spacing) * design_scale
        else:
            # Preserve legacy payload appearance. New UI payloads send a
            # design-pixel value and therefore use the WYSIWYG scale above.
            caption_spacing = 1.4 if width >= 1080 else 1.0
    except Exception:
        caption_spacing = 1.4 if width >= 1080 else 1.0
    caption_spacing = max(0.0, min(8.0, caption_spacing))
    caption_effect = caption_effect_prefix(payload)
    word_caption_effect = caption_effect_prefix(payload, word_highlight=True)
    subtitle_animation = subtitle_animation_name(payload)
    word_highlight_enabled = bool_payload(payload, "subtitleWordHighlight", True)
    caption_position = subtitle_position_override(payload, width, height)
    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        # Keep hook copy legible on both light and dark source footage.  The
        # former opaque-box style used black primary text, which made the hook
        # effectively disappear whenever the source was also dark.
        f"Style: Hook,{font_name},{hook_font},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,5,70,70,0,1",
        f"Style: HookBox,{font_name},10,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
        f"Style: Context,{font_name},{context_font},&H00FFFFFF,&H00FFFFFF,&H00101010,&HCC000000,-1,0,0,0,100,100,0,0,3,1,1,8,92,92,{context_margin},1",
        f"Style: Caption,{font_name},{caption_font},{primary_color},{active_color},{stroke_color},&H00000000,-1,0,0,0,100,100,{caption_spacing:.1f},0,1,{outline},{shadow},2,80,80,{bottom_margin},1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    if hook_enabled:
        lines.extend(
            ass_hook_card_events(
                hook_text,
                hook_end,
                width,
                height,
                hook_font,
            )
        )
    if context_enabled:
        context_duration = max(1.0, min(2.2, float(payload.get("contextDuration") or 1.8)))
        context_end = min(duration, context_duration)
        context_text = context_overlay_from_moment(moment)
        if context_end > 0.35 and not hook_is_duplicate_caption(context_text, hook_text):
            lines.append(f"Dialogue: 2,{ass_time(0.15)},{ass_time(context_end)},Context,,0,0,0,,{ass_escape(context_text)}")
    if caption_enabled:
        for event in caption_events:
            start = float(event.get("start") or 0.0)
            end = float(event.get("end") or start)
            text = clean_text(event.get("text") or "")
            if end <= start:
                continue
            # Hook deduplication belongs to the intro only. Applying it to the
            # full clip can remove legitimate short replies at the end.
            if hook_enabled and start < hook_end and hook_is_duplicate_caption(hook_text, text):
                continue
            word_items = distribute_caption_words(start, end, text, event.get("words") or [])
            progressive_words = word_highlight_enabled or subtitle_animation == "typewriter"
            if progressive_words and word_items:
                for word_index, word_item in enumerate(word_items):
                    word_start = max(start, float(word_item.get("start") or start))
                    next_start = float(word_items[word_index + 1].get("start") or end) if word_index + 1 < len(word_items) else end
                    spoken_end = min(end, max(word_start, float(word_item.get("end") or word_start)))
                    # Word highlight follows the acoustic word end. Extending
                    # it through a pause until the next word makes captions
                    # feel late even though their start timestamp is correct.
                    word_end = min(spoken_end, max(word_start + 0.01, next_start))
                    if word_end <= word_start:
                        continue
                    if word_end - word_start < 0.04:
                        # Keep a valid short word without extending its end
                        # past the acoustic timestamp.
                        word_start = max(start, word_end - 0.04)
                    active_phrase = ass_active_word_phrase(
                        word_items,
                        word_index,
                        active_color if word_highlight_enabled else primary_color,
                        primary_color,
                        subtitle_animation,
                    )
                    lines.append(
                        f"Dialogue: 0,{ass_time(word_start)},{ass_time(word_end)},Caption,Word,0,0,0,,"
                        f"{caption_position}{word_caption_effect}{active_phrase}"
                    )
                    # Keep the completed phrase visible in its neutral color
                    # until the caption event ends. This is separate from the
                    # active word timing: the highlight still ends exactly at
                    # the acoustic word boundary.
                    if next_start - word_end >= 0.08:
                        hold_words = word_items[: word_index + 1] if subtitle_animation == "typewriter" else word_items
                        neutral_phrase = ass_active_word_phrase(
                            hold_words,
                            -1,
                            primary_color,
                            primary_color,
                            "None",
                        )
                        lines.append(
                            f"Dialogue: 0,{ass_time(word_end)},{ass_time(min(end, next_start))},Caption,Hold,0,0,0,,"
                            f"{caption_position}{neutral_phrase}"
                        )
            else:
                lines.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Caption,,0,0,0,,{caption_position}{caption_effect}{build_ass_karaoke_line(start, end, text, active_color, primary_color, word_highlight=False)}")
    Path(path).write_text("\n".join(lines), encoding="utf-8")
    return True


def validate_subtitle_sync(moment, transcript, payload, duration, ass_path):
    """Validate the locked clip-relative timeline without changing word timing."""
    source_duration = max(0.1, float(duration or 0.1))
    ass_path = Path(ass_path)
    hook_plan = hook_overlay_plan(moment, transcript or [], payload)
    hook_offset = float(hook_plan.get("sourceOffset") or 0.0)
    duration = source_duration + hook_offset
    expected_events = build_timed_caption_events(moment, transcript or [], payload, source_duration, 0.0)
    expected_events = shift_caption_events(expected_events, hook_offset, duration)
    errors = []
    warnings = []
    expected_words = []
    previous_end = 0.0
    for event in expected_events:
        start = float(event.get("start") or 0.0)
        end = float(event.get("end") or start)
        if not math.isfinite(start) or not math.isfinite(end):
            errors.append("timestamp event bukan angka finite")
            continue
        if start < -0.001 or end > duration + 0.05 or end <= start:
            errors.append(f"event di luar clip {start:.3f}-{end:.3f}")
        if start < previous_end - 0.15:
            warnings.append(f"overlap event {previous_end - start:.3f}s")
        previous_end = max(previous_end, end)
        for word in distribute_caption_words(start, end, event.get("text") or "", event.get("words") or []):
            word_start = float(word.get("start") or start)
            word_end = float(word.get("end") or word_start)
            if not math.isfinite(word_start) or not math.isfinite(word_end) or word_start < -0.001 or word_end > duration + 0.05 or word_end <= word_start:
                errors.append(f"word timestamp invalid {word_start}-{word_end}")
                continue
            expected_words.append(word)

    ass_events = []
    if not ass_path.exists():
        errors.append("file ASS tidak ditemukan")
    else:
        try:
            for line in ass_path.read_text(encoding="utf-8", errors="replace").splitlines():
                if not line.startswith("Dialogue:"):
                    continue
                parts = line.split(",", 9)
                if len(parts) < 10 or parts[3].strip() != "Caption":
                    continue
                start = timestamp_to_seconds(parts[1])
                end = timestamp_to_seconds(parts[2])
                event_name = parts[4].strip()
                text = clean_text(re.sub(r"\{[^}]*\}", "", parts[9]).replace(r"\N", " "))
                if end <= start or start < -0.001 or end > duration + 0.05 or not text:
                    errors.append(f"ASS event invalid {start:.3f}-{end:.3f}")
                    continue
                ass_events.append({"start": start, "end": end, "text": text, "name": event_name})
        except Exception as exc:
            errors.append(f"ASS tidak dapat dibaca: {exc}")

    relevant_words = expected_words
    expected_count = len(relevant_words) if bool_payload(payload, "subtitleWordHighlight", True) else len(expected_events)
    coverage_events = [event for event in ass_events if str(event.get("name") or "").lower() != "hold"]
    coverage_ratio = len(coverage_events) / max(1, expected_count)
    if expected_events and not coverage_events:
        errors.append("ASS tidak memiliki Caption event")
    if expected_count and coverage_ratio < 0.90:
        errors.append(f"coverage ASS hanya {coverage_ratio * 100:.1f}%")
    # Validate two different timelines independently. Word events prove the
    # karaoke highlight tracks speech; all Caption events prove the subtitle
    # remains visible through the intended phrase boundary. A neutral Hold is
    # visually correct after an active word and must not be treated as drift.
    if ass_events:
        actual_first = ass_events[0]["start"]
        actual_last = ass_events[-1]["end"]
        expected_first = float(expected_events[0].get("start") or 0.0) if expected_events else 0.0
        expected_last = float(expected_events[-1].get("end") or duration) if expected_events else duration
        if abs(actual_first - expected_first) > 0.35:
            errors.append(f"awal ASS bergeser {actual_first - expected_first:+.3f}s")
        if abs(actual_last - expected_last) > 0.35:
            errors.append(f"akhir ASS bergeser {actual_last - expected_last:+.3f}s")
    else:
        actual_first = None
        actual_last = None

    highlight_first = coverage_events[0]["start"] if coverage_events else None
    highlight_last = coverage_events[-1]["end"] if coverage_events else None
    if coverage_events and relevant_words:
        expected_word_first = float(relevant_words[0].get("start") or 0.0)
        expected_word_last = float(relevant_words[-1].get("end") or duration)
        if abs(highlight_first - expected_word_first) > 0.35:
            errors.append(f"awal highlight bergeser {highlight_first - expected_word_first:+.3f}s")
        if abs(highlight_last - expected_word_last) > 0.35:
            errors.append(f"akhir highlight bergeser {highlight_last - expected_word_last:+.3f}s")

    signature_payload = [
        [round(float(event.get("start") or 0.0), 3), round(float(event.get("end") or 0.0), 3), clean_text(event.get("text") or "")]
        for event in expected_events
    ]
    timeline_version = hashlib.sha256(json_dumps(signature_payload).encode("utf-8", errors="replace")).hexdigest()[:16]
    return {
        "ok": not errors,
        "timeline_version": timeline_version,
        "clip_duration": round(duration, 3),
        "subtitle_count": len(expected_events),
        "word_count": len(expected_words),
        "ass_event_count": len(ass_events),
        "highlight_event_count": len(coverage_events),
        "hold_event_count": len(ass_events) - len(coverage_events),
        "coverage_ratio": round(coverage_ratio, 4),
        "subtitle_start": round(actual_first, 3) if actual_first is not None else None,
        "subtitle_end": round(actual_last, 3) if actual_last is not None else None,
        "highlight_start": round(highlight_first, 3) if highlight_first is not None else None,
        "highlight_end": round(highlight_last, 3) if highlight_last is not None else None,
        "errors": errors[:12],
        "warnings": warnings[:12],
        "camera_sync": "locked_to_audio_timeline",
        "recovery_count": 0,
    }


def short_caption_chunks(text, max_chunks=5, words_per_chunk=7):
    words = clean_text(text).split()
    if not words:
        return []
    chunks = []
    for offset in range(0, len(words), words_per_chunk):
        chunks.append(" ".join(words[offset:offset + words_per_chunk]))
        if len(chunks) >= max_chunks:
            break
    return chunks


def hook_is_duplicate_caption(hook_text, caption_text):
    hook = clean_text(hook_text)
    caption = clean_text(caption_text)
    if not hook or not caption:
        return False
    caption_head = " ".join(caption.split()[:32])
    if hook.lower() in caption_head.lower() or caption_head.lower() in hook.lower():
        return True
    return text_similarity(hook, caption_head) >= 0.52


def add_text_overlay_filters(filters, payload, moment=None):
    moment = moment or {}
    if bool_payload(payload, "addWatermark", False) and payload.get("watermarkText"):
        design_scale = overlay_design_scale(payload)
        opacity = max(0.1, min(1.0, float(payload.get("watermarkOpacity") or 68) / 100))
        x_expr = pct_expr(payload.get("watermarkTextX", 82), "w", "text_w")
        y_expr = pct_expr(payload.get("watermarkTextY", 20), "h", "text_h")
        design_fontsize = max(20, min(96, int(float(payload.get("watermarkTextSize") or 42))))
        fontsize = max(12, min(256, int(round(design_fontsize * design_scale))))
        design_shadow = max(0, min(8, int(float(payload.get("watermarkTextShadow") or 2))))
        shadow = max(0, int(round(design_shadow * design_scale)))
        border_width = max(1, int(round(2 * design_scale)))
        filters.append(
            drawtext_filter(
                payload.get("watermarkText"),
                x_expr,
                y_expr,
                fontsize=fontsize,
                color=payload.get("watermarkTextColor") or "white",
                box=False,
                alpha=opacity,
                border_color=payload.get("watermarkTextStroke") or "black",
                shadow=shadow,
                font_path=payload.get("watermarkFontPath"),
                border_width=border_width,
            )
        )

    if bool_payload(payload, "creditText", False):
        filters.append(drawtext_filter(payload.get("sourceCreditText") or "Source: YouTube", "32", "h-text_h-34", fontsize=18, alpha=0.72))


def make_hook_text(moment, payload=None):
    source_text = clean_text(moment.get("transcript") or moment.get("text") or moment.get("title") or "")
    default = clean_text(moment.get("hook") or local_hook_from_text(source_text) or moment.get("titleSuggestion") or moment.get("title") or "Bagian ini penting untuk kamu lihat")
    source_evidence = profile_source_text(source_text or default, payload)
    if payload and bool_payload(payload, "addHook", False) and is_ai_feature_enabled(payload, "hook"):
        ai_result = ai_generate_hook(moment, payload)
        if ai_result.get("response"):
            hook = seo_clean_title(ai_result["response"], default)
            if (
                len(hook.split()) <= 12
                and relevance_ok(hook, source_evidence, EDITORIAL_MIN_OVERLAP)
                and editorial_claim_is_grounded(hook, source_evidence)
                and hook_quality_score(hook, source_text or default) >= 58
                and not hook_is_duplicate_caption(hook, source_text)
            ):
                return hook
    if (
        len(default.split()) > 12
        or hook_is_duplicate_caption(default, source_text)
        or not editorial_claim_is_grounded(default, source_evidence)
        or hook_quality_score(default, source_evidence) < 58
    ):
        approved_title = clean_text(moment.get("titleSuggestion") or moment.get("title") or "")
        if hook_quality_score(approved_title, source_evidence) >= 58:
            default = approved_title
        else:
            default = pick_best_hook(content_aware_local_hook_candidates(source_text, payload), source_evidence)
    if not editorial_claim_is_grounded(default, source_evidence) or hook_quality_score(default, source_evidence) <= 0:
        default = pick_best_hook(content_aware_local_hook_candidates(source_text, payload), source_evidence)
    return seo_clean_title(default, "Bagian ini wajib kamu lihat")


def hook_seconds(payload):
    numbers = [int(item) for item in re.findall(r"\d+", str(payload.get("hookDuration") or "3"))]
    return max(1, min(6, numbers[0] if numbers else 3))


def select_encoder(payload):
    if bool_payload(payload, "gpuAcceleration", True):
        available = available_h264_encoders()
        for encoder in ["h264_nvenc", "h264_amf", "h264_qsv"]:
            if encoder in available:
                return encoder, "balanced"
    return "libx264", "veryfast"


def encoder_fallback_chain(engine, payload):
    available = set((engine.probe_result or {}).get("encoders") or [])
    chain = []
    if bool_payload(payload, "gpuAcceleration", True):
        for encoder in ["h264_nvenc", "h264_amf", "h264_qsv"]:
            if encoder in available:
                chain.append(encoder)
    chain.append("libx264")
    return chain


def build_caption_file(moment, path, payload, transcript=None):
    source_duration = max(4, float(moment.get("duration") or 20))
    hook_plan = hook_overlay_plan(moment, transcript or [], payload)
    hook_enabled = bool(hook_plan.get("enabled"))
    hook_offset = float(hook_plan.get("sourceOffset") or 0.0)
    duration = source_duration + hook_offset
    captions_enabled = bool_payload(payload, "addCaptions", False)
    hook_end = float(hook_plan.get("visualDuration") or 0.0) if hook_enabled else 0.0

    lines = []
    index = 1
    if bool_payload(payload, "addHook", False) and not captions_enabled:
        hook = make_hook_text(moment, payload)
        end = min(duration, hook_end)
        lines.append(f"{index}\n{srt_time(0)} --> {srt_time(end)}\n{hook}\n")
        index += 1

    if captions_enabled:
        events = build_timed_caption_events(moment, transcript or [], payload, source_duration, 0.0)
        events = shift_caption_events(events, hook_offset, duration)
        if events:
            for event in events:
                chunk_start = float(event.get("start") or 0.0)
                chunk_end = float(event.get("end") or chunk_start)
                chunk = clean_text(event.get("text") or "")
                if chunk_end <= chunk_start:
                    continue
                lines.append(f"{index}\n{srt_time(chunk_start)} --> {srt_time(chunk_end)}\n{chunk}\n")
                index += 1
            Path(path).write_text("\n".join(lines), encoding="utf-8")
            return True

    if isinstance(transcript, list) and transcript:
        segments = normalized_caption_segments_for_clip(moment, transcript, duration, payload)
        segments = [s for s in segments if s[1] > s[0]]
        seen_texts = set()
        for start, end, text in segments:
            for chunk_start, chunk_end, chunk in timed_chunks_for_segment(start, end, text, max_chars=42, max_words=7):
                if chunk_end <= chunk_start:
                    continue
                normalized_chunk = clean_text(chunk).strip().lower()
                if not normalized_chunk or normalized_chunk in seen_texts:
                    continue
                lines.append(f"{index}\n{srt_time(chunk_start)} --> {srt_time(chunk_end)}\n{chunk}\n")
                seen_texts.add(normalized_chunk)
                index += 1
        if lines:
            Path(path).write_text("\n".join(lines), encoding="utf-8")
            return True

    if captions_enabled:
        fallback_text = clean_text(moment.get("transcript") or moment.get("text") or "")
        chunks = subtitle_phrase_chunks(fallback_text, max_chars=42, max_words=7)[:18]
        if chunks:
            start_offset = 0.0
            usable = max(1, duration - start_offset)
            slice_len = max(0.65, usable / max(len(chunks), 1))
            for chunk_index, chunk in enumerate(chunks):
                start = start_offset + chunk_index * slice_len
                end = min(duration, start + slice_len * 0.92)
                if end <= start:
                    continue
                lines.append(f"{index}\n{srt_time(start)} --> {srt_time(end)}\n{chunk}\n")
                index += 1
            if lines:
                Path(path).write_text("\n".join(lines), encoding="utf-8")
                return True
        try:
            Path(path).unlink(missing_ok=True)
        except Exception:
            pass
        return False

    text = clean_text(moment.get("transcript") or "")
    if not text:
        try:
            Path(path).unlink(missing_ok=True)
        except Exception:
            pass
        return False
    sentence_chunks = [chunk.strip() for chunk in re.split(r"(?<=[.!?])\s+", text) if chunk.strip()]
    chunks = []
    for sentence in sentence_chunks or [text]:
        words = sentence.split()
        if len(words) <= 9:
            chunks.append(sentence)
            continue
        for offset in range(0, len(words), 7):
            chunks.append(" ".join(words[offset : offset + 7]))
    chunks = [chunk.strip() for chunk in chunks if chunk.strip()] or [text]
    start_offset = min(duration - 0.5, hook_offset if hook_enabled else 0)
    usable = max(1, duration - start_offset)
    slice_len = usable / len(chunks)
    for chunk_index, chunk in enumerate(chunks):
        start = start_offset + chunk_index * slice_len
        end = min(duration, start_offset + (chunk_index + 1) * slice_len)
        lines.append(f"{index}\n{srt_time(start)} --> {srt_time(end)}\n{chunk}\n")
        index += 1
    Path(path).write_text("\n".join(lines), encoding="utf-8")
    return True


def subtitle_audio_regeneration_enabled(payload):
    if not bool_payload(payload, "addCaptions", False):
        return False
    if "regenerateSubtitlesFromAudio" in (payload or {}):
        return bool_payload(payload, "regenerateSubtitlesFromAudio", True)
    return True


def subtitle_language_for_whisper(payload):
    language = str((payload or {}).get("subtitleLang") or "").strip().lower()
    if not language or language in {"auto", "automatic", "default"}:
        # Creator videos commonly mix Indonesian, regional languages, English,
        # music, and proper names. Forced Indonesian produced plausible but
        # incorrect words, so Auto must use Whisper language detection.
        return None
    language = language.split("-")[0]
    if re.match(r"^[a-z]{2}$", language):
        return language
    return None


def extract_subtitle_audio(engine, source, start, duration, audio_path):
    audio_path = Path(audio_path)
    audio_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        engine.ffmpeg_path or "ffmpeg",
        "-y",
        "-ss",
        str(max(0.0, float(start or 0.0))),
        "-t",
        str(max(0.5, float(duration or 0.5))),
        "-i",
        str(source),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "wav",
        str(audio_path),
    ]
    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=max(45, int(float(duration or 10) * 4)),
    )
    if proc.returncode != 0 or not audio_path.exists() or audio_path.stat().st_size < 1024:
        raise RuntimeError(f"extract audio gagal: {proc.stdout[-500:]}")
    return audio_path


def get_faster_whisper_model(payload):
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        raise RuntimeError(f"faster-whisper belum tersedia: {exc}") from exc
    model_name = str((payload or {}).get("subtitleWhisperModel") or os.environ.get("CLIPER_WHISPER_MODEL") or "small").strip()
    device = str((payload or {}).get("subtitleWhisperDevice") or os.environ.get("CLIPER_WHISPER_DEVICE") or "cpu").strip()
    compute_type = str((payload or {}).get("subtitleWhisperCompute") or os.environ.get("CLIPER_WHISPER_COMPUTE") or "int8").strip()
    cache_key = (model_name, device, compute_type)
    if cache_key not in WHISPER_MODEL_CACHE:
        WHISPER_MODEL_CACHE[cache_key] = WhisperModel(model_name, device=device, compute_type=compute_type)
    return WHISPER_MODEL_CACHE[cache_key], model_name


def flush_word_group(groups, current):
    if not current:
        return
    text = clean_text(" ".join(item.get("word") or "" for item in current))
    if not text:
        return
    start = min(float(item.get("start") or 0.0) for item in current)
    end = max(float(item.get("end") or start) for item in current)
    if end <= start:
        end = start + 0.35
    groups.append({
        "start": round(max(0.0, start), 3),
        "end": round(max(start + 0.18, end), 3),
        "text": text,
        "words": [
            {
                "word": clean_text(item.get("word") or ""),
                "start": round(max(0.0, float(item.get("start") or 0.0)), 3),
                "end": round(max(float(item.get("start") or 0.0) + 0.04, float(item.get("end") or 0.0)), 3),
                "probability": round(max(0.0, min(1.0, float(item.get("probability") or 0.0))), 3),
            }
            for item in current
            if clean_text(item.get("word") or "")
        ],
    })


def word_timestamp_segments(words, max_words=6, max_chars=38):
    groups = []
    current = []
    for raw in words or []:
        word_text = clean_text(getattr(raw, "word", "") or (raw.get("word") if isinstance(raw, dict) else ""))
        if not word_text:
            continue
        start = getattr(raw, "start", None) if not isinstance(raw, dict) else raw.get("start")
        end = getattr(raw, "end", None) if not isinstance(raw, dict) else raw.get("end")
        if re.fullmatch(r"[\[(](?:musik|music|applause|tepuk tangan|laughter|tertawa)[\])]", word_text, flags=re.IGNORECASE):
            continue
        try:
            item = {
                "word": word_text,
                "start": float(start),
                "end": float(end),
                "probability": float(getattr(raw, "probability", 1.0) if not isinstance(raw, dict) else raw.get("probability", 1.0)),
            }
        except Exception:
            continue
        proposed = current + [item]
        proposed_text = clean_text(" ".join(part["word"] for part in proposed))
        boundary = bool(re.search(r"[,.!?…:]$", word_text))
        if current and (len(proposed) > max_words or len(proposed_text) > max_chars):
            flush_word_group(groups, current)
            current = [item]
        else:
            current = proposed
        if boundary and len(current) >= 3:
            flush_word_group(groups, current)
            current = []
    flush_word_group(groups, current)
    return groups


def transcribe_clip_audio_for_subtitles(engine, source, start, duration, audio_path, payload):
    if not subtitle_audio_regeneration_enabled(payload):
        return []
    try:
        audio_path = extract_subtitle_audio(engine, source, start, duration, audio_path)
        model, model_name = get_faster_whisper_model(payload)
        language = subtitle_language_for_whisper(payload)
        try:
            beam_size = max(1, min(5, int((payload or {}).get("subtitleWhisperBeamSize") or 3)))
        except Exception:
            beam_size = 3
        segments_iter, info = model.transcribe(
            str(audio_path),
            language=language,
            beam_size=beam_size,
            best_of=max(1, beam_size),
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 420, "speech_pad_ms": 180},
            word_timestamps=True,
            condition_on_previous_text=False,
            hallucination_silence_threshold=1.5,
        )
        transcript = []
        for segment in segments_iter:
            no_speech_probability = float(getattr(segment, "no_speech_prob", 0.0) or 0.0)
            average_log_probability = float(getattr(segment, "avg_logprob", 0.0) or 0.0)
            if no_speech_probability >= 0.78 and average_log_probability < -0.8:
                continue
            words = getattr(segment, "words", None)
            word_groups = word_timestamp_segments(words)
            if word_groups:
                for group in word_groups:
                    probabilities = [
                        float(word.get("probability") or 0.0)
                        for word in group.get("words") or []
                        if word.get("probability") is not None
                    ]
                    word_confidence = sum(probabilities) / len(probabilities) if probabilities else 0.5
                    speech_confidence = max(0.0, min(1.0, 1.0 - no_speech_probability))
                    group["confidence"] = round(speech_confidence * 0.55 + word_confidence * 0.45, 3)
                transcript.extend(word_groups)
                continue
            text = clean_text(getattr(segment, "text", ""))
            if text and not re.fullmatch(r"[\[(](?:musik|music|applause|tepuk tangan|laughter|tertawa)[\])]", text, flags=re.IGNORECASE):
                seg_start = float(getattr(segment, "start", 0.0) or 0.0)
                seg_end = float(getattr(segment, "end", seg_start + 0.5) or seg_start + 0.5)
                transcript.append({"start": round(seg_start, 3), "end": round(max(seg_start + 0.25, seg_end), 3), "text": text})
        cleaned = []
        seen = set()
        for item in transcript:
            text = clean_text(item.get("text") or "")
            if not text:
                continue
            key = (round(float(item.get("start") or 0.0), 2), text.lower())
            if key in seen:
                continue
            seen.add(key)
            cleaned.append({
                "start": item["start"],
                "end": item["end"],
                "text": text,
                "words": item.get("words") or [],
                "source": "audio_whisper",
                "confidence": item.get("confidence"),
            })
        if cleaned:
            emit(
                "log",
                stage="caption",
                message=f"Subtitle dibuat ulang dari audio clip memakai faster-whisper {model_name}: {len(cleaned)} segment",
            )
        return cleaned
    except Exception as exc:
        emit("log", stage="caption", message=f"Audio-first subtitle gagal, fallback transcript lama: {exc}")
        return []


def caption_speech_text(value):
    text = re.sub(
        r"[\[(](?:musik|music|applause|tepuk tangan|laughter|tertawa|bersorak|berteriak|sorak|crowd|cheering|booing)[\])]",
        " ",
        clean_text(value or ""),
        flags=re.IGNORECASE,
    )
    return clean_text(text)


def source_caption_transcript_for_clip(moment, transcript, duration, payload=None):
    result = []
    for start, end, raw_text in normalized_caption_segments_for_clip(moment, transcript or [], duration, payload):
        text = caption_speech_text(raw_text)
        if not text:
            continue
        result.append({
            "start": round(start, 3),
            "end": round(end, 3),
            "text": text,
            "words": distribute_caption_words(start, end, text),
            "source": "source_caption_lkg",
            "confidence": None,
        })
    return result


def transcript_anchor_match(anchor, segment_text):
    """Score a model-proposed phrase against local transcript text only."""
    raw_anchor = clean_text(anchor)
    raw_segment = clean_text(segment_text)
    anchor_words = normalize_words(raw_anchor)
    segment_words = normalize_words(raw_segment)
    if len(anchor_words) < 3 or not segment_words:
        return 0.0, "none"
    if raw_anchor.lower() in raw_segment.lower():
        return 1.0, "exact"
    normalized_anchor = " ".join(anchor_words)
    normalized_segment = " ".join(segment_words)
    if normalized_anchor in normalized_segment:
        return 0.94, "normalized"
    anchor_set = set(anchor_words)
    coverage = len(anchor_set & set(segment_words)) / max(1, len(anchor_set))
    longest_run = 0
    for start_index, word in enumerate(segment_words):
        if word not in anchor_set:
            continue
        run = 0
        for offset, expected in enumerate(anchor_words):
            if start_index + offset >= len(segment_words) or segment_words[start_index + offset] != expected:
                break
            run += 1
        longest_run = max(longest_run, run)
    required_run = max(2, min(4, math.ceil(len(anchor_words) * 0.5)))
    if coverage >= 0.72 and longest_run >= required_run:
        return min(0.90, 0.62 + coverage * 0.30), "fuzzy"
    return 0.0, "none"


def align_ai_boundary_anchors(start, end, transcript, start_anchor, end_anchor, max_duration):
    """Map AI phrases to local subtitle timecodes; never trust model timestamps."""
    original_start = float(start)
    original_end = float(end)
    search_radius = max(45.0, min(150.0, float(max_duration) * 1.5))

    def find(anchor, reference, prefer_end=False):
        best = None
        for item in transcript or []:
            try:
                seg_start = float(item.get("start") or 0.0)
                seg_end = float(item.get("end") or seg_start)
            except Exception:
                continue
            if seg_end < reference - search_radius or seg_start > reference + search_radius:
                continue
            score, mode = transcript_anchor_match(anchor, item.get("text") or "")
            if score <= 0:
                continue
            distance = abs((seg_end if prefer_end else seg_start) - reference)
            candidate = (score, -distance, seg_start, seg_end, mode)
            if best is None or candidate > best:
                best = candidate
        return best

    start_match = find(start_anchor, original_start, False)
    end_match = find(end_anchor, original_end, True)
    aligned_start = start_match[2] if start_match else original_start
    aligned_end = end_match[3] if end_match else original_end
    # Do not accept an anchor pair that inverts the scene or lets the model
    # jump to a distant unrelated passage. Boundary refinement remains the
    # source of truth for duration and natural sentence edges.
    if aligned_end <= aligned_start + 3.0 or aligned_end - aligned_start > float(max_duration) * 1.35:
        aligned_start, aligned_end = original_start, original_end
        start_match = None
        end_match = None
    return aligned_start, aligned_end, {
        "start": {"matched": bool(start_match), "mode": start_match[4] if start_match else "none"},
        "end": {"matched": bool(end_match), "mode": end_match[4] if end_match else "none"},
    }


def subtitle_transcript_quality(transcript, duration):
    duration = max(0.1, float(duration or 0.1))
    words = []
    confidences = []
    first_start = None
    last_end = None
    for segment in transcript or []:
        text = caption_speech_text(segment.get("text") or "")
        words.extend(normalize_words(text))
        try:
            start = max(0.0, float(segment.get("start") or 0.0))
            end = min(duration, float(segment.get("end") or start))
            if end > start:
                first_start = start if first_start is None else min(first_start, start)
                last_end = end if last_end is None else max(last_end, end)
        except Exception:
            pass
        confidence = segment.get("confidence")
        if confidence is not None:
            try:
                confidences.append(max(0.0, min(1.0, float(confidence))))
            except Exception:
                pass
    return {
        "word_count": len(words),
        "words_per_minute": round(len(words) / duration * 60.0, 2),
        "average_confidence": round(sum(confidences) / len(confidences), 3) if confidences else None,
        "timeline_span": round(max(0.0, (last_end or 0.0) - (first_start or 0.0)), 3),
    }


def choose_caption_transcript(regenerated, source_fallback, duration):
    audio_quality = subtitle_transcript_quality(regenerated, duration)
    source_quality = subtitle_transcript_quality(source_fallback, duration)
    audio_words = int(audio_quality["word_count"])
    source_words = int(source_quality["word_count"])
    audio_confidence = audio_quality.get("average_confidence")
    fallback_reason = ""

    if not regenerated:
        fallback_reason = "audio_transcript_empty"
    elif audio_words < 3 and source_words >= 3:
        fallback_reason = "audio_word_count_too_low"
    elif audio_confidence is not None and audio_confidence < 0.42 and source_words >= 3:
        fallback_reason = "audio_confidence_too_low"
    elif source_words >= 8 and audio_words < source_words * 0.45:
        fallback_reason = "audio_coverage_below_source"

    if fallback_reason and source_fallback:
        return source_fallback, "source_caption_lkg", {
            "selected": "source_caption_lkg",
            "reason": fallback_reason,
            "audio": audio_quality,
            "source": source_quality,
        }
    if regenerated:
        return regenerated, "audio_whisper", {
            "selected": "audio_whisper",
            "reason": "audio_quality_accepted",
            "audio": audio_quality,
            "source": source_quality,
        }
    return source_fallback, "source_caption_lkg", {
        "selected": "source_caption_lkg" if source_fallback else "none",
        "reason": fallback_reason or "no_caption_candidate",
        "audio": audio_quality,
        "source": source_quality,
    }


def smooth_focus_points(points, alpha=0.88):
    if not points:
        return []
    smoothed = [float(points[0])]
    current = float(points[0])
    for point in points[1:]:
        current = current * alpha + float(point) * (1 - alpha)
        smoothed.append(current)
    return smoothed


def calm_camera_keyframes(points, duration, max_points=5, min_gap=2.75, max_step=0.12):
    if not points:
        return []
    duration = max(0.0, float(duration or 0.0))
    stride = max(1, math.ceil(len(points) / max_points))
    keyframes = []
    previous_t = -999.0
    previous_x = max(0.12, min(0.88, float(points[0])))
    for point_index in range(0, len(points), stride):
        relative_time = duration * (point_index + 0.5) / max(len(points), 1)
        if keyframes and relative_time - previous_t < min_gap:
            continue
        raw_x = max(0.12, min(0.88, float(points[point_index])))
        if keyframes:
            delta = max(-max_step, min(max_step, raw_x - previous_x))
            x = previous_x + delta
        else:
            x = raw_x
        keyframes.append({"t": round(relative_time, 2), "x": round(x, 4)})
        previous_t = relative_time
        previous_x = x
    last_time = round(max(0.0, duration - 0.35), 2)
    if last_time > 0 and (not keyframes or keyframes[-1]["t"] < last_time - min_gap):
        last_x = max(0.12, min(0.88, float(points[-1])))
        if keyframes:
            last_x = keyframes[-1]["x"] + max(-max_step, min(max_step, last_x - keyframes[-1]["x"]))
        keyframes.append({"t": last_time, "x": round(last_x, 4)})
    return keyframes


def visual_cut_keyframes(points, duration, max_points=8, min_gap=2.5, deadzone=0.075):
    """Convert verified human centers into stable hard-cut camera positions.

    Points are face/body centers, not generic motion centroids. Keeping the
    measured subject position avoids the old LEFT/CENTER/RIGHT quantization
    error that could move a valid face out of a narrow 9:16 crop.
    """
    if not points:
        return []
    duration = max(0.0, float(duration or 0.0))
    stride = max(1, math.ceil(len(points) / max_points))
    keyframes = []
    previous_t = -999.0
    previous_x = None
    for point_index in range(0, len(points), stride):
        raw_point = points[point_index]
        raw_x = raw_point.get("x") if isinstance(raw_point, dict) else raw_point
        focus_x = round(max(0.08, min(0.92, float(raw_x))), 4)
        relative_time = 0.0 if not keyframes else duration * (point_index + 0.5) / max(len(points), 1)
        if keyframes and relative_time - previous_t < min_gap:
            continue
        if previous_x is not None and abs(focus_x - previous_x) < max(0.0, float(deadzone)):
            continue
        keyframes.append({"t": round(relative_time, 2), "x": focus_x})
        previous_t = relative_time
        previous_x = focus_x
    return keyframes


def clip_relative_transcript_segments(transcript, moment=None, duration=None):
    """Normalize source-absolute and clip-relative transcript timestamps.

    Camera, subtitle, and render plans must share the same clip-local clock.
    This helper intentionally does not apply subtitle lead/lag.
    """
    moment = moment or {}
    clip_start = float(moment.get("start") or 0.0)
    clip_duration = max(
        0.1,
        float(duration or moment.get("duration") or (float(moment.get("end") or clip_start) - clip_start) or 0.1),
    )
    raw = []
    for item in transcript or []:
        if not isinstance(item, dict):
            continue
        try:
            start = float(item.get("start") or 0.0)
            end = float(item.get("end") or start)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(start) or not math.isfinite(end) or end <= start:
            continue
        raw.append((item, start, end))
    if not raw:
        return []

    max_end = max(item[2] for item in raw)
    min_start = min(item[1] for item in raw)
    absolute_hits = [
        item
        for item in raw
        if item[2] > clip_start and item[1] < clip_start + clip_duration
    ]
    looks_relative = max_end <= clip_duration + 8.0 and min_start < max(clip_duration, 12.0)
    use_relative = looks_relative and len(absolute_hits) < max(1, len(raw) // 3)
    source = raw if use_relative else absolute_hits
    result = []
    for item, start, end in source:
        relative_start = start if use_relative else start - clip_start
        relative_end = end if use_relative else end - clip_start
        relative_start = max(0.0, relative_start)
        relative_end = min(clip_duration, relative_end)
        if relative_end <= relative_start:
            continue
        result.append(
            {
                **item,
                "start": round(relative_start, 4),
                "end": round(relative_end, 4),
                "timeline_source": "relative" if use_relative else "source_absolute",
            }
        )
    return sorted(result, key=lambda item: (item["start"], item["end"]))


def speaker_timeline_context(transcript, moment=None, duration=None):
    speakers = []
    intervals = []
    for item in clip_relative_transcript_segments(transcript, moment, duration):
        speaker = str(item.get("speaker_id") or item.get("speaker") or "").strip()
        if not speaker or speaker.lower() in {"auto", "speaker auto"}:
            continue
        verified = item.get("speaker_verified")
        if verified is None:
            # Older source-caption caches may contain synthetic A/B/C labels.
            # Keep named diarization labels, but never treat generic labels as
            # proof that a real speaker was identified.
            verified = speaker.upper() not in {"A", "B", "C", "S1", "S2", "S3"}
        if not bool(verified):
            continue
        if speaker not in speakers:
            speakers.append(speaker)
        intervals.append(
            {
                "start": float(item["start"]),
                "end": float(item["end"]),
                "speaker": speaker,
                "confidence": max(0.0, min(1.0, float(item.get("speaker_confidence") or 0.75))),
            }
        )

    turns = []
    for interval in intervals:
        if (
            turns
            and turns[-1]["speaker"] == interval["speaker"]
            and interval["start"] - turns[-1]["end"] <= 0.45
        ):
            turns[-1]["end"] = max(turns[-1]["end"], interval["end"])
            turns[-1]["confidence"] = max(turns[-1]["confidence"], interval["confidence"])
        else:
            turns.append(dict(interval))

    overlap = 0.0
    for index, left in enumerate(intervals):
        for right in intervals[index + 1:]:
            if left["speaker"] == right["speaker"]:
                continue
            overlap = max(
                overlap,
                max(0.0, min(left["end"], right["end"]) - max(left["start"], right["start"])),
            )
    metrics = (moment or {}).get("metrics") or {}
    emotion = max(
        float(metrics.get("emotion") or 0),
        float(metrics.get("surprise") or 0),
        float(metrics.get("conflict") or 0),
    ) / 100.0
    return {
        "speakers": speakers,
        "speaker_count": len(speakers),
        "turns": turns,
        "overlap_seconds": round(overlap, 3),
        "emotion": max(0.0, min(1.0, emotion)),
    }


def editor_story_beats(transcript, moment, duration):
    """Extract grounded local editorial events without inventing timestamps."""
    keyword_groups = {
        "reveal": {"ternyata", "rupanya", "rahasia", "terungkap", "baru tahu"},
        "payoff": {"akhirnya", "hasilnya", "kesimpulannya", "makanya", "jadi"},
        "conflict": {"tetapi", "tapi", "namun", "masalah", "gagal", "ditolak", "takut"},
        "important_statement": {"penting", "harus", "paling", "serius", "faktanya", "intinya"},
    }
    question_words = {
        "apa",
        "apakah",
        "bagaimana",
        "berapa",
        "di mana",
        "dimana",
        "gimana",
        "kapan",
        "kenapa",
        "kok",
        "mana",
        "mengapa",
        "menurut",
        "siapa",
    }
    candidates = []
    for item in clip_relative_transcript_segments(transcript, moment, duration):
        text = clean_text(item.get("text") or "")
        if not text:
            continue
        lower = text.lower()
        words = set(normalize_words(lower))
        speaker = str(item.get("speaker_id") or item.get("speaker") or "").strip()
        speaker_verified = bool(item.get("speaker_verified"))
        beat_type = None
        confidence = 0.0
        if "?" in text or words.intersection(question_words):
            beat_type = "question"
            confidence = 0.72
        for label, keywords in keyword_groups.items():
            hits = sum(1 for keyword in keywords if keyword in lower)
            if hits and 0.68 + min(0.18, hits * 0.06) > confidence:
                beat_type = label
                confidence = 0.68 + min(0.18, hits * 0.06)
        if "!" in text or text.count("...") >= 1:
            if 0.74 > confidence:
                beat_type = "emotion_peak"
                confidence = 0.74
        importance = float(item.get("importance_score") or 0.0) / 100.0
        emotion = float(item.get("emotion_score") or 0.0) / 100.0
        if max(importance, emotion) >= 0.72 and max(importance, emotion) > confidence:
            beat_type = "important_statement" if importance >= emotion else "emotion_peak"
            confidence = max(importance, emotion)
        if beat_type:
            candidates.append(
                {
                    "time": round(float(item["start"]), 3),
                    "end": round(float(item["end"]), 3),
                    "type": beat_type,
                    "confidence": round(max(0.0, min(1.0, confidence)), 3),
                    "text": text[:180],
                    "evidence": "transcript",
                    "speaker": speaker or None,
                    "speaker_verified": speaker_verified,
                }
            )

    selected = []
    for item in sorted(candidates, key=lambda value: (-value["confidence"], value["time"])):
        if any(abs(item["time"] - existing["time"]) < 2.0 for existing in selected):
            continue
        selected.append(item)
        if len(selected) >= 8:
            break
    selected.sort(key=lambda item: item["time"])
    return selected


def verified_camera_speakers(speaker_context):
    """Build camera subjects only from verified diarization labels."""
    context = speaker_context or {}
    labels = [
        clean_text(label)
        for label in context.get("speakers") or []
        if clean_text(label)
    ]
    if not labels:
        return [{"speaker": "subject", "zone": "CENTER"}], 1, False
    if len(labels) == 1:
        zones = ["CENTER"]
    elif len(labels) == 2:
        zones = ["LEFT", "RIGHT"]
    else:
        zones = ["LEFT", "CENTER", "RIGHT"]
    speakers = [
        {"speaker": label, "zone": zones[min(index, len(zones) - 1)]}
        for index, label in enumerate(labels[:3])
    ]
    return speakers, len(speakers), True


def should_enable_split_screen(moment, speaker_context, duration, max_faces, average_faces, average_span, jitter):
    speaker_context = speaker_context or {}
    split_requested = (
        str((moment or {}).get("layout") or (moment or {}).get("layout_suggestion") or "").lower() == "split"
    )
    verified_speaker_overlap = bool(
        speaker_context.get("speaker_count", 0) >= 2
        and speaker_context.get("overlap_seconds", 0.0) > 1.0
    )
    if split_requested and verified_speaker_overlap:
        return True
    return bool(
        float(duration or 0) >= 12
        and int(max_faces or 0) >= 2
        and float(average_faces or 0) >= 1.65
        and float(average_span or 0) >= 0.44
        and float(jitter or 0) <= 0.28
        and verified_speaker_overlap
    )


def human_shot_eligibility(
    detection_ratio,
    human_coverage,
    safe_visibility_ratio,
    person_count,
    face_count,
):
    """Validate whether tracked humans are strong enough for a portrait crop."""
    detection_ratio = max(0.0, min(1.0, float(detection_ratio or 0.0)))
    human_coverage = max(0.0, min(1.0, float(human_coverage or 0.0)))
    safe_visibility_ratio = max(0.0, min(1.0, float(safe_visibility_ratio or 0.0)))
    person_count = max(0, int(person_count or 0))
    face_count = max(0, int(face_count or 0))
    rejection_reasons = []
    if person_count < 1:
        rejection_reasons.append("no verified human detection")
    if detection_ratio < 0.24:
        rejection_reasons.append("human detection coverage too low")
    if human_coverage < 0.08:
        rejection_reasons.append("human subject too small for portrait crop")
    if safe_visibility_ratio < 0.62:
        rejection_reasons.append("human subject is too close to frame edge")

    composition_score = bounded_score(
        min(1.0, detection_ratio / 0.72) * 34
        + min(1.0, human_coverage / 0.28) * 34
        + safe_visibility_ratio * 24
        + min(1.0, max(face_count, person_count) / 2.0) * 8,
        0,
        100,
    )
    if composition_score < 58:
        rejection_reasons.append("portrait composition confidence too low")
    return {
        "eligible": not rejection_reasons,
        "compositionScore": composition_score,
        "humanCoverage": round(human_coverage, 4),
        "backgroundRatio": round(max(0.0, 1.0 - human_coverage), 4),
        "safeVisibility": round(safe_visibility_ratio, 4),
        "rejectionReasons": rejection_reasons,
    }


def detection_box_iou(left, right):
    left_x1 = float(left.get("x") or 0.5) - float(left.get("w") or 0.0) / 2
    left_y1 = float(left.get("y") or 0.5) - float(left.get("h") or 0.0) / 2
    left_x2 = left_x1 + float(left.get("w") or 0.0)
    left_y2 = left_y1 + float(left.get("h") or 0.0)
    right_x1 = float(right.get("x") or 0.5) - float(right.get("w") or 0.0) / 2
    right_y1 = float(right.get("y") or 0.5) - float(right.get("h") or 0.0) / 2
    right_x2 = right_x1 + float(right.get("w") or 0.0)
    right_y2 = right_y1 + float(right.get("h") or 0.0)
    overlap_w = max(0.0, min(left_x2, right_x2) - max(left_x1, right_x1))
    overlap_h = max(0.0, min(left_y2, right_y2) - max(left_y1, right_y1))
    intersection = overlap_w * overlap_h
    union = (
        max(0.0, (left_x2 - left_x1) * (left_y2 - left_y1))
        + max(0.0, (right_x2 - right_x1) * (right_y2 - right_y1))
        - intersection
    )
    return intersection / max(union, 1e-9)


def deduplicate_face_candidates(candidates, limit=8):
    """Merge overlapping detector results while preferring stronger models."""
    selected = []
    detector_priority = {
        "yunet": 3,
        "frontal": 2,
        "profile_right": 1,
        "profile_left": 1,
    }
    for candidate in sorted(
        [dict(item) for item in candidates or [] if isinstance(item, dict)],
        key=lambda item: (
            detector_priority.get(item.get("detector"), 0),
            float(item.get("detector_confidence") or 0.0),
            float(item.get("area") or 0.0),
        ),
        reverse=True,
    ):
        duplicate = False
        for accepted in selected:
            center_distance = math.hypot(
                float(candidate.get("x") or 0.5) - float(accepted.get("x") or 0.5),
                float(candidate.get("y") or 0.5) - float(accepted.get("y") or 0.5),
            )
            if detection_box_iou(candidate, accepted) >= 0.20 or center_distance <= max(
                0.025,
                min(
                    float(candidate.get("w") or 0.0),
                    float(accepted.get("w") or 0.0),
                )
                * 0.46,
            ):
                duplicate = True
                break
        if not duplicate:
            selected.append(candidate)
    return selected[: max(1, int(limit or 8))]


def yunet_model_path():
    path = Path(__file__).resolve().parent / "models" / "face_detection_yunet_2023mar.onnx"
    return path if path.exists() and path.stat().st_size > 100_000 else None


def create_yunet_face_detector(cv2, input_size):
    model_path = yunet_model_path()
    factory = getattr(cv2, "FaceDetectorYN", None)
    if model_path is None or factory is None:
        return None
    try:
        width, height = (max(1, int(item)) for item in input_size)
        return factory.create(
            str(model_path),
            "",
            (width, height),
            0.72,
            0.30,
            5000,
        )
    except Exception:
        return None


def detect_yunet_face_candidates(image, detector):
    """Return normalized YuNet faces without making it a hard dependency."""
    if image is None or detector is None:
        return []
    height, width = image.shape[:2]
    try:
        detector.setInputSize((int(width), int(height)))
        _status, faces = detector.detect(image)
    except Exception:
        return []
    if faces is None:
        return []
    result = []
    for row in faces:
        values = list(row)
        if len(values) < 5:
            continue
        x, y, box_width, box_height = (float(item) for item in values[:4])
        confidence = float(values[14]) if len(values) > 14 else 0.72
        if box_width <= 0 or box_height <= 0 or confidence < 0.70:
            continue
        center_x = (x + box_width / 2.0) / max(width, 1)
        center_y = (y + box_height / 2.0) / max(height, 1)
        area = (box_width * box_height) / max(width * height, 1)
        aspect = box_width / max(box_height, 1.0)
        if area < 0.0015:
            continue
        if not 0.08 <= center_y <= 0.92:
            continue
        if not 0.42 <= aspect <= 1.65:
            continue
        if not 0.01 <= center_x <= 0.99:
            continue
        result.append(
            {
                "x": center_x,
                "y": center_y,
                "w": box_width / max(width, 1),
                "h": box_height / max(height, 1),
                "area": area,
                "kind": "face",
                "detector": "yunet",
                "detector_confidence": confidence,
            }
        )
    return result


def detect_face_candidates(gray, frontal_cascade, profile_cascade=None):
    """Detect frontal and profile faces, then remove logo/artwork false hits."""
    height, width = gray.shape[:2]
    # Analysis frames are normally reduced to 720 px wide. A fixed 42 px
    # floor discarded valid people seated farther from the camera before
    # persistence validation could evaluate them.
    minimum_size = max(24, int(min(width, height) * 0.035))
    raw = []

    def append_detections(rectangles, detector, mirrored=False):
        for raw_x, raw_y, raw_w, raw_h in rectangles:
            x = width - int(raw_x) - int(raw_w) if mirrored else int(raw_x)
            y = int(raw_y)
            w = int(raw_w)
            h = int(raw_h)
            center_x = (x + w / 2) / max(width, 1)
            center_y = (y + h / 2) / max(height, 1)
            area = (w * h) / max(width * height, 1)
            aspect = w / max(h, 1)
            if area < 0.0018:
                continue
            if not 0.105 <= center_y <= 0.90:
                continue
            if not 0.48 <= aspect <= 1.62:
                continue
            if center_x < 0.015 or center_x > 0.985:
                continue
            raw.append(
                {
                    "x": center_x,
                    "y": center_y,
                    "w": w / max(width, 1),
                    "h": h / max(height, 1),
                    "area": area,
                    "kind": "face",
                    "detector": detector,
                    "_pixel_box": (x, y, w, h),
                }
            )

    frontal = frontal_cascade.detectMultiScale(
        gray,
        scaleFactor=1.10,
        minNeighbors=5,
        minSize=(minimum_size, minimum_size),
    )
    append_detections(frontal, "frontal")
    if profile_cascade is not None and not profile_cascade.empty():
        profile = profile_cascade.detectMultiScale(
            gray,
            scaleFactor=1.09,
            minNeighbors=5,
            minSize=(minimum_size, minimum_size),
        )
        append_detections(profile, "profile_right")
        mirrored_gray = gray[:, ::-1].copy()
        mirrored = profile_cascade.detectMultiScale(
            mirrored_gray,
            scaleFactor=1.09,
            minNeighbors=5,
            minSize=(minimum_size, minimum_size),
        )
        append_detections(mirrored, "profile_left", mirrored=True)

    return deduplicate_face_candidates(raw, limit=8)


def assign_subject_track_ids(detections, tracks=None, next_track_id=1, sample_time=0.0):
    """Assign stable subject IDs to sparse face/body detections.

    This is intentionally lightweight: podcast subjects are matched by spatial
    continuity and size while scene sampling keeps CPU use bounded. Identity is
    never inferred from LEFT/CENTER/RIGHT labels.
    """
    tracks = tracks if isinstance(tracks, dict) else {}
    available_ids = set(tracks)
    assigned = []
    ordered = sorted(
        [dict(item) for item in detections or [] if isinstance(item, dict)],
        key=lambda item: float(item.get("area") or 0.0),
        reverse=True,
    )
    for detection in ordered:
        x = max(0.0, min(1.0, float(detection.get("x") or 0.5)))
        y = max(0.0, min(1.0, float(detection.get("y") or 0.5)))
        width = max(0.0, min(1.0, float(detection.get("w") or 0.0)))
        height = max(0.0, min(1.0, float(detection.get("h") or 0.0)))
        best_id = None
        best_cost = float("inf")
        for track_id in list(available_ids):
            track = tracks.get(track_id) or {}
            age = max(0.0, float(sample_time or 0.0) - float(track.get("last_time") or 0.0))
            if age > 6.0:
                continue
            x_distance = abs(x - float(track.get("x") or 0.5))
            y_distance = abs(y - float(track.get("y") or 0.5))
            size_distance = abs(width - float(track.get("w") or width)) + abs(
                height - float(track.get("h") or height)
            )
            same_kind = detection.get("kind") == track.get("kind")
            reference_width = max(width, float(track.get("w") or width))
            if same_kind and detection.get("kind") == "face":
                max_x_distance = max(0.07, min(0.135, reference_width * 1.75))
                max_y_distance = 0.17
            elif same_kind:
                max_x_distance = max(0.10, min(0.17, reference_width * 1.25))
                max_y_distance = 0.23
            else:
                max_x_distance = 0.10
                max_y_distance = 0.20
            if x_distance > max_x_distance or y_distance > max_y_distance:
                continue
            detector_penalty = (
                0.0
                if detection.get("detector") == track.get("detector")
                else 0.012
            )
            cost = x_distance + y_distance * 0.55 + size_distance * 0.28 + age * 0.010 + detector_penalty
            if cost < best_cost:
                best_cost = cost
                best_id = track_id
        if best_id is None:
            best_id = f"person_{int(next_track_id):02d}"
            next_track_id += 1
        else:
            available_ids.discard(best_id)
        enriched = {
            **detection,
            "track_id": best_id,
            "subject_id": best_id,
            "x": x,
            "y": y,
            "w": width,
            "h": height,
        }
        tracks[best_id] = {
            "x": x,
            "y": y,
            "w": width,
            "h": height,
            "kind": detection.get("kind"),
            "detector": detection.get("detector"),
            "last_time": float(sample_time or 0.0),
        }
        assigned.append(enriched)
    return assigned, tracks, next_track_id


def consolidate_spatial_subject_tracks(track_samples, max_gap_seconds=12.0):
    """Merge non-concurrent detector fragments that describe the same seat.

    This is a framing fallback, not biometric identity recognition. Fixed
    podcast cameras often lose a profile face for several samples and create a
    fresh Haar track when it returns. Keeping those fragments separate makes a
    real host look transient and removes them from the camera plan.
    """
    merged = {}
    aliases = {}

    def describe(samples):
        samples = list(samples or [])
        times = sorted(float(item.get("time") or 0.0) for item in samples)
        count = max(1, len(samples))
        return {
            "x": sum(float(item.get("x") or 0.5) for item in samples) / count,
            "y": sum(float(item.get("y") or 0.5) for item in samples) / count,
            "w": sum(float(item.get("w") or 0.0) for item in samples) / count,
            "h": sum(float(item.get("h") or 0.0) for item in samples) / count,
            "area": sum(float(item.get("area") or 0.0) for item in samples) / count,
            "kind": str(samples[0].get("kind") or "face") if samples else "face",
            "times": times,
            "first": times[0] if times else 0.0,
            "last": times[-1] if times else 0.0,
        }

    ordered = sorted(
        (
            (str(subject_id), [dict(item) for item in samples or []])
            for subject_id, samples in (track_samples or {}).items()
            if samples
        ),
        key=lambda item: describe(item[1])["first"],
    )
    for subject_id, samples in ordered:
        candidate = describe(samples)
        best_id = None
        best_cost = float("inf")
        for representative_id, representative_samples in merged.items():
            representative = describe(representative_samples)
            if candidate["kind"] != representative["kind"]:
                continue
            concurrent = any(
                abs(candidate_time - representative_time) <= 0.02
                for candidate_time in candidate["times"]
                for representative_time in representative["times"]
            )
            if concurrent:
                continue
            gap = max(
                0.0,
                candidate["first"] - representative["last"],
                representative["first"] - candidate["last"],
            )
            if gap > float(max_gap_seconds):
                continue
            x_distance = abs(candidate["x"] - representative["x"])
            y_distance = abs(candidate["y"] - representative["y"])
            size_distance = abs(candidate["w"] - representative["w"]) + abs(
                candidate["h"] - representative["h"]
            )
            area_ratio = max(candidate["area"], representative["area"]) / max(
                min(candidate["area"], representative["area"]),
                1e-6,
            )
            x_limit = 0.078 if candidate["kind"] == "face" else 0.11
            y_limit = 0.085 if candidate["kind"] == "face" else 0.13
            if (
                x_distance > x_limit
                or y_distance > y_limit
                or size_distance > 0.12
                or area_ratio > 1.9
            ):
                continue
            cost = x_distance + y_distance * 0.65 + size_distance * 0.28 + gap * 0.002
            if cost < best_cost:
                best_cost = cost
                best_id = representative_id
        representative_id = best_id or subject_id
        aliases[subject_id] = representative_id
        normalized_samples = []
        for sample in samples:
            sample["subject_id"] = representative_id
            sample["track_id"] = representative_id
            normalized_samples.append(sample)
        merged.setdefault(representative_id, []).extend(normalized_samples)
        merged[representative_id].sort(key=lambda item: float(item.get("time") or 0.0))
    return merged, aliases


def summarize_subject_tracks(track_samples, total_samples):
    summaries = []
    for subject_id, samples in (track_samples or {}).items():
        if not samples:
            continue
        weights = [
            max(0.001, float(item.get("area") or 0.0))
            * (1.15 if item.get("kind") == "face" else 1.0)
            for item in samples
        ]
        total_weight = max(0.001, sum(weights))
        focus_x = sum(float(item.get("x") or 0.5) * weight for item, weight in zip(samples, weights)) / total_weight
        focus_y = sum(float(item.get("y") or 0.5) * weight for item, weight in zip(samples, weights)) / total_weight
        safe_samples = [
            item
            for item in samples
            if float(item.get("x") or 0.5) - float(item.get("w") or 0.0) / 2 >= 0.01
            and float(item.get("x") or 0.5) + float(item.get("w") or 0.0) / 2 <= 0.99
            and float(item.get("y") or 0.5) - float(item.get("h") or 0.0) / 2 >= 0.005
            and float(item.get("y") or 0.5) + float(item.get("h") or 0.0) / 2 <= 0.975
        ]
        visibility = min(1.0, len(samples) / max(1, int(total_samples or 1)))
        activity_peak = max(float(item.get("activity_score") or 0.0) for item in samples)
        activity_average = sum(float(item.get("activity_score") or 0.0) for item in samples) / len(samples)
        mouth_motion_peak = max(float(item.get("mouth_motion") or 0.0) for item in samples)
        mouth_motion_average = sum(float(item.get("mouth_motion") or 0.0) for item in samples) / len(samples)
        speech_motion_peak = max(
            float(item.get("speech_motion", item.get("mouth_motion")) or 0.0)
            for item in samples
        )
        speech_motion_average = sum(
            float(item.get("speech_motion", item.get("mouth_motion")) or 0.0)
            for item in samples
        ) / len(samples)
        jaw_motion_peak = max(float(item.get("jaw_motion") or 0.0) for item in samples)
        jaw_motion_average = sum(float(item.get("jaw_motion") or 0.0) for item in samples) / len(samples)
        frame_motion_peak = max(float(item.get("frame_motion") or 0.0) for item in samples)
        frame_motion_average = sum(float(item.get("frame_motion") or 0.0) for item in samples) / len(samples)
        profile_ratio = sum(
            1
            for item in samples
            if str(item.get("detector") or "").lower().startswith("profile")
        ) / len(samples)
        expression_score = max(
            0.0,
            min(
                1.0,
                speech_motion_average * 0.56
                + speech_motion_peak * 0.22
                + jaw_motion_average * 0.08
                + frame_motion_average * 0.09
                + frame_motion_peak * 0.05,
            ),
        )
        average_area = sum(float(item.get("area") or 0.0) for item in samples) / len(samples)
        confidence = max(
            0.0,
            min(
                1.0,
                visibility * 0.42
                + min(1.0, average_area / (0.03 if any(item.get("kind") == "face" for item in samples) else 0.12)) * 0.22
                + expression_score * 0.16
                + activity_peak * 0.08
                + (len(safe_samples) / len(samples)) * 0.12,
            ),
        )
        summaries.append(
            {
                "subject_id": subject_id,
                "focus_x": round(max(0.06, min(0.94, focus_x)), 4),
                "focus_y": round(max(0.04, min(0.96, focus_y)), 4),
                "zone": "LEFT" if focus_x < 0.34 else ("RIGHT" if focus_x > 0.66 else "CENTER"),
                "visibility": round(visibility, 4),
                "confidence": round(confidence, 4),
                "safe_visibility": round(len(safe_samples) / len(samples), 4),
                "average_area": round(average_area, 5),
                "activity_average": round(activity_average, 4),
                "activity_peak": round(activity_peak, 4),
                "mouth_motion_average": round(mouth_motion_average, 4),
                "mouth_motion_peak": round(mouth_motion_peak, 4),
                "speech_motion_average": round(speech_motion_average, 4),
                "speech_motion_peak": round(speech_motion_peak, 4),
                "jaw_motion_average": round(jaw_motion_average, 4),
                "jaw_motion_peak": round(jaw_motion_peak, 4),
                "frame_motion_average": round(frame_motion_average, 4),
                "frame_motion_peak": round(frame_motion_peak, 4),
                "profile_ratio": round(profile_ratio, 4),
                "expression_score": round(expression_score, 4),
                "kind": "face" if any(item.get("kind") == "face" for item in samples) else "body",
                "sample_count": len(samples),
            }
        )
    return sorted(
        summaries,
        key=lambda item: (item["visibility"], item["confidence"], item["average_area"]),
        reverse=True,
    )


def validate_subject_tracks(subject_tracks, total_samples):
    """Keep only persistent human tracks that are safe camera targets.

    Haar detections can briefly match logos, artwork, or a face entering at the
    edge. Those observations remain useful for diagnostics, but a professional
    camera plan must never cut to a one-frame candidate.
    """
    total_samples = max(1, int(total_samples or 1))
    # Three stable detections across a one-minute sparse sample represent
    # roughly a 4-5 second host question. Requiring four removed valid profile
    # turns, while the two-sample floor still rejects logo/edge flashes.
    minimum_samples = max(2, int(math.ceil(total_samples * 0.07)))
    accepted = []
    rejected = []
    for item in subject_tracks or []:
        subject = dict(item)
        sample_count = max(0, int(subject.get("sample_count") or 0))
        confidence = max(0.0, min(1.0, float(subject.get("confidence") or 0.0)))
        visibility = max(0.0, min(1.0, float(subject.get("visibility") or 0.0)))
        safe_visibility = max(0.0, min(1.0, float(subject.get("safe_visibility") or 0.0)))
        focus_y = max(0.0, min(1.0, float(subject.get("focus_y") or 0.5)))
        average_area = max(0.0, float(subject.get("average_area") or 0.0))
        kind = str(subject.get("kind") or "face").lower()
        reasons = []
        if sample_count < minimum_samples:
            reasons.append("transient_track")
        if confidence < 0.22 or visibility < 0.06:
            reasons.append("low_track_confidence")
        if safe_visibility < 0.60:
            reasons.append("unsafe_frame_edge")
        if kind == "face" and not 0.10 <= focus_y <= 0.90:
            reasons.append("non_human_face_region")
        if kind == "body" and not 0.12 <= focus_y <= 0.94:
            reasons.append("non_human_body_region")
        if average_area < (0.0025 if kind == "face" else 0.006):
            reasons.append("subject_too_small")
        if reasons:
            rejected.append(
                {
                    "subject_id": subject.get("subject_id"),
                    "reasons": reasons,
                    "sample_count": sample_count,
                    "confidence": round(confidence, 4),
                    "focus_x": subject.get("focus_x"),
                    "focus_y": subject.get("focus_y"),
                }
            )
            continue
        subject["validated"] = True
        accepted.append(subject)
    return accepted, rejected, minimum_samples


def stabilize_visual_activity_events(activity_events, subject_tracks):
    """Suppress one-sample challengers and calibrate visual activity evidence."""
    subject_by_id = {
        item.get("subject_id"): item
        for item in subject_tracks or []
        if item.get("subject_id")
    }
    clean = [
        dict(item)
        for item in sorted(
            activity_events or [],
            key=lambda item: float(item.get("time") or 0.0),
        )
        if item.get("subject_id") in subject_by_id
    ]
    if not clean:
        return []

    def runs(items):
        result = []
        start_index = 0
        for index in range(1, len(items) + 1):
            if index < len(items) and items[index].get("subject_id") == items[start_index].get("subject_id"):
                continue
            result.append((start_index, index))
            start_index = index
        return result

    activity_runs = runs(clean)
    for run_index, (start_index, end_index) in enumerate(activity_runs):
        if end_index - start_index != 1 or run_index == 0 or run_index == len(activity_runs) - 1:
            continue
        previous_start, previous_end = activity_runs[run_index - 1]
        next_start, _next_end = activity_runs[run_index + 1]
        previous_subject = clean[previous_start].get("subject_id")
        next_subject = clean[next_start].get("subject_id")
        challenger_subject = clean[start_index].get("subject_id")
        raw_confidence = float(clean[start_index].get("confidence") or 0.0)
        if previous_subject == next_subject and raw_confidence < 0.78:
            subject = subject_by_id.get(previous_subject) or {}
            clean[start_index].update(
                {
                    "subject_id": previous_subject,
                    "focus_x": subject.get("focus_x", clean[previous_end - 1].get("focus_x")),
                    "evidence": "suppressed_single_sample_challenger",
                    "suppressed_subject_id": challenger_subject,
                }
            )

    for start_index, end_index in runs(clean):
        subject_id = clean[start_index].get("subject_id")
        subject = subject_by_id.get(subject_id) or {}
        run_samples = end_index - start_index
        start_time = float(clean[start_index].get("time") or 0.0)
        end_time = float(clean[end_index - 1].get("time") or start_time)
        expression = max(0.0, min(1.0, float(subject.get("expression_score") or 0.0)))
        track_confidence = max(0.0, min(1.0, float(subject.get("confidence") or 0.0)))
        for index in range(start_index, end_index):
            event = clean[index]
            raw_confidence = max(0.0, min(1.0, float(event.get("confidence") or 0.0)))
            speech_motion = max(
                0.0,
                min(
                    1.0,
                    float(event.get("speech_motion", event.get("mouth_motion")) or 0.0),
                ),
            )
            calibrated = max(
                0.0,
                min(
                    1.0,
                    0.29
                    + raw_confidence * 0.39
                    + speech_motion * 0.17
                    + expression * 0.08
                    + track_confidence * 0.07,
                ),
            )
            event.update(
                {
                    "raw_confidence": round(raw_confidence, 4),
                    "confidence": round(calibrated, 4),
                    "run_samples": run_samples,
                    "run_duration": round(max(0.0, end_time - start_time), 3),
                    "sustained": run_samples >= 2,
                    "turn_evidence": round(
                        min(
                            1.0,
                            max(
                                speech_motion,
                                min(1.0, max(0.0, end_time - start_time) / 2.2)
                                * raw_confidence,
                            ),
                        ),
                        4,
                    ),
                    "expression_score": round(expression, 4),
                }
            )
    return clean


def map_speakers_to_subjects(speaker_turns, activity_events, subject_tracks):
    """Map diarized speakers to measured person tracks using time evidence."""
    subject_ids = {item.get("subject_id") for item in subject_tracks or []}
    totals = {}
    for turn in speaker_turns or []:
        speaker = str(turn.get("speaker") or "")
        if not speaker:
            continue
        matching = [
            event
            for event in activity_events or []
            if event.get("subject_id") in subject_ids
            and float(event.get("time") or 0.0) >= float(turn.get("start") or 0.0) - 0.20
            and float(event.get("time") or 0.0) <= float(turn.get("end") or 0.0) + 0.20
        ]
        for event in matching:
            subject_id = event.get("subject_id")
            weight = max(0.05, float(event.get("confidence") or event.get("activity_score") or 0.0))
            totals.setdefault(speaker, {})
            totals[speaker][subject_id] = totals[speaker].get(subject_id, 0.0) + weight

    mapping = {}
    claimed = set()
    ranked_speakers = sorted(
        totals,
        key=lambda speaker: max(totals[speaker].values()) if totals[speaker] else 0.0,
        reverse=True,
    )
    for speaker in ranked_speakers:
        options = sorted(totals[speaker].items(), key=lambda item: item[1], reverse=True)
        available = next((item for item in options if item[0] not in claimed), options[0] if options else None)
        if not available:
            continue
        subject_id, score = available
        total = max(0.001, sum(totals[speaker].values()))
        confidence = score / total
        if confidence < 0.42:
            continue
        mapping[speaker] = {
            "subject_id": subject_id,
            "confidence": round(min(1.0, confidence), 4),
            "evidence_score": round(score, 4),
        }
        claimed.add(subject_id)
    return mapping


def visual_speech_motion_score(
    mouth_motion,
    jaw_motion,
    upper_face_motion,
    frame_motion,
    detector=None,
):
    """Estimate speech articulation for frontal and profile faces.

    A fixed frontal mouth box under-rates a host who turns toward a guest.
    Profile faces therefore use the wider jaw/chin region while upper-face
    movement is treated as camera/head-motion noise.
    """
    mouth = max(0.0, min(1.0, float(mouth_motion or 0.0)))
    jaw = max(0.0, min(1.0, float(jaw_motion or 0.0)))
    upper = max(0.0, min(1.0, float(upper_face_motion or 0.0)))
    frame = max(0.0, min(1.0, float(frame_motion or 0.0)))
    articulation = max(mouth, jaw * 0.94)
    residual = max(0.0, articulation - upper * 0.48)
    local_motion = max(0.0, frame - upper * 0.72)
    score = max(
        mouth * 0.80,
        jaw * 0.84,
        residual * 1.14,
    ) + local_motion * 0.10
    if str(detector or "").lower().startswith("profile"):
        score = max(score, jaw * 0.94 + residual * 0.12)
    return max(0.0, min(1.0, score))


def select_visual_active_subject(subjects, previous_active=None, switch_margin=0.14):
    """Select a stable human subject using speech-like motion and continuity.

    Face size alone is a poor active-speaker signal: a quiet person closer to
    the camera would win every frame. Mouth motion is the strongest visual
    cue, while continuity prevents one noisy detection from moving the crop.
    """
    if not subjects:
        return None

    candidates = [item for item in subjects if item.get("kind") == "face"]
    if not candidates:
        candidates = list(subjects)

    scored = []
    for subject in candidates:
        mouth_motion = max(0.0, min(1.0, float(subject.get("mouth_motion") or 0.0)))
        speech_motion = max(
            0.0,
            min(
                1.0,
                float(subject.get("speech_motion", subject.get("mouth_motion")) or 0.0),
            ),
        )
        frame_motion = max(0.0, min(1.0, float(subject.get("frame_motion") or 0.0)))
        area_target = 0.035 if subject.get("kind") == "face" else 0.14
        area_score = max(0.0, min(1.0, float(subject.get("area") or 0.0) / area_target))
        edge_score = max(0.0, min(1.0, min(float(subject.get("x") or 0.5), 1.0 - float(subject.get("x") or 0.5)) / 0.16))
        continuity = 0.45
        if previous_active is not None:
            if (
                subject.get("track_id")
                and previous_active.get("track_id")
                and subject.get("track_id") == previous_active.get("track_id")
            ):
                continuity = 1.0
            else:
                distance = abs(float(subject.get("x") or 0.5) - float(previous_active.get("x") or 0.5))
                continuity = max(0.0, 1.0 - distance / 0.28)
        score = (
            speech_motion * 0.61
            + mouth_motion * 0.05
            + frame_motion * 0.07
            + area_score * 0.06
            + continuity * 0.17
            + edge_score * 0.04
        )
        scored.append((score, subject))

    best_score, best = max(scored, key=lambda item: item[0])
    if previous_active is not None and len(scored) > 1:
        previous_match = next(
            (
                item
                for item in scored
                if previous_active.get("track_id")
                and item[1].get("track_id") == previous_active.get("track_id")
            ),
            None,
        )
        if previous_match is None:
            previous_match = min(
                scored,
                key=lambda item: abs(float(item[1].get("x") or 0.5) - float(previous_active.get("x") or 0.5)),
            )
        previous_score, previous_subject = previous_match
        previous_distance = abs(
            float(previous_subject.get("x") or 0.5) - float(previous_active.get("x") or 0.5)
        )
        challenger_mouth = float(
            best.get("speech_motion", best.get("mouth_motion")) or 0.0
        )
        previous_mouth = float(
            previous_subject.get(
                "speech_motion",
                previous_subject.get("mouth_motion"),
            )
            or 0.0
        )
        if (
            previous_distance <= 0.16
            and best is not previous_subject
            and best_score < previous_score + max(0.08, float(switch_margin or 0.14))
            and challenger_mouth < previous_mouth + 0.22
        ):
            best_score, best = previous_score, previous_subject

    selected = dict(best)
    selected["activity_score"] = round(best_score, 4)
    return selected


def detect_conversation_focus(
    video_path,
    start,
    duration,
    moment=None,
    transcript=None,
    variation_index=0,
    content_profile=None,
    speaker_grounding_path=None,
):
    try:
        import cv2
    except Exception:
        return None

    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        return None
    cv2_data = getattr(cv2, "data", None)
    haarcascades_dir = getattr(cv2_data, "haarcascades", "") if cv2_data is not None else ""
    cascade_path = os.path.join(haarcascades_dir, "haarcascade_frontalface_default.xml")
    cascade = cv2.CascadeClassifier(cascade_path)
    if cascade.empty():
        capture.release()
        return None
    profile_path = os.path.join(haarcascades_dir, "haarcascade_profileface.xml")
    profile_cascade = cv2.CascadeClassifier(profile_path)
    upperbody_path = os.path.join(haarcascades_dir, "haarcascade_upperbody.xml")
    upperbody = cv2.CascadeClassifier(upperbody_path)
    has_body_detector = not upperbody.empty()
    yunet_detector = None
    yunet_unavailable = False

    centers = []
    activity_points = []
    face_counts = []
    person_counts = []
    spans = []
    left_points = []
    right_points = []
    detected_areas = []
    estimated_human_areas = []
    safe_visibility_samples = []
    portrait_crop_fractions = []
    body_hits = 0
    mode_counts = {}
    previous_active = None
    subject_registry = {}
    subject_samples = {}
    activity_events = []
    next_subject_track_id = 1
    source_width = 0
    source_height = 0
    base_sample_count = max(12, min(42, int(float(duration or 0) / 1.55) or 14))
    sample_times = [
        float(duration) * (index + 0.5) / base_sample_count
        for index in range(base_sample_count)
    ]
    precomputed_story_beats = editor_story_beats(transcript, moment or {}, duration)
    # Uniform sampling can miss a short host question between two long guest
    # answers. Add a small number of transcript-guided observations, but keep
    # every spatial decision dependent on a measured face/body detection.
    for beat in precomputed_story_beats:
        beat_start = max(0.15, min(float(duration) - 0.2, float(beat.get("time") or 0.0) + 0.12))
        sample_times.append(beat_start)
        if str(beat.get("type") or "").lower() == "question":
            beat_end = max(beat_start, min(float(duration) - 0.2, float(beat.get("end") or beat_start)))
            sample_times.append(min(beat_end, beat_start + 1.05))
    sample_times = sorted(
        {
            round(max(0.05, min(float(duration) - 0.05, sample_time)), 3)
            for sample_time in sample_times
            if float(duration or 0.0) > 0.1
        }
    )
    sample_count = len(sample_times)
    for sample_time in sample_times:
        position = (float(start) + sample_time) * 1000
        capture.set(cv2.CAP_PROP_POS_MSEC, position)
        ok, frame = capture.read()
        if not ok or frame is None:
            continue
        height, width = frame.shape[:2]
        source_width = source_width or int(width)
        source_height = source_height or int(height)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        detection_scale = min(1.0, 720.0 / max(width, 1))
        if detection_scale < 0.999:
            detection_frame = cv2.resize(
                frame,
                (
                    max(1, int(round(width * detection_scale))),
                    max(1, int(round(height * detection_scale))),
                ),
                interpolation=cv2.INTER_AREA,
            )
            detection_gray = cv2.cvtColor(detection_frame, cv2.COLOR_BGR2GRAY)
        else:
            detection_frame = frame
            detection_gray = gray
        face_candidates = detect_face_candidates(detection_gray, cascade, profile_cascade)
        if yunet_detector is None and not yunet_unavailable:
            yunet_detector = create_yunet_face_detector(
                cv2,
                (detection_frame.shape[1], detection_frame.shape[0]),
            )
            yunet_unavailable = yunet_detector is None
        if yunet_detector is not None:
            face_candidates = deduplicate_face_candidates(
                detect_yunet_face_candidates(detection_frame, yunet_detector)
                + face_candidates,
                limit=8,
            )
        for candidate in face_candidates:
            candidate["_pixel_box"] = (
                max(0, int((float(candidate.get("x") or 0.5) - float(candidate.get("w") or 0.0) / 2) * width)),
                max(0, int((float(candidate.get("y") or 0.5) - float(candidate.get("h") or 0.0) / 2) * height)),
                max(1, int(float(candidate.get("w") or 0.0) * width)),
                max(1, int(float(candidate.get("h") or 0.0) * height)),
            )
        paired_gray = None
        capture.set(cv2.CAP_PROP_POS_MSEC, position + 140)
        paired_ok, paired_frame = capture.read()
        if paired_ok and paired_frame is not None and paired_frame.shape[:2] == frame.shape[:2]:
            paired_gray = cv2.cvtColor(paired_frame, cv2.COLOR_BGR2GRAY)
        detections = list(face_candidates)
        detection_kind = "face"
        if len(detections) == 0 and has_body_detector:
            bodies = upperbody.detectMultiScale(
                detection_gray,
                scaleFactor=1.08,
                minNeighbors=4,
                minSize=(48, 64),
            )
            inverse_scale = 1.0 / max(detection_scale, 1e-6)
            detections = [
                (
                    int(x * inverse_scale),
                    int(y * inverse_scale),
                    int(w * inverse_scale),
                    int(h * inverse_scale),
                )
                for x, y, w, h in bodies
            ]
            detection_kind = "body"
            if len(detections) > 0:
                body_hits += 1
        if len(detections) == 0:
            continue
        normalized = []
        for detection in detections:
            if isinstance(detection, dict):
                x, y, w, h = detection.get("_pixel_box") or (0, 0, 0, 0)
                area = float(detection.get("area") or 0.0)
                center_x = float(detection.get("x") or 0.5)
                center_y = float(detection.get("y") or 0.5)
                detector = detection.get("detector")
            else:
                x, y, w, h = detection
                area = (w * h) / max(width * height, 1)
                center_x = (x + w / 2) / max(width, 1)
                center_y = (y + h / 2) / max(height, 1)
                detector = "upperbody"
            minimum_area = 0.0025 if detection_kind == "face" else 0.006
            if area < minimum_area:
                continue
            mouth_motion = 0.0
            jaw_motion = 0.0
            upper_face_motion = 0.0
            frame_motion = 0.0
            if paired_gray is not None:
                def roi_motion(left, top, right, bottom, divisor):
                    left = max(0, int(left))
                    right = min(width, int(right))
                    top = max(0, int(top))
                    bottom = min(height, int(bottom))
                    if right <= left or bottom <= top:
                        return 0.0
                    current = gray[top:bottom, left:right]
                    paired = paired_gray[top:bottom, left:right]
                    if not current.size or not paired.size or current.shape != paired.shape:
                        return 0.0
                    current = cv2.GaussianBlur(current, (3, 3), 0)
                    paired = cv2.GaussianBlur(paired, (3, 3), 0)
                    return min(
                        1.0,
                        float(cv2.mean(cv2.absdiff(current, paired))[0])
                        / max(float(divisor), 1.0),
                    )

                x1 = max(0, int(x))
                x2 = min(width, int(x + w))
                y1 = max(0, int(y))
                y2 = min(height, int(y + h))
                frame_motion = roi_motion(x1, y1, x2, y2, 30.0)
                if detection_kind == "face":
                    mouth_motion = roi_motion(
                        x + w * 0.14,
                        y + h * 0.54,
                        x + w * 0.86,
                        y + h * 0.93,
                        22.0,
                    )
                    # The jaw/chin ROI extends below the Haar face box. This
                    # remains visible when a host turns sideways to ask a
                    # guest a question and the frontal mouth box is incomplete.
                    jaw_motion = roi_motion(
                        x + w * 0.04,
                        y + h * 0.48,
                        x + w * 0.96,
                        y + h * 1.13,
                        24.0,
                    )
                    upper_face_motion = roi_motion(
                        x + w * 0.14,
                        y + h * 0.10,
                        x + w * 0.86,
                        y + h * 0.51,
                        25.0,
                    )
            speech_motion = visual_speech_motion_score(
                mouth_motion,
                jaw_motion,
                upper_face_motion,
                frame_motion,
                detector,
            )
            normalized.append({
                "x": center_x,
                "y": center_y,
                "w": w / max(width, 1),
                "h": h / max(height, 1),
                "area": area,
                "kind": detection_kind,
                "detector": detector,
                "mouth_motion": mouth_motion,
                "jaw_motion": jaw_motion,
                "upper_face_motion": upper_face_motion,
                "speech_motion": speech_motion,
                "frame_motion": frame_motion,
            })
        if not normalized:
            continue
        normalized = sorted(normalized, key=lambda item: item["area"], reverse=True)[:8]
        normalized, subject_registry, next_subject_track_id = assign_subject_track_ids(
            normalized,
            subject_registry,
            next_subject_track_id,
            sample_time,
        )
        detected_areas.append(sum(item["area"] for item in normalized))
        estimated_human_areas.append(
            min(
                0.82,
                sum(
                    item["area"] * (6.0 if item["kind"] == "face" else 1.35)
                    for item in normalized
                ),
            )
        )
        safe_visibility_samples.append(
            sum(
                1
                for item in normalized
                if item["x"] - item["w"] / 2 >= 0.012
                and item["x"] + item["w"] / 2 <= 0.988
                and item["y"] - item["h"] / 2 >= 0.008
                and item["y"] + item["h"] / 2 <= 0.97
            )
            / max(len(normalized), 1)
        )
        portrait_crop_fractions.append(
            min(1.0, (height * (9.0 / 16.0)) / max(width, 1))
        )
        face_counts.append(len(normalized) if detection_kind == "face" else 0)
        person_counts.append(len(normalized))
        group_min = min(face["x"] for face in normalized)
        group_max = max(face["x"] for face in normalized)
        group_span = group_max - group_min
        spans.append(group_span)
        group_center = sum(face["x"] * face["area"] for face in normalized) / max(sum(face["area"] for face in normalized), 0.001)
        if len(normalized) >= 2:
            by_x = sorted(normalized, key=lambda item: item["x"])
            left_points.append(max(0.08, min(0.92, by_x[0]["x"])))
            right_points.append(max(0.08, min(0.92, by_x[-1]["x"])))

        active = select_visual_active_subject(normalized, previous_active)
        if active is None:
            continue
        previous_active = active
        activity_points.append(max(0.08, min(0.92, active["x"])))
        active_subject_id = active.get("subject_id") or active.get("track_id")
        for subject in normalized:
            sample = {
                **subject,
                "time": round(sample_time, 3),
                "activity_score": (
                    float(active.get("activity_score") or 0.0)
                    if subject.get("subject_id") == active_subject_id
                    else 0.0
                ),
            }
            subject_samples.setdefault(subject.get("subject_id"), []).append(sample)
        activity_events.append(
            {
                "time": round(sample_time, 3),
                "subject_id": active_subject_id,
                "focus_x": round(max(0.08, min(0.92, float(active.get("x") or 0.5))), 4),
                "confidence": round(max(0.0, min(1.0, float(active.get("activity_score") or 0.0))), 4),
                "kind": active.get("kind"),
                "area": round(float(active.get("area") or 0.0), 5),
                "mouth_motion": round(float(active.get("mouth_motion") or 0.0), 4),
                "jaw_motion": round(float(active.get("jaw_motion") or 0.0), 4),
                "speech_motion": round(
                    float(active.get("speech_motion", active.get("mouth_motion")) or 0.0),
                    4,
                ),
                "detector": active.get("detector"),
                "evidence": "profile_aware_speech_motion+visual_continuity",
            }
        )

        if len(normalized) >= 2:
            if group_span <= 0.42:
                focus = group_center
                mode = "conversation-group"
            else:
                focus = active["x"] * 0.88 + group_center * 0.12
                mode = "speaker-priority"
        else:
            focus = active["x"]
            mode = "single-speaker"
        centers.append(max(0.12, min(0.88, focus)))
        mode_counts[mode] = mode_counts.get(mode, 0) + 1
        try:
            has_detection_proxy = detection_gray is not gray
            del frame
            if has_detection_proxy:
                del detection_gray
            del gray
            del face_candidates
            if paired_frame is not None:
                del paired_frame
            if paired_gray is not None:
                del paired_gray
            if "bodies" in locals():
                del bodies
        except Exception:
            pass
    capture.release()
    gc.collect()
    if not centers:
        return None
    subject_samples, subject_aliases = consolidate_spatial_subject_tracks(subject_samples)
    for event in activity_events:
        subject_id = event.get("subject_id")
        if subject_id in subject_aliases:
            event["subject_id"] = subject_aliases[subject_id]
    subject_candidates = summarize_subject_tracks(subject_samples, sample_count)
    subject_summaries, rejected_subject_tracks, minimum_subject_samples = validate_subject_tracks(
        subject_candidates,
        sample_count,
    )
    valid_subject_ids = {
        item.get("subject_id")
        for item in subject_summaries
        if item.get("subject_id")
    }
    activity_events = [
        item
        for item in activity_events
        if item.get("subject_id") in valid_subject_ids
    ]
    activity_events = stabilize_visual_activity_events(activity_events, subject_summaries)
    grounding_result = {
        "available": False,
        "verified": False,
        "source": "local_visual_fallback",
        "speaker_subject_map": {},
        "mapped_segments": [],
    }
    if (
        callable(discover_speaker_grounding_path)
        and callable(load_speaker_grounding)
        and callable(fuse_speaker_grounding)
    ):
        grounding_path = discover_speaker_grounding_path(
            video_path,
            speaker_grounding_path,
        )
        if grounding_path:
            loaded_grounding = load_speaker_grounding(
                grounding_path,
                clip_start=start,
                duration=duration,
            )
            activity_events, grounding_result = fuse_speaker_grounding(
                activity_events,
                subject_summaries,
                loaded_grounding,
            )
    detection_ratio = len(centers) / max(sample_count, 1)
    average_raw_detection_coverage = sum(detected_areas) / max(len(detected_areas), 1)
    average_estimated_human_area = sum(estimated_human_areas) / max(len(estimated_human_areas), 1)
    average_crop_fraction = sum(portrait_crop_fractions) / max(len(portrait_crop_fractions), 1)
    average_human_coverage = min(
        0.92,
        average_estimated_human_area / max(average_crop_fraction, 0.08),
    )
    safe_visibility_ratio = sum(safe_visibility_samples) / max(len(safe_visibility_samples), 1)
    max_faces = max(face_counts) if face_counts else 0
    max_people = max(person_counts) if person_counts else 0
    eligibility = human_shot_eligibility(
        detection_ratio,
        average_human_coverage,
        safe_visibility_ratio,
        max_people,
        max_faces,
    )
    if not subject_summaries:
        eligibility["eligible"] = False
        eligibility["rejectionReasons"] = list(eligibility.get("rejectionReasons") or [])
        eligibility["rejectionReasons"].append("no persistent human subject track")
    if not eligibility["eligible"]:
        return {
            "schema": 6,
            "focus_x": None,
            "face_count": max_faces,
            "person_count": max_people,
            "average_faces": round(sum(face_counts) / max(len(face_counts), 1), 2) if face_counts else 0.0,
            "mode": "human_safe_wide",
            "fallback": True,
            "human_safe_fallback": True,
            "eligible": False,
            "reason": "; ".join(eligibility["rejectionReasons"]),
            "rejection_reasons": eligibility["rejectionReasons"],
            "composition_score": eligibility["compositionScore"],
            "human_detection_ratio": round(detection_ratio, 3),
            "human_coverage": eligibility["humanCoverage"],
            "raw_detection_coverage": round(average_raw_detection_coverage, 4),
            "background_ratio": eligibility["backgroundRatio"],
            "safe_visibility": eligibility["safeVisibility"],
            "keyframes": [],
            "camera_director": [],
            "editor_plan": {},
            "subject_tracks": subject_summaries,
            "subject_candidates": subject_candidates,
            "rejected_subject_tracks": rejected_subject_tracks,
            "minimum_subject_samples": minimum_subject_samples,
            "activity_events": activity_events,
            "camera_layout": "HUMAN_SAFE_WIDE",
            "camera_source": "safe_original_frame",
            "source_width": source_width,
            "source_height": source_height,
            "split_screen": False,
            "body_tracking": body_hits > 0,
            "speaker_evidence": False,
            "speaker_grounding": grounding_result,
            "speaker_grounding_mode": "LIGHT",
            "transition_ms": 0,
        }
    smoothed_points = smooth_focus_points(centers)
    focus_x = max(0.16, min(0.84, sum(smoothed_points) / len(smoothed_points)))
    jitter = max(smoothed_points) - min(smoothed_points) if len(smoothed_points) > 1 else 0.0
    dominant_mode = max(mode_counts.items(), key=lambda item: item[1])[0] if mode_counts else "single-speaker"
    average_faces = sum(face_counts) / len(face_counts) if face_counts else 0.0
    average_span = sum(spans) / len(spans) if spans else 0.0
    zoom = 1.018 if average_faces >= 2 else 1.04
    if jitter > 0.22:
        zoom = max(1.018, zoom - 0.012)
    left_focus = sum(smooth_focus_points(left_points)) / len(left_points) if left_points else max(0.16, focus_x - 0.18)
    right_focus = sum(smooth_focus_points(right_points)) / len(right_points) if right_points else min(0.84, focus_x + 0.18)
    speaker_context = speaker_timeline_context(transcript, moment, duration)
    if callable(merge_speaker_context_with_grounding):
        speaker_context = merge_speaker_context_with_grounding(
            speaker_context,
            grounding_result,
        )
    story_beats = precomputed_story_beats
    # Spatial focus must always come from a detected human. Speaker labels
    # provide timing evidence, but without a verified speaker-to-face mapping
    # they are not allowed to invent LEFT/CENTER/RIGHT positions.
    validated_activity_points = [
        item.get("focus_x")
        for item in activity_events
        if item.get("focus_x") is not None
    ]
    keyframes = visual_cut_keyframes(
        validated_activity_points or centers,
        duration,
        max_points=9,
        min_gap=2.5,
    )
    content_profile = content_profile or {}
    split_screen = should_enable_split_screen(
        moment,
        speaker_context,
        duration,
        max_faces,
        average_faces,
        average_span,
        jitter,
    )
    body_tracking = body_hits > 0 and body_hits >= max(1, len(centers) // 4)
    camera_layout = None
    camera_score = 0
    camera_director = []
    editor_plan = {}
    verified_speakers, verified_speaker_count, has_speaker_evidence = verified_camera_speakers(speaker_context)
    speaker_subject_map = map_speakers_to_subjects(
        speaker_context.get("turns") or [],
        activity_events,
        subject_summaries,
    )
    external_speaker_subject_map = (
        grounding_result.get("speaker_subject_map")
        if isinstance(grounding_result, dict)
        else {}
    ) or {}
    speaker_subject_map.update(external_speaker_subject_map)
    if grounding_result.get("verified") and external_speaker_subject_map:
        has_speaker_evidence = True
    subject_by_id = {
        item.get("subject_id"): item
        for item in subject_summaries
        if item.get("subject_id")
    }
    speaker_by_subject = {
        value.get("subject_id"): speaker
        for speaker, value in speaker_subject_map.items()
        if value.get("subject_id")
    }
    speakers = []
    for subject in subject_summaries:
        subject_id = subject.get("subject_id")
        speaker = speaker_by_subject.get(subject_id) or subject_id
        mapping = speaker_subject_map.get(speaker) or {}
        speakers.append(
            {
                "speaker": speaker,
                "subject_id": subject_id,
                "zone": subject.get("zone"),
                "focus_x": subject.get("focus_x"),
                "confidence": max(
                    float(subject.get("confidence") or 0.0),
                    float(mapping.get("confidence") or 0.0),
                ),
            }
        )
    speaker_count = verified_speaker_count if has_speaker_evidence else max(1, len(speakers))
    has_visual_speaker_mapping = bool(speaker_subject_map)
    grounding_mode = (
        "FULL"
        if grounding_result.get("verified") and external_speaker_subject_map
        else ("STANDARD" if activity_events else "LIGHT")
    )
    if CameraEngine is not None:
        try:
            camera = CameraEngine()
            scene_context = {
                "face_count": max_faces,
                "speaker_count": speaker_count,
                "visual_subject_count": max_people,
                "speaker_evidence": has_speaker_evidence and has_visual_speaker_mapping,
                "speaker_grounding_mode": grounding_mode,
                "body_tracking": body_tracking,
                "split_screen": split_screen,
                "average_span": average_span,
                "overlap_seconds": speaker_context.get("overlap_seconds", 0.0),
                "emotion": speaker_context.get("emotion", 0.0),
                "stability": bounded_score(100 - jitter * 220, 35, 99),
                "variation_seed": int(variation_index or 0) + int(float(start or 0) // 30),
                "story_id": (moment or {}).get("story_id"),
                "topic": (moment or {}).get("topic"),
                "content_type": content_profile.get("videoType"),
                "camera_style": content_profile.get("cameraStyle"),
                "transition_style": content_profile.get("transitionStyle"),
                "source_width": source_width,
                "source_height": source_height,
                "subject_tracks": subject_summaries,
                "min_subject_samples": minimum_subject_samples,
                "activity_events": activity_events,
                "speaker_turns": speaker_context.get("turns") or [],
                "story_beats": story_beats,
                "zone_focus": {
                    "LEFT": round(max(0.08, min(0.92, left_focus)), 4),
                    "CENTER": round(max(0.08, min(0.92, focus_x)), 4),
                    "RIGHT": round(max(0.08, min(0.92, right_focus)), 4),
                },
            }
            editor_plan = camera.build_editor_plan(
                speakers=speakers,
                scene=scene_context,
                duration=duration,
            )
            editor_plan.setdefault("qa", {})
            editor_plan["qa"].update(
                {
                    "rawSubjectCount": len(subject_candidates),
                    "validatedSubjectCount": len(subject_summaries),
                    "rejectedSubjectCount": len(rejected_subject_tracks),
                }
            )
            camera_director = editor_plan.get("camera_events") or []
            if camera_director:
                camera_layout = "EDITOR_DIRECTOR_V2"
                camera_score = camera.camera_score(camera_layout)
            else:
                camera_layout = "HUMAN_ACTIVITY_CUT"
                camera_score = bounded_score(72 - jitter * 70, 45, 78)
        except Exception as exc:
            emit("log", stage="camera director", message=f"Editor Director fallback ke human activity cuts: {exc}")
            camera_layout = None
            camera_score = 0
            camera_director = []
            editor_plan = {}
    if camera_layout is None:
        camera_layout = "SPLIT_SCREEN" if split_screen else ("HUMAN_ACTIVITY_CUT" if max_faces >= 1 else ("BODY_TRACK" if body_tracking else "HUMAN_SAFE_WIDE"))
    transition_ms = 200 if split_screen else (camera_director[0].get("transition_ms", 180) if camera_director else 180)
    return {
        "schema": 6,
        "focus_x": focus_x,
        "face_count": max_faces,
        "person_count": max_people,
        "average_faces": round(average_faces, 2),
        "average_span": round(average_span, 3),
        "mode": dominant_mode,
        "stability": bounded_score(100 - jitter * 220, 35, 99),
        "zoom": zoom,
        "keyframes": keyframes,
        "body_tracking": body_tracking,
        "split_screen": split_screen,
        "camera_layout": camera_layout,
        "camera_score": camera_score,
        "camera_director": camera_director,
        "editor_plan": editor_plan,
        "subject_tracks": subject_summaries,
        "subject_candidates": subject_candidates,
        "rejected_subject_tracks": rejected_subject_tracks,
        "minimum_subject_samples": minimum_subject_samples,
        "activity_events": activity_events,
        "story_beats": story_beats,
        "speaker_timeline": speaker_context,
        "speaker_evidence": has_speaker_evidence,
        "speaker_visual_mapping": has_visual_speaker_mapping,
        "speaker_subject_map": speaker_subject_map,
        "speaker_grounding": grounding_result,
        "speaker_grounding_mode": grounding_mode,
        "camera_source": (
            "talknet_speaker_grounding"
            if grounding_result.get("verified") and external_speaker_subject_map
            else ("speaker_subject_map" if has_visual_speaker_mapping else "visual_subject_activity")
        ),
        "source_width": source_width,
        "source_height": source_height,
        "eligible": True,
        "rejection_reasons": [],
        "composition_score": eligibility["compositionScore"],
        "human_detection_ratio": round(detection_ratio, 3),
        "human_coverage": eligibility["humanCoverage"],
        "raw_detection_coverage": round(average_raw_detection_coverage, 4),
        "background_ratio": eligibility["backgroundRatio"],
        "safe_visibility": eligibility["safeVisibility"],
        "transition_ms": transition_ms,
        "clip_timeline": {
            "schema": 1,
            "source_start": round(float(start or 0.0), 3),
            "source_end": round(float(start or 0.0) + float(duration or 0.0), 3),
            "duration": round(float(duration or 0.0), 3),
            "speaker_turns": speaker_context.get("turns") or [],
            "subject_tracks": subject_summaries,
            "story_beats": story_beats,
            "camera_events": camera_director,
            "zoom_events": editor_plan.get("zoom_events") or [],
        },
        "split_focus": {
            "top": round(max(0.08, min(0.92, left_focus)), 4),
            "bottom": round(max(0.08, min(0.92, right_focus)), 4),
        },
    }


def detect_face_focus(video_path, start, duration):
    analysis = detect_conversation_focus(video_path, start, duration)
    if not analysis:
        return None
    return analysis.get("focus_x")


def ffmpeg_number(value, default=0.5):
    try:
        return f"{float(value):.5f}".rstrip("0").rstrip(".")
    except Exception:
        return f"{float(default):.5f}".rstrip("0").rstrip(".")


def focus_curve_expression(focus_analysis, fallback_focus=0.5):
    if not isinstance(focus_analysis, dict):
        return ffmpeg_number(fallback_focus)

    def cut_expression(frames, fallback):
        if not frames:
            return ffmpeg_number(fallback)
        expr = ffmpeg_number(frames[-1]["x"], fallback)
        for index in range(len(frames) - 2, -1, -1):
            boundary = ffmpeg_number(frames[index + 1]["t"])
            focus = ffmpeg_number(frames[index]["x"], fallback)
            expr = f"if(lt(t,{boundary}),{focus},{expr})"
        return expr

    director = focus_analysis.get("camera_director") or []
    director_frames = []
    for item in director:
        try:
            director_frames.append({
                "t": max(0.0, float(item.get("start") or 0.0)),
                "x": max(0.08, min(0.92, float(item.get("focus_x") or fallback_focus))),
            })
        except Exception:
            continue
    if director_frames:
        director_frames = sorted(director_frames, key=lambda item: item["t"])
        return cut_expression(director_frames, fallback_focus)

    keyframes = focus_analysis.get("keyframes") or []
    clean_frames = []
    for item in keyframes:
        try:
            t = max(0.0, float(item.get("t") or 0.0))
            x = max(0.08, min(0.92, float(item.get("x") or fallback_focus)))
        except Exception:
            continue
        clean_frames.append({"t": t, "x": x})
    clean_frames = sorted(clean_frames, key=lambda item: item["t"])[:9]
    if len(clean_frames) < 2:
        return ffmpeg_number(focus_analysis.get("focus_x", fallback_focus), fallback_focus)

    return cut_expression(clean_frames, fallback_focus)


def zoom_curve_expression(focus_analysis, fallback_zoom=1.0):
    """Build a bounded, short-ease zoom expression from Editor Director events."""
    if not isinstance(focus_analysis, dict):
        return ffmpeg_number(fallback_zoom, 1.0)
    director = focus_analysis.get("camera_director") or []
    frames = []
    for item in director:
        try:
            start = max(0.0, float(item.get("start") or 0.0))
            zoom = max(1.0, min(1.22, float(item.get("zoom") or fallback_zoom or 1.0)))
            transition = max(0.12, min(0.30, float(item.get("transition_ms") or 180) / 1000.0))
        except (TypeError, ValueError):
            continue
        if frames and abs(start - frames[-1]["start"]) < 0.01:
            frames[-1] = {"start": start, "zoom": zoom, "transition": transition}
        else:
            frames.append({"start": start, "zoom": zoom, "transition": transition})
    if not frames:
        return ffmpeg_number(
            max(1.0, min(1.22, float(focus_analysis.get("zoom") or fallback_zoom or 1.0))),
            1.0,
        )

    expression = ffmpeg_number(frames[0]["zoom"], 1.0)
    previous_zoom = frames[0]["zoom"]
    for frame in frames[1:]:
        start = frame["start"]
        transition = frame["transition"]
        end = start + transition
        target_zoom = frame["zoom"]
        start_text = ffmpeg_number(start, 0.0)
        end_text = ffmpeg_number(end, 0.2)
        previous_text = ffmpeg_number(previous_zoom, 1.0)
        target_text = ffmpeg_number(target_zoom, 1.0)
        delta_text = ffmpeg_number(target_zoom - previous_zoom, 0.0)
        transition_text = ffmpeg_number(transition, 0.2)
        ramp = f"{previous_text}+({delta_text})*(t-{start_text})/{transition_text}"
        expression = (
            f"if(lt(t,{start_text}),({expression}),"
            f"if(lt(t,{end_text}),({ramp}),{target_text}))"
        )
        previous_zoom = target_zoom
    return expression


def vertical_focus_curve_expression(focus_analysis, fallback_focus=0.5):
    """Return hard-cut vertical face focus from the verified camera plan."""
    if not isinstance(focus_analysis, dict):
        return ffmpeg_number(fallback_focus)
    frames = []
    for item in focus_analysis.get("camera_director") or []:
        if item.get("focus_y") is None:
            continue
        try:
            frames.append(
                {
                    "t": max(0.0, float(item.get("start") or 0.0)),
                    "y": max(0.08, min(0.92, float(item.get("focus_y")))),
                }
            )
        except (TypeError, ValueError):
            continue
    if not frames:
        tracks = focus_analysis.get("subject_tracks") or []
        primary_id = None
        director = focus_analysis.get("camera_director") or []
        if director:
            primary_id = director[0].get("subject_id")
        primary = next(
            (
                item
                for item in tracks
                if item.get("focus_y") is not None
                and (primary_id is None or item.get("subject_id") == primary_id)
            ),
            None,
        )
        return ffmpeg_number((primary or {}).get("focus_y", fallback_focus), fallback_focus)
    frames.sort(key=lambda item: item["t"])
    expression = ffmpeg_number(frames[-1]["y"], fallback_focus)
    for index in range(len(frames) - 2, -1, -1):
        boundary = ffmpeg_number(frames[index + 1]["t"])
        focus_y = ffmpeg_number(frames[index]["y"], fallback_focus)
        expression = f"if(lt(t,{boundary}),{focus_y},{expression})"
    return expression


def split_screen_filter(width, height, payload, focus_analysis):
    half_height = int(math.floor(height / 2 / 2) * 2)
    bottom_height = height - half_height
    scaler = "lanczos"
    split_focus = focus_analysis.get("split_focus") if isinstance(focus_analysis, dict) else {}
    top_focus = float((split_focus or {}).get("top") or max(0.16, float(focus_analysis.get("focus_x", 0.5)) - 0.18))
    bottom_focus = float((split_focus or {}).get("bottom") or min(0.84, float(focus_analysis.get("focus_x", 0.5)) + 0.18))
    top_focus = max(0.06, min(0.94, top_focus))
    bottom_focus = max(0.06, min(0.94, bottom_focus))
    top_x = f"min(max(iw*{ffmpeg_number(top_focus)}-ow*0.5,0),iw-ow)"
    bottom_x = f"min(max(iw*{ffmpeg_number(bottom_focus)}-ow*0.5,0),iw-ow)"
    divider = "drawbox=x=0:y=ih-4:w=iw:h=8:color=black@0.58:t=fill"
    return (
        f"split=2[topsrc][botsrc];"
        f"[topsrc]scale={width}:{half_height}:force_original_aspect_ratio=increase:flags={scaler},"
        f"crop={width}:{half_height}:x='{top_x}':y='(ih-oh)/2',{divider}[topv];"
        f"[botsrc]scale={width}:{bottom_height}:force_original_aspect_ratio=increase:flags={scaler},"
        f"crop={width}:{bottom_height}:x='{bottom_x}':y='(ih-oh)/2'[botv];"
        f"[topv][botv]vstack=inputs=2"
    )


def automatic_video_enhancement_filters(payload, moment=None):
    if bool_payload(payload, "disableAutoEnhancement", False):
        return []
    moment = moment or {}
    # Profile selection must not be triggered by an incidental transcript word
    # such as "lagu" inside a podcast conversation.
    category = clean_text(f"{moment.get('category') or ''} {moment.get('segment_type') or ''}").lower()
    title = clean_text(moment.get("title") or "").lower()
    content_profile = payload.get("_contentProfile") if isinstance(payload.get("_contentProfile"), dict) else {}
    profile_type = clean_text(content_profile.get("videoType") or "").lower()
    profile_text = f"{profile_type} {category} {title}"
    if profile_type == "gaming" or (not profile_type and any(word in profile_text for word in ["gaming", "gameplay", "esports"])):
        profile = "gaming"
        contrast, brightness, saturation = 1.025, 0.002, 1.020
    elif profile_type == "music" or (not profile_type and any(word in profile_text for word in ["music", "musik", "konser", "band"])):
        profile = "music"
        contrast, brightness, saturation = 1.020, 0.002, 1.018
    elif profile_type in {"podcast", "interview"} or (
        not profile_type and any(word in profile_text for word in ["interview", "wawancara", "narasumber"])
    ):
        profile = "interview"
        contrast, brightness, saturation = 1.018, 0.003, 1.015
    elif profile_type == "news":
        profile = "broadcast_natural"
        contrast, brightness, saturation = 1.015, 0.002, 1.010
    elif profile_type == "review":
        profile = "product_natural"
        contrast, brightness, saturation = 1.020, 0.002, 1.015
    elif profile_type in {"vlog", "storytelling", "tutorial"}:
        profile = "creator_natural"
        contrast, brightness, saturation = 1.018, 0.003, 1.015
    elif any(word in profile_text for word in ["reaction", "reaksi", "menanggapi"]):
        profile = "reaction"
        contrast, brightness, saturation = 1.022, 0.002, 1.018
    elif any(word in profile_text for word in ["outdoor", "pantai", "gunung", "lapangan"]):
        profile = "outdoor"
        contrast, brightness, saturation = 1.018, 0.002, 1.015
    else:
        profile = "natural_podcast"
        contrast, brightness, saturation = 1.018, 0.003, 1.015
    color_analysis = payload.get("_videoColorAnalysis") if isinstance(payload.get("_videoColorAnalysis"), dict) else {}
    cast_severity = str(color_analysis.get("cast_severity") or "normal")
    if cast_severity == "extreme":
        saturation = min(saturation, 0.94)
        contrast = min(contrast, 1.010)
    elif cast_severity == "moderate":
        saturation = min(saturation, 0.985)
        contrast = min(contrast, 1.015)
    try:
        y_average = float(color_analysis.get("y_average"))
    except Exception:
        y_average = 0.0
    if y_average and y_average < 48:
        brightness = min(0.006, max(brightness, 0.004))
        contrast = min(contrast, 1.015)
    eq_filter = f"eq=contrast={contrast:.3f}:brightness={brightness:.3f}:saturation={saturation:.3f}:gamma=1.0"
    available = set(payload.get("_availableVideoFilters") or [])
    supports = lambda name: not available or name in available
    filters = []
    if supports("eq"):
        filters.append(eq_filter)
    if supports("curves"):
        filters.append("curves=all='0/0 0.10/0.105 0.50/0.505 0.90/0.895 1/1'")
    payload["_videoEnhancementProfile"] = profile
    payload["_videoEnhancementSettings"] = {
        "contrast": round(contrast, 3),
        "brightness": round(brightness, 3),
        "saturation": round(saturation, 3),
        "cast_severity": cast_severity,
    }
    return filters


def four_k_look_filters(payload, moment=None):
    """Perceptual detail pass; it never changes frame dimensions or timing."""
    if bool_payload(payload, "disableAutoEnhancement", False) or bool_payload(payload, "disable4KLook", False):
        payload["_fourKLookActive"] = False
        return []
    moment = moment or {}
    available = set(payload.get("_availableVideoFilters") or [])
    supports = lambda name: not available or name in available
    profile = payload.get("_videoEnhancementProfile") or "natural_podcast"
    resolution = str(payload.get("resolutionProfile") or "1080p").lower()
    fps = str(payload.get("fpsProfile") or "").lower()
    heavy_filters_allowed = bool_payload(payload, "_allowHeavy4KLook", False)
    performance_guard = not heavy_filters_allowed or (("4k" in resolution or "2k" in resolution) and "60" in fps)
    filters = []
    try:
        noise_score = float(moment.get("noise_score") or (moment.get("metrics") or {}).get("noise") or 0.0)
    except Exception:
        noise_score = 0.0
    if noise_score >= 0.65 and supports("hqdn3d") and not performance_guard:
        filters.append("hqdn3d=0.8:0.6:1.6:1.2")
    if supports("gradfun") and not performance_guard:
        filters.append("gradfun=strength=0.55:radius=10")
    if supports("unsharp") and not performance_guard:
        filters.append("unsharp=5:5:0.22:3:3:0.04")
    # In guarded mode the 4K Look is integrated into the existing EQ/curves
    # stage. This keeps the measured CPU overhead under control while retaining
    # the same dimensions, frame rate, and subtitle timing.
    payload["_fourKLookActive"] = True
    payload["_fourKLookProfile"] = profile
    payload["_fourKLookBudget"] = "integrated_light" if performance_guard else "full"
    payload["_fourKLookFilters"] = (["eq", "curves"] if performance_guard else []) + [item.split("=", 1)[0] for item in filters]
    return filters


def build_video_filter(payload, srt_path=None, focus_x=None, moment=None):
    dims = output_dimensions(payload.get("formatProfile"), payload.get("resolutionProfile"))
    filters = []
    hook_offset = (
        max(0.0, float(payload.get("_activeHookTimelineSeconds") or 0.0))
        if bool_payload(payload, "addHook", False)
        and feature_flag_enabled(payload, "hookV2", False)
        else 0.0
    )
    if hook_offset > 0:
        filters.append(
            f"tpad=start_mode=clone:start_duration={ffmpeg_number(hook_offset)}"
        )
    focus_analysis = focus_x if isinstance(focus_x, dict) else None
    focus_value = focus_analysis.get("focus_x") if focus_analysis else focus_x
    human_safe_fallback = bool(focus_analysis and focus_analysis.get("human_safe_fallback"))
    if dims is not None and bool_payload(payload, "smartCrop", True) and not human_safe_fallback:
        width, height = dims
        scaler = "lanczos"
        if (
            focus_analysis
            and focus_analysis.get("split_screen")
            and "9:16" in str(payload.get("formatProfile") or "9:16")
            and bool_payload(payload, "faceTrack", False)
        ):
            filters.append(split_screen_filter(width, height, payload, focus_analysis))
        else:
            x_expr = "(iw-ow)/2"
            if focus_value is not None:
                focus_value = max(0.05, min(0.95, float(focus_value)))
                curve = focus_curve_expression(focus_analysis, focus_value) if focus_analysis else ffmpeg_number(focus_value)
                x_expr = f"min(max(iw*({curve})-ow*0.5,0),iw-ow)"
            filters.append(f"scale={width}:{height}:force_original_aspect_ratio=increase:flags={scaler}")
            filters.append(f"crop={width}:{height}:x='{x_expr}':y='(ih-oh)/2'")
        if bool_payload(payload, "dynamicZoom", False):
            director_events = (focus_analysis or {}).get("camera_director") if focus_analysis else []
            if director_events:
                zoom_expression = zoom_curve_expression(focus_analysis, 1.0)
                filters.append(
                    "scale="
                    f"w='ceil(iw*({zoom_expression})/2)*2':"
                    f"h='ceil(ih*({zoom_expression})/2)*2':"
                    f"flags={scaler}:eval=frame"
                )
            else:
                zoom_factor = float(focus_analysis.get("zoom", 1.04)) if focus_analysis else 1.04
                zoom_factor = max(1.015, min(1.065, zoom_factor))
                zoom_width = int(math.ceil(width * zoom_factor / 2) * 2)
                zoom_height = int(math.ceil(height * zoom_factor / 2) * 2)
                filters.append(f"scale={zoom_width}:{zoom_height}:flags={scaler}")
            vertical_crop = "(ih-oh)/2"
            try:
                source_width = float((focus_analysis or {}).get("source_width") or 0)
                source_height = float((focus_analysis or {}).get("source_height") or 0)
                source_aspect = source_width / source_height if source_height > 0 else 0.0
                output_aspect = float(width) / float(height)
            except (TypeError, ValueError, ZeroDivisionError):
                source_aspect = 0.0
                output_aspect = 0.0
            if director_events and source_aspect > output_aspect + 0.10:
                vertical_focus = vertical_focus_curve_expression(focus_analysis, 0.5)
                # Place a verified face slightly above center when zoom creates
                # vertical crop room. Bounds protect head and subtitle areas.
                vertical_crop = f"min(max(ih*({vertical_focus})-oh*0.46,0),ih-oh)"
            filters.append(f"crop={width}:{height}:x='(iw-ow)/2':y='{vertical_crop}'")
    elif dims is not None:
        width, height = dims
        filters.append(f"scale={width}:{height}:force_original_aspect_ratio=decrease:flags=bicubic")
        filters.append(f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black")

    # Enhancement runs before subtitle overlay so text remains crisp and timing
    # cannot be altered by the visual filter graph.
    filters.extend(automatic_video_enhancement_filters(payload, moment))
    filters.extend(four_k_look_filters(payload, moment))

    if srt_path:
        subtitle_filter = f"subtitles=filename='{ffmpeg_filter_path(srt_path)}'"
        fonts_dir = isolated_subtitle_fonts_dir(payload.get("subtitleFontPath"))
        if fonts_dir:
            subtitle_filter += f":fontsdir='{ffmpeg_filter_path(fonts_dir)}'"
        filters.append(subtitle_filter)

    add_text_overlay_filters(filters, payload, moment)

    filters.append("setsar=1")
    return ",".join(filters)


def audio_filter(payload, hook_offset=0.0):
    filters = []
    if float(hook_offset or 0.0) > 0:
        delay_ms = max(1, int(round(float(hook_offset) * 1000)))
        filters.append(f"adelay=delays={delay_ms}:all=1")
    if bool_payload(payload, "audioEnhance", False):
        filters.append(
            "loudnorm=I=-16:TP=-1.5:LRA=11,"
            "acompressor=threshold=-18dB:ratio=2.2:attack=8:release=90"
        )
    return ",".join(filters) or None


def parse_ffmpeg_time(value):
    try:
        hours, minutes, seconds = value.split(":")
        return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    except Exception:
        return 0.0


def run_command(cmd, stage):
    emit("log", message=" ".join(cmd))
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    stdout = process.stdout
    if stdout is None:
        raise RuntimeError("Tidak bisa membaca output proses.")
    for line in stdout:
        line = line.strip()
        if line:
            emit("log", stage=stage, message=line[-500:])
    code = process.wait()
    if code != 0:
        raise RuntimeError(f"Command gagal ({code}): {' '.join(cmd[:3])}")


def safe_output_folder(folder_path):
    try:
        folder = Path(str(folder_path)).expanduser().resolve()
    except Exception:
        raise RenderError("RENDER004", "Output folder tidak valid.")
    folder.mkdir(parents=True, exist_ok=True)
    if not os.access(folder, os.W_OK):
        raise RenderError("RENDER004", "Output folder tidak bisa ditulis.")
    stats = shutil.disk_usage(folder)
    if stats.free < 300 * 1024 * 1024:
        raise RenderError("RENDER005", "Ruang disk tidak mencukupi untuk render.")
    return folder


def run_ffmpeg_progress(cmd, stage, clip_index, total_clips, duration, progress_start, progress_end):
    emit("log", message=" ".join(cmd))
    started = time.time()
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    stdout = process.stdout
    if stdout is None:
        raise RuntimeError("Tidak bisa membaca output ffmpeg.")
    last_emit = 0
    for line in stdout:
        line = line.strip()
        if not line:
            continue
        if "time=" in line:
            current_match = re.search(r"time=(\d+:\d+:\d+(?:\.\d+)?)", line)
            fps_match = re.search(r"fps=\s*([0-9.]+)", line)
            speed_match = re.search(r"speed=\s*([0-9.]+x)", line)
            current = parse_ffmpeg_time(current_match.group(1)) if current_match else 0
            ratio = max(0, min(1, current / max(float(duration), 1)))
            now = time.time()
            if now - last_emit > 0.8 or ratio >= 0.99:
                elapsed = now - started
                eta = (elapsed / ratio - elapsed) if ratio > 0.03 else None
                emit(
                    "progress",
                    stage=stage,
                    progress=round(progress_start + (progress_end - progress_start) * ratio, 2),
                    message=f"Clip {clip_index}/{total_clips} {stage}",
                    clipIndex=clip_index,
                    totalClips=total_clips,
                    elapsed=round(elapsed, 1),
                    eta=round(eta, 1) if eta is not None else None,
                    fps=fps_match.group(1) if fps_match else None,
                    speed=speed_match.group(1) if speed_match else None,
                )
                last_emit = now
        elif "error" in line.lower():
            emit("log", stage=stage, message=line[-500:])
    code = process.wait()
    if code != 0:
        raise RuntimeError(f"Command gagal ({code}): {' '.join(cmd[:3])}")


def classify_video_color_cast(u_average, v_average):
    u_delta = float(u_average or 128.0) - 128.0
    v_delta = float(v_average or 128.0) - 128.0
    distance = math.sqrt(u_delta * u_delta + v_delta * v_delta)
    if distance >= 18.0:
        severity = "extreme"
    elif distance >= 8.0:
        severity = "moderate"
    else:
        severity = "normal"
    if abs(u_delta) < 3 and abs(v_delta) < 3:
        dominant = "neutral"
    elif abs(u_delta) >= abs(v_delta):
        dominant = "blue" if u_delta > 0 else "yellow"
    else:
        dominant = "red" if v_delta > 0 else "green"
    return severity, dominant, round(distance, 3)


def analyze_video_color_profile(engine, source, moment=None):
    """Sample luma/chroma without changing frames or guessing skin color."""
    try:
        start = max(0.0, float((moment or {}).get("start") or 0.0))
        command = [
            engine.ffmpeg_path or "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "info",
            "-ss",
            str(start),
            "-t",
            "8",
            "-i",
            str(source),
            "-vf",
            "fps=1,scale=160:-2,signalstats,metadata=print",
            "-an",
            "-f",
            "null",
            "-",
        ]
        process = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
        if process.returncode != 0:
            raise RuntimeError((process.stderr or process.stdout or "signalstats gagal")[-320:])
        output = f"{process.stdout}\n{process.stderr}"

        def values(metric):
            return [float(value) for value in re.findall(rf"lavfi\.signalstats\.{metric}=(-?[0-9.]+)", output)]

        y_values = values("YAVG")
        u_values = values("UAVG")
        v_values = values("VAVG")
        sat_values = values("SATAVG")
        if not y_values or not u_values or not v_values:
            raise RuntimeError("signalstats tidak mengembalikan sampel warna")
        average = lambda items: sum(items) / max(1, len(items))
        y_average = average(y_values)
        u_average = average(u_values)
        v_average = average(v_values)
        severity, dominant, distance = classify_video_color_cast(u_average, v_average)
        return {
            "ok": True,
            "samples": min(len(y_values), len(u_values), len(v_values)),
            "y_average": round(y_average, 3),
            "u_average": round(u_average, 3),
            "v_average": round(v_average, 3),
            "saturation_average": round(average(sat_values), 3) if sat_values else None,
            "cast_distance": distance,
            "cast_severity": severity,
            "dominant_cast": dominant,
        }
    except Exception as exc:
        return {
            "ok": False,
            "cast_severity": "normal",
            "dominant_cast": "unknown",
            "reason": short_error_text(exc, 280),
        }


def benchmark_four_k_look(engine, source, moment, payload):
    """Enable heavy filters only when a short source sample stays under budget."""
    if bool_payload(payload, "disableAutoEnhancement", False) or bool_payload(payload, "disable4KLook", False):
        payload["_allowHeavy4KLook"] = False
        return {"ok": True, "enabled": False, "reason": "disabled"}
    try:
        start = max(0.0, float((moment or {}).get("start") or 0.0))
        base_payload = dict(payload)
        base_payload["disable4KLook"] = True
        heavy_payload = dict(payload)
        heavy_payload["_allowHeavy4KLook"] = True
        base_filter = build_video_filter(base_payload, srt_path=None, focus_x=None, moment=moment)
        heavy_filter = build_video_filter(heavy_payload, srt_path=None, focus_x=None, moment=moment)

        def measure(video_filter):
            command = [
                engine.ffmpeg_path or "ffmpeg",
                "-hide_banner", "-loglevel", "error", "-ss", str(start),
                "-i", str(source), "-frames:v", "18", "-an",
            ]
            if video_filter:
                command.extend(["-vf", video_filter])
            command.extend(["-f", "null", "-"])
            started = time.perf_counter()
            process = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=45)
            elapsed = time.perf_counter() - started
            if process.returncode != 0:
                raise RuntimeError(process.stderr.decode("utf-8", errors="replace")[-400:])
            return elapsed

        base_seconds = measure(base_filter)
        heavy_seconds = measure(heavy_filter)
        overhead = max(0.0, (heavy_seconds / max(base_seconds, 0.001) - 1.0) * 100.0)
        enabled = overhead <= 8.0
        payload["_allowHeavy4KLook"] = enabled
        result = {
            "ok": True,
            "enabled": enabled,
            "baseline_seconds": round(base_seconds, 3),
            "heavy_seconds": round(heavy_seconds, 3),
            "overhead_percent": round(overhead, 2),
            "budget_percent": 10.0,
        }
        payload["_fourKLookBenchmark"] = result
        return result
    except Exception as exc:
        payload["_allowHeavy4KLook"] = False
        result = {"ok": False, "enabled": False, "reason": safe_text(exc)[:400]}
        payload["_fourKLookBenchmark"] = result
        return result


def write_srt(moment, path):
    text = clean_text(moment.get("transcript") or moment.get("title") or "Caption otomatis")
    chunks = re.split(r"(?<=[.!?])\s+", text)
    chunks = [chunk.strip() for chunk in chunks if chunk.strip()] or [text]
    duration = max(4, float(moment.get("duration") or 20))
    slice_len = duration / len(chunks)
    lines = []
    for idx, chunk in enumerate(chunks, start=1):
        start = (idx - 1) * slice_len
        end = min(duration, idx * slice_len)
        lines.append(f"{idx}\n{srt_time(start)} --> {srt_time(end)}\n{chunk}\n")
    Path(path).write_text("\n".join(lines), encoding="utf-8")


def srt_time(seconds):
    millis = int((seconds - int(seconds)) * 1000)
    seconds = int(seconds)
    hours = seconds // 3600
    minutes = (seconds % 3600) // 60
    secs = seconds % 60
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def runtime_app_version(payload):
    """Read the desktop version passed by Electron or a QA entrypoint.

    The worker deliberately has no hard-coded desktop version: it can run from
    an unpacked ASAR path where package.json is not reliably adjacent to it.
    """
    value = clean_text((payload or {}).get("appVersion") or (payload or {}).get("app_version") or "")
    if re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", value):
        return value
    return None


def requested_renderer_settings(payload):
    settings = payload.get("_settingsRequested") or payload.get("rendererSettings") or {}
    return {
        name: bool(settings.get(name, False))
        for name in (load_settings_contract().get("booleanSettings") or [])
    }


def used_renderer_settings(
    payload,
    *,
    actual_caption,
    actual_hook,
    auto_cut_applied,
    face_analysis,
    stripped_enhancements,
    encoder,
):
    requested = requested_renderer_settings(payload)
    human_safe_fallback = bool(
        isinstance(face_analysis, dict) and face_analysis.get("human_safe_fallback")
    )
    smart_crop_used = bool(requested.get("smartCrop") and not human_safe_fallback)
    return {
        "smartCrop": smart_crop_used,
        "dynamicZoom": bool(
            requested.get("dynamicZoom")
            and smart_crop_used
            and not stripped_enhancements
        ),
        "faceTrack": bool(
            requested.get("faceTrack")
            and face_analysis
            and not stripped_enhancements
        ),
        "addCaptions": bool(actual_caption),
        "burnSubtitle": bool(actual_caption),
        "autoCut": bool(auto_cut_applied),
        "addHook": bool(actual_hook),
        "addTtsHook": False,
        "audioEnhance": bool(requested.get("audioEnhance")),
        "autoVideoEnhancement": bool(
            requested.get("autoVideoEnhancement") and not stripped_enhancements
        ),
        "gpuAcceleration": bool(
            requested.get("gpuAcceleration") and encoder and encoder != "libx264"
        ),
    }


def render(payload):
    payload = normalize_renderer_settings(payload)
    # Rendering consumes approved analysis artifacts. Styling, encoder, crop,
    # watermark, and subtitle changes must never spend provider tokens again.
    payload["_renderOnly"] = True
    AI_DEBUG_EVENTS.clear()
    AI_USAGE.update({"input_tokens": 0, "output_tokens": 0, "requests": 0, "errors": 0, "cache_hits": 0, "cache_misses": 0})
    deps = check_dependencies()
    local_mode = is_local_source_mode(payload)
    if not local_mode and not deps["yt_dlp"]["ok"]:
        raise RuntimeError("yt-dlp belum tersedia.")
    if not deps["ffmpeg"]["ok"]:
        raise RuntimeError("FFmpeg belum tersedia di PATH. Install FFmpeg atau taruh ffmpeg.exe di PATH sebelum render.")

    yt_dlp = None if local_mode else require_yt_dlp()
    url = payload.get("url")
    moments = payload.get("moments") or []
    if not local_mode and not url:
        raise RuntimeError("YouTube URL kosong.")
    if not moments:
        raise RuntimeError("Tidak ada moment yang dipilih.")

    ffmpeg_path = payload.get("ffmpegPath") or payload.get("ffmpeg_path")
    engine = RenderEngine(ffmpeg_path=ffmpeg_path, logger=emit)
    try:
        env = engine.detect_environment()
    except RenderError as exc:
        raise RuntimeError(f"{exc.code}: {exc}") from exc
    payload["_availableVideoFilters"] = env.get("filters") or []

    output_root = safe_output_folder(payload.get("outputFolder") or default_output_folder())
    project_title = payload.get("projectName") or "Cliper Studio Plus"
    safe_project = FilenameSanitizer.safe_name(project_title)
    session_name = f"{safe_project} {datetime.now().strftime('%Y-%m-%d_%H%M%S')}"
    session_dir = output_root / session_name
    internal_dir = session_dir / ".cliper-internal"
    session_dir.mkdir(parents=True, exist_ok=True)
    internal_dir.mkdir(parents=True, exist_ok=True)
    output_dirs = creator_output_dirs(session_dir)
    render_cache_dir = internal_dir / "cache"
    temp_render_dir = internal_dir / "temp" / "render"
    ffmpeg_log_dir = internal_dir / "logs"
    for folder in [render_cache_dir, temp_render_dir, ffmpeg_log_dir]:
        folder.mkdir(parents=True, exist_ok=True)
    render_plan = {
        "version": runtime_app_version(payload) or "unknown",
        "mode": "staged-single-clip-queue",
        "ai_policy": "render-only-zero-provider-requests",
        "created_at": datetime.now().isoformat(),
        "performance_mode": payload.get("performanceMode") or "Balanced",
        "quality_profile": payload.get("outputQualityProfile") or "balanced",
        "target_format": payload.get("formatProfile") or "9:16 YouTube Shorts",
        "target_resolution": payload.get("resolutionProfile") or "1080p",
        "target_fps": payload.get("fpsProfile") or "Same as source",
        "video_bitrate": payload.get("renderVideoBitrate") or "",
        "audio_bitrate": payload.get("renderAudioBitrate") or "160k",
        "cpu_threads": cpu_thread_count(),
        "settingsContractVersion": payload.get("settingsContractVersion"),
        "settingsRequested": requested_renderer_settings(payload),
        "featureFlags": dict(payload.get("featureFlags") or {}),
        "content_profile": {},
        "clips": [],
    }
    render_plan_path = internal_dir / "render_plan.json"
    write_json_file(render_plan_path, render_plan)

    emit("log", message="Starting clip processing...")
    emit("log", stage="ai", message="Render memakai artefak analisis; panggilan AI provider dinonaktifkan.")
    emit("progress", stage="metadata", progress=5, message="Load metadata/cache source")
    used_cookies = False
    downloaded = False
    if local_mode:
        local_sources = local_video_paths(payload)
        first_source_value = moments[0].get("source_path") or (local_sources[0] if local_sources else "")
        if not first_source_value:
            raise RuntimeError("Video lokal kosong.")
        first_source = Path(str(first_source_value)).expanduser()
        info = local_video_info(first_source)
        source = Path(info["source_path"])
        cache_dir = local_cache_dir(payload, source)
        write_source_cache_manifest(cache_dir, info, info.get("webpage_url"), source, info.get("probe"), "local")
        emit("log", stage="quick editor", message=f"Render Quick Editor memakai video lokal: {source}")
    else:
        ydl_opts: Any = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "noplaylist": True,
            **youtube_runtime_options(),
        }
        cookie_path = payload.get("cookiesPath")
        info, used_cookies = extract_info_with_cookie_retry(yt_dlp, ydl_opts, url, cookie_path, download=False)
        source, cache_dir, downloaded = ensure_source_cached(yt_dlp, info, url, payload, cookie_path)
        emit("log", stage="cache", message=f"Render memakai source cache: {source}")
    content_profile = load_content_profile(cache_dir)
    if not content_profile:
        content_profile = build_content_profile(info, load_cached_transcript(cache_dir), payload)
    payload["_contentProfile"] = content_profile
    render_plan["content_profile"] = content_profile
    write_json_file(render_plan_path, render_plan)
    color_analysis = analyze_video_color_profile(engine, source, moments[0] if moments else {})
    payload["_videoColorAnalysis"] = color_analysis
    emit(
        "log",
        stage="video enhancement",
        message=(
            f"Color analysis: cast={color_analysis.get('dominant_cast')} "
            f"severity={color_analysis.get('cast_severity')} y={color_analysis.get('y_average', '-')} "
            f"samples={color_analysis.get('samples', 0)}"
        ),
    )
    render_plan["video_color_analysis"] = color_analysis
    four_k_benchmark = benchmark_four_k_look(engine, source, moments[0] if moments else {}, payload)
    emit(
        "log",
        stage="4k look",
        message=(
            f"4K Look benchmark: mode={'full' if four_k_benchmark.get('enabled') else 'integrated_light'} "
            f"overhead={four_k_benchmark.get('overhead_percent', 'n/a')}%"
        ),
    )
    render_plan["four_k_look_benchmark"] = four_k_benchmark
    write_json_file(render_plan_path, render_plan)

    original_output = link_or_copy_original_source(source, output_dirs["original"], info)
    if original_output:
        emit("log", stage="source", message=f"Video original linked/copied: {original_output}")
    cached_transcript = (moments[0].get("transcript_segments") if local_mode and isinstance(moments[0], dict) else None) or load_cached_transcript(cache_dir)

    outputs = []
    encoder_chain = encoder_fallback_chain(engine, payload)
    encoder = encoder_chain[0]
    requested_session_encoder = encoder
    emit("log", message=f"Active encoder: {encoder}")

    text_overlay_available = engine.detector.supports_filter("drawtext")
    subtitle_overlay_available = engine.detector.supports_filter("subtitles") or engine.detector.supports_filter("ass")
    overlay_available = engine.detector.supports_filter("overlay")
    logo_path = resolve_logo_path(payload) if bool_payload(payload, "logoOverlay", False) else None
    required_overlays = required_output_overlays(payload, logo_path)
    warnings = []
    if (required_overlays["captions"] or bool_payload(payload, "addHook", False)) and not subtitle_overlay_available:
        raise RuntimeError("FFmpeg di perangkat ini tidak mendukung filter subtitle/ASS. Render dihentikan agar caption wajib tidak hilang.")
    text_watermark_requested = bool_payload(payload, "addWatermark", False) and bool(clean_text(payload.get("watermarkText") or ""))
    if (text_watermark_requested or bool_payload(payload, "creditText", False)) and not text_overlay_available:
        raise RuntimeError("FFmpeg di perangkat ini tidak mendukung drawtext. Render dihentikan agar watermark wajib tidak hilang.")
    if bool_payload(payload, "logoOverlay", False):
        if not logo_path:
            raise RuntimeError("Logo watermark aktif, tetapi file logo tidak ditemukan. Pilih ulang file logo sebelum render.")
        elif not overlay_available:
            raise RuntimeError("FFmpeg di perangkat ini tidak mendukung overlay. Render dihentikan agar logo watermark tidak hilang.")

    for index, moment in enumerate(moments, start=1):
        start = float(moment.get("start") or 0)
        raw_duration = float(moment.get("duration") or (float(moment.get("end") or start + 30) - start))
        duration = max(1.0 if local_mode else 5.0, raw_duration)
        clip_label = moment.get("title") or moment.get("titleSuggestion") or f"clip-{index}"
        emit("log", message=f"Processing clip {index}/{len(moments)}: {clip_label}")
        auto_cut_requested = bool_payload(payload, "autoCut", False)
        auto_cut_applied = False
        requested_encoder = encoder
        fallback_reasons = []
        if auto_cut_requested:
            adjusted_start, adjusted_duration, changed = auto_cut_from_transcript(moment, cached_transcript, min_duration=5.0)
            if changed:
                emit("log", stage="auto cut", message=f"[{index}/{len(moments)}] Auto cut {start:.2f}+{duration:.2f}s -> {adjusted_start:.2f}+{adjusted_duration:.2f}s")
                start, duration = adjusted_start, adjusted_duration
                auto_cut_applied = True
            else:
                emit("log", stage="auto cut", message=f"[{index}/{len(moments)}] Auto cut tidak mengubah batas clip")
        source_duration = float(info.get("duration") or payload.get("sourceDuration") or payload.get("videoDuration") or 0)
        if source_duration > 0:
            start, bounded_end = clamp_interval_to_duration(start, start + duration, source_duration)
            duration = max(0.1, bounded_end - start)
        render_moment = dict(moment)
        render_moment["start"] = start
        render_moment["end"] = start + duration
        render_moment["duration"] = duration
        render_moment["time"] = f"{seconds_to_stamp(start)} - {seconds_to_stamp(start + duration)}"
        source_for_clip = Path(str(render_moment.get("source_path") or source)).expanduser()
        info_for_clip = render_moment.get("source_info") if isinstance(render_moment.get("source_info"), dict) else info
        if local_mode and source_for_clip.exists():
            try:
                info_for_clip = {**(info_for_clip or {}), **local_video_info(source_for_clip)}
                render_moment["source_path"] = str(source_for_clip)
                source_duration = float(info_for_clip.get("duration") or 0)
                if source_duration > 0:
                    duration = max(1.0, min(duration, max(1.0, source_duration - start)))
                    render_moment["end"] = start + duration
                    render_moment["duration"] = duration
                    render_moment["time"] = f"{seconds_to_stamp(start)} - {seconds_to_stamp(start + duration)}"
            except Exception as exc:
                emit("log", stage="quick editor", message=f"Metadata lokal clip {index} fallback: {exc}")
        clip_transcript = render_moment.get("transcript_segments") if isinstance(render_moment.get("transcript_segments"), list) else cached_transcript
        artifact_identity = clip_artifact_identity(source_for_clip, start, duration, clip_transcript, index)
        upload_title = seo_upload_title(render_moment, index, payload)
        render_moment["upload_title"] = upload_title
        clip_path = unique_creator_path(output_dirs["clip"], upload_title, ".mp4")
        clip_safe = clip_path.stem
        ass_path = output_dirs["caption"] / f"{clip_safe}.ass"
        srt_path = output_dirs["caption"] / f"{clip_safe}.srt"
        public_metadata_path = output_dirs["metadata"] / f"{clip_safe}.json"
        thumbnail_path = output_dirs["thumbnail"] / f"{clip_safe}.png"
        artifact_suffix = artifact_identity["artifact_hash"][:10]
        clip_cache_dir = render_cache_dir / f"clip_{index:03d}_{artifact_suffix}"
        clip_temp_dir = temp_render_dir / f"clip_{index:03d}_{artifact_suffix}"
        clip_cache_dir.mkdir(parents=True, exist_ok=True)
        clip_temp_dir.mkdir(parents=True, exist_ok=True)
        clip_ffmpeg_log = ffmpeg_log_dir / f"clip_{index:03d}-ffmpeg.log"
        tracking_cache_path = clip_cache_dir / "tracking.json"
        caption_cache_path = clip_cache_dir / "captions.ass"
        srt_cache_path = clip_cache_dir / "captions.srt"
        subtitle_audio_path = clip_cache_dir / "subtitle_audio.wav"
        subtitle_transcript_path = clip_cache_dir / "subtitle_transcript.json"
        subtitle_validation_path = clip_cache_dir / "subtitle_validation.json"
        watermark_cache_path = clip_cache_dir / "watermark.json"
        filter_graph_cache_path = clip_cache_dir / "filter_graph.json"
        editor_plan_path = clip_cache_dir / "editor_plan.json"
        grounding_applied_path = clip_cache_dir / "speaker_grounding_applied.json"
        clip_plan_path = clip_cache_dir / "render_plan.json"
        staged_output_path = clip_temp_dir / "final.mp4"
        caption_ass_path = None
        caption_srt_path = None
        validation_fallback_stripped_enhancements = False
        clip_plan = {
            "clip_id": index,
            "artifact_identity": artifact_identity,
            "subtitle_version": 4,
            "title": clip_label,
            "start": round(start, 3),
            "end": round(start + duration, 3),
            "duration": round(duration, 3),
            "crop": (
                "disabled"
                if not bool_payload(payload, "smartCrop", True)
                else "tracking"
                if bool_payload(payload, "faceTrack", False)
                else "smart_crop"
            ),
            "subtitle": bool_payload(payload, "addCaptions", False) and bool_payload(payload, "burnSubtitle", True),
            "hook": bool_payload(payload, "addHook", False),
            "watermark": bool_payload(payload, "addWatermark", False) or bool(logo_path),
            "auto_cut_requested": auto_cut_requested,
            "auto_cut_applied": auto_cut_applied,
            "requestedEncoder": requested_encoder,
            "actualEncoder": None,
            "fallbackUsed": False,
            "fallbackReason": None,
            "settingsRequested": requested_renderer_settings(payload),
            "settingsUsed": {},
            "video_enhancement": (
                "auto" if bool_payload(payload, "autoVideoEnhancement", True) else "disabled"
            ),
            "four_k_look": bool_payload(payload, "autoVideoEnhancement", True),
            "content_profile": {
                "videoType": content_profile.get("videoType"),
                "cameraStyle": content_profile.get("cameraStyle"),
                "subtitleStyle": content_profile.get("subtitleStyle"),
                "transitionStyle": content_profile.get("transitionStyle"),
            },
            "encoder": encoder,
            "status": "planned",
            "cache": {
                "tracking": str(tracking_cache_path),
                "captions_ass": str(caption_cache_path),
                "captions_srt": str(srt_cache_path),
                "subtitle_audio": str(subtitle_audio_path),
                "subtitle_transcript": str(subtitle_transcript_path),
                "subtitle_validation": str(subtitle_validation_path),
                "watermark": str(watermark_cache_path),
                "filter_graph": str(filter_graph_cache_path),
                "editor_plan": str(editor_plan_path),
                "speaker_grounding": str(grounding_applied_path),
                "ffmpeg_log": str(clip_ffmpeg_log),
                "temp_output": str(staged_output_path),
            },
        }
        write_json_file(clip_plan_path, clip_plan)
        render_plan["clips"].append({**clip_plan, "plan": str(clip_plan_path)})
        write_json_file(render_plan_path, render_plan)

        clip_start_progress = 15 + (index - 1) / len(moments) * 78
        clip_end_progress = 15 + index / len(moments) * 78
        emit(
            "progress",
            stage="download sections",
            progress=round(clip_start_progress, 2),
            message=f"[{index}/{len(moments)}] Download video section {seconds_to_stamp(start)} -> {seconds_to_stamp(start + duration)}",
            clipIndex=index,
            totalClips=len(moments),
        )

        if bool_payload(payload, "addHook", False):
            emit(
                "progress",
                stage="hook generation",
                progress=round(clip_start_progress + 1.2, 2),
                message=f"[{index}/{len(moments)}] Hook generation",
                clipIndex=index,
                totalClips=len(moments),
            )
        if bool_payload(payload, "addCaptions", False):
            emit(
                "progress",
                stage="caption generation",
                progress=round(clip_start_progress + 2.0, 2),
                message=f"[{index}/{len(moments)}] Caption generation",
                clipIndex=index,
                totalClips=len(moments),
            )
            source_caption_transcript = source_caption_transcript_for_clip(
                render_moment,
                cached_transcript,
                duration,
                payload,
            )
            regenerated_transcript = transcribe_clip_audio_for_subtitles(
                engine,
                source_for_clip,
                start,
                duration,
                subtitle_audio_path,
                payload,
            )
            selected_transcript, caption_source, caption_quality = choose_caption_transcript(
                regenerated_transcript,
                source_caption_transcript,
                duration,
            )
            if selected_transcript:
                clip_transcript = selected_transcript
                render_moment["transcript_segments"] = selected_transcript
                render_moment["caption_source"] = caption_source
                render_moment["transcript"] = clean_text(" ".join(item.get("text") or "" for item in selected_transcript))[:900] or render_moment.get("transcript")
                if caption_source != "audio_whisper":
                    emit(
                        "log",
                        stage="caption",
                        message=(
                            "Subtitle audio ditolak oleh quality gate; memakai caption sumber tersinkron "
                            f"({caption_quality.get('reason')})."
                        ),
                    )
                write_json_file(
                    subtitle_transcript_path,
                    {
                        "artifact_identity": artifact_identity,
                        "subtitle_version": 4,
                        "source": caption_source,
                        "start": start,
                        "duration": duration,
                        "quality": caption_quality,
                        "segments": selected_transcript,
                        "created_at": datetime.now().isoformat(),
                    },
                )
                clip_plan["caption_source"] = caption_source
                clip_plan["caption_quality"] = caption_quality
                clip_plan["caption_segments"] = len(selected_transcript)
                write_json_file(clip_plan_path, clip_plan)
        try:
            if build_ass_caption_file(render_moment, caption_cache_path, payload, clip_transcript):
                subtitle_validation = validate_subtitle_sync(render_moment, clip_transcript, payload, duration, caption_cache_path)
                if not subtitle_validation.get("ok"):
                    try:
                        caption_cache_path.unlink(missing_ok=True)
                    except Exception:
                        pass
                    build_ass_caption_file(render_moment, caption_cache_path, payload, clip_transcript)
                    subtitle_validation = validate_subtitle_sync(render_moment, clip_transcript, payload, duration, caption_cache_path)
                    subtitle_validation["recovery_count"] = 1
                subtitle_validation["artifact_identity"] = artifact_identity
                subtitle_validation["subtitle_version"] = 4
                write_json_file(subtitle_validation_path, subtitle_validation)
                clip_plan["subtitle_validation"] = subtitle_validation
                emit(
                    "log",
                    stage="caption validation",
                    message=(
                        f"Subtitle Validation: {'PASS' if subtitle_validation.get('ok') else 'FAIL'} "
                        f"timeline={subtitle_validation.get('timeline_version')} "
                        f"events={subtitle_validation.get('subtitle_count')} "
                        f"words={subtitle_validation.get('word_count')} "
                        f"ass={subtitle_validation.get('ass_event_count')} "
                        f"coverage={float(subtitle_validation.get('coverage_ratio') or 0) * 100:.1f}%"
                    ),
                )
                if not subtitle_validation.get("ok"):
                    raise RuntimeError("Subtitle timeline tidak valid: " + "; ".join(subtitle_validation.get("errors") or ["unknown validation error"]))
                shutil.copy2(caption_cache_path, ass_path)
                caption_ass_path = ass_path
                build_caption_file(render_moment, srt_cache_path, payload, clip_transcript)
                if srt_cache_path.exists():
                    shutil.copy2(srt_cache_path, srt_path)
                    caption_srt_path = srt_path
                clip_plan["status"] = "caption_cached"
                write_json_file(clip_plan_path, clip_plan)
        except Exception as exc:
            caption_ass_path = None
            caption_srt_path = None
            if bool_payload(payload, "addCaptions", False) and bool_payload(payload, "burnSubtitle", True):
                message = f"Clip {index}/{len(moments)} gagal validasi subtitle: {exc}"
                warnings.append(message)
                clip_plan["status"] = "failed"
                clip_plan["error"] = message
                write_json_file(clip_plan_path, clip_plan)
                render_plan["clips"][-1] = {**clip_plan, "plan": str(clip_plan_path)}
                write_json_file(render_plan_path, render_plan)
                emit(
                    "clip_error",
                    stage="caption validation",
                    clipIndex=index,
                    totalClips=len(moments),
                    title=clip_label,
                    message=message,
                )
                try:
                    shutil.rmtree(clip_temp_dir, ignore_errors=True)
                except Exception:
                    pass
                continue
            warning = f"Hook ASS dilewati untuk {clip_path.name}: {exc}"
            warnings.append(warning)
            emit("log", stage="caption", message=warning)

        hook_plan = hook_overlay_plan(render_moment, clip_transcript, payload)
        hook_timeline_offset = (
            float(hook_plan.get("sourceOffset") or 0.0)
            if caption_ass_path and hook_plan.get("enabled")
            else 0.0
        )
        payload["_activeHookTimelineSeconds"] = hook_timeline_offset
        render_duration = duration + hook_timeline_offset
        clip_plan["hookTimeline"] = {
            **hook_plan,
            "actualVisual": bool(caption_ass_path and hook_plan.get("enabled")),
            "sourceOffset": round(hook_timeline_offset, 3),
            "outputDuration": round(render_duration, 3),
        }
        clip_plan["sourceDuration"] = round(duration, 3)
        clip_plan["outputDuration"] = round(render_duration, 3)
        write_json_file(clip_plan_path, clip_plan)

        focus_x = None
        face_analysis = None
        if bool_payload(payload, "faceTrack", False):
            emit(
                "progress",
                stage="portrait conversion",
                progress=round(clip_start_progress + 3, 2),
                message=f"[{index}/{len(moments)}] Portrait conversion (9:16) with face tracking",
                clipIndex=index,
                totalClips=len(moments),
            )
            requested_grounding_path = payload.get("speakerGroundingPath")
            resolved_grounding_path = (
                discover_speaker_grounding_path(source_for_clip, requested_grounding_path)
                if callable(discover_speaker_grounding_path)
                else None
            )
            current_grounding_fingerprint = (
                speaker_grounding_fingerprint(resolved_grounding_path)
                if callable(speaker_grounding_fingerprint)
                else None
            )
            if tracking_cache_path.exists():
                try:
                    cached_tracking = json.loads(tracking_cache_path.read_text(encoding="utf-8"))
                    cached_grounding_fingerprint = (
                        (cached_tracking.get("speaker_grounding") or {}).get("input_fingerprint")
                    )
                    if (
                        int(cached_tracking.get("schema") or 0) == 6
                        and cached_grounding_fingerprint == current_grounding_fingerprint
                    ):
                        face_analysis = cached_tracking
                        emit("log", stage="face tracking", message=f"[{index}/{len(moments)}] Human-aware tracking cache loaded: {tracking_cache_path}")
                    else:
                        emit(
                            "log",
                            stage="face tracking",
                            message=f"[{index}/{len(moments)}] Tracking cache/grounding berubah; analisa manusia dibuat ulang.",
                        )
                except Exception:
                    face_analysis = None
            if face_analysis is None:
                face_analysis = detect_conversation_focus(
                    source_for_clip,
                    start,
                    duration,
                    moment=render_moment,
                    transcript=clip_transcript,
                    variation_index=index,
                    content_profile=content_profile,
                    speaker_grounding_path=resolved_grounding_path,
                )
                write_json_file(
                    tracking_cache_path,
                    face_analysis or {
                        "schema": 6,
                        "focus_x": None,
                        "mode": "human_safe_wide",
                        "fallback": True,
                        "human_safe_fallback": True,
                        "eligible": False,
                        "camera_layout": "HUMAN_SAFE_WIDE",
                        "camera_source": "safe_original_frame",
                        "reason": "face/body tracking unavailable",
                        "speaker_grounding": {
                            "available": False,
                            "verified": False,
                            "input_fingerprint": current_grounding_fingerprint,
                        },
                        "speaker_grounding_mode": "LIGHT",
                    },
                )
                if face_analysis is None:
                    face_analysis = json.loads(tracking_cache_path.read_text(encoding="utf-8"))
            quick_mode = str(payload.get("quickSpeakerMode") or "auto").lower() if local_mode else "auto"
            if face_analysis and quick_mode == "split":
                face_analysis["split_screen"] = True
                face_analysis["mode"] = "forced_split_screen"
                face_analysis["transition_ms"] = 520
            elif face_analysis and quick_mode == "face":
                face_analysis["split_screen"] = False
                face_analysis["mode"] = "forced_face_tracking"
            elif face_analysis and quick_mode == "body":
                face_analysis["split_screen"] = False
                face_analysis["body_tracking"] = True
                face_analysis["mode"] = "forced_body_tracking"
            if local_mode and face_analysis:
                write_json_file(tracking_cache_path, face_analysis)
            if face_analysis and isinstance(face_analysis.get("editor_plan"), dict):
                write_json_file(editor_plan_path, face_analysis.get("editor_plan"))
            if face_analysis and isinstance(face_analysis.get("speaker_grounding"), dict):
                write_json_file(
                    grounding_applied_path,
                    face_analysis.get("speaker_grounding"),
                )
            focus_x = face_analysis
            if face_analysis.get("human_safe_fallback"):
                emit("log", stage="face tracking", message="Human-aware fallback: bukti wajah/tubuh tidak cukup, mempertahankan seluruh frame agar manusia tidak terpotong.")
            else:
                focus_display = face_analysis.get("focus_x")
                focus_display = f"{float(focus_display):.3f}" if focus_display is not None else "center"
                emit(
                    "log",
                    stage="face tracking",
                    message=(
                        f"Conversation crop: mode={face_analysis.get('mode')} "
                        f"faces={face_analysis.get('face_count')} "
                        f"body={face_analysis.get('body_tracking')} "
                        f"split={face_analysis.get('split_screen')} "
                        f"grounding={face_analysis.get('speaker_grounding_mode', 'STANDARD')} "
                        f"x={focus_display} "
                        f"stability={face_analysis.get('stability')}"
                    ),
                )
                clip_plan["tracking"] = {
                    "mode": face_analysis.get("mode"),
                    "face_count": face_analysis.get("face_count"),
                    "body_tracking": face_analysis.get("body_tracking"),
                    "split_screen": face_analysis.get("split_screen"),
                    "camera_layout": face_analysis.get("camera_layout"),
                    "camera_score": face_analysis.get("camera_score"),
                    "camera_director": face_analysis.get("camera_director") or [],
                    "editor_plan": str(editor_plan_path) if editor_plan_path.exists() else None,
                    "editor_plan_qa": (face_analysis.get("editor_plan") or {}).get("qa") or {},
                    "subject_tracks": face_analysis.get("subject_tracks") or [],
                    "speaker_subject_map": face_analysis.get("speaker_subject_map") or {},
                    "speaker_grounding_mode": face_analysis.get("speaker_grounding_mode") or "LIGHT",
                    "speaker_grounding": (
                        str(grounding_applied_path)
                        if grounding_applied_path.exists()
                        else None
                    ),
                    "story_beats": face_analysis.get("story_beats") or [],
                    "clip_timeline": face_analysis.get("clip_timeline") or {},
                    "speaker_timeline": face_analysis.get("speaker_timeline") or {},
                    "transition_ms": face_analysis.get("transition_ms"),
                    "split_focus": face_analysis.get("split_focus"),
                    "stability": face_analysis.get("stability"),
                }
            clip_plan["status"] = "tracking_cached"
            write_json_file(clip_plan_path, clip_plan)
        else:
            emit("log", stage="face tracking", message=f"[{index}/{len(moments)}] Face tracking skipped (disabled)")

        if logo_path or bool_payload(payload, "addWatermark", False) or bool_payload(payload, "creditText", False):
            emit(
                "progress",
                stage="watermark overlay",
                progress=round(clip_start_progress + 3.4, 2),
                message=f"[{index}/{len(moments)}] Watermark overlay",
                clipIndex=index,
                totalClips=len(moments),
            )
            write_json_file(
                watermark_cache_path,
                {
                    "logo_path": str(logo_path) if logo_path else None,
                    "logo_x": payload.get("logoX"),
                    "logo_y": payload.get("logoY"),
                    "logo_scale": payload.get("logoScale"),
                    "logo_opacity": payload.get("logoOpacity"),
                    "logo_rotation": payload.get("logoRotation"),
                    "text": payload.get("watermarkText"),
                    "text_x": payload.get("watermarkTextX"),
                    "text_y": payload.get("watermarkTextY"),
                    "text_size": payload.get("watermarkTextSize"),
                    "text_color": payload.get("watermarkTextColor"),
                    "text_opacity": payload.get("watermarkOpacity"),
                },
            )
            clip_plan["status"] = "watermark_cached"
            write_json_file(clip_plan_path, clip_plan)
        vf = build_video_filter(payload, srt_path=caption_ass_path, focus_x=focus_x, moment=render_moment)
        four_k_look_active = bool(payload.get("_fourKLookActive"))
        write_json_file(
            filter_graph_cache_path,
            {
                "video_filter": vf,
                "profile": payload.get("_videoEnhancementProfile") or "natural_podcast",
                "settings": payload.get("_videoEnhancementSettings") or {},
                "color_analysis": payload.get("_videoColorAnalysis") or {},
                "four_k_look": four_k_look_active,
                "four_k_look_profile": payload.get("_fourKLookProfile") or payload.get("_videoEnhancementProfile") or "natural_podcast",
                "four_k_look_budget": payload.get("_fourKLookBudget") or "full",
                "four_k_look_filters": payload.get("_fourKLookFilters") or [],
                "camera_layout": (face_analysis or {}).get("camera_layout") if isinstance(face_analysis, dict) else "center",
                "created_at": datetime.now().isoformat(),
            },
        )
        clip_plan["filter_graph"] = str(filter_graph_cache_path)
        clip_plan["video_enhancement_profile"] = payload.get("_videoEnhancementProfile") or "natural_podcast"
        clip_plan["video_enhancement_settings"] = payload.get("_videoEnhancementSettings") or {}
        clip_plan["video_color_analysis"] = payload.get("_videoColorAnalysis") or {}
        clip_plan["four_k_look"] = four_k_look_active
        clip_plan["four_k_look_profile"] = payload.get("_fourKLookProfile") or payload.get("_videoEnhancementProfile") or "natural_podcast"
        clip_plan["four_k_look_budget"] = payload.get("_fourKLookBudget") or "full"
        write_json_file(clip_plan_path, clip_plan)
        af = audio_filter(payload, hook_timeline_offset)
        crf = str(payload.get("crfProfile") or "23")
        render_target_path = staged_output_path

        fps_args_value = fps_args(payload)
        bitrate_settings = render_bitrate_settings(payload)
        if logo_path:
            cmd = build_logo_overlay_command(engine, source_for_clip, logo_path, start, duration, render_target_path, encoder, fps_args_value, vf, af, crf, payload)
        else:
            builder = engine.builder(source_for_clip, start, duration, render_target_path, encoder, fps_args_value, filters=[vf] if vf else [], audio_filters=[af] if af else [], crf=crf, threads=cpu_thread_count(), **bitrate_settings)
            cmd = builder.build()

        render_failed = None
        try:
            engine.run_process(cmd, "portrait conversion", index, len(moments), render_duration, clip_start_progress + 4, clip_end_progress, log_path=clip_ffmpeg_log)
        except RenderError as exc:
            if four_k_look_active and bool_payload(payload, "_allowHeavy4KLook", False):
                look_payload = dict(payload)
                look_payload["disable4KLook"] = True
                look_fallback_vf = build_video_filter(look_payload, srt_path=caption_ass_path, focus_x=focus_x, moment=render_moment)
                if logo_path:
                    look_cmd = build_logo_overlay_command(engine, source_for_clip, logo_path, start, duration, render_target_path, encoder, fps_args_value, look_fallback_vf, af, crf, look_payload)
                else:
                    look_builder = engine.builder(source_for_clip, start, duration, render_target_path, encoder, fps_args_value, filters=[look_fallback_vf] if look_fallback_vf else [], audio_filters=[af] if af else [], crf=crf, threads=cpu_thread_count(), **bitrate_settings)
                    look_cmd = look_builder.build()
                try:
                    engine.run_process(look_cmd, "4K Look fallback", index, len(moments), render_duration, clip_start_progress + 4, clip_end_progress, log_path=clip_ffmpeg_log)
                except RenderError as look_exc:
                    exc = look_exc
                else:
                    warning = f"4K Look dilewati untuk clip {index} setelah filter gagal; render utama tetap dilanjutkan."
                    warnings.append(warning)
                    emit("log", stage="4k look", message=warning)
                    four_k_look_active = False
                    fallback_reasons.append("4k-look-filter")
                    vf = look_fallback_vf
                    clip_plan["four_k_look"] = False
                    clip_plan["four_k_look_fallback"] = True
                    write_json_file(
                        filter_graph_cache_path,
                        {
                            "video_filter": vf,
                            "profile": payload.get("_videoEnhancementProfile") or "natural_podcast",
                            "four_k_look": False,
                            "fallback": True,
                            "created_at": datetime.now().isoformat(),
                        },
                    )
                    write_json_file(clip_plan_path, clip_plan)
                    exc = None
            if exc is not None:
                current_index = encoder_chain.index(encoder) if encoder in encoder_chain else -1
                fallback_error = exc
                for fallback_encoder in encoder_chain[current_index + 1:]:
                    failed_encoder = encoder
                    emit("log", stage="encode", message=f"Encoder {failed_encoder} gagal: {fallback_error}. Retry memakai {fallback_encoder}.")
                    encoder = fallback_encoder
                    if logo_path:
                        cmd = build_logo_overlay_command(engine, source_for_clip, logo_path, start, duration, render_target_path, encoder, fps_args_value, vf, af, crf, payload)
                    else:
                        builder = engine.builder(source_for_clip, start, duration, render_target_path, encoder, fps_args_value, filters=[vf] if vf else [], audio_filters=[af] if af else [], crf=crf, threads=cpu_thread_count(), **bitrate_settings)
                        cmd = builder.build()
                    try:
                        engine.run_process(cmd, f"portrait conversion {fallback_encoder} fallback", index, len(moments), render_duration, clip_start_progress + 4, clip_end_progress, log_path=clip_ffmpeg_log)
                        fallback_reasons.append(f"encoder:{failed_encoder}->{fallback_encoder}")
                        fallback_error = None
                        break
                    except RenderError as fallback_exc:
                        fallback_error = fallback_exc
                exc = fallback_error
            if exc is not None and caption_ass_path is not None and not required_overlays["captions"]:
                # Encoder availability and subtitle support are independent. Preserve
                # ASS/hook overlays while trying every encoder before treating this as
                # a subtitle failure; otherwise a bad GPU driver silently strips text.
                warning = f"Semua encoder gagal dengan subtitle aktif untuk clip {index}; retry tanpa caption: {exc}"
                warnings.append(warning)
                emit("log", stage="caption", message=warning)
                safe_payload = dict(payload)
                safe_payload["addCaptions"] = False
                safe_payload["burnSubtitle"] = False
                safe_payload["addHook"] = False
                vf = build_video_filter(safe_payload, srt_path=None, focus_x=focus_x, moment=render_moment)
                safe_af = audio_filter(safe_payload, 0.0)
                if logo_path:
                    cmd = build_logo_overlay_command(engine, source_for_clip, logo_path, start, duration, render_target_path, encoder, fps_args_value, vf, safe_af, crf, safe_payload)
                else:
                    builder = engine.builder(source_for_clip, start, duration, render_target_path, encoder, fps_args_value, filters=[vf] if vf else [], audio_filters=[safe_af] if safe_af else [], crf=crf, threads=cpu_thread_count(), **bitrate_settings)
                    cmd = builder.build()
                try:
                    engine.run_process(cmd, "portrait conversion caption fallback", index, len(moments), duration, clip_start_progress + 4, clip_end_progress, log_path=clip_ffmpeg_log)
                except RenderError as retry_exc:
                    exc = retry_exc
                    caption_ass_path = None
                else:
                    caption_ass_path = None
                    fallback_reasons.append("optional-caption-overlay")
                    exc = None
            if exc is not None:
                render_failed = exc

        if render_failed is not None:
            if required_overlays["captions"] or required_overlays["watermark"]:
                required_labels = []
                if required_overlays["captions"]:
                    required_labels.append("subtitle")
                if required_overlays["watermark"]:
                    required_labels.append("watermark")
                message = (
                    f"Clip {index}/{len(moments)} gagal merender {' dan '.join(required_labels)} wajib: {render_failed}. "
                    "Output tanpa overlay wajib tidak disimpan."
                )
                warnings.append(message)
                clip_plan["status"] = "failed"
                clip_plan["error"] = message
                write_json_file(clip_plan_path, clip_plan)
                render_plan["clips"][-1] = {**clip_plan, "plan": str(clip_plan_path)}
                write_json_file(render_plan_path, render_plan)
                try:
                    staged_output_path.unlink(missing_ok=True)
                except Exception:
                    pass
                emit(
                    "clip_error",
                    stage="required overlay render",
                    clipIndex=index,
                    totalClips=len(moments),
                    title=clip_label,
                    message=message,
                )
                continue
            warning = f"Clip {index}/{len(moments)} full render gagal: {render_failed}. Retry minimal MP4 fallback."
            warnings.append(warning)
            emit("log", stage="minimal fallback", message=warning)
            minimal_payload = dict(payload)
            minimal_payload["addCaptions"] = False
            minimal_payload["burnSubtitle"] = False
            minimal_payload["addHook"] = False
            minimal_payload["addWatermark"] = False
            minimal_payload["creditText"] = False
            minimal_payload["logoOverlay"] = False
            minimal_payload["faceTrack"] = False
            minimal_payload["dynamicZoom"] = False
            minimal_payload["disableAutoEnhancement"] = True
            minimal_payload["disable4KLook"] = True
            minimal_filter = build_video_filter(minimal_payload, srt_path=None, focus_x=None, moment=render_moment)
            try:
                minimal_builder = engine.builder(
                    source_for_clip,
                    start,
                    duration,
                    render_target_path,
                    "libx264",
                    fps_args_value,
                    filters=[minimal_filter] if minimal_filter else [],
                    audio_filters=[],
                    crf=crf,
                    threads=cpu_thread_count(),
                    **bitrate_settings,
                )
                engine.run_process(minimal_builder.build(), "minimal mp4 fallback", index, len(moments), duration, clip_start_progress + 4, clip_end_progress, log_path=clip_ffmpeg_log)
                encoder = "libx264"
                fallback_reasons.append("minimal-mp4")
                render_failed = None
                validation_fallback_stripped_enhancements = True
                four_k_look_active = False
                caption_ass_path = None
                caption_srt_path = None
                face_analysis = None
            except RenderError as fallback_exc:
                message = f"Clip {index}/{len(moments)} gagal: {fallback_exc}"
                warnings.append(message)
                clip_plan["status"] = "failed"
                clip_plan["error"] = message
                write_json_file(clip_plan_path, clip_plan)
                render_plan["clips"][-1] = {**clip_plan, "plan": str(clip_plan_path)}
                write_json_file(render_plan_path, render_plan)
                emit(
                    "clip_error",
                    stage="minimal mp4 fallback",
                    clipIndex=index,
                    totalClips=len(moments),
                    title=clip_label,
                    message=message,
                )
                continue

        if staged_output_path.exists():
            try:
                if clip_path.exists():
                    clip_path.unlink()
                shutil.move(str(staged_output_path), str(clip_path))
                clip_plan["status"] = "rendered"
                clip_plan["output"] = str(clip_path)
                write_json_file(clip_plan_path, clip_plan)
                render_plan["clips"][-1] = {**clip_plan, "plan": str(clip_plan_path)}
                write_json_file(render_plan_path, render_plan)
            except Exception as exc:
                message = f"Clip {index}/{len(moments)} gagal memindahkan staged output ke final: {exc}"
                warnings.append(message)
                clip_plan["status"] = "failed"
                clip_plan["error"] = message
                write_json_file(clip_plan_path, clip_plan)
                render_plan["clips"][-1] = {**clip_plan, "plan": str(clip_plan_path)}
                write_json_file(render_plan_path, render_plan)
                emit("clip_error", stage="finalize", clipIndex=index, totalClips=len(moments), title=clip_label, message=message)
                continue

        metadata_path = internal_dir / f"{clip_safe}.json"
        metadata_path.write_text(json_dumps(render_moment, indent=2), encoding="utf-8")
        actual_caption_ass = bool(caption_ass_path and Path(caption_ass_path).exists())
        actual_caption_srt = bool(caption_srt_path and Path(caption_srt_path).exists())
        actual_hook = bool(hook_plan.get("enabled")) and actual_caption_ass and not validation_fallback_stripped_enhancements
        actual_watermark = not validation_fallback_stripped_enhancements and required_overlays["watermark"]
        public_metadata = build_clip_metadata(
            render_moment,
            info_for_clip,
            payload,
            has_hook=actual_hook,
            has_captions=actual_caption_ass,
            has_watermark=actual_watermark,
        )
        size_bytes = clip_path.stat().st_size if clip_path.exists() else 0
        media_probe = probe_media_file(clip_path)
        if not media_probe.get("valid"):
            if required_overlays["captions"] or required_overlays["watermark"]:
                required_labels = []
                if required_overlays["captions"]:
                    required_labels.append("subtitle")
                if required_overlays["watermark"]:
                    required_labels.append("watermark")
                message = (
                    f"Clip {index}/{len(moments)} gagal validasi MP4 dengan {' dan '.join(required_labels)} wajib: "
                    f"{media_probe.get('reason')}. Output tanpa overlay wajib tidak disimpan."
                )
                warnings.append(message)
                clip_plan["status"] = "failed"
                clip_plan["error"] = message
                write_json_file(clip_plan_path, clip_plan)
                render_plan["clips"][-1] = {**clip_plan, "plan": str(clip_plan_path)}
                write_json_file(render_plan_path, render_plan)
                try:
                    clip_path.unlink(missing_ok=True)
                except Exception:
                    pass
                emit("clip_error", stage="validate mp4", clipIndex=index, totalClips=len(moments), title=clip_label, message=message)
                continue
            warning = f"Clip {index}/{len(moments)} output tidak valid ({media_probe.get('reason')}), retry safe render CPU."
            warnings.append(warning)
            emit("log", stage="validate mp4", message=warning)
            safe_payload = dict(payload)
            safe_payload["addCaptions"] = False
            safe_payload["burnSubtitle"] = False
            safe_payload["addHook"] = False
            safe_payload["addWatermark"] = False
            safe_payload["creditText"] = False
            safe_payload["logoOverlay"] = False
            safe_payload["faceTrack"] = False
            safe_payload["disableAutoEnhancement"] = True
            safe_payload["disable4KLook"] = True
            validation_fallback_stripped_enhancements = True
            four_k_look_active = False
            caption_ass_path = None
            caption_srt_path = None
            vf = build_video_filter(safe_payload, srt_path=None, focus_x=None, moment=render_moment)
            safe_af = audio_filter(safe_payload, 0.0)
            builder = engine.builder(source_for_clip, start, duration, clip_path, "libx264", fps_args_value, filters=[vf] if vf else [], audio_filters=[safe_af] if safe_af else [], crf=crf, threads=cpu_thread_count(), **bitrate_settings)
            try:
                engine.run_process(builder.build(), "safe render validation fallback", index, len(moments), duration, clip_start_progress + 4, clip_end_progress, log_path=clip_ffmpeg_log)
                encoder = "libx264"
                fallback_reasons.append("validation-safe-cpu")
                media_probe = probe_media_file(clip_path)
                size_bytes = clip_path.stat().st_size if clip_path.exists() else 0
            except RenderError as exc:
                media_probe = {"valid": False, "reason": str(exc), "hasAudio": False}
            if not media_probe.get("valid"):
                message = f"Clip {index}/{len(moments)} output tidak valid: {media_probe.get('reason')}"
                warnings.append(message)
                clip_plan["status"] = "failed"
                clip_plan["error"] = message
                write_json_file(clip_plan_path, clip_plan)
                render_plan["clips"][-1] = {**clip_plan, "plan": str(clip_plan_path)}
                write_json_file(render_plan_path, render_plan)
                emit("clip_error", stage="validate mp4", clipIndex=index, totalClips=len(moments), title=clip_label, message=message)
                continue
        if not media_probe.get("hasAudio"):
            warning = f"Clip {index}/{len(moments)} tidak punya audio stream. Video sumber mungkin silent atau audio tidak tersedia."
            warnings.append(warning)
            emit("log", stage="audio", message=warning)
        actual_caption_ass = bool(caption_ass_path and Path(caption_ass_path).exists()) and not validation_fallback_stripped_enhancements
        actual_caption_srt = bool(caption_srt_path and Path(caption_srt_path).exists()) and not validation_fallback_stripped_enhancements
        actual_hook = bool(hook_plan.get("enabled")) and actual_caption_ass
        actual_watermark = not validation_fallback_stripped_enhancements and required_overlays["watermark"]
        actual_hook_offset = hook_timeline_offset if actual_hook else 0.0
        actual_output_duration = float(media_probe.get("duration") or (duration + actual_hook_offset))
        hook_timeline_result = {
            **hook_plan,
            "actualVisual": actual_hook,
            "sourceOffset": round(actual_hook_offset, 3),
            "outputDuration": round(actual_output_duration, 3),
        }
        fallback_used = bool(fallback_reasons)
        fallback_reason = "; ".join(dict.fromkeys(fallback_reasons)) or None
        clip_settings_used = used_renderer_settings(
            payload,
            actual_caption=actual_caption_ass,
            actual_hook=actual_hook,
            auto_cut_applied=auto_cut_applied,
            face_analysis=face_analysis,
            stripped_enhancements=validation_fallback_stripped_enhancements,
            encoder=encoder,
        )
        public_metadata["settingsRequested"] = requested_renderer_settings(payload)
        public_metadata["settingsUsed"] = clip_settings_used
        public_metadata["hookTimeline"] = hook_timeline_result
        public_metadata["has_hook"] = actual_hook
        public_metadata["has_captions"] = actual_caption_ass
        public_metadata["has_watermark"] = actual_watermark
        public_metadata.setdefault("content_safety", {}).setdefault("enhancements", {})
        public_metadata["content_safety"]["adds_transformative_elements"] = bool(actual_hook or actual_caption_ass or actual_watermark or public_metadata.get("context_text"))
        public_metadata["content_safety"]["enhancements"].update(
            {
                "hook": actual_hook,
                "captions": actual_caption_ass,
                "watermark": actual_watermark,
                "smart_crop": clip_settings_used["smartCrop"],
                "dynamic_zoom": clip_settings_used["dynamicZoom"],
                "face_tracking": clip_settings_used["faceTrack"],
                "auto_cut_requested": auto_cut_requested,
                "auto_cut_applied": auto_cut_applied,
                "audio_enhancement": clip_settings_used["audioEnhance"],
                "encoder": encoder,
                "requested_encoder": requested_encoder,
                "actual_encoder": encoder,
                "fallback_used": fallback_used,
                "fallback_reason": fallback_reason,
                "video_enhancement": not validation_fallback_stripped_enhancements,
                "four_k_look": four_k_look_active,
                "four_k_look_profile": payload.get("_fourKLookProfile") or payload.get("_videoEnhancementProfile") or "natural_podcast",
                "validation_fallback_stripped_enhancements": validation_fallback_stripped_enhancements,
            }
        )
        public_metadata["upload_title"] = upload_title
        public_metadata["filename"] = clip_path.name
        public_metadata["paths"] = {
            "video": str(clip_path),
            "caption_ass": str(caption_ass_path) if actual_caption_ass else None,
            "caption_srt": str(caption_srt_path) if actual_caption_srt else None,
            "metadata": str(public_metadata_path),
            "thumbnail": str(thumbnail_path),
        }
        public_metadata["validation"] = media_probe
        public_metadata["face_analysis"] = face_analysis
        public_metadata["render"] = {
            "requestedEncoder": requested_encoder,
            "actualEncoder": encoder,
            "fallbackUsed": fallback_used,
            "fallbackReason": fallback_reason,
            "encoder": encoder,
            "gpu_acceleration_requested": bool_payload(payload, "gpuAcceleration", True),
            "auto_cut_requested": auto_cut_requested,
            "auto_cut_applied": auto_cut_applied,
            "validation_fallback_stripped_enhancements": validation_fallback_stripped_enhancements,
        }
        public_metadata_path.write_text(json_dumps(public_metadata, indent=2), encoding="utf-8")
        clip_plan["status"] = "completed"
        clip_plan["encoder"] = encoder
        clip_plan["requestedEncoder"] = requested_encoder
        clip_plan["actualEncoder"] = encoder
        clip_plan["fallbackUsed"] = fallback_used
        clip_plan["fallbackReason"] = fallback_reason
        clip_plan["settingsUsed"] = clip_settings_used
        clip_plan["hookTimeline"] = hook_timeline_result
        clip_plan["outputDuration"] = round(actual_output_duration, 3)
        clip_plan["subtitle"] = actual_caption_ass
        clip_plan["hook"] = actual_hook
        clip_plan["watermark"] = actual_watermark
        clip_plan["validated"] = bool(media_probe.get("valid"))
        clip_plan["has_audio"] = bool(media_probe.get("hasAudio"))
        clip_plan["metadata"] = str(public_metadata_path)
        write_json_file(clip_plan_path, clip_plan)
        render_plan["clips"][-1] = {**clip_plan, "plan": str(clip_plan_path)}
        write_json_file(render_plan_path, render_plan)
        thumbnail_output = write_thumbnail_png(engine, clip_path, thumbnail_path)
        outputs.append(
            {
                "video": str(clip_path),
                "title": upload_title,
                "time": render_moment.get("time"),
                "duration": actual_output_duration,
                "sourceDuration": duration,
                "hookTimeline": hook_timeline_result,
                "resolution": payload.get("resolutionProfile") or "1080p",
                "sizeBytes": size_bytes,
                "hasAudio": media_probe.get("hasAudio"),
                "validated": media_probe.get("valid"),
                "ffprobe": media_probe,
                "settingsRequested": requested_renderer_settings(payload),
                "settingsUsed": clip_settings_used,
                "subtitle": str(caption_ass_path) if actual_caption_ass else None,
                "subtitleSrt": str(caption_srt_path) if actual_caption_srt else None,
                "metadata": str(public_metadata_path),
                "thumbnail": str(thumbnail_output) if thumbnail_output else None,
                "youtubeTitle": public_metadata.get("youtube_title"),
                "youtubeDescription": public_metadata.get("youtube_description"),
                "youtubeTags": public_metadata.get("youtube_tags"),
                "enhancements": {
                    "smartCrop": clip_settings_used["smartCrop"],
                    "dynamicZoom": clip_settings_used["dynamicZoom"],
                    "faceTrack": clip_settings_used["faceTrack"],
                    "autoCut": clip_settings_used["autoCut"],
                    "autoCutRequested": auto_cut_requested,
                    "autoCutApplied": auto_cut_applied,
                    "captions": clip_settings_used["addCaptions"],
                    "hook": clip_settings_used["addHook"],
                    "ttsHook": clip_settings_used["addTtsHook"],
                    "audioEnhance": clip_settings_used["audioEnhance"],
                    "videoEnhancement": clip_settings_used["autoVideoEnhancement"],
                    "videoEnhancementProfile": payload.get("_videoEnhancementProfile") or "natural_podcast",
                    "fourKLook": four_k_look_active,
                    "fourKLookProfile": payload.get("_fourKLookProfile") or payload.get("_videoEnhancementProfile") or "natural_podcast",
                    "fourKLookBudget": payload.get("_fourKLookBudget") or "full",
                    "watermark": actual_watermark,
                    "logoOverlay": bool(logo_path),
                    "encoder": encoder,
                    "requestedEncoder": requested_encoder,
                    "actualEncoder": encoder,
                    "fallbackUsed": fallback_used,
                    "fallbackReason": fallback_reason,
                    "gpuAccelerationRequested": bool_payload(payload, "gpuAcceleration", True),
                    "validationFallbackStrippedEnhancements": validation_fallback_stripped_enhancements,
                    "faceAnalysis": face_analysis,
                },
            }
        )
        emit(
            "clip_done",
            clipIndex=index,
            totalClips=len(moments),
            title=upload_title,
            path=str(clip_path),
        )
        try:
            shutil.rmtree(clip_temp_dir, ignore_errors=True)
        except Exception:
            pass
        gc.collect()

    requested_count = len(moments)
    valid_mp4_count = sum(1 for item in outputs if item.get("validated"))
    failed_count = max(0, requested_count - valid_mp4_count)
    if failed_count:
        warnings.append(f"Requested {requested_count} clip, valid MP4 output {valid_mp4_count}. {failed_count} clip gagal setelah retry/safe fallback.")
    emit("log", stage="summary", message=f"requested={requested_count} valid_mp4={valid_mp4_count} failed={failed_count} warnings={len(warnings)}")
    render_plan["status"] = "Completed" if failed_count == 0 else "Completed with Warning"
    render_plan["rendered_count"] = len(outputs)
    render_plan["valid_mp4_count"] = valid_mp4_count
    render_plan["failed_count"] = failed_count
    setting_names = load_settings_contract().get("booleanSettings") or []
    aggregate_settings_used = {
        name: any(bool(item.get("settingsUsed", {}).get(name)) for item in outputs)
        for name in setting_names
    }
    render_plan["settingsUsed"] = aggregate_settings_used
    render_plan["completed_at"] = datetime.now().isoformat()
    write_json_file(render_plan_path, render_plan)

    manifest = {
        "source": url or (str(source) if local_mode else ""),
        "source_mode": "local" if local_mode else "youtube",
        "source_path": str(source),
        "original_output": str(original_output) if original_output else None,
        "cache_dir": str(cache_dir),
        "source_cache_status": "local" if local_mode else ("downloaded" if downloaded else "cached"),
        "render_plan": str(render_plan_path),
        "render_cache_dir": str(render_cache_dir),
        "ffmpeg_log_dir": str(ffmpeg_log_dir),
        "temp_render_dir": str(temp_render_dir),
        "title": info.get("title"),
        "used_cookies": used_cookies,
        "encoder": encoder,
        "requestedEncoder": requested_session_encoder,
        "actualEncoder": sorted({str(item.get("enhancements", {}).get("actualEncoder") or "") for item in outputs if item.get("enhancements")}),
        "fallbackUsed": any(bool(item.get("enhancements", {}).get("fallbackUsed")) for item in outputs),
        "fallbackReason": sorted({str(item.get("enhancements", {}).get("fallbackReason")) for item in outputs if item.get("enhancements", {}).get("fallbackReason")}),
        "output_structure": {key: str(folder) for key, folder in output_dirs.items()},
        "requested_clip_count": requested_count,
        "candidate_count": len(moments),
        "rendered_count": len(outputs),
        "valid_mp4_count": valid_mp4_count,
        "failed_count": failed_count,
        "status": "Completed" if failed_count == 0 else "Completed with Warning",
        "ai_provider": ai_provider_name(payload.get("providerType")) if is_ai_enabled(payload) else "Local Heuristic",
        "ai_enabled": bool(is_ai_enabled(payload)),
        "ai_usage": dict(AI_USAGE),
        "ai_diagnostics": ai_diagnostics_summary(),
        "ai_log_path": str(ai_log_path(payload)),
        "fallback_used": any("fallback" in str(item).lower() or "gagal" in str(item).lower() for item in warnings),
        "settingsContractVersion": payload.get("settingsContractVersion"),
        "settingsRequested": requested_renderer_settings(payload),
        "settingsUsed": aggregate_settings_used,
        "featureFlags": dict(payload.get("featureFlags") or {}),
        "settings": {
            "format": payload.get("formatProfile"),
            "resolution": payload.get("resolutionProfile"),
            "fps": payload.get("fpsProfile"),
            "crf": payload.get("crfProfile"),
            "model": payload.get("highlightModel") or payload.get("model"),
        },
        "created_at": datetime.now().isoformat(),
        "outputs": outputs,
        "warnings": warnings,
    }
    ai_debug_path = session_dir / "ai-debug-log.json"
    ai_debug_path.write_text(json_dumps(AI_DEBUG_EVENTS, indent=2), encoding="utf-8")
    manifest["ai_debug_log"] = str(ai_debug_path)
    error_log_path = session_dir / "error.log"
    if warnings or failed_count:
        error_lines = [
            f"Cliper Studio Plus render diagnostics - {datetime.now().isoformat()}",
            f"status={manifest.get('status')}",
            f"requested={requested_count} valid_mp4={valid_mp4_count} failed={failed_count}",
            "",
        ]
        for warning in warnings:
            error_lines.append(str(warning))
        error_log_path.write_text("\n".join(error_lines), encoding="utf-8")
        manifest["error_log"] = str(error_log_path)
    else:
        error_log_path.write_text("No fatal render errors.\n", encoding="utf-8")
        manifest["error_log"] = str(error_log_path)
    (internal_dir / "session.json").write_text(json_dumps(manifest, indent=2), encoding="utf-8")
    engine.write_log(session_dir, manifest, metadata={"ffmpeg": env}, warnings=warnings)
    emit("progress", stage="done", progress=100, message="Render selesai")
    emit("done", result={"sessionDir": str(session_dir), "outputs": outputs, "manifest": manifest})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", required=True, choices=["check", "validate-cookies", "test-cookies", "test-provider", "analyze", "render"])
    parser.add_argument("--payload", required=True)
    args = parser.parse_args()
    payload = load_payload(args.payload)
    try:
        if args.mode == "check":
            emit("done", result=check_dependencies())
        elif args.mode == "validate-cookies":
            emit("done", result=validate_cookie_file(payload.get("cookiesPath")))
        elif args.mode == "test-cookies":
            emit("done", result=test_cookies(payload))
        elif args.mode == "test-provider":
            emit("done", result=test_provider_request(payload))
        elif args.mode == "analyze":
            start_cloud_analysis_job(payload)
            analyze(payload)
        elif args.mode == "render":
            render(payload)
    except Exception as exc:
        if args.mode == "analyze":
            fail_cloud_analysis_job(payload, exc)
        try:
            error_root = safe_output_folder(payload.get("outputFolder") or default_output_folder())
            crash_log = error_root / "worker-error.log"
            crash_log.write_text(
                f"Worker mode={args.mode} failed at {datetime.now().isoformat()}\n{type(exc).__name__}: {exc}\n",
                encoding="utf-8",
            )
        except Exception:
            pass
        emit("error", message=str(exc))
        sys.exit(1)


if __name__ == "__main__":
    main()

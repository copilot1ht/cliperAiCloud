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
    from story_engine import extend_story_boundary as external_extend_story_boundary
    from story_engine import build_story_timeline as external_build_story_timeline
    from story_engine import segment_into_story_candidates as external_story_candidates
except Exception:
    external_extend_story_boundary = None
    external_build_story_timeline = None
    external_story_candidates = None

CameraEngine = None
SpeakerEngine = None
try:
    # Worker-local engines are packaged with the Python runtime.
    from camera_engine import CameraEngine
except Exception:
    try:
        from engine.camera_engine import CameraEngine
    except Exception:
        CameraEngine = None
try:
    from speaker_engine import SpeakerEngine
except Exception:
    try:
        from engine.speaker_engine import SpeakerEngine
    except Exception:
        SpeakerEngine = None

try:
    from subtitle_engine import SubtitleEngine as ProductionSubtitleEngine, build_word_highlight_ass_text, split_ass_tokens
except Exception:
    ProductionSubtitleEngine = None
    build_word_highlight_ass_text = None
    split_ass_tokens = None

AI_DEBUG_EVENTS = []
AI_USAGE = {"input_tokens": 0, "output_tokens": 0, "requests": 0, "errors": 0}
WHISPER_MODEL_CACHE = {}

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


def load_payload(path):
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        return json.load(handle)


def command_exists(name):
    return shutil.which(name) is not None


def check_dependencies():
    deps = {
        "python": {
            "ok": True,
            "path": sys.executable,
            "version": sys.version.split()[0],
        },
        "yt_dlp": {"ok": False, "version": None},
        "ffmpeg": {"ok": command_exists("ffmpeg"), "path": shutil.which("ffmpeg")},
        "ffprobe": {"ok": command_exists("ffprobe"), "path": shutil.which("ffprobe")},
        "openai": {"ok": False, "version": None},
        "opencv": {"ok": False, "version": None},
        "mediapipe": {"ok": False, "version": None},
        "faster_whisper": {"ok": False, "version": None},
        "encoders": {"ok": False, "available": []},
    }
    try:
        yt_dlp = importlib.import_module("yt_dlp")
        deps["yt_dlp"] = {"ok": True, "version": getattr(yt_dlp, "__version__", None)}
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


def classify_download_error(exc):
    text = str(exc).lower()
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
        return "Koneksi download YouTube terputus"
    if any(item in text for item in ["sign in", "login", "log in", "authentication", "account"]):
        return "Login diperlukan"
    if any(item in text for item in ["age", "confirm your age", "age-restricted"]):
        return "Age restricted"
    if any(item in text for item in ["private", "members-only", "members only", "join this channel"]):
        return "Video private/member only"
    if any(item in text for item in ["region", "country", "not available in your country"]):
        return "Region locked"
    if any(item in text for item in ["403", "forbidden", "access denied"]):
        return "Login diperlukan"
    if "cookie" in text and any(item in text for item in ["expired", "invalid", "malformed"]):
        return "Cookies expired"
    return "yt-dlp error"


def needs_cookies_error(exc):
    reason = classify_download_error(exc).lower()
    return any(item in reason for item in ["login", "age", "private", "member", "region"])


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
        return validation
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
        return {
            **validation,
            "ok": False,
            "testOk": False,
            "status": classify_download_error(exc),
            "reason": str(exc),
            "testedAt": datetime.now().isoformat(),
        }


def extract_info_with_cookie_retry(yt_dlp, ydl_opts, url, cookie_path, download=False):
    public_opts = dict(ydl_opts)
    public_opts.pop("cookiefile", None)
    try:
        with yt_dlp.YoutubeDL(public_opts) as ydl:
            return ydl.extract_info(url, download=download), False
    except Exception as public_exc:
        if not needs_cookies_error(public_exc):
            raise
        if not cookie_path:
            raise RuntimeError(f"{classify_download_error(public_exc)}. Import cookies di Settings > Cookies Manager.") from public_exc
        validation = validate_cookie_file(cookie_path)
        if not validation.get("ok"):
            raise RuntimeError(f"{classify_download_error(public_exc)}. Cookies tidak valid: {validation.get('reason')}") from public_exc
        emit("log", message=f"{classify_download_error(public_exc)}. Retry otomatis menggunakan cookies.")
        retry_opts = dict(ydl_opts)
        retry_opts["cookiefile"] = cookie_path
        try:
            with yt_dlp.YoutubeDL(retry_opts) as ydl:
                return ydl.extract_info(url, download=download), True
        except Exception as cookie_exc:
            raise RuntimeError(f"{classify_download_error(cookie_exc)}. Export ulang cookies terbaru lalu coba lagi.") from cookie_exc


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
    ffprobe = shutil.which("ffprobe") or shutil.which("ffprobe.exe")
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
    ffprobe = shutil.which("ffprobe") or shutil.which("ffprobe.exe")
    result = {"valid": False, "hasVideo": False, "hasAudio": False, "duration": 0.0, "reason": ""}
    if not path or not Path(path).exists():
        result["reason"] = "file tidak ditemukan"
        return result
    if Path(path).stat().st_size < 32 * 1024:
        result["reason"] = "ukuran file terlalu kecil"
        return result
    if not ffprobe:
        result.update({"valid": True, "reason": "ffprobe tidak tersedia, validasi stream dilewati"})
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
        data = json.loads(proc.stdout or "{}")
        streams = data.get("streams") or []
        result["hasVideo"] = any(item.get("codec_type") == "video" for item in streams)
        result["hasAudio"] = any(item.get("codec_type") == "audio" for item in streams)
        result["duration"] = float((data.get("format") or {}).get("duration") or 0.0)
        result["valid"] = bool(result["hasVideo"] and result["duration"] > 0)
        result["reason"] = "ok" if result["valid"] else "video stream/duration tidak valid"
        return result
    except Exception as exc:
        result.update({"valid": True, "reason": f"ffprobe gagal, file dianggap ada: {exc}"})
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
        "retries": 20,
        "fragment_retries": 35,
        "extractor_retries": 5,
        "file_access_retries": 5,
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
    }


def source_download_formats():
    return [
        (
            "1080p stable mp4",
            "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/best[height<=1080]/best",
            5,
        ),
        (
            "720p stable fallback",
            "bv*[height<=720][ext=mp4]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]/best[height<=720]/best",
            4,
        ),
        (
            "single file emergency fallback",
            "b[height<=1080]/best[height<=1080]/best",
            3,
        ),
    ]


def short_error_text(exc, limit=320):
    text = safe_text(exc).replace("\r", " ").replace("\n", " ")
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


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
                reason = classify_download_error(exc)
                emit(
                    "log",
                    stage="cache",
                    message=f"Download source gagal mode={label} attempt {attempt}/{attempts}: {reason}. {short_error_text(exc)}",
                )
                if needs_cookies_error(exc):
                    raise
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
    raise RuntimeError(
        "Koneksi download YouTube terputus. Aplikasi sudah mencoba resume dan fallback format. "
        "Coba jalankan lagi; file .part tetap disimpan agar bisa dilanjutkan. "
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
        request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(request, timeout=20) as response:
            data = response.read()
        if data:
            path.write_bytes(data)
    except Exception as exc:
        emit("log", stage="thumbnail", message=f"Thumbnail cache dilewati: {exc}")


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
    existing = cached_source_file(cache_dir)
    if existing:
        probe = probe_media_file(existing)
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
        "debug_events": len(events),
        "retry_count": sum(int(item.get("retry_count") or 0) for item in events),
        "fallback_events": sum(1 for item in events if item.get("fallback_used")),
        "last_fallback_reason": next((str(item.get("fallback_reason") or item.get("error") or "") for item in reversed(failed)), ""),
        "modules": modules,
    }


def ai_module_key(module):
    text = str(module or "").lower()
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
        "title": 220,
        "hook": 160,
        "caption": 140,
        "tts": 180,
        "default": 260,
    }
    default_budgets = {
        "test": 240,
        "highlight": 1600,
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
    retry_defaults = {"highlight": 3, "title": 2, "hook": 2, "caption": 2, "test": 2, "default": 2}
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
        }
    return {
        "model": data.get("model"),
        "messages": data.get("messages"),
        "max_tokens": data.get("max_tokens"),
    }


def call_openai_compatible(payload, prompt):
    base_url = str(payload.get("baseUrl") or "").rstrip("/")
    if not base_url:
        raise RuntimeError("Base URL AI kosong.")
    provider_type = str(payload.get("providerType") or "").lower()
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
        request_chars = len(json_dumps(data))
        try:
            request_headers = cloud_signed_headers(payload, endpoint, data) if provider_type == "cloud" else dict(headers)
            result = fetch_json(endpoint, data=data, headers=request_headers, timeout=timeout)
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
    emit("log", message=f"AI request sent to {provider_name} ({module}) model={model} max_tokens={max_tokens}")
    started = time.time()
    try:
        if provider_type == "gemini":
            result = call_gemini(payload, prompt)
        else:
            result = call_openai_compatible(payload, prompt)
        record_ai_usage(payload, module, "Success", time.time() - started, result.get("usage") or {})
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
AUTO_SELECT_MIN_SCORE = 78

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
    selected = []
    for raw_word in phrase.split():
        normalized = re.sub(r"[^\wÀ-ÖØ-öø-ÿĀ-ž\u0100-\u024F\u1E00-\u1EFF'-]", "", raw_word.lower(), flags=re.UNICODE)
        if len(normalized) < 3 or normalized in STOPWORDS_ID:
            continue
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


def hook_quality_score(hook, source_text, used_signatures=None):
    hook = seo_clean_title(hook, "")
    source_text = clean_text(source_text)
    used_signatures = set(used_signatures or [])
    if not hook or is_generic_template(hook):
        return 0
    words = hook.split()
    if len(words) > 12:
        return 0
    lower = hook.lower()
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
    if lower.startswith(("jawaban ini", "konflik ini", "hal ini", "momen ini")):
        uniqueness -= 40
    if lower.startswith("pengakuan") and "pengakuan" not in source_text.lower():
        uniqueness -= 32
    score = curiosity * 0.40 + specificity * 0.20 + emotion * 0.20 + uniqueness * 0.20
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


def ai_generate_title(text, payload):
    try:
        transcript = compact_text_for_ai(text, 850)
        prompt = (
            "Kamu adalah title maker Shorts/Reels/TikTok profesional.\n"
            "Buat 3 kandidat judul SEO/FYP yang spesifik dari transcript, bukan template.\n"
            "Rules: Bahasa Indonesia natural, 35-70 karakter, tanpa emoji, tanpa hashtag, relevan, tidak clickbait palsu.\n"
            "DILARANG pakai template: Jawaban Ini Bikin Penasaran, Konflik Ini Terungkap, Hal Ini Mengejutkan.\n"
            f"Gaya: {payload.get('scoreMode') or 'viral'}\n"
            f"Transcript: {transcript}\n"
            "Output JSON valid saja: {\"titles\":[\"...\",\"...\",\"...\"]}"
        )
        result = provider_request(payload, prompt, module="Title Generator")
        if result.get("response"):
            candidates = parse_candidate_strings(result["response"], ["titles", "title"])
            result["candidates"] = candidates
            result["response"] = pick_best_title(candidates + local_title_candidates(text), text)
        return result
    except Exception as exc:
        emit("log", message=f"AI title generator gagal: {exc}")
        return {"ok": False, "error": str(exc)}


def ai_generate_upload_title(moment, payload):
    try:
        transcript = compact_text_for_ai(moment.get("transcript") or moment.get("text") or "", 850)
        prompt = (
            "Buat 3 kandidat judul MP4 SEO/FYP untuk clip pendek ini.\n"
            "Rules: Bahasa Indonesia natural, 35-70 karakter, title case, tanpa emoji, tanpa hashtag, tanpa karakter Windows / : * ? \" < > |, "
            "curiosity gap ringan, harus spesifik dan relevan dengan transcript.\n"
            "DILARANG pakai template generik: Jawaban Ini Bikin Penasaran, Konflik Ini Terungkap, Hal Ini Mengejutkan.\n"
            "Output JSON valid saja: {\"titles\":[\"...\",\"...\",\"...\"]}\n\n"
            f"Hook: {moment.get('hook') or ''}\n"
            f"Title: {moment.get('titleSuggestion') or moment.get('title') or ''}\n"
            f"Transcript: {transcript}"
        )
        result = provider_request(payload, prompt, module="Title Generator")
        if result.get("response"):
            source = transcript or moment.get("title") or ""
            candidates = parse_candidate_strings(result["response"], ["titles", "title"])
            result["candidates"] = candidates
            result["response"] = pick_best_title(candidates + local_title_candidates(source), source)
        return result
    except Exception as exc:
        emit("log", message=f"AI upload title generator gagal: {exc}")
        return {"ok": False, "error": str(exc)}


def ai_generate_hook(moment, payload):
    try:
        transcript = compact_text_for_ai(moment.get("transcript") or moment.get("text") or moment.get("title") or "", 520)
        prompt = (
            "Anda adalah editor TikTok dan Facebook Reels.\n"
            "Buat 5 kandidat hook terbaik berdasarkan transcript.\n"
            "Rules: maksimal 12 kata, memancing penasaran, relevan, tidak clickbait berlebihan, Bahasa Indonesia natural, tanpa emoji/hashtag.\n"
            "DILARANG pakai template: Jawaban Ini Bikin Penasaran, Konflik Ini Terungkap, Hal Ini Mengejutkan, Bagian Ini Wajib Kamu Lihat.\n"
            f"Judul scene: {moment.get('titleSuggestion') or moment.get('title') or ''}\n"
            f"Transcript: {transcript}\n"
            "Output JSON valid saja: {\"hooks\":[\"...\",\"...\",\"...\",\"...\",\"...\"]}"
        )
        result = provider_request(payload, prompt, module="Hook Maker")
        if result.get("response"):
            source = transcript or moment.get("title") or ""
            candidates = parse_candidate_strings(result["response"], ["hooks", "hook"])
            result["candidates"] = candidates
            result["response"] = pick_best_hook(candidates + local_hook_candidates(source), source)
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
    AI_USAGE.update({"input_tokens": 0, "output_tokens": 0, "requests": 0, "errors": 0})
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


def highlight_batch_prompt(candidate_payload, target_count, min_duration, max_duration, score_mode, batch_index, batch_count):
    return (
        "Kamu adalah editor short-form profesional. Nilai kandidat dalam batch kecil ini berdasarkan isi nyata, bukan panjang transcript.\n"
        "Prioritas: hook kuat pada pembuka, konflik/emosi/komedi/value, setup jelas, payoff selesai, dan retention.\n"
        "Jangan pilih scene menggantung, filler tinggi, topik kabur, atau kandidat yang hanya ramai tanpa makna.\n"
        f"Batch {batch_index}/{batch_count}. Pilih maksimal {target_count} kandidat terbaik dari batch ini.\n"
        f"Durasi: punchline 25-65 detik, tutorial 45-110 detik, storytelling maksimal {int(min(max_duration, 145))} detik; minimum {int(min_duration)} detik.\n"
        f"Mode: {score_mode or 'Random Viral Mix'}. Score 78-100 hanya bila benar-benar layak auto-render; 65-77 optional.\n"
        "Title Bahasa Indonesia 4-9 kata dan hook 6-10 kata harus spesifik pada transcript. Jangan mengarang nama, angka, konflik, atau fakta.\n"
        "Balas HANYA JSON array valid tanpa markdown. Format:\n"
        "[{\"source_id\":1,\"score\":88,\"title\":\"...\",\"hook\":\"...\",\"reason\":\"maksimal 12 kata\",\"layout\":\"single|split\"}]\n"
        f"Kandidat:\n{json_dumps(candidate_payload)}"
    )


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
        batch_pick = max(2, math.ceil(target_count / max(1, len(batches))) + 1)
        for batch_index, batch in enumerate(batches, 1):
            prompt = highlight_batch_prompt(
                [compact_ai_highlight_candidate(item) for item in batch],
                batch_pick,
                min_duration,
                max_duration,
                payload.get("scoreMode"),
                batch_index,
                len(batches),
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
            local_score = clamp_score(candidate.get("score"), 50)
            ai_score = clamp_score(ai_item.get("score"), local_score)
            metrics = candidate.get("metrics") or {}
            evidence_bonus = 0
            if metrics.get("story_complete", 0) >= 75 and metrics.get("payoff", 0) >= 65:
                evidence_bonus += 2
            if metrics.get("retention_predictor", 0) >= 78:
                evidence_bonus += 1
            # AI reasons about context, but cannot replace local evidence. This
            # validation prevents a provider from assigning 99 to every clip.
            validated_score = local_score * 0.30 + ai_score * 0.70 + evidence_bonus
            candidate["score"] = clamp_score(validated_score, local_score)
            candidate["local_score"] = local_score
            candidate["ai_score"] = ai_score
            candidate["score_validated"] = True
            evidence_gate = bool(
                metrics.get("story_complete", 0) >= 52
                and metrics.get("filler_ratio", 0) <= 0.28
                and (
                    metrics.get("hook", 0) >= 55
                    or metrics.get("payoff", 0) >= 55
                    or metrics.get("retention_predictor", 0) >= 68
                )
            )
            candidate["ai_evidence_gate"] = evidence_gate
            if candidate["score"] >= AUTO_SELECT_MIN_SCORE and not evidence_gate:
                candidate["score"] = AUTO_SELECT_MIN_SCORE - 1
            if candidate["score"] < minimum_ai_score:
                continue
            candidate["grade"] = score_grade(candidate["score"])
            source_text = candidate.get("text") or candidate.get("transcript") or ""
            if ai_item.get("title"):
                ai_title = seo_clean_title(ai_item.get("title"), fyp_title_from_text(source_text))
                if not is_generic_template(ai_title) and relevance_ok(ai_title, source_text, 0.03):
                    candidate["title"] = ai_title
                    candidate["titleSuggestion"] = ai_title
            if ai_item.get("hook"):
                hook_value = seo_clean_title(ai_item.get("hook"), fyp_hook_from_text(source_text))
                if len(hook_value.split()) <= 12 and not is_generic_template(hook_value) and relevance_ok(hook_value, source_text, 0.03):
                    candidate["hook"] = hook_value
            if ai_item.get("reason"):
                candidate["reason"] = clean_text(ai_item.get("reason"))[:260]
            if str(ai_item.get("layout") or "").lower() == "split":
                candidate["layout"] = "split"
            effective_min, effective_target, effective_max, duration_profile = candidate_duration_bounds(
                candidate.get("text") or candidate.get("transcript") or "",
                min_duration,
                min(max_duration, max(min_duration, (float(min_duration) + float(max_duration)) / 2)),
                max_duration,
            )
            improved_start, improved_end, improved_text = improve_story_boundaries(
                candidate.get("start", 0),
                min(float(candidate.get("end", 0)), float(candidate.get("start", 0)) + effective_max),
                transcript,
                effective_min,
                effective_target,
                effective_max,
            )
            candidate["start"] = improved_start
            candidate["end"] = improved_end
            candidate["duration"] = round(improved_end - improved_start, 2)
            candidate.setdefault("metrics", {})["duration_profile"] = duration_profile
            if improved_text:
                candidate["text"] = improved_text
                candidate["transcript"] = improved_text[:700]
            candidate["ai_selected"] = True
            candidate["segment_type"] = "AI"
            candidate["ai_source"] = f"{ai_provider_name(payload.get('providerType'))} AI"
            candidate["ai_batch"] = int(ai_item.get("_ai_batch") or 1)
            candidate["ai_retry_count"] = int(ai_item.get("_ai_retry_count") or 0)
            validated_candidates.append(candidate)
        selected = []
        for candidate in sorted(validated_candidates, key=lambda item: item.get("score", 0), reverse=True):
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
                    f"dari {len(batches)} batch; batch_gagal={len(failed_batches)}"
                ),
            )
            return ordered
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
    prompt = (
        "Rewrite title dan hook untuk clip pendek agar lebih SEO/FYP tapi tetap relevan dengan transcript.\n"
        "Rules: Bahasa Indonesia natural, tanpa emoji, tanpa hashtag. Title 4-9 kata, hook 6-10 kata, jangan bohong.\n"
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
                text = moment.get("transcript") or moment.get("text") or moment.get("title") or ""
                if item.get("title"):
                    title = seo_clean_title(item.get("title"), fyp_title_from_text(text, index + 1))
                    if not is_generic_template(title) and relevance_ok(title, text, 0.04):
                        moment["titleSuggestion"] = title
                        moment["title"] = title
                if item.get("hook"):
                    hook = seo_clean_title(item.get("hook"), fyp_hook_from_text(text))
                    if len(hook.split()) <= 12 and not is_generic_template(hook) and relevance_ok(hook, text, 0.03):
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
        start = timestamp_to_seconds(str(start_value or "0"))
        end = timestamp_to_seconds(str(end_value or "0")) if str(end_value or "").strip() else video_duration
        if video_duration:
            start = max(0.0, min(start, video_duration))
            end = max(0.0, min(end, video_duration))
        if end > start:
            ranges.append((float(start), float(end)))

    if mode == "range":
        add_range(payload.get("rangeStart"), payload.get("rangeEnd"))
    elif mode == "multiple":
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


def candidate_in_ranges(start, end, ranges):
    if not ranges:
        return True
    start = float(start or 0.0)
    end = float(end or start)
    for range_start, range_end in ranges:
        overlap = max(0.0, min(end, range_end) - max(start, range_start))
        if overlap >= max(3.0, (end - start) * 0.45):
            return True
    return False


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
        if candidate_in_ranges(seg_start, seg_end, ranges):
            filtered.append(segment)
    return filtered


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
    return deduped


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
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        text = response.read().decode("utf-8", errors="replace")
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


def payoff_depth_score(lower_text, words, raw_text):
    last_words = " ".join(words[-28:])
    payoff_words = [
        ("akhirnya", 14), ("ternyata", 13), ("makanya", 11), ("jadi", 8),
        ("kesimpulannya", 13), ("intinya", 11), ("jawabannya", 11), ("selesai", 10),
        ("hasilnya", 12), ("solusinya", 12), ("akibatnya", 10), ("berhasil", 10),
        ("terbukti", 10), ("gitu", 6), ("begitu", 7), ("kan", 4), ("loh", 4),
    ]
    score = 28 + keyword_score(last_words, payoff_words)
    if re.search(r"[.!?]$", clean_text(raw_text)):
        score += 8
    dangling_tail = words[-4:]
    if dangling_tail and dangling_tail[-1] in {"karena", "tapi", "kalau", "yang", "dan", "atau"}:
        score -= 12
    if len(words) >= 45:
        score += 6
    return bounded_score(score, 20, 96)


def editor_retention_predictor(metrics, filler_ratio=0.0):
    score = (
        metrics.get("hook", 0) * 0.24
        + metrics.get("surprise", 0) * 0.16
        + metrics.get("emotion", 0) * 0.16
        + metrics.get("dialogue", 0) * 0.14
        + metrics.get("payoff", 0) * 0.14
        + metrics.get("story_complete", 0) * 0.10
        + metrics.get("duration_fit", 0) * 0.06
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
    score = bounded_score(weighted, 42, 99)
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
    first_words = " ".join(words[:16])
    last_words = " ".join(words[-24:])
    setup = any(word in first_words for word in ["tapi", "kenapa", "kok", "jadi", "nah", "gue", "aku", "kita", "ini", "waktu"])
    development = keyword_hits(
        lower,
        ["karena", "terus", "lalu", "setelah", "sebelum", "makanya", "ternyata", "akhirnya", "jawab", "tanya", "bilang"],
    )
    payoff = any(word in last_words for word in ["jadi", "makanya", "akhirnya", "ternyata", "gitu", "loh", "kan", "begitu", "selesai"])
    clean_end = bool(re.search(r"[.!?]$", clean_text(text)))
    duration_fit = min_duration * 0.85 <= float(duration or 0) <= max_duration * 1.08
    score = 42
    reasons = []
    if setup:
        score += 14
        reasons.append("setup jelas")
    if development:
        score += min(22, development * 6)
        reasons.append("alur berkembang")
    if payoff:
        score += 14
        reasons.append("ending punya payoff")
    if clean_end:
        score += 8
        reasons.append("ending rapi")
    if duration_fit:
        score += 10
        reasons.append("durasi pas")
    if lower.startswith(("dan ", "atau ", "yang ", "kalau ", "karena ", "terus ")):
        score -= 14
        reasons.append("awal terasa menggantung")
    if last_words.endswith(("kalau", "karena", "terus", "tapi", "yang", "dan", "atau")):
        score -= 14
        reasons.append("ending menggantung")
    if len(words) < 22:
        score -= 10
        reasons.append("konteks pendek")
    return bounded_score(score, 20, 99), reasons


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
        text = clean_text(item.get("text") or "")
        if text:
            result.append({"start": seg_start, "end": seg_end, "text": text})
    return result


def has_payoff_boundary(text):
    lower = clean_text(text).lower()
    if not lower:
        return False
    last_words = " ".join(normalize_words(lower)[-28:])
    payoff_words = [
        "jadi", "makanya", "akhirnya", "ternyata", "gitu", "loh", "kan",
        "begitu", "selesai", "intinya", "kesimpulannya", "jawabannya",
        "hasilnya", "karena itu", "nah itu",
    ]
    return bool(re.search(r"[.!?…]$", lower)) or any(word in last_words for word in payoff_words)


def improve_story_boundaries(start, end, transcript, min_duration, target_duration, max_duration):
    if not transcript:
        return float(start), float(end), ""
    if callable(external_extend_story_boundary):
        try:
            return external_extend_story_boundary(
                transcript,
                start,
                end,
                min_duration=min_duration,
                target_duration=target_duration,
                max_duration=max_duration,
                ending_buffer=2.5,
            )
        except Exception:
            pass
    start = smart_boundary_start(float(start), transcript)
    end = smart_boundary_end(float(end), transcript)
    max_end = start + float(max_duration)
    target_end = start + float(target_duration)
    selected_segments = transcript_segments_between(transcript, start, end)
    text = clean_text(" ".join(item["text"] for item in selected_segments))

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
        candidate_end = min(max_end, seg_end)
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
        end = min(max_end, start + float(min_duration))
        text = transcript_text_between(transcript, start, end) or text
    if end - start > float(max_duration):
        end = start + float(max_duration)
        text = transcript_text_between(transcript, start, end) or text
    return round(start, 2), round(end, 2), clean_text(text)


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


def build_editorial_candidate_windows(info, transcript, target_count, min_duration, target_duration, max_duration):
    duration = float(info.get("duration") or 0)
    candidates = []
    stories = []
    if callable(external_build_story_timeline):
        try:
            stories = external_build_story_timeline(transcript, {"min_duration": min_duration, "max_duration": max_duration})
            emit("log", stage="story detection", message=f"Story Detection: {len(stories)} story ditemukan")
        except Exception as exc:
            emit("log", stage="story detection", message=f"Story Engine fallback: {exc}")
    if callable(external_story_candidates):
        try:
            story_windows = external_story_candidates(
                transcript,
                {"durations": [min_duration, target_duration, min(max_duration, target_duration * 1.35)]},
            )
            candidates.extend(story_windows)
        except Exception as exc:
            emit("log", stage="story detection", message=f"Story candidate fallback: {exc}")
    if callable(external_generate_highlight_candidates):
        try:
            evidence_candidates = external_generate_highlight_candidates(
                transcript,
                metadata={
                    "duration": duration,
                    "title": info.get("title"),
                    "story_candidates": stories,
                },
                config={"min_candidates": 40 if duration >= 1800 else 20, "max_candidates": 80},
            )
            for item in evidence_candidates:
                candidates.append({**item, "segment_type": "Evidence"})
            emit("log", stage="candidate", message=f"Candidate Generator: {len(evidence_candidates)} evidence candidate")
        except Exception as exc:
            emit("log", stage="candidate", message=f"Evidence candidate fallback: {exc}")
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
    seen = set()
    for item in candidates:
        text_key = clean_text(item.get("text") or "")[:180]
        key = (round(float(item.get("start") or 0), 1), round(float(item.get("end") or 0), 1), text_key)
        if not text_key or key in seen:
            continue
        seen.add(key)
        unique.append(item)
    max_pool = max(220, min(360, int(target_count or 1) * 48))
    if len(unique) > max_pool:
        def rough_signal(item):
            text = clean_text(item.get("text") or "")
            opening = " ".join(text.split()[:32]).lower()
            ending = " ".join(text.split()[-28:]).lower()
            existing = float(item.get("score") or 0)
            source_bonus = 8 if item.get("candidate_source") == "story" or item.get("segment_type") == "Story" else 0
            opening_signal = keyword_hits(opening, ["kenapa", "kok", "ternyata", "jangan", "rahasia", "gimana", "bagaimana"]) * 7
            ending_signal = keyword_hits(ending, ["akhirnya", "hasilnya", "makanya", "intinya", "jawabannya", "berhasil"]) * 7
            specificity = min(16, len(extract_specific_terms(text, 8)) * 2)
            return existing + source_bonus + opening_signal + ending_signal + specificity

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
    metrics, editor_score = editor_scene_metrics(text, duration, min_duration, max_duration, index)
    profile = dynamic_duration_profile(text) if callable(dynamic_duration_profile) else {"type": "general"}
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
    hook = bounded_score(max(hook_strength(opening_text), metrics["hook"]), 20, 96)
    metrics["hook"] = hook
    conflict = max(
        metrics.get("conflict", 0),
        bounded_score(keyword_hits(text.lower(), ["konflik", "ribut", "ditolak", "masalah", "debat", "bullying", "marah"]) * 14 + 24, 20, 96),
    )
    retention = max(retention_score(text, duration, min_duration, max_duration), metrics["flow"], metrics.get("retention_predictor", 0))
    metrics["emotion"] = bounded_score(max(emotion_score(text), metrics["emotion"]), 20, 96)
    metrics["conflict"] = bounded_score(conflict, 20, 96)
    metrics["retention_predictor"] = bounded_score(retention, 20, 96)
    metrics["speaker_energy"] = bounded_score(metrics.get("dialogue", metrics.get("conversation", 45)), 20, 96)
    metrics["visual_activity"] = bounded_score(candidate.get("visual_activity", 45), 20, 96)
    metrics["seo_potential"] = bounded_score(metrics.get("knowledge", metrics.get("value", 45)), 20, 96)
    category = choose_category(text, payload)
    if callable(score_highlight_v2):
        score = bounded_score(score_highlight_v2(metrics), 25, 97)
    else:
        score = bounded_score(editor_score, 25, 97)
    if len(extract_specific_terms(text, 6)) < 2:
        score = bounded_score(score - 7, 25, 97)
    if is_generic_template(hook_text):
        score = bounded_score(score - 10, 25, 97)
    if metrics.get("retention_predictor", 0) >= 82 and metrics.get("payoff", 0) >= 70:
        score = bounded_score(score + 3, 25, 97)
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
        "filler_ratio": metrics.get("filler_ratio", 0),
    }
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
        "reason": editor_reason(metrics),
        "hook": hook_text,
    }


def calibrate_candidate_scores(candidates):
    """Calibrate evidence scores against the candidate pool deterministically.

    The raw score remains available for audit. A relative boost is granted only
    when story, payoff, retention, and specificity gates pass, so weak footage
    cannot become excellent merely by being the best item in a poor pool.
    """
    if not candidates:
        return candidates
    ranked = sorted(candidates, key=lambda item: float(item.get("score") or 0), reverse=True)
    denominator = max(1, len(ranked) - 1)
    for rank, candidate in enumerate(ranked):
        raw_score = clamp_score(candidate.get("score"), 0)
        metrics = candidate.get("metrics") or {}
        percentile = 1.0 - rank / denominator
        specificity = len(extract_specific_terms(candidate.get("text") or candidate.get("transcript") or "", 8))
        evidence_gate = (
            raw_score >= 48
            and metrics.get("story_complete", 0) >= 65
            and metrics.get("retention_predictor", 0) >= 62
            and metrics.get("payoff", 0) >= 45
            and metrics.get("filler_ratio", 0) <= 0.12
            and specificity >= 3
        )
        rank_bonus = percentile * (20 if evidence_gate else 6)
        evidence_bonus = 0
        if evidence_gate and metrics.get("hook", 0) >= 70:
            evidence_bonus += 3
        if evidence_gate and metrics.get("payoff", 0) >= 60:
            evidence_bonus += 2
        calibrated = bounded_score(raw_score + rank_bonus + evidence_bonus, raw_score, 97)
        candidate["raw_score"] = raw_score
        candidate["score"] = calibrated
        candidate["score_percentile"] = round(percentile * 100, 1)
        candidate["score_calibrated"] = True
        candidate["evidence_gate"] = evidence_gate
        candidate["grade"] = score_grade(calibrated)
        candidate["priority"] = score_priority(calibrated)
        candidate["auto_render"] = calibrated >= AUTO_SELECT_MIN_SCORE
        candidate["render_eligible"] = calibrated >= AUTO_RENDER_MIN_SCORE
    return candidates


def apply_title_hook_diversity(moments):
    used_hook_signatures = set()
    used_title_signatures = set()
    refined = []
    for index, item in enumerate(moments or [], 1):
        moment = dict(item)
        source = clean_text(moment.get("transcript") or moment.get("text") or moment.get("title") or "")

        hook = clean_text(moment.get("hook") or "")
        if not hook or is_generic_template(hook) or hook_signature(hook) in used_hook_signatures or hook_quality_score(hook, source, used_hook_signatures) < 58:
            hook = pick_best_hook(local_hook_candidates(source), source, used_hook_signatures)
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
        if not title or is_generic_template(title) or hook_signature(title) in used_title_signatures or title_quality_score(title, source, used_title_signatures) < 58:
            title = pick_best_title(local_title_candidates(source, index), source, index, used_title_signatures)
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
        manual_review = bool(moment.get("manual_review_candidate"))
        moment["priority"] = "OPTIONAL" if manual_review else score_priority(score)
        moment["grade"] = score_grade(score)
        moment["auto_render"] = score >= AUTO_SELECT_MIN_SCORE
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
        refined.append(moment)
    return refined


def select_review_fallback_moments(candidates, target_count, video_duration=0.0):
    """Return honest low-confidence candidates instead of an empty Moment page.

    Scores are never raised. These clips are visible and manually selectable,
    but remain excluded from automatic render selection.
    """
    ranked = sorted(candidates or [], key=lambda item: float(item.get("score") or 0), reverse=True)
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
            review["reason"] = clean_text(
                f"{review.get('reason') or ''}; Kandidat terbaik tersedia untuk review manual, score tidak dinaikkan"
            ).strip("; ")
            selected.append(review)
            used_buckets.add(int(float(review.get("start") or 0.0) / bucket_size))
        if len(selected) >= target_count:
            break
    return sorted(selected, key=lambda item: float(item.get("start") or 0.0))


def candidate_duration_bounds(text, minimum, target, maximum):
    profile = dynamic_duration_profile(text) if callable(dynamic_duration_profile) else {"type": "general", "min": minimum, "target": target, "max": maximum}
    profile_min = float(profile.get("min") or minimum)
    profile_target = float(profile.get("target") or target)
    profile_max = float(profile.get("max") or maximum)
    effective_min = max(float(minimum), min(profile_min, float(maximum)))
    effective_target = max(effective_min, min(float(target), profile_target, float(maximum)))
    effective_max = max(effective_target, min(float(maximum), profile_max))
    return effective_min, effective_target, effective_max, str(profile.get("type") or "general")


def select_diverse_moments(candidates, target_count, transcript, min_duration, target_duration, max_duration, payload, video_duration=0.0):
    candidates = sorted(candidates, key=lambda item: item["score"], reverse=True)
    selected = []
    exclusion_windows = []
    bucket_size = max(float(max_duration), float(video_duration or 0) / max(int(target_count or 1), 1))
    bucket_counts = {}
    category_counts = {}
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
        if clamp_score(candidate.get("score"), 0) < minimum_score:
            candidate["rejected"] = True
            candidate["low_quality"] = True
            candidate["render_eligible"] = False
            candidate["auto_render"] = False
            candidate["reject_reason"] = f"Score di bawah {minimum_score}"
            return False
        effective_min, effective_target, effective_max, duration_profile = candidate_duration_bounds(
            candidate.get("text") or candidate.get("transcript") or "",
            min_duration,
            target_duration,
            max_duration,
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
        if improved_text:
            candidate["text"] = improved_text
            candidate["transcript"] = improved_text[:700]
        candidate["duration"] = max(5.0, round(candidate["end"] - candidate["start"], 2))
        candidate.setdefault("metrics", {})["duration_profile"] = duration_profile
        if candidate["duration"] > effective_max:
            candidate["end"] = round(candidate["start"] + float(effective_max), 2)
            candidate["duration"] = round(candidate["end"] - candidate["start"], 2)
            candidate["time"] = f"{seconds_to_stamp(candidate['start'])} - {seconds_to_stamp(candidate['end'])}"
        if candidate["duration"] < effective_min:
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
        bucket = int(candidate["start"] / max(bucket_size, 1.0))
        if strict_bucket and bucket_counts.get(bucket, 0) >= 1:
            return False
        selected.append(candidate)
        bucket_counts[bucket] = bucket_counts.get(bucket, 0) + 1
        category_counts[category] = category_counts.get(category, 0) + 1
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
            try_add(candidate, strict_bucket=False, allow_text_repeat=True, allow_nearby=True)
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
    working_count = auto_target_clip_count(duration, transcript) if bool_payload(payload, "autoClipCount", False) else int(payload.get("clipCount") or 5)
    target_count = max(1, min(20, working_count))
    if bool_payload(payload, "autoClipCount", False):
        emit("log", stage="highlight", message=f"Full AI Auto Mode: target clip dinamis {target_count} berdasarkan durasi {seconds_to_stamp(duration)}")
    timeline_ranges = parse_timeline_ranges(payload, duration)
    payload["_timelineRanges"] = timeline_ranges
    working_transcript = filter_transcript_by_ranges(transcript, timeline_ranges)
    if timeline_ranges and not working_transcript:
        emit("log", message="Timeline range tidak punya transcript, fallback ke transcript penuh untuk mencegah hasil kosong.")
        working_transcript = transcript
        timeline_ranges = []
        payload["_timelineRanges"] = []
    segments = build_semantic_segments(info, working_transcript, duration)
    windows = build_editorial_candidate_windows(info, working_transcript, target_count, min_duration, target_duration, max_duration)
    emit("log", stage="ranking", message=f"Ranking Engine: {len(windows)} candidate dianalisis untuk target maksimal {target_count} clip")
    audio_timeline = build_audio_activity_timeline(info.get("_source_path"), info.get("_analysis_cache_dir"))
    if audio_timeline:
        emit("log", stage="audio evidence", message=f"Audio Evidence: {len(audio_timeline)} detik activity timeline siap")
    if timeline_ranges:
        windows = [item for item in windows if candidate_in_ranges(item.get("start"), item.get("end"), timeline_ranges)]

    moments = []
    used_keys = set()
    for index, item in enumerate(windows):
        start = max(0, float(item["start"]))
        end = max(start + min_duration, float(item["end"]))
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
        )
        end = min(end, start + effective_max)
        start, end, improved_text = improve_story_boundaries(start, end, working_transcript, effective_min, effective_target, effective_max)
        if improved_text:
            text = improved_text
        if timeline_ranges and not candidate_in_ranges(start, end, timeline_ranges):
            continue
        if end <= start:
            continue
        duration_seconds = max(effective_min, min(effective_max, end - start))
        if duration_seconds < effective_min:
            continue
        moment = {
            "id": len(moments) + 1,
            "title": make_title(text, len(moments) + 1, payload),
            "start": round(start, 2),
            "end": round(start + duration_seconds, 2),
            "duration": round(duration_seconds, 2),
            "time": f"{seconds_to_stamp(start)} - {seconds_to_stamp(start + duration_seconds)}",
            "transcript": text[:420] or "Tidak ada transcript untuk segmen ini.",
            "titleSuggestion": make_title(text, len(moments) + 1, payload),
            "segment_type": item.get("segment_type", "Auto"),
            "text": text,
            "story_id": item.get("story_id"),
            "topic": item.get("topic"),
            "story_summary": item.get("summary"),
            "candidate_source": item.get("candidate_source") or item.get("segment_type"),
            "candidate_metrics": item.get("metrics") if isinstance(item.get("metrics"), dict) else {},
            "audio_metrics": audio_evidence_between(audio_timeline, start, start + duration_seconds),
        }
        moment.update(score_moment_candidate(moment, payload, index, effective_min, effective_max))
        moment.setdefault("metrics", {})["duration_profile"] = duration_profile
        if isinstance(item.get("metrics"), dict):
            moment["evidence_metrics"] = item.get("metrics")
        moments.append(moment)

    moments = calibrate_candidate_scores(moments)
    ai_selections = ai_select_moments(moments, payload, target_count, working_transcript, min_duration, max_duration)
    if ai_selections:
        full_auto = bool_payload(payload, "fullAutoMode", False)
        output_limit = target_count
        if len(ai_selections) < target_count and not full_auto:
            local_fill = select_diverse_moments(moments, target_count * 2, working_transcript, min_duration, target_duration, max_duration, payload, duration)
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
            output_limit = min(16, max(target_count + 3, target_count * 2))
            review_fill = select_review_fallback_moments(moments, output_limit, duration)
            for candidate in review_fill:
                if len(ai_selections) >= output_limit:
                    break
                if overlaps_any(candidate, ai_selections):
                    continue
                ai_selections.append(candidate)
            emit(
                "log",
                stage="fallback selection",
                message=f"AI memilih kurang dari target; hasil dilengkapi menjadi {len(ai_selections)} kandidat dengan Optional evidence lokal.",
            )
        ordered_ai = sorted(ai_selections[:output_limit], key=lambda item: item["start"])
        for index, item in enumerate(ordered_ai, 1):
            item["id"] = index
            item["score"] = clamp_score(item.get("score"), 75 if item.get("ai_selected") else 0)
            item["grade"] = score_grade(item["score"])
            item["duration"] = round(float(item["end"]) - float(item["start"]), 2)
            item["time"] = f"{seconds_to_stamp(item['start'])} - {seconds_to_stamp(item['end'])}"
        final_ai = apply_title_hook_diversity(revise_moments_with_ai(ordered_ai, payload))
        emit("log", stage="final selection", message=f"Final Selection: {len(final_ai)} clip AI tanpa overlap")
        return final_ai

    selections = select_diverse_moments(moments, target_count, working_transcript, min_duration, target_duration, max_duration, payload, duration)
    if not selections and moments:
        minimum_score = AUTO_SELECT_MIN_SCORE if bool_payload(payload, "fullAutoMode", False) else AUTO_RENDER_MIN_SCORE
        selections = [item for item in moments if clamp_score(item.get("score"), 0) >= minimum_score][:target_count]
        if not selections and bool_payload(payload, "fullAutoMode", False):
            review_target = min(16, max(target_count + 3, target_count * 2))
            selections = select_review_fallback_moments(moments, review_target, duration)
            if selections:
                emit("log", stage="fallback selection", message=f"Tidak ada score {AUTO_SELECT_MIN_SCORE}+. Menampilkan {len(selections)} kandidat terbaik sebagai Optional tanpa menaikkan score.")
    if (
        not bool_payload(payload, "fullAutoMode", False)
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
    final_local = apply_title_hook_diversity(revise_moments_with_ai(selections, payload))
    emit("log", stage="final selection", message=f"Final Selection: {len(final_local)} clip lokal tanpa overlap")
    return final_local


def transcript_text_between(transcript, start, end):
    parts = []
    for segment in transcript or []:
        try:
            seg_start = float(segment.get("start") or 0)
            seg_end = float(segment.get("end") or seg_start)
        except Exception:
            continue
        if seg_end < start or seg_start > end:
            continue
        text = clean_text(segment.get("text") or "")
        if text:
            parts.append(text)
    return clean_text(" ".join(parts))


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
        if timeline_ranges and not candidate_in_ranges(candidate["start"], candidate["end"], timeline_ranges):
            continue
        candidate["duration"] = round(candidate["end"] - candidate["start"], 2)
        if candidate["duration"] < min_duration:
            continue
        if overlaps_any(candidate, selected):
            continue
        text = improved_text or transcript_text_between(transcript, candidate["start"], candidate["end"])
        if not text:
            text = clean_text(info.get("title") or "Moment lokal dari source cache")
        moment = {
            "id": len(selected) + 1,
            "title": make_title(text, len(selected) + 1, payload),
            "start": round(candidate["start"], 2),
            "end": round(candidate["end"], 2),
            "duration": candidate["duration"],
            "time": f"{seconds_to_stamp(candidate['start'])} - {seconds_to_stamp(candidate['end'])}",
            "transcript": text[:420],
            "titleSuggestion": make_title(text, len(selected) + 1, payload),
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
    if payload and bool_payload(payload, "metadataToggle", False) and is_ai_feature_enabled(payload, "title") and index <= 3:
        ai_result = ai_generate_title(text, payload)
        if ai_result.get("response"):
            return seo_clean_title(ai_result["response"], fyp_title_from_text(text, index))
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


def analyze(payload):
    AI_DEBUG_EVENTS.clear()
    AI_USAGE.update({"input_tokens": 0, "output_tokens": 0, "requests": 0, "errors": 0})
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
    write_cache_files(cache_dir, info, transcript, subtitle_language)
    emit("log", stage="cache", message=f"{'Cached new source' if downloaded else 'Using cached source'}: {source}")

    emit("progress", stage="moments", progress=88, message="Ranking moments dan hapus overlap")
    moments = find_moments(info, transcript, payload)
    write_moments_cache(cache_dir, moments)
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
        },
        "moments": moments,
        "transcript": transcript,
        "dependencies": check_dependencies(),
        "ai_usage": dict(AI_USAGE),
        "ai_diagnostics": ai_diagnostics_summary(),
        "ai_log_path": str(ai_log_path(payload)),
        "ai_debug_path": str(analysis_ai_debug_path),
    }
    emit("progress", stage="done", progress=100, message="Analisa selesai")
    emit("done", result=result)


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
    if payload and is_ai_feature_enabled(payload, "title"):
        ai_result = ai_generate_upload_title(moment, payload)
        if ai_result.get("response"):
            ai_title = clean_text(ai_result["response"])
            emit("log", stage="ai title", message=f"AI SEO filename aktif: {ai_title[:90]}")
        else:
            emit("log", stage="ai title", message=f"AI SEO filename fallback local: {ai_result.get('error') or 'empty response'}")
    source = ai_title or (
        moment.get("titleSuggestion")
        or moment.get("hook")
        or moment.get("title")
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
    title = title_case_upload(" ".join(words[:12]))
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
    try:
        percent = max(0.0, min(100.0, float(value)))
    except Exception:
        percent = 50.0
    return f"({total_expr}-{size_expr})*{percent / 100:.4f}"


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
    overlay_y = pct_expr(payload.get("logoY", 8), "H", "h")
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


def drawtext_filter(text, x, y, fontsize=42, color="white", box=True, enable=None, alpha=1.0, border_color="black", shadow=2, font_path=None):
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
    parts.extend([f"borderw={2 if shadow else 1}", f"bordercolor={ffmpeg_color(border_color, 'black')}@0.95"])
    if shadow:
        parts.extend([f"shadowx={shadow}", f"shadowy={shadow}", "shadowcolor=black@0.55"])
    if enable:
        parts.append(f"enable='{enable}'")
    return "drawtext=" + ":".join(parts[1:])


def ass_time(seconds):
    seconds = max(0.0, float(seconds or 0.0))
    centis = int(round((seconds - int(seconds)) * 100))
    whole = int(seconds)
    hours = whole // 3600
    minutes = (whole % 3600) // 60
    secs = whole % 60
    if centis >= 100:
        secs += 1
        centis = 0
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


def ass_active_word_phrase(words, active_index, active_color, primary_color):
    display = [clean_text(item.get("word") or "") for item in words or []]
    display = [word for word in display if word]
    if not display:
        return ""
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
            styled = (
                r"{\c" + active_color
                + r"\fscx100\fscy100\t(0,90,\fscx108\fscy108)}"
                + core
                + r"{\c" + primary_color + r"\fscx100\fscy100}"
                + punctuation
            )
        else:
            styled = r"{\c" + primary_color + r"\fscx100\fscy100}" + core + punctuation
        parts.append(prefix + styled)
    return " ".join(parts)


def caption_effect_prefix(payload):
    animation = str((payload or {}).get("subtitleAnimation") or "Scale").lower()
    if "fade" in animation:
        return r"{\fad(80,90)}"
    if "bounce" in animation:
        return r"{\fad(40,70)\fscx96\fscy96\t(0,120,\fscx114\fscy114)\t(120,260,\fscx100\fscy100)}"
    if "pop" in animation or "scale" in animation:
        return r"{\fad(35,65)\fscx94\fscy94\t(0,120,\fscx110\fscy110)\t(120,240,\fscx100\fscy100)}"
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
            rel_start = item["start"]
            rel_end = item["end"]
        else:
            rel_start = item["start"] - clip_start
            rel_end = item["end"] - clip_start
        rel_start = max(0.0, rel_start - lead)
        rel_end = min(duration, max(rel_start + 0.28, rel_end + end_buffer))
        if rel_end <= 0 or rel_start >= duration:
            continue
        result.append((max(0.0, rel_start), min(duration, rel_end), item["text"]))
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
            seen = set()
            for item in built_events or []:
                clean_chunk = clean_text(item.get("text") or "")
                key = clean_chunk.lower()
                if not clean_chunk or key in seen:
                    continue
                start = max(0.0, float(item.get("start") or 0.0))
                end = min(float(duration or 0.0), float(item.get("end") or start))
                if end - start < 0.20:
                    continue
                events.append({
                    "start": start,
                    "end": end,
                    "text": clean_chunk,
                    "speaker_id": item.get("speaker_id") or "",
                    "words": distribute_caption_words(start, end, clean_chunk, item.get("words") or []),
                })
                seen.add(key)
                if len(events) >= max_events:
                    break
            if events:
                return events
        except Exception as exc:
            emit("log", stage="caption", message=f"SubtitleEngine v4 fallback ke legacy timing: {exc}")

    events = []
    seen_texts = set()
    last_text = ""
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
            if clean_chunk.lower() == last_text.lower() or clean_chunk.lower() in seen_texts:
                continue
            if end - start < 0.25:
                continue
            if len(events) and text_similarity(clean_chunk, events[-1]["text"]) > 0.65:
                continue
            events.append({"start": start, "end": end, "text": clean_chunk, "speaker_id": "", "words": distribute_caption_words(start, end, clean_chunk)})
            seen_texts.add(clean_chunk.lower())
            last_text = clean_chunk
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


def build_ass_caption_file(moment, path, payload, transcript=None):
    duration = max(1.0, float(moment.get("duration") or 20))
    hook_enabled = bool_payload(payload, "addHook", False)
    caption_enabled = bool_payload(payload, "addCaptions", False) and bool_payload(payload, "burnSubtitle", True)
    context_enabled = (bool_payload(payload, "introContext", False) or bool_payload(payload, "transformativeMode", False)) and not hook_enabled and not caption_enabled
    if not hook_enabled and not caption_enabled and not context_enabled:
        return False

    width, height = output_dimensions(payload.get("formatProfile"), payload.get("resolutionProfile")) or (1080, 1920)
    caption_preview_events = build_timed_caption_events(moment, transcript or [], payload, duration, 0.0) if caption_enabled else []
    hook_text = make_hook_text(moment, payload) if hook_enabled else ""
    caption_preview_text = " ".join(item.get("text") or "" for item in caption_preview_events[:3])
    if hook_enabled and (not hook_text or hook_is_duplicate_caption(hook_text, caption_preview_text)):
        emit("log", stage="hook", message="Hook intro dilewati karena mirip dengan caption/transcript awal.")
        hook_enabled = False
        hook_text = ""
    hook_end = min(hook_seconds(payload), duration) if hook_enabled else 0.0
    caption_events = build_timed_caption_events(moment, transcript or [], payload, duration, hook_end) if caption_enabled else []
    if caption_enabled and not caption_events:
        emit("log", stage="caption", message="Caption tidak dibakar karena transcript/SRT/manual caption tidak tersedia.")
        caption_enabled = False
    if not hook_enabled and not caption_enabled and not context_enabled:
        try:
            Path(path).unlink(missing_ok=True)
        except Exception:
            pass
        return False

    configured_caption_font = int(float(payload.get("subtitleFontSize") or 0) or 0)
    caption_font = configured_caption_font if configured_caption_font else (70 if height >= 1800 else 50)
    hook_font = 58 if height >= 1800 else 42
    context_font = 34 if height >= 1800 else 24
    bottom_margin = 250 if height >= 1800 else 150
    top_margin = 72 if height >= 1800 else 42
    context_margin = 178 if height >= 1800 else 112
    font_name = subtitle_font_name(payload)
    primary_color = ass_color(payload.get("subtitlePrimaryColor"), "#ffffff")
    active_color = ass_color(payload.get("subtitleActiveColor"), "#19ff47")
    stroke_color = ass_color(payload.get("subtitleStrokeColor"), "#000000")
    shadow = max(0, min(8, int(float(payload.get("subtitleShadow") or 2))))
    try:
        configured_spacing = payload.get("subtitleLetterSpacing")
        caption_spacing = float(configured_spacing) if configured_spacing not in {None, ""} else (1.4 if width >= 1080 else 1.0)
    except Exception:
        caption_spacing = 1.4 if width >= 1080 else 1.0
    caption_spacing = max(0.0, min(3.0, caption_spacing))
    caption_effect = caption_effect_prefix(payload)
    word_highlight_enabled = bool_payload(payload, "subtitleWordHighlight", True)
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
        f"Style: Hook,{font_name},{hook_font},&H00000000,&H00000000,&H00000000,&H00FFFFFF,-1,0,0,0,100,100,0,0,3,0,0,8,80,80,{top_margin},1",
        f"Style: Context,{font_name},{context_font},&H00FFFFFF,&H00FFFFFF,&H00101010,&HCC000000,-1,0,0,0,100,100,0,0,3,1,1,8,92,92,{context_margin},1",
        f"Style: Caption,{font_name},{caption_font},{primary_color},{active_color},{stroke_color},&H00000000,-1,0,0,0,100,100,{caption_spacing:.1f},0,1,5,{shadow},2,80,80,{bottom_margin},1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    if hook_enabled:
        lines.append(f"Dialogue: 1,{ass_time(0)},{ass_time(hook_end)},Hook,,0,0,0,,{ass_escape(hook_text)}")
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
            if hook_enabled and hook_is_duplicate_caption(hook_text, text):
                continue
            word_items = distribute_caption_words(start, end, text, event.get("words") or [])
            if word_highlight_enabled and word_items:
                for word_index, word_item in enumerate(word_items):
                    word_start = max(start, float(word_item.get("start") or start))
                    next_start = float(word_items[word_index + 1].get("start") or end) if word_index + 1 < len(word_items) else end
                    # End exactly where the next word starts. Overlapping ASS
                    # dialogue lines render two captions at once and look like
                    # flicker, even when both word timestamps are individually
                    # correct.
                    word_end = min(end, max(word_start + 0.04, next_start))
                    if word_end - word_start < 0.04:
                        continue
                    active_phrase = ass_active_word_phrase(word_items, word_index, active_color, primary_color)
                    lines.append(f"Dialogue: 0,{ass_time(word_start)},{ass_time(word_end)},Caption,,0,0,0,,{active_phrase}")
            else:
                lines.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Caption,,0,0,0,,{caption_effect}{build_ass_karaoke_line(start, end, text, active_color, primary_color, word_highlight=False)}")
    Path(path).write_text("\n".join(lines), encoding="utf-8")
    return True


def validate_subtitle_sync(moment, transcript, payload, duration, ass_path):
    """Validate the locked clip-relative timeline without changing word timing."""
    duration = max(0.1, float(duration or 0.1))
    ass_path = Path(ass_path)
    hook_end = min(hook_seconds(payload), duration) if bool_payload(payload, "addHook", False) else 0.0
    expected_events = build_timed_caption_events(moment, transcript or [], payload, duration, hook_end)
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
                text = clean_text(re.sub(r"\{[^}]*\}", "", parts[9]).replace(r"\N", " "))
                if end <= start or start < -0.001 or end > duration + 0.05 or not text:
                    errors.append(f"ASS event invalid {start:.3f}-{end:.3f}")
                    continue
                ass_events.append({"start": start, "end": end, "text": text})
        except Exception as exc:
            errors.append(f"ASS tidak dapat dibaca: {exc}")

    relevant_words = expected_words
    expected_count = len(relevant_words) if bool_payload(payload, "subtitleWordHighlight", True) else len(expected_events)
    coverage_ratio = len(ass_events) / max(1, expected_count)
    if expected_events and not ass_events:
        errors.append("ASS tidak memiliki Caption event")
    if expected_count and coverage_ratio < 0.90:
        errors.append(f"coverage ASS hanya {coverage_ratio * 100:.1f}%")
    if ass_events:
        actual_first = ass_events[0]["start"]
        actual_last = ass_events[-1]["end"]
        expected_first = float(relevant_words[0].get("start") or 0.0) if relevant_words else float(expected_events[0].get("start") or 0.0)
        expected_last = float(relevant_words[-1].get("end") or duration) if relevant_words else float(expected_events[-1].get("end") or duration)
        if abs(actual_first - expected_first) > 0.35:
            errors.append(f"awal ASS bergeser {actual_first - expected_first:+.3f}s")
        if abs(actual_last - expected_last) > 0.35:
            errors.append(f"akhir ASS bergeser {actual_last - expected_last:+.3f}s")
    else:
        actual_first = None
        actual_last = None

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
        "coverage_ratio": round(coverage_ratio, 4),
        "subtitle_start": round(actual_first, 3) if actual_first is not None else None,
        "subtitle_end": round(actual_last, 3) if actual_last is not None else None,
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
        opacity = max(0.1, min(1.0, float(payload.get("watermarkOpacity") or 68) / 100))
        x_expr = pct_expr(payload.get("watermarkTextX", 78), "w", "text_w")
        y_expr = pct_expr(payload.get("watermarkTextY", 16), "h", "text_h")
        fontsize = max(14, min(90, int(float(payload.get("watermarkTextSize") or 28))))
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
                shadow=max(0, min(8, int(float(payload.get("watermarkTextShadow") or 2)))),
                font_path=payload.get("watermarkFontPath"),
            )
        )

    if bool_payload(payload, "creditText", False):
        filters.append(drawtext_filter(payload.get("sourceCreditText") or "Source: YouTube", "32", "h-text_h-34", fontsize=18, alpha=0.72))


def make_hook_text(moment, payload=None):
    source_text = clean_text(moment.get("transcript") or moment.get("text") or moment.get("title") or "")
    default = clean_text(moment.get("hook") or local_hook_from_text(source_text) or moment.get("titleSuggestion") or moment.get("title") or "Bagian ini penting untuk kamu lihat")
    if payload and bool_payload(payload, "addHook", False) and is_ai_feature_enabled(payload, "hook"):
        ai_result = ai_generate_hook(moment, payload)
        if ai_result.get("response"):
            hook = seo_clean_title(ai_result["response"], default)
            if len(hook.split()) <= 12 and relevance_ok(hook, source_text or default, 0.03) and not hook_is_duplicate_caption(hook, source_text):
                return hook
    if len(default.split()) > 12 or hook_is_duplicate_caption(default, source_text):
        default = fyp_hook_from_text(source_text or moment.get("title") or "")
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
    duration = max(4, float(moment.get("duration") or 20))
    hook_enabled = bool_payload(payload, "addHook", False)
    captions_enabled = bool_payload(payload, "addCaptions", False)
    hook_end = min(duration, hook_seconds(payload)) if hook_enabled else 0.0

    lines = []
    index = 1
    if bool_payload(payload, "addHook", False) and not captions_enabled:
        hook = make_hook_text(moment, payload)
        end = min(duration, hook_end)
        lines.append(f"{index}\n{srt_time(0)} --> {srt_time(end)}\n{hook}\n")
        index += 1

    if captions_enabled:
        events = build_timed_caption_events(moment, transcript or [], payload, duration, hook_end)
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
    start_offset = min(duration - 0.5, hook_end if hook_enabled and not captions_enabled else 0)
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
        return "id"
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
        try:
            item = {"word": word_text, "start": float(start), "end": float(end)}
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
        segments_iter, info = model.transcribe(
            str(audio_path),
            language=language,
            beam_size=1,
            best_of=1,
            vad_filter=True,
            word_timestamps=True,
            condition_on_previous_text=False,
        )
        transcript = []
        for segment in segments_iter:
            words = getattr(segment, "words", None)
            word_groups = word_timestamp_segments(words)
            if word_groups:
                transcript.extend(word_groups)
                continue
            text = clean_text(getattr(segment, "text", ""))
            if text:
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


def smooth_focus_points(points, alpha=0.78):
    if not points:
        return []
    smoothed = [points[0]]
    current = float(points[0])
    for point in points[1:]:
        current = current * alpha + float(point) * (1 - alpha)
        smoothed.append(current)
    return smoothed


def calm_camera_keyframes(points, duration, max_points=6, min_gap=2.25, max_step=0.16):
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


def speaker_timeline_context(transcript, moment=None):
    speakers = []
    intervals = []
    for item in transcript or []:
        speaker = str(item.get("speaker_id") or item.get("speaker") or "").strip()
        if not speaker or speaker.lower() in {"auto", "speaker auto"}:
            continue
        if speaker not in speakers:
            speakers.append(speaker)
        try:
            intervals.append((float(item.get("start") or 0.0), float(item.get("end") or 0.0), speaker))
        except Exception:
            continue
    overlap = 0.0
    for index, left in enumerate(intervals):
        for right in intervals[index + 1:]:
            if left[2] == right[2]:
                continue
            overlap = max(overlap, max(0.0, min(left[1], right[1]) - max(left[0], right[0])))
    metrics = (moment or {}).get("metrics") or {}
    emotion = max(float(metrics.get("emotion") or 0), float(metrics.get("surprise") or 0), float(metrics.get("conflict") or 0)) / 100.0
    return {
        "speakers": speakers,
        "speaker_count": len(speakers),
        "overlap_seconds": round(overlap, 3),
        "emotion": max(0.0, min(1.0, emotion)),
    }


def detect_conversation_focus(video_path, start, duration, moment=None, transcript=None, variation_index=0):
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
    upperbody_path = os.path.join(haarcascades_dir, "haarcascade_upperbody.xml")
    upperbody = cv2.CascadeClassifier(upperbody_path)
    has_body_detector = not upperbody.empty()

    centers = []
    face_counts = []
    spans = []
    left_points = []
    right_points = []
    body_hits = 0
    mode_counts = {}
    previous_active = None
    sample_count = max(12, min(42, int(float(duration or 0) / 1.55) or 14))
    for index in range(sample_count):
        position = (float(start) + (float(duration) * (index + 0.5) / sample_count)) * 1000
        capture.set(cv2.CAP_PROP_POS_MSEC, position)
        ok, frame = capture.read()
        if not ok or frame is None:
            continue
        height, width = frame.shape[:2]
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = cascade.detectMultiScale(gray, scaleFactor=1.12, minNeighbors=5, minSize=(50, 50))
        detections = list(faces)
        detection_kind = "face"
        if len(detections) == 0 and has_body_detector:
            bodies = upperbody.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=4, minSize=(70, 90))
            detections = list(bodies)
            detection_kind = "body"
            if len(detections) > 0:
                body_hits += 1
        if len(detections) == 0:
            continue
        normalized = []
        for x, y, w, h in detections:
            area = (w * h) / max(width * height, 1)
            center_x = (x + w / 2) / max(width, 1)
            center_y = (y + h / 2) / max(height, 1)
            if area < 0.002:
                continue
            normalized.append({"x": center_x, "y": center_y, "w": w / max(width, 1), "h": h / max(height, 1), "area": area, "kind": detection_kind})
        if not normalized:
            continue
        normalized = sorted(normalized, key=lambda item: item["area"], reverse=True)[:4]
        face_counts.append(len(normalized))
        group_min = min(face["x"] for face in normalized)
        group_max = max(face["x"] for face in normalized)
        group_span = group_max - group_min
        spans.append(group_span)
        group_center = sum(face["x"] * face["area"] for face in normalized) / max(sum(face["area"] for face in normalized), 0.001)
        if len(normalized) >= 2:
            by_x = sorted(normalized, key=lambda item: item["x"])
            left_points.append(max(0.08, min(0.92, by_x[0]["x"])))
            right_points.append(max(0.08, min(0.92, by_x[-1]["x"])))

        scored = []
        for face in normalized:
            movement = 0.0
            if previous_active is not None:
                movement = min(1.0, abs(face["x"] - previous_active["x"]) * 4.0 + abs(face["area"] - previous_active["area"]) * 12.0)
            center_bias = 1.0 - min(1.0, abs(face["x"] - 0.5) * 1.6)
            score = face["area"] * 95.0 + movement * 0.22 + center_bias * 0.12
            scored.append((score, face))
        active = max(scored, key=lambda item: item[0])[1]
        previous_active = active

        if len(normalized) >= 2:
            if group_span <= 0.42:
                focus = group_center
                mode = "conversation-group"
            else:
                focus = active["x"] * 0.68 + group_center * 0.32
                mode = "speaker-priority"
        else:
            focus = active["x"]
            mode = "single-speaker"
        centers.append(max(0.12, min(0.88, focus)))
        mode_counts[mode] = mode_counts.get(mode, 0) + 1
        try:
            del frame
            del gray
            del faces
            if "bodies" in locals():
                del bodies
        except Exception:
            pass
    capture.release()
    gc.collect()
    if not centers:
        return None
    smoothed_points = smooth_focus_points(centers)
    focus_x = max(0.16, min(0.84, sum(smoothed_points) / len(smoothed_points)))
    jitter = max(smoothed_points) - min(smoothed_points) if len(smoothed_points) > 1 else 0.0
    dominant_mode = max(mode_counts.items(), key=lambda item: item[1])[0] if mode_counts else "single-speaker"
    max_faces = max(face_counts) if face_counts else 1
    average_faces = sum(face_counts) / len(face_counts) if face_counts else 1.0
    average_span = sum(spans) / len(spans) if spans else 0.0
    zoom = 1.018 if average_faces >= 2 else 1.04
    if jitter > 0.22:
        zoom = max(1.018, zoom - 0.012)
    keyframes = calm_camera_keyframes(smoothed_points, duration)
    left_focus = sum(smooth_focus_points(left_points)) / len(left_points) if left_points else max(0.16, focus_x - 0.18)
    right_focus = sum(smooth_focus_points(right_points)) / len(right_points) if right_points else min(0.84, focus_x + 0.18)
    speaker_context = speaker_timeline_context(transcript, moment)
    forced_split = str((moment or {}).get("layout") or "").lower() == "split"
    split_screen = forced_split or (
        float(duration or 0) >= 12
        and max_faces >= 2
        and average_faces >= 1.65
        and average_span >= 0.44
        and jitter <= 0.28
        and speaker_context.get("overlap_seconds", 0.0) > 1.0
    )
    body_tracking = body_hits > 0 and body_hits >= max(1, len(centers) // 4)
    camera_layout = None
    camera_score = 0
    camera_director = []
    if CameraEngine is not None:
        try:
            camera = CameraEngine()
            speaker_count = speaker_context.get("speaker_count") or max(1, max_faces)
            speakers = [
                {"speaker": label, "zone": ["LEFT", "CENTER", "RIGHT"][index % 3]}
                for index, label in enumerate(speaker_context.get("speakers") or [f"S{i + 1}" for i in range(speaker_count)])
            ]
            scene_context = {
                "face_count": max_faces,
                "speaker_count": speaker_count,
                "body_tracking": body_tracking,
                "split_screen": split_screen,
                "average_span": average_span,
                "overlap_seconds": speaker_context.get("overlap_seconds", 0.0),
                "emotion": speaker_context.get("emotion", 0.0),
                "stability": bounded_score(100 - jitter * 220, 35, 99),
                "variation_seed": int(variation_index or 0) + int(float(start or 0) // 30),
                "story_id": (moment or {}).get("story_id"),
                "topic": (moment or {}).get("topic"),
            }
            camera_layout = camera.select_layout(
                speakers=speakers,
                scene=scene_context,
            )
            camera_score = camera.camera_score(camera_layout)
            camera_director = camera.build_shot_sequence(
                speakers=speakers,
                scene=scene_context,
                duration=duration,
            )
        except Exception:
            camera_layout = None
            camera_score = 0
            camera_director = []
    if camera_layout is None:
        camera_layout = "SPLIT_SCREEN" if split_screen else ("FACE_TRACK" if max_faces >= 1 else ("BODY_TRACK" if body_tracking else "CENTER_CROP"))
    transition_ms = 200 if split_screen else (camera_director[0].get("transition_ms", 180) if camera_director else 180)
    return {
        "focus_x": focus_x,
        "face_count": max_faces,
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
        "speaker_timeline": speaker_context,
        "transition_ms": transition_ms,
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
        expression = ffmpeg_number(director_frames[-1]["x"], fallback_focus)
        for index in range(len(director_frames) - 2, -1, -1):
            current = director_frames[index]
            next_frame = director_frames[index + 1]
            expression = f"if(lt(t,{ffmpeg_number(next_frame['t'])}),{ffmpeg_number(current['x'])},{expression})"
        return expression

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

    expression = ffmpeg_number(clean_frames[-1]["x"], fallback_focus)
    for index in range(len(clean_frames) - 2, -1, -1):
        left = clean_frames[index]
        right = clean_frames[index + 1]
        dt = max(0.1, right["t"] - left["t"])
        slope = (right["x"] - left["x"]) / dt
        # Legacy keyframes are snapped to cuts. Continuous interpolation caused
        # the CCTV-like pan the director is designed to remove.
        expression = f"if(lt(t,{ffmpeg_number(right['t'])}),{ffmpeg_number(left['x'])},{expression})"
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
    profile_text = f"{category} {title}"
    if any(word in profile_text for word in ["gaming", "gameplay", "esports"]):
        profile = "gaming"
        contrast, brightness, saturation = 1.025, 0.002, 1.020
    elif any(word in profile_text for word in ["music", "musik", "konser", "band"]):
        profile = "music"
        contrast, brightness, saturation = 1.020, 0.002, 1.018
    elif any(word in profile_text for word in ["interview", "wawancara", "narasumber"]):
        profile = "interview"
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
    focus_analysis = focus_x if isinstance(focus_x, dict) else None
    focus_value = focus_analysis.get("focus_x") if focus_analysis else focus_x
    if dims is not None and bool_payload(payload, "smartCrop", True):
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
            zoom_factor = float(focus_analysis.get("zoom", 1.04)) if focus_analysis else 1.04
            zoom_factor = max(1.015, min(1.065, zoom_factor))
            zoom_width = int(math.ceil(width * zoom_factor / 2) * 2)
            zoom_height = int(math.ceil(height * zoom_factor / 2) * 2)
            filters.append(f"scale={zoom_width}:{zoom_height}:flags={scaler}")
            filters.append(f"crop={width}:{height}:x='(iw-ow)/2':y='(ih-oh)/2'")
    elif dims is not None:
        width, height = dims
        filters.append(f"scale={width}:{height}:force_original_aspect_ratio=decrease:flags=bicubic")
        filters.append(f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2")

    # Enhancement runs before subtitle overlay so text remains crisp and timing
    # cannot be altered by the visual filter graph.
    filters.extend(automatic_video_enhancement_filters(payload, moment))
    filters.extend(four_k_look_filters(payload, moment))

    if srt_path:
        subtitle_filter = f"subtitles=filename='{ffmpeg_filter_path(srt_path)}'"
        font_path = payload.get("subtitleFontPath")
        if font_path and Path(str(font_path)).exists():
            subtitle_filter += f":fontsdir='{ffmpeg_filter_path(Path(str(font_path)).parent)}'"
        filters.append(subtitle_filter)

    add_text_overlay_filters(filters, payload, moment)

    filters.append("setsar=1")
    return ",".join(filters)


def audio_filter(payload):
    if bool_payload(payload, "audioEnhance", False):
        return "loudnorm=I=-16:TP=-1.5:LRA=11,acompressor=threshold=-18dB:ratio=2.2:attack=8:release=90"
    return None


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


def render(payload):
    AI_DEBUG_EVENTS.clear()
    AI_USAGE.update({"input_tokens": 0, "output_tokens": 0, "requests": 0, "errors": 0})
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
        "version": "1.10.0-beta.3",
        "mode": "staged-single-clip-queue",
        "created_at": datetime.now().isoformat(),
        "performance_mode": payload.get("performanceMode") or "Balanced",
        "quality_profile": payload.get("outputQualityProfile") or "balanced",
        "target_format": payload.get("formatProfile") or "9:16 YouTube Shorts",
        "target_resolution": payload.get("resolutionProfile") or "1080p",
        "target_fps": payload.get("fpsProfile") or "Same as source",
        "video_bitrate": payload.get("renderVideoBitrate") or "",
        "audio_bitrate": payload.get("renderAudioBitrate") or "160k",
        "cpu_threads": cpu_thread_count(),
        "clips": [],
    }
    render_plan_path = internal_dir / "render_plan.json"
    write_json_file(render_plan_path, render_plan)

    emit("log", message="Starting clip processing...")
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
        }
        cookie_path = payload.get("cookiesPath")
        info, used_cookies = extract_info_with_cookie_retry(yt_dlp, ydl_opts, url, cookie_path, download=False)
        source, cache_dir, downloaded = ensure_source_cached(yt_dlp, info, url, payload, cookie_path)
        emit("log", stage="cache", message=f"Render memakai source cache: {source}")
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
    emit("log", message=f"Active encoder: {encoder}")

    text_overlay_available = engine.detector.supports_filter("drawtext")
    subtitle_overlay_available = engine.detector.supports_filter("subtitles") or engine.detector.supports_filter("ass")
    overlay_available = engine.detector.supports_filter("overlay")
    logo_path = resolve_logo_path(payload) if bool_payload(payload, "logoOverlay", False) else None
    warnings = []
    text_overlay_requested = (
        (bool_payload(payload, "addCaptions", False) and bool_payload(payload, "burnSubtitle", True))
        or bool_payload(payload, "addHook", False)
        or bool_payload(payload, "addWatermark", False)
        or bool_payload(payload, "creditText", False)
    )
    if ((bool_payload(payload, "addCaptions", False) and bool_payload(payload, "burnSubtitle", True)) or bool_payload(payload, "addHook", False)) and not subtitle_overlay_available:
        warnings.append("FFmpeg subtitles/ass filter tidak tersedia. Hook/caption dimatikan.")
        emit("log", stage="caption", message="FFmpeg subtitles/ass filter tidak tersedia. Hook/caption dimatikan.")
        payload["addCaptions"] = False
        payload["burnSubtitle"] = False
        payload["addHook"] = False
    if (bool_payload(payload, "addWatermark", False) or bool_payload(payload, "creditText", False)) and not text_overlay_available:
        warnings.append("FFmpeg drawtext filter tidak tersedia. Text watermark/credit dimatikan.")
        emit("log", stage="caption", message="FFmpeg drawtext filter tidak tersedia. Text watermark/credit dimatikan.")
        payload["addWatermark"] = False
        payload["creditText"] = False
    if bool_payload(payload, "logoOverlay", False):
        if not logo_path:
            warnings.append("Logo overlay aktif, tetapi file logo transparan tidak ditemukan.")
            emit("log", stage="watermark", message="Logo overlay aktif, tetapi file logo transparan tidak ditemukan.")
        elif not overlay_available:
            warnings.append("FFmpeg overlay filter tidak tersedia. Logo overlay dimatikan.")
            emit("log", stage="watermark", message="FFmpeg overlay filter tidak tersedia. Logo overlay dimatikan.")
            logo_path = None

    for index, moment in enumerate(moments, start=1):
        start = float(moment.get("start") or 0)
        raw_duration = float(moment.get("duration") or (float(moment.get("end") or start + 30) - start))
        duration = max(1.0 if local_mode else 5.0, raw_duration)
        clip_label = moment.get("title") or moment.get("titleSuggestion") or f"clip-{index}"
        emit("log", message=f"Processing clip {index}/{len(moments)}: {clip_label}")
        if bool_payload(payload, "autoCut", False):
            adjusted_start, adjusted_duration, changed = auto_cut_from_transcript(moment, cached_transcript, min_duration=5.0)
            if changed:
                emit("log", stage="auto cut", message=f"[{index}/{len(moments)}] Auto cut {start:.2f}+{duration:.2f}s -> {adjusted_start:.2f}+{adjusted_duration:.2f}s")
                start, duration = adjusted_start, adjusted_duration
            else:
                emit("log", stage="auto cut", message=f"[{index}/{len(moments)}] Auto cut tidak mengubah batas clip")
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
        upload_title = seo_upload_title(render_moment, index, payload)
        render_moment["upload_title"] = upload_title
        clip_path = unique_creator_path(output_dirs["clip"], upload_title, ".mp4")
        clip_safe = clip_path.stem
        ass_path = output_dirs["caption"] / f"{clip_safe}.ass"
        srt_path = output_dirs["caption"] / f"{clip_safe}.srt"
        public_metadata_path = output_dirs["metadata"] / f"{clip_safe}.json"
        thumbnail_path = output_dirs["thumbnail"] / f"{clip_safe}.png"
        clip_cache_dir = render_cache_dir / f"clip_{index:03d}"
        clip_temp_dir = temp_render_dir / f"clip_{index:03d}"
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
        clip_plan_path = clip_cache_dir / "render_plan.json"
        staged_output_path = clip_temp_dir / "final.mp4"
        caption_ass_path = None
        caption_srt_path = None
        validation_fallback_stripped_enhancements = False
        clip_plan = {
            "clip_id": index,
            "title": clip_label,
            "start": round(start, 3),
            "end": round(start + duration, 3),
            "duration": round(duration, 3),
            "crop": "tracking" if bool_payload(payload, "faceTrack", False) else "smart_crop",
            "subtitle": bool_payload(payload, "addCaptions", False) and bool_payload(payload, "burnSubtitle", True),
            "hook": bool_payload(payload, "addHook", False),
            "watermark": bool_payload(payload, "addWatermark", False) or bool(logo_path),
            "video_enhancement": "auto",
            "four_k_look": True,
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
            regenerated_transcript = transcribe_clip_audio_for_subtitles(
                engine,
                source_for_clip,
                start,
                duration,
                subtitle_audio_path,
                payload,
            )
            if regenerated_transcript:
                clip_transcript = regenerated_transcript
                render_moment["transcript_segments"] = regenerated_transcript
                render_moment["caption_source"] = "audio_whisper"
                render_moment["transcript"] = clean_text(" ".join(item.get("text") or "" for item in regenerated_transcript))[:900] or render_moment.get("transcript")
                write_json_file(
                    subtitle_transcript_path,
                    {
                        "source": "audio_whisper",
                        "start": start,
                        "duration": duration,
                        "segments": regenerated_transcript,
                        "created_at": datetime.now().isoformat(),
                    },
                )
                clip_plan["caption_source"] = "audio_whisper"
                clip_plan["caption_segments"] = len(regenerated_transcript)
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
                raise RuntimeError(f"Render dihentikan karena subtitle gagal divalidasi untuk {clip_path.name}: {exc}") from exc
            warning = f"Hook ASS dilewati untuk {clip_path.name}: {exc}"
            warnings.append(warning)
            emit("log", stage="caption", message=warning)

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
            if tracking_cache_path.exists():
                try:
                    face_analysis = json.loads(tracking_cache_path.read_text(encoding="utf-8"))
                    emit("log", stage="face tracking", message=f"[{index}/{len(moments)}] Tracking cache loaded: {tracking_cache_path}")
                except Exception:
                    face_analysis = None
            else:
                face_analysis = detect_conversation_focus(
                    source_for_clip,
                    start,
                    duration,
                    moment=render_moment,
                    transcript=clip_transcript,
                    variation_index=index,
                )
                write_json_file(
                    tracking_cache_path,
                    face_analysis or {"focus_x": None, "mode": "center_fallback", "fallback": True, "reason": "face tracking unavailable"},
                )
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
            focus_x = face_analysis
            if face_analysis is None:
                emit("log", stage="face tracking", message="Face tracking fallback: wajah tidak terdeteksi/OpenCV belum tersedia, memakai smart center crop.")
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
        af = audio_filter(payload)
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
            engine.run_process(cmd, "portrait conversion", index, len(moments), duration, clip_start_progress + 4, clip_end_progress, log_path=clip_ffmpeg_log)
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
                    engine.run_process(look_cmd, "4K Look fallback", index, len(moments), duration, clip_start_progress + 4, clip_end_progress, log_path=clip_ffmpeg_log)
                except RenderError as look_exc:
                    exc = look_exc
                else:
                    warning = f"4K Look dilewati untuk clip {index} setelah filter gagal; render utama tetap dilanjutkan."
                    warnings.append(warning)
                    emit("log", stage="4k look", message=warning)
                    four_k_look_active = False
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
            if exc is not None and caption_ass_path is not None:
                warning = f"Caption/Hook overlay gagal untuk clip {index}, retry tanpa caption: {exc}"
                warnings.append(warning)
                emit("log", stage="caption", message=warning)
                safe_payload = dict(payload)
                safe_payload["addCaptions"] = False
                safe_payload["burnSubtitle"] = False
                safe_payload["addHook"] = False
                vf = build_video_filter(safe_payload, srt_path=None, focus_x=focus_x, moment=render_moment)
                if logo_path:
                    cmd = build_logo_overlay_command(engine, source_for_clip, logo_path, start, duration, render_target_path, encoder, fps_args_value, vf, af, crf, safe_payload)
                else:
                    builder = engine.builder(source_for_clip, start, duration, render_target_path, encoder, fps_args_value, filters=[vf] if vf else [], audio_filters=[af] if af else [], crf=crf, threads=cpu_thread_count(), **bitrate_settings)
                    cmd = builder.build()
                try:
                    engine.run_process(cmd, "portrait conversion caption fallback", index, len(moments), duration, clip_start_progress + 4, clip_end_progress, log_path=clip_ffmpeg_log)
                except RenderError as retry_exc:
                    exc = retry_exc
                    caption_ass_path = None
                else:
                    caption_ass_path = None
                    exc = None
            if exc is not None:
                current_index = encoder_chain.index(encoder) if encoder in encoder_chain else -1
                fallback_error = exc
                for fallback_encoder in encoder_chain[current_index + 1:]:
                    emit("log", stage="encode", message=f"Encoder {encoder} gagal: {fallback_error}. Retry memakai {fallback_encoder}.")
                    encoder = fallback_encoder
                    if logo_path:
                        cmd = build_logo_overlay_command(engine, source_for_clip, logo_path, start, duration, render_target_path, encoder, fps_args_value, vf, af, crf, payload)
                    else:
                        builder = engine.builder(source_for_clip, start, duration, render_target_path, encoder, fps_args_value, filters=[vf] if vf else [], audio_filters=[af] if af else [], crf=crf, threads=cpu_thread_count(), **bitrate_settings)
                        cmd = builder.build()
                    try:
                        engine.run_process(cmd, f"portrait conversion {fallback_encoder} fallback", index, len(moments), duration, clip_start_progress + 4, clip_end_progress, log_path=clip_ffmpeg_log)
                        fallback_error = None
                        break
                    except RenderError as fallback_exc:
                        fallback_error = fallback_exc
                if fallback_error is not None:
                    render_failed = fallback_error

        if render_failed is not None:
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
        actual_hook = bool_payload(payload, "addHook", False) and actual_caption_ass and not validation_fallback_stripped_enhancements
        actual_watermark = not validation_fallback_stripped_enhancements and (bool(logo_path) or (
            bool_payload(payload, "addWatermark", False)
            and (
                bool(payload.get("watermarkText"))
                or bool(payload.get("watermarkImagePath"))
                or bool(payload.get("watermarkPath"))
            )
        ))
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
            builder = engine.builder(source_for_clip, start, duration, clip_path, "libx264", fps_args_value, filters=[vf] if vf else [], audio_filters=[af] if af else [], crf=crf, threads=cpu_thread_count(), **bitrate_settings)
            try:
                engine.run_process(builder.build(), "safe render validation fallback", index, len(moments), duration, clip_start_progress + 4, clip_end_progress, log_path=clip_ffmpeg_log)
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
        actual_hook = bool_payload(payload, "addHook", False) and actual_caption_ass
        actual_watermark = not validation_fallback_stripped_enhancements and (bool(logo_path) or (
            bool_payload(payload, "addWatermark", False)
            and (
                bool(payload.get("watermarkText"))
                or bool(payload.get("watermarkImagePath"))
                or bool(payload.get("watermarkPath"))
            )
        ))
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
        public_metadata_path.write_text(json_dumps(public_metadata, indent=2), encoding="utf-8")
        clip_plan["status"] = "completed"
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
                "duration": duration,
                "resolution": payload.get("resolutionProfile") or "1080p",
                "sizeBytes": size_bytes,
                "hasAudio": media_probe.get("hasAudio"),
                "validated": media_probe.get("valid"),
                "ffprobe": media_probe,
                "subtitle": str(caption_ass_path) if actual_caption_ass else None,
                "subtitleSrt": str(caption_srt_path) if actual_caption_srt else None,
                "metadata": str(public_metadata_path),
                "thumbnail": str(thumbnail_output) if thumbnail_output else None,
                "youtubeTitle": public_metadata.get("youtube_title"),
                "youtubeDescription": public_metadata.get("youtube_description"),
                "youtubeTags": public_metadata.get("youtube_tags"),
                "enhancements": {
                    "smartCrop": bool_payload(payload, "smartCrop", True),
                    "dynamicZoom": bool_payload(payload, "dynamicZoom", False),
                    "faceTrack": bool_payload(payload, "faceTrack", False),
                    "autoCut": bool_payload(payload, "autoCut", False),
                    "captions": actual_caption_ass,
                    "hook": actual_hook,
                    "audioEnhance": bool_payload(payload, "audioEnhance", False),
                    "videoEnhancement": True,
                    "videoEnhancementProfile": payload.get("_videoEnhancementProfile") or "natural_podcast",
                    "fourKLook": four_k_look_active,
                    "fourKLookProfile": payload.get("_fourKLookProfile") or payload.get("_videoEnhancementProfile") or "natural_podcast",
                    "fourKLookBudget": payload.get("_fourKLookBudget") or "full",
                    "watermark": actual_watermark,
                    "logoOverlay": bool(logo_path),
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
            analyze(payload)
        elif args.mode == "render":
            render(payload)
    except Exception as exc:
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

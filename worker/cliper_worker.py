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
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

from render_engine import RenderEngine, FilenameSanitizer, default_output_folder, RenderError

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
    if obj is None or isinstance(obj, (bool, int, float)):
        return obj
    return safe_text(obj)


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
    return [encoder for encoder in ["h264_amf", "h264_nvenc", "h264_qsv", "libx264"] if encoder in text]


def classify_download_error(exc):
    text = str(exc).lower()
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


def require_yt_dlp():
    try:
        import yt_dlp

        return yt_dlp
    except Exception as exc:
        raise RuntimeError("yt-dlp belum tersedia. Install dengan: python -m pip install yt-dlp") from exc


def ai_provider_name(provider_type):
    names = {
        "openai": "OpenAI",
        "groq": "Groq",
        "ytclip": "YTClip AI",
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
    return bool(payload.get("apiKey") and payload.get("baseUrl") and payload.get("highlightModel"))


def fetch_json(url, data=None, headers=None, timeout=30):
    headers = headers or {}
    method = "GET" if data is None else "POST"
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        text = response.read().decode("utf-8", errors="replace")
        try:
            return json.loads(text)
        except Exception:
            return {"raw": text}


def call_openai_compatible(payload, prompt):
    base_url = str(payload.get("baseUrl") or "").rstrip("/")
    if not base_url:
        raise RuntimeError("Base URL AI kosong.")
    endpoint = base_url
    if not endpoint.endswith("/chat/completions"):
        endpoint = f"{endpoint}/chat/completions"
    model = str(payload.get("highlightModel") or "").strip()
    if not model:
        raise RuntimeError("Model AI kosong.")
    api_key = str(payload.get("apiKey") or "").strip()
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    data = {
        "model": model,
        "messages": [
            {"role": "system", "content": "You are a helpful assistant for YouTube Shorts content generation."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.25,
        "max_tokens": 120,
        "n": 1,
    }
    result = fetch_json(endpoint, data=data, headers=headers)
    if not isinstance(result, dict):
        raise RuntimeError("Invalid response dari AI provider.")
    if result.get("error"):
        raise RuntimeError(result.get("error", {}).get("message") or result.get("error") or "AI request gagal")
    choices = result.get("choices") or []
    if not choices:
        raise RuntimeError("AI provider tidak mengembalikan jawaban.")
    first = choices[0]
    text = ""
    if isinstance(first, dict):
        text = first.get("message", {}).get("content") or first.get("text") or ""
    else:
        text = str(first)
    usage = result.get("usage") or {}
    return {"response": str(text).strip(), "usage": usage, "raw": result}


def call_gemini(payload, prompt):
    base_url = str(payload.get("baseUrl") or "").rstrip("/")
    if not base_url:
        raise RuntimeError("Base URL AI kosong.")
    model = str(payload.get("highlightModel") or "").strip()
    if not model:
        raise RuntimeError("Model AI kosong.")
    api_key = str(payload.get("apiKey") or "").strip()
    endpoint = f"{base_url}/models/{urllib.parse.quote(model)}:generateText"
    if api_key and not api_key.startswith("Bearer "):
        endpoint = f"{endpoint}?key={urllib.parse.quote(api_key)}"
    headers = {"Content-Type": "application/json"}
    if api_key.startswith("Bearer "):
        headers["Authorization"] = api_key
    data = {
        "temperature": 0.25,
        "maxOutputTokens": 120,
        "candidateCount": 1,
        "input": {"text": prompt},
    }
    result = fetch_json(endpoint, data=data, headers=headers)
    if not isinstance(result, dict):
        raise RuntimeError("Invalid response dari Gemini.")
    if result.get("error"):
        raise RuntimeError(result.get("error", {}).get("message") or result.get("error") or "AI request gagal")
    response_text = ""
    if isinstance(result.get("candidates"), list) and result["candidates"]:
        candidate = result["candidates"][0]
        response_text = candidate.get("content", {}).get("text") or candidate.get("content") or ""
    if not response_text and result.get("output"):
        response_text = result["output"].get("generatedText") or result["output"].get("content", {}).get("text", "")
    if not response_text:
        raise RuntimeError("Gemini tidak mengembalikan konten.")
    return {"response": str(response_text).strip(), "usage": {}, "raw": result}


def provider_request(payload, prompt):
    provider_type = str(payload.get("providerType") or "openai").lower()
    provider_name = ai_provider_name(provider_type)
    emit("log", message=f"AI request sent to {provider_name}")
    if provider_type == "gemini":
        return call_gemini(payload, prompt)
    return call_openai_compatible(payload, prompt)


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


def ai_generate_title(text, payload):
    try:
        prompt = (
            f"Buat judul video singkat yang menarik untuk segmen berikut, gunakan gaya {payload.get('scoreMode') or 'viral'}:\n"
            f"{text}\n"
            "Jawab hanya dengan satu judul singkat."
        )
        result = provider_request(payload, prompt)
        return result
    except Exception as exc:
        emit("log", message=f"AI title generator gagal: {exc}")
        return {"ok": False, "error": str(exc)}


def ai_generate_hook(moment, payload):
    try:
        prompt = (
            f"Buat hook pembuka singkat untuk YouTube Shorts berdasarkan segmen berikut:\n"
            f"{moment.get('transcript') or moment.get('title') or ''}\n"
            "Jawab hanya dengan satu kalimat hook yang memancing penasaran."
        )
        return provider_request(payload, prompt)
    except Exception as exc:
        emit("log", message=f"AI hook generator gagal: {exc}")
        return {"ok": False, "error": str(exc)}


def ai_clean_caption(text, payload):
    try:
        prompt = (
            f"Bersihkan teks berikut agar cocok sebagai subtitle YouTube Shorts tanpa mengubah arti:\n"
            f"{text}\n"
            "Jawab dengan teks singkat yang sudah dirapikan."
        )
        return provider_request(payload, prompt)
    except Exception as exc:
        emit("log", message=f"AI caption cleanup gagal: {exc}")
        return {"ok": False, "error": str(exc)}


def test_provider_request(payload):
    try:
        prompt = "Reply only: OK"
        result = provider_request(payload, prompt)
        response = result.get("response") or "OK"
        return {
            "ok": True,
            "status": "Connected ✓",
            "provider": ai_provider_name(str(payload.get("providerType") or "openai")),
            "model": payload.get("highlightModel"),
            "response": response.strip(),
            "usage": result.get("usage") or {},
        }
    except Exception as exc:
        return {"ok": False, "status": str(exc), "error": str(exc)}


def parse_ai_refined_titles(raw_text):
    titles = parse_simple_listed_titles(raw_text)
    return [title for title in titles if title]


def revise_moments_with_ai(moments, payload):
    if not moments or payload.get("providerType") == "local" or not is_ai_enabled(payload):
        return moments
    if not (
        bool_payload(payload, "addHook", False)
        or bool_payload(payload, "addCaptions", False)
        or bool_payload(payload, "metadataToggle", False)
        or bool_payload(payload, "writeMetadata", False)
    ):
        return moments

    text_payload = "\n".join([f"Segment {idx+1}: {item.get('transcript') or item.get('title') or ''}" for idx, item in enumerate(moments[:3])])
    prompt = (
        f"Berikan judul hook yang lebih menarik untuk setiap segmen berikut sesuai gaya {payload.get('scoreMode') or 'viral'}:\n{text_payload}\n"
        "Kembalikan dalam format 1) judul, 2) judul, 3) judul."
    )
    try:
        result = provider_request(payload, prompt)
        titles = parse_ai_refined_titles(result.get("response") or "")
        if titles:
            for index, title in enumerate(titles[: len(moments[:3])]):
                moments[index]["titleSuggestion"] = title
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


def seconds_to_stamp(seconds):
    seconds = max(0, int(seconds))
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


def score_text(text, index, start, duration):
    keywords = [
        "cara",
        "kenapa",
        "rahasia",
        "penting",
        "jangan",
        "hasil",
        "tips",
        "cepat",
        "mudah",
        "masalah",
        "solusi",
        "best",
        "why",
        "how",
        "secret",
        "mistake",
        "result",
    ]
    lower = text.lower()
    keyword_score = sum(1 for keyword in keywords if keyword in lower) * 4
    length_score = min(22, len(text) / 18)
    duration_score = max(0, 18 - abs(duration - 42) * 0.45)
    position_score = 8 if start > 20 else 3
    rank_score = max(0, 12 - index * 1.5)
    return round(min(99, 48 + keyword_score + length_score + duration_score + position_score + rank_score))


def build_windows_from_transcript(segments, duration, target_count, min_duration, max_duration):
    if not segments:
        fallback = []
        step = max(max_duration, duration / max(target_count, 1))
        for index in range(target_count):
            start = min(max(0, index * step), max(0, duration - min_duration))
            end = min(duration, start + max_duration)
            fallback.append(
                {
                    "start": start,
                    "end": end,
                    "text": "Moment kandidat dibuat dari durasi video karena subtitle tidak ditemukan.",
                }
            )
        return fallback

    windows = []
    total = len(segments)
    for left in range(total):
        start = segments[left]["start"]
        text_parts = []
        end = start
        for right in range(left, total):
            end = segments[right]["end"]
            text_parts.append(segments[right]["text"])
            length = end - start
            if length >= min_duration:
                windows.append({"start": start, "end": min(end, start + max_duration), "text": " ".join(text_parts)})
                break
            if length > max_duration:
                break
    return windows


def find_moments(info, transcript, payload):
    target_count = max(1, min(20, int(payload.get("clipCount") or 5)))
    min_duration, max_duration = parse_duration_target(payload.get("durationTarget"))
    duration = float(info.get("duration") or 0)
    windows = []

    for chapter in info.get("chapters") or []:
        start = float(chapter.get("start_time") or 0)
        end = float(chapter.get("end_time") or min(duration, start + max_duration))
        if end - start >= 12:
            windows.append(
                {
                    "start": start,
                    "end": min(end, start + max_duration),
                    "text": chapter.get("title") or "Chapter kandidat",
                }
            )

    windows.extend(build_windows_from_transcript(transcript, duration, target_count * 3, min_duration, max_duration))

    moments = []
    seen = set()
    for index, item in enumerate(windows):
        start = max(0, float(item["start"]))
        end = max(start + 8, float(item["end"]))
        key = round(start / 5) * 5
        if key in seen:
            continue
        seen.add(key)
        text = clean_text(item.get("text") or "")
        score = score_text(text, len(moments), start, end - start)
        moments.append(
            {
                "id": len(moments) + 1,
                "title": make_title(text, len(moments) + 1),
                "start": round(start, 2),
                "end": round(end, 2),
                "duration": round(end - start, 2),
                "time": f"{seconds_to_stamp(start)} - {seconds_to_stamp(end)}",
                "score": score,
                "type": classify_text(text),
                "transcript": text[:420] or "Tidak ada transcript untuk segmen ini.",
                "titleSuggestion": make_title(text, len(moments) + 1),
            }
        )
    moments.sort(key=lambda item: item["score"], reverse=True)
    return moments[:target_count]


def make_title(text, index, payload=None):
    if payload and bool_payload(payload, "metadataToggle", False) and is_ai_enabled(payload) and index < 2:
        ai_result = ai_generate_title(text, payload)
        if ai_result.get("response"):
            return ai_result["response"][:72]
    words = clean_text(text).split()
    if len(words) >= 5:
        title = " ".join(words[:10])
        return title[:72]
    return f"Moment terbaik #{index}"


def classify_text(text):
    lower = text.lower()
    if any(word in lower for word in ["cara", "how", "tips", "step"]):
        return "Tutorial"
    if any(word in lower for word in ["kenapa", "why", "rahasia", "secret"]):
        return "Hook"
    if any(word in lower for word in ["hasil", "result", "before", "after"]):
        return "Before after"
    return "Insight"


def analyze(payload):
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
        subtitle_languages = sorted(
            set((info.get("subtitles") or {}).keys()).union(set((info.get("automatic_captions") or {}).keys()))
        )
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
    except Exception as exc:
        subtitle_language, transcript = None, []
        emit("log", message=f"Subtitle tidak bisa diambil: {exc}")

    emit("progress", stage="moments", progress=68, message="Mencari moment terbaik")
    moments = find_moments(info, transcript, payload)
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
        },
        "moments": moments,
        "dependencies": check_dependencies(),
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


def escape_drawtext(value):
    return clean_text(value).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def make_hook_text(moment, payload=None):
    default = clean_text(moment.get("title") or moment.get("titleSuggestion") or "Bagian ini penting untuk kamu lihat")
    if payload and bool_payload(payload, "addHook", False) and is_ai_enabled(payload):
        ai_result = ai_generate_hook(moment, payload)
        if ai_result.get("response"):
            return ai_result["response"]
    return default


def hook_seconds(payload):
    numbers = [int(item) for item in re.findall(r"\d+", str(payload.get("hookDuration") or "3"))]
    return max(1, min(6, numbers[0] if numbers else 3))


def select_encoder(payload):
    if bool_payload(payload, "gpuAcceleration", True):
        available = available_h264_encoders()
        for encoder in ["h264_amf", "h264_nvenc", "h264_qsv"]:
            if encoder in available:
                return encoder, "balanced"
    return "libx264", "veryfast"


def build_caption_file(moment, path, payload):
    text = clean_text(moment.get("transcript") or moment.get("title") or "Caption otomatis")
    if bool_payload(payload, "addCaptions", False) and is_ai_enabled(payload):
        ai_result = ai_clean_caption(text, payload)
        if ai_result.get("response"):
            text = ai_result["response"]
    chunks = re.split(r"(?<=[.!?])\s+", text)
    chunks = [chunk.strip() for chunk in chunks if chunk.strip()] or [text]
    duration = max(4, float(moment.get("duration") or 20))
    lines = []
    index = 1
    if bool_payload(payload, "addHook", False):
        hook = make_hook_text(moment, payload)
        end = min(duration, hook_seconds(payload))
        lines.append(f"{index}\n{srt_time(0)} --> {srt_time(end)}\n{hook}\n")
        index += 1
    start_offset = min(duration - 0.5, hook_seconds(payload) if bool_payload(payload, "addHook", False) else 0)
    usable = max(1, duration - start_offset)
    slice_len = usable / len(chunks)
    for chunk_index, chunk in enumerate(chunks):
        start = start_offset + chunk_index * slice_len
        end = min(duration, start_offset + (chunk_index + 1) * slice_len)
        lines.append(f"{index}\n{srt_time(start)} --> {srt_time(end)}\n{chunk}\n")
        index += 1
    Path(path).write_text("\n".join(lines), encoding="utf-8")


def detect_face_focus(video_path, start, duration):
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

    centers = []
    sample_count = 12
    for index in range(sample_count):
        position = (float(start) + (float(duration) * (index + 0.5) / sample_count)) * 1000
        capture.set(cv2.CAP_PROP_POS_MSEC, position)
        ok, frame = capture.read()
        if not ok or frame is None:
            continue
        height, width = frame.shape[:2]
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = cascade.detectMultiScale(gray, scaleFactor=1.12, minNeighbors=5, minSize=(50, 50))
        if len(faces) == 0:
            continue
        x, y, w, h = max(faces, key=lambda item: item[2] * item[3])
        centers.append((x + w / 2) / max(width, 1))
    capture.release()
    if not centers:
        return None
    smoothed = centers[0]
    for center in centers[1:]:
        smoothed = smoothed * 0.72 + center * 0.28
    return max(0.18, min(0.82, smoothed))


def build_video_filter(payload, srt_path=None, focus_x=None, moment=None):
    dims = output_dimensions(payload.get("formatProfile"), payload.get("resolutionProfile"))
    filters = []
    if dims is not None and bool_payload(payload, "smartCrop", True):
        width, height = dims
        scaler = "lanczos" if "lanczos" in str(payload.get("upscaleMethod") or "").lower() else "bicubic"
        x_expr = "(iw-ow)/2"
        if focus_x is not None:
            x_expr = f"min(max((iw-ow)*{focus_x:.3f},0),iw-ow)"
        filters.append(f"scale={width}:{height}:force_original_aspect_ratio=increase:flags={scaler}")
        filters.append(f"crop={width}:{height}:{x_expr}:(ih-oh)/2")
        if bool_payload(payload, "dynamicZoom", False):
            filters.append(
                f"crop=w=iw/(1+0.045*sin(2*PI*t/5.5)):h=ih/(1+0.045*sin(2*PI*t/5.5)):x=(iw-ow)/2:y=(ih-oh)/2"
            )
            filters.append(f"scale={width}:{height}:flags={scaler}")
    elif dims is not None:
        width, height = dims
        filters.append(f"scale={width}:{height}:force_original_aspect_ratio=decrease:flags=bicubic")
        filters.append(f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2")

    if bool_payload(payload, "colorEnhance", False):
        filters.append("eq=contrast=1.04:brightness=0.01:saturation=1.06")
        filters.append("unsharp=5:5:0.35")

    should_burn_captions = bool_payload(payload, "addCaptions", False) and bool_payload(payload, "burnSubtitle", True)
    if srt_path and (should_burn_captions or bool_payload(payload, "addHook", False)):
        style = "Fontsize=15,PrimaryColour=&H00FFFFFF&,OutlineColour=&H00000000&,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=110"
        filters.append(f"subtitles=filename='{ffmpeg_filter_path(srt_path)}':force_style='{style}'")

    if bool_payload(payload, "addWatermark", False) and payload.get("watermarkText"):
        text = escape_drawtext(payload.get("watermarkText"))
        opacity = max(0.1, min(1.0, float(payload.get("watermarkOpacity") or 68) / 100))
        filters.append(f"drawtext=text='{text}':x=w-tw-36:y=36:fontsize=26:fontcolor=white@{opacity:.2f}:box=1:boxcolor=black@0.28:boxborderw=12")

    if bool_payload(payload, "creditText", False):
        credit = escape_drawtext("Source: YouTube")
        filters.append(f"drawtext=text='{credit}':x=32:y=h-th-34:fontsize=18:fontcolor=white@0.72:box=1:boxcolor=black@0.20:boxborderw=8")

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
    deps = check_dependencies()
    if not deps["yt_dlp"]["ok"]:
        raise RuntimeError("yt-dlp belum tersedia.")
    if not deps["ffmpeg"]["ok"]:
        raise RuntimeError("FFmpeg belum tersedia di PATH. Install FFmpeg atau taruh ffmpeg.exe di PATH sebelum render.")

    yt_dlp = require_yt_dlp()
    url = payload.get("url")
    moments = payload.get("moments") or []
    if not url:
        raise RuntimeError("YouTube URL kosong.")
    if not moments:
        raise RuntimeError("Tidak ada moment yang dipilih.")

    ffmpeg_path = payload.get("ffmpegPath") or payload.get("ffmpeg_path")
    engine = RenderEngine(ffmpeg_path=ffmpeg_path, logger=emit)
    try:
        env = engine.detect_environment()
    except RenderError as exc:
        raise RuntimeError(f"{exc.code}: {exc}") from exc

    output_root = safe_output_folder(payload.get("outputFolder") or default_output_folder())
    project_title = payload.get("projectName") or "YT Short Clipper V2"
    safe_project = FilenameSanitizer.safe_name(project_title)
    session_name = f"{safe_project} {datetime.now().strftime('%Y-%m-%d_%H%M%S')}"
    session_dir = output_root / session_name
    internal_dir = session_dir / ".cliper-internal"
    session_dir.mkdir(parents=True, exist_ok=True)
    internal_dir.mkdir(parents=True, exist_ok=True)
    source_template = str(internal_dir / "source.%(ext)s")

    emit("progress", stage="download", progress=8, message="Download video sumber")
    ydl_opts: Any = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "format": "bv*[height<=1080]+ba/b[height<=1080]/best",
        "merge_output_format": "mp4",
        "outtmpl": source_template,
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.youtube.com/",
        },
    }
    cookie_path = payload.get("cookiesPath")
    info, used_cookies = extract_info_with_cookie_retry(yt_dlp, ydl_opts, url, cookie_path, download=True)

    source = next(internal_dir.glob("source.*"), None)
    if source is None:
        raise RuntimeError("File video sumber tidak ditemukan setelah download.")

    outputs = []
    encoder = engine.recommend_encoder(bool_payload(payload, "gpuAcceleration", True))
    if not engine.detector.has_encoder(encoder):
        emit("log", stage="encoder", message=f"Encoder {encoder} tidak tersedia, fallback ke libx264.")
        encoder = "libx264"
    emit("log", message=f"Active encoder: {encoder}")

    subtitles_available = engine.detector.supports_filter("subtitles") or engine.detector.supports_filter("ass")
    warnings = []
    if bool_payload(payload, "addCaptions", False) and bool_payload(payload, "burnSubtitle", True) and not subtitles_available:
        warnings.append("Subtitle filter tidak tersedia. Rendering tanpa burned subtitle.")
        emit("log", stage="subtitle", message="Subtitle filter tidak tersedia. Burn subtitle dimatikan.")

    for index, moment in enumerate(moments, start=1):
        start = float(moment.get("start") or 0)
        duration = max(5, float(moment.get("duration") or (float(moment.get("end") or start + 30) - start)))
        clip_label = moment.get("title") or moment.get("titleSuggestion") or f"clip-{index}"
        clip_safe = FilenameSanitizer.safe_name(f"{index:02d}-{clip_label}")
        clip_name = FilenameSanitizer.unique_name(session_dir, clip_safe, ".mp4")
        clip_path = session_dir / clip_name
        srt_path = internal_dir / f"{FilenameSanitizer.safe_name(clip_label)}.srt"
        build_caption_file(moment, srt_path, payload)

        clip_start_progress = 15 + (index - 1) / len(moments) * 78
        clip_end_progress = 15 + index / len(moments) * 78
        emit(
            "progress",
            stage="prepare",
            progress=round(clip_start_progress, 2),
            message=f"Prepare clip {index}/{len(moments)}",
            clipIndex=index,
            totalClips=len(moments),
        )

        focus_x = None
        if bool_payload(payload, "faceTrack", False):
            emit(
                "progress",
                stage="face tracking",
                progress=round(clip_start_progress + 1, 2),
                message=f"Face tracking clip {index}/{len(moments)}",
                clipIndex=index,
                totalClips=len(moments),
            )
            focus_x = detect_face_focus(source, start, duration)
            if focus_x is None:
                emit("log", stage="face tracking", message="Face tracking fallback: wajah tidak terdeteksi/OpenCV belum tersedia, memakai smart center crop.")
            else:
                emit("log", stage="face tracking", message=f"Face focus computed: x={focus_x:.3f}")
        else:
            emit("log", stage="face tracking", message=f"[{index}/{len(moments)}] Face tracking skipped (disabled)")

        should_use_srt = subtitles_available and (
            bool_payload(payload, "addHook", False)
            or (bool_payload(payload, "addCaptions", False) and bool_payload(payload, "burnSubtitle", True))
        )
        vf = build_video_filter(payload, srt_path=srt_path if should_use_srt else None, focus_x=focus_x, moment=moment)
        af = audio_filter(payload)
        crf = str(payload.get("crfProfile") or "23")

        builder = engine.builder(source, start, duration, clip_path, encoder, fps_args(payload), filters=[vf] if vf else [], audio_filters=[af] if af else [])
        cmd = builder.build()

        try:
            engine.run_process(cmd, "encode", index, len(moments), duration, clip_start_progress + 4, clip_end_progress)
        except RenderError as exc:
            if encoder != "libx264":
                emit("log", stage="encode", message=f"GPU encoder gagal: {exc}. Retry otomatis memakai CPU libx264.")
                encoder = "libx264"
                builder = engine.builder(source, start, duration, clip_path, encoder, fps_args(payload), filters=[vf] if vf else [], audio_filters=[af] if af else [])
                cmd = builder.build()
                engine.run_process(cmd, "encode cpu fallback", index, len(moments), duration, clip_start_progress + 4, clip_end_progress)
            else:
                raise

        metadata_path = internal_dir / f"{clip_safe}.json"
        metadata_path.write_text(json.dumps(moment, ensure_ascii=False, indent=2), encoding="utf-8")
        size_bytes = clip_path.stat().st_size if clip_path.exists() else 0
        outputs.append(
            {
                "video": str(clip_path),
                "title": moment.get("title"),
                "time": moment.get("time"),
                "duration": duration,
                "resolution": payload.get("resolutionProfile") or "1080p",
                "sizeBytes": size_bytes,
                "enhancements": {
                    "smartCrop": bool_payload(payload, "smartCrop", True),
                    "dynamicZoom": bool_payload(payload, "dynamicZoom", False),
                    "faceTrack": bool_payload(payload, "faceTrack", False),
                    "captions": bool_payload(payload, "addCaptions", False) and bool_payload(payload, "burnSubtitle", True) and subtitles_available,
                    "hook": bool_payload(payload, "addHook", False),
                    "audioEnhance": bool_payload(payload, "audioEnhance", False),
                    "colorEnhance": bool_payload(payload, "colorEnhance", False),
                    "watermark": bool_payload(payload, "addWatermark", False),
                },
            }
        )

    manifest = {
        "source": url,
        "title": info.get("title"),
        "used_cookies": used_cookies,
        "encoder": encoder,
        "settings": {
            "format": payload.get("formatProfile"),
            "resolution": payload.get("resolutionProfile"),
            "fps": payload.get("fpsProfile"),
            "crf": payload.get("crfProfile"),
        },
        "created_at": datetime.now().isoformat(),
        "outputs": outputs,
        "warnings": warnings,
    }
    (internal_dir / "session.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
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
        emit("error", message=str(exc))
        sys.exit(1)


if __name__ == "__main__":
    main()

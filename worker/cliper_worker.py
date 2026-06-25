import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime
from pathlib import Path


def emit(event_type, **payload):
    print(json.dumps({"type": event_type, **payload}, ensure_ascii=False), flush=True)


def load_payload(path):
    with open(path, "r", encoding="utf-8") as handle:
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
    }
    try:
        import yt_dlp

        deps["yt_dlp"] = {"ok": True, "version": yt_dlp.version.__version__}
    except Exception as exc:
        deps["yt_dlp"]["error"] = str(exc)
    try:
        import openai

        deps["openai"] = {"ok": True, "version": getattr(openai, "__version__", "installed")}
    except Exception as exc:
        deps["openai"]["error"] = str(exc)
    return deps


def require_yt_dlp():
    try:
        import yt_dlp

        return yt_dlp
    except Exception as exc:
        raise RuntimeError("yt-dlp belum tersedia. Install dengan: python -m pip install yt-dlp") from exc


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


def make_title(text, index):
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
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
    }
    cookie_path = payload.get("cookiesPath")
    if cookie_path and Path(cookie_path).exists():
        ydl_opts["cookiefile"] = cookie_path

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

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
        },
        "moments": moments,
        "dependencies": check_dependencies(),
    }
    emit("progress", stage="done", progress=100, message="Analisa selesai")
    emit("done", result=result)


def safe_filename(value):
    value = re.sub(r"[^\w\s.-]", "", value or "clip").strip()
    value = re.sub(r"\s+", "-", value)
    return value[:80] or "clip"


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


def build_video_filter(payload):
    dims = output_dimensions(payload.get("formatProfile"), payload.get("resolutionProfile"))
    if dims is None:
        return "setsar=1"
    width, height = dims
    scaler = "lanczos" if payload.get("enableUpscale", True) else "bicubic"
    return f"scale={width}:{height}:force_original_aspect_ratio=increase:flags={scaler},crop={width}:{height},setsar=1"


def fps_args(payload):
    value = str(payload.get("fpsProfile") or "").lower()
    if "30" in value:
        return ["-r", "30"]
    if "60" in value:
        return ["-r", "60"]
    return []


def run_command(cmd, stage):
    emit("log", message=" ".join(cmd))
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    for line in process.stdout:
        line = line.strip()
        if line:
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

    output_root = Path(payload.get("outputFolder") or Path.cwd() / "cliper_outputs")
    session_name = datetime.now().strftime("session-%Y%m%d-%H%M%S")
    session_dir = output_root / session_name
    internal_dir = session_dir / ".cliper-internal"
    session_dir.mkdir(parents=True, exist_ok=True)
    internal_dir.mkdir(parents=True, exist_ok=True)
    source_template = str(internal_dir / "source.%(ext)s")

    emit("progress", stage="download", progress=8, message="Download video sumber")
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "format": "bv*[height<=1080]+ba/b[height<=1080]/best",
        "merge_output_format": "mp4",
        "outtmpl": source_template,
    }
    cookie_path = payload.get("cookiesPath")
    if cookie_path and Path(cookie_path).exists():
        ydl_opts["cookiefile"] = cookie_path
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)

    source = next(internal_dir.glob("source.*"), None)
    if source is None:
        raise RuntimeError("File video sumber tidak ditemukan setelah download.")

    outputs = []
    for index, moment in enumerate(moments, start=1):
        start = float(moment.get("start") or 0)
        duration = max(5, float(moment.get("duration") or (float(moment.get("end") or start + 30) - start)))
        clip_name = f"{index:02d}-{safe_filename(moment.get('title') or moment.get('titleSuggestion'))}"
        clip_path = session_dir / f"{clip_name}.mp4"
        srt_path = internal_dir / f"{clip_name}.srt"
        write_srt(moment, srt_path)
        emit("progress", stage="render", progress=round(15 + (index - 1) / len(moments) * 78), message=f"Render clip {index}/{len(moments)}")

        vf = build_video_filter(payload)
        crf = str(payload.get("crfProfile") or "23")
        cmd = [
            "ffmpeg",
            "-y",
            "-ss",
            str(start),
            "-t",
            str(duration),
            "-i",
            str(source),
            "-vf",
            vf,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            crf,
            *fps_args(payload),
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            str(clip_path),
        ]
        run_command(cmd, "render")
        metadata_path = internal_dir / f"{clip_name}.json"
        metadata_path.write_text(json.dumps(moment, ensure_ascii=False, indent=2), encoding="utf-8")
        outputs.append(
            {
                "video": str(clip_path),
                "title": moment.get("title"),
                "time": moment.get("time"),
                "duration": duration,
                "resolution": payload.get("resolutionProfile") or "1080p",
            }
        )

    manifest = {
        "source": url,
        "title": info.get("title"),
        "created_at": datetime.now().isoformat(),
        "outputs": outputs,
    }
    (internal_dir / "session.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    emit("progress", stage="done", progress=100, message="Render selesai")
    emit("done", result={"sessionDir": str(session_dir), "outputs": outputs, "manifest": manifest})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", required=True, choices=["check", "analyze", "render"])
    parser.add_argument("--payload", required=True)
    args = parser.parse_args()
    payload = load_payload(args.payload)
    try:
        if args.mode == "check":
            emit("done", result=check_dependencies())
        elif args.mode == "analyze":
            analyze(payload)
        elif args.mode == "render":
            render(payload)
    except Exception as exc:
        emit("error", message=str(exc))
        sys.exit(1)


if __name__ == "__main__":
    main()

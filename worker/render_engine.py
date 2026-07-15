import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path


def json_safe(value):
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [json_safe(item) for item in value]
    if isinstance(value, Path):
        return str(value)
    if hasattr(value, "item"):
        try:
            return json_safe(value.item())
        except Exception:
            pass
    if hasattr(value, "tolist"):
        try:
            return json_safe(value.tolist())
        except Exception:
            pass
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    return str(value)


def json_dumps(value, **kwargs):
    return json.dumps(json_safe(value), ensure_ascii=False, **kwargs)


class RenderError(Exception):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


class FilenameSanitizer:
    INVALID_CHARS = re.compile(r"[\\/:*?\"<>|\x00-\x1f]")
    EMOJI = re.compile(
        r"[\U00010000-\U0010FFFF]",
        flags=re.UNICODE,
    )

    @classmethod
    def safe_name(cls, value, max_length=80):
        if not value:
            value = "clip_001"
        value = str(value)
        value = value.strip()
        value = cls.EMOJI.sub("", value)
        value = cls.INVALID_CHARS.sub("", value)
        value = re.sub(r"\s+", " ", value)
        value = re.sub(r"[.]{2,}", ".", value)
        value = value.strip(" ._-")
        if len(value) > max_length:
            value = value[:max_length].rstrip()
        if not value:
            value = "clip_001"
        return value

    @classmethod
    def unique_name(cls, folder, base_name, extension=".mp4"):
        base_name = cls.safe_name(base_name)
        if not base_name:
            base_name = "clip_001"
        candidate = f"{base_name}{extension}"
        count = 1
        while (Path(folder) / candidate).exists():
            candidate = f"{base_name}_{count:03d}{extension}"
            count += 1
        return candidate


class FFmpegDetector:
    def __init__(self, ffmpeg_path=None):
        self.explicit_path = str(ffmpeg_path).strip() if ffmpeg_path else None
        self.ffmpeg_path = None
        self.details = {
            "version": None,
            "filters": [],
            "encoders": [],
            "hwaccels": [],
            "supports_subtitles": False,
            "supports_ass": False,
            "supports_drawtext": False,
        }

    def resolve(self):
        if self.explicit_path:
            explicit = Path(self.explicit_path)
            if explicit.exists() and os.access(explicit, os.X_OK):
                return str(explicit)
        system = shutil.which("ffmpeg") or shutil.which("ffmpeg.exe")
        if system:
            return system
        return None

    def _run(self, args, timeout=15):
        process = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
        return process.returncode, process.stdout

    def probe(self):
        ffmpeg = self.resolve()
        if not ffmpeg:
            raise RenderError("RENDER001", "FFmpeg tidak ditemukan.")
        self.ffmpeg_path = ffmpeg
        code, version_text = self._run([ffmpeg, "-version"])
        if code != 0:
            raise RenderError("RENDER001", "Gagal menjalankan ffmpeg -version.")
        self.details["version"] = version_text.splitlines()[0] if version_text else "unknown"

        _, filters_text = self._run([ffmpeg, "-filters"])
        self.details["filters"] = [line.split()[1] for line in filters_text.splitlines() if line and not line.startswith("--") and len(line.split()) > 1]
        self.details["supports_subtitles"] = any(name in self.details["filters"] for name in ["subtitles", "ass", "overlay"])
        self.details["supports_ass"] = "ass" in self.details["filters"]
        self.details["supports_drawtext"] = "drawtext" in self.details["filters"]

        _, encoders_text = self._run([ffmpeg, "-encoders"])
        self.details["encoders"] = [token for token in re.findall(r"\b([a-z0-9_]+)\b", encoders_text.lower())]

        _, hwaccels_text = self._run([ffmpeg, "-hwaccels"])
        self.details["hwaccels"] = [line.strip() for line in hwaccels_text.splitlines() if line.strip()]

        return self.details

    def has_encoder(self, encoder_name):
        return encoder_name.lower() in self.details["encoders"]

    def supports_filter(self, filter_name):
        return filter_name.lower() in self.details["filters"]


class GPUDetector:
    PREFERRED = ["h264_nvenc", "h264_amf", "h264_qsv"]

    @staticmethod
    def recommend(encoders):
        for candidate in GPUDetector.PREFERRED:
            if candidate in encoders:
                return candidate
        return "libx264"

    @staticmethod
    def is_gpu_encoder(encoder_name):
        return encoder_name in {"h264_nvenc", "h264_amf", "h264_qsv", "hevc_nvenc"}


class FFmpegCommandBuilder:
    def __init__(self, ffmpeg_path):
        self.cmd = [ffmpeg_path, "-y"]
        self.video_filters = []
        self.audio_filters = []
        self.output = None
        self.extra = []

    def add_input(self, path):
        self.cmd.extend(["-i", str(path)])
        return self

    def cut(self, start, duration):
        self.cmd = [self.cmd[0], "-y", "-ss", str(start), "-t", str(duration)] + self.cmd[2:]
        return self

    def add_video_filters(self, filters):
        if filters:
            self.video_filters.extend(filters)
        return self

    def add_audio_filters(self, filters):
        if filters:
            self.audio_filters.extend(filters)
        return self

    def set_encoder(self, encoder, preset=None, crf=None, threads=None, video_bitrate=None, maxrate=None, bufsize=None):
        self.cmd.extend(["-c:v", encoder])
        if encoder == "libx264" and preset:
            self.cmd.extend(["-preset", preset])
        if encoder == "libx264" and crf is not None:
            self.cmd.extend(["-crf", str(crf)])
        if encoder == "libx264" and threads:
            self.cmd.extend(["-threads", str(threads)])
        if encoder != "libx264":
            self.cmd.extend(["-quality", "balanced", "-b:v", str(video_bitrate or "8M")])
        elif video_bitrate:
            self.cmd.extend(["-b:v", str(video_bitrate)])
        if maxrate:
            self.cmd.extend(["-maxrate", str(maxrate)])
        if bufsize:
            self.cmd.extend(["-bufsize", str(bufsize)])
        return self

    def set_audio(self, codec="aac", bitrate="160k"):
        self.cmd.extend(["-c:a", codec, "-b:a", bitrate])
        return self

    def add_fps(self, fps_args):
        if fps_args:
            self.cmd.extend(fps_args)
        return self

    def set_output(self, output_path):
        self.output = str(output_path)
        return self

    def add_extra(self, args):
        if args:
            self.extra.extend(args)
        return self

    def build(self):
        if not self.output:
            raise RenderError("RENDER008", "Output file belum diatur pada builder FFmpeg.")
        if self.video_filters:
            self.cmd.extend(["-vf", ",".join(self.video_filters)])
        if self.audio_filters:
            self.cmd.extend(["-af", ",".join(self.audio_filters)])
        self.cmd.extend(self.extra)
        self.cmd.append(self.output)
        return self.cmd

    @staticmethod
    def _escape_path(path_value):
        return str(path_value).replace("'", "\\'").replace("\\", "/")


class RenderEngine:
    def __init__(self, ffmpeg_path=None, logger=None):
        self.logger = logger or (lambda *args, **kwargs: None)
        self.detector = FFmpegDetector(ffmpeg_path)
        self.ffmpeg_path = None
        self.probe_result = {}

    def log(self, **payload):
        self.logger("log", **payload)

    def progress(self, **payload):
        self.logger("progress", **payload)

    def error(self, **payload):
        self.logger("error", **payload)

    def detect_environment(self):
        details = self.detector.probe()
        self.ffmpeg_path = self.detector.ffmpeg_path
        self.probe_result = details
        return details

    def recommend_encoder(self, use_gpu=True):
        if use_gpu:
            return GPUDetector.recommend(self.probe_result.get("encoders", []))
        return "libx264"

    def builder(self, source, start, duration, output_path, encoder, fps_args=None, filters=None, audio_filters=None, crf=None, threads=None, video_bitrate=None, maxrate=None, bufsize=None, audio_bitrate=None):
        builder = FFmpegCommandBuilder(self.ffmpeg_path)
        builder.add_input(source)
        builder.cut(start, duration)
        builder.add_video_filters(filters or [])
        builder.add_audio_filters(audio_filters or [])
        builder.set_encoder(encoder, preset="veryfast", crf=crf, threads=threads, video_bitrate=video_bitrate, maxrate=maxrate, bufsize=bufsize)
        builder.set_audio(bitrate=audio_bitrate or "160k")
        builder.add_fps(fps_args or [])
        builder.add_extra([
            "-map", "0:v:0", "-map", "0:a?",
            "-pix_fmt", "yuv420p",
            "-colorspace", "bt709",
            "-color_primaries", "bt709",
            "-color_trc", "bt709",
            "-color_range", "tv",
            "-movflags", "+faststart",
        ])
        builder.set_output(output_path)
        return builder

    def build_temp_session(self, root, project_name):
        project_name = FilenameSanitizer.safe_name(project_name or "YT Short Clipper V2")
        folder = Path(root) / f"{project_name} {datetime.now().strftime('%Y-%m-%d')}"
        folder.mkdir(parents=True, exist_ok=True)
        return folder

    def write_log(self, session_dir, manifest, metadata=None, errors=None, warnings=None):
        log_path = Path(session_dir) / "render-log.json"
        requested = int(manifest.get("requested_clip_count") or 0)
        valid = int(manifest.get("valid_mp4_count") or 0)
        failed = int(manifest.get("failed_count") or max(0, requested - valid))
        warnings = warnings or manifest.get("warnings") or []
        errors = errors or []
        status = manifest.get("status") or ("Completed" if failed == 0 and not errors else "Completed with Warning")
        standard_outputs = []
        for item in manifest.get("outputs") or []:
            probe = item.get("ffprobe") or {}
            standard_outputs.append(
                {
                    "title": item.get("title") or "",
                    "mp4": item.get("video") or item.get("mp4") or "",
                    "ass": item.get("subtitle") or item.get("ass") or "",
                    "srt": item.get("subtitleSrt") or item.get("srt") or "",
                    "json": item.get("metadata") or item.get("json") or "",
                    "xml": item.get("xml") or "",
                    "thumbnail": item.get("thumbnail") or "",
                    "ffprobe": {
                        "has_video": bool(probe.get("hasVideo", item.get("validated"))),
                        "has_audio": bool(probe.get("hasAudio", item.get("hasAudio"))),
                        "duration": float(probe.get("duration") or item.get("duration") or 0),
                    },
                }
            )
        info = {
            "session_id": Path(session_dir).name,
            "requested_count": requested,
            "candidate_count": int(manifest.get("candidate_count") or requested),
            "rendered_count": int(manifest.get("rendered_count") or len(manifest.get("outputs") or [])),
            "valid_mp4_count": valid,
            "failed_count": failed,
            "status": status,
            "ai": {
                "enabled": bool(manifest.get("ai_enabled")),
                "provider": manifest.get("ai_provider") or "",
                "model": (manifest.get("settings") or {}).get("model") or manifest.get("ai_model") or "",
                "fallback_used": bool(manifest.get("fallback_used")),
                "warnings": [item for item in warnings if "ai" in str(item).lower() or "fallback" in str(item).lower()],
            },
            "outputs": standard_outputs,
            "warnings": warnings,
            "errors": errors,
            "created_at": datetime.now().isoformat(),
            "manifest": manifest,
            "metadata": metadata or {},
        }
        Path(log_path).write_text(json_dumps(info, indent=2), encoding="utf-8")
        legacy_path = Path(session_dir) / "render.log"
        try:
            legacy_path.write_text(json_dumps(info, indent=2), encoding="utf-8")
        except Exception:
            pass
        return str(log_path)

    def run_process(self, cmd, stage, clip_index, total_clips, duration, progress_start, progress_end, log_path=None):
        self.log(message="Running command: " + " ".join(cmd))
        started = time.time()
        log_file = None
        if log_path:
            log_path = Path(log_path)
            log_path.parent.mkdir(parents=True, exist_ok=True)
            log_file = log_path.open("a", encoding="utf-8", errors="replace")
            log_file.write(f"\n[{datetime.now().isoformat()}] STAGE={stage}\n")
            log_file.write("COMMAND=" + " ".join(cmd) + "\n")
        process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
        last_emit = 0
        try:
            for raw in process.stdout:
                line = raw.strip()
                if log_file and line:
                    log_file.write(line + "\n")
                if not line:
                    continue
                if "time=" in line:
                    current_match = re.search(r"time=(\d+:\d+:\d+(?:\.\d+)?)", line)
                    fps_match = re.search(r"fps=\s*([0-9.]+)", line)
                    speed_match = re.search(r"speed=\s*([0-9.]+x)", line)
                    current = self._parse_time(current_match.group(1)) if current_match else 0.0
                    ratio = max(0.0, min(1.0, current / max(float(duration), 1.0)))
                    now = time.time()
                    if now - last_emit > 0.8 or ratio >= 0.99:
                        elapsed = now - started
                        self.progress(
                            stage=stage,
                            progress=round(progress_start + (progress_end - progress_start) * ratio, 2),
                            clipIndex=clip_index,
                            totalClips=total_clips,
                            elapsed=round(elapsed, 1),
                            eta=round((elapsed / ratio - elapsed), 1) if ratio > 0.03 else None,
                            fps=fps_match.group(1) if fps_match else None,
                            speed=speed_match.group(1) if speed_match else None,
                            message=f"Clip {clip_index}/{total_clips} {stage}",
                        )
                        last_emit = now
                if "error" in line.lower():
                    self.log(stage=stage, message=line)
            code = process.wait()
            if log_file:
                log_file.write(f"EXIT_CODE={code}\n")
            if code != 0:
                raise RenderError("RENDER008", f"FFmpeg command gagal dengan kode {code}: {' '.join(cmd[:3])}")
        finally:
            if log_file:
                log_file.close()

    @staticmethod
    def _parse_time(value):
        parts = value.split(":")
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
        return 0.0


def default_output_folder():
    home = Path.home()
    return str(home / "Videos" / "Cliper Studio Plus")

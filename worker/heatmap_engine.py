"""YouTube Most Replayed evidence for story-aware highlight ranking.

This module intentionally does not cut clips around raw heatmap peaks. It
normalizes engagement markers, keeps meaningful local maxima, and binds those
peaks to transcript/story boundaries so the editorial pipeline retains setup
and payoff.
"""

from __future__ import annotations

import json
import math
import statistics
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any


SCHEMA = "cliper.youtube-heatmap.v1"
SOURCE = "youtube_most_replayed"
WATCH_PAGE_MARKER_KEYS = (
    '"markers"',
    '"heatMarkers"',
    '"heatmapMarkers"',
    '"heatmap"',
    '"heatmapRenderer"',
    '"heatMarkerRenderer"',
)


def _finite_number(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def extract_youtube_video_id(url: str) -> str:
    """Return a conservative YouTube video id or an empty string."""
    try:
        parsed = urllib.parse.urlparse(str(url or "").strip())
    except ValueError:
        return ""
    host = (parsed.hostname or "").lower().removeprefix("www.")
    candidate = ""
    if host == "youtu.be":
        candidate = parsed.path.strip("/").split("/")[0]
    elif host in {"youtube.com", "m.youtube.com", "music.youtube.com"}:
        if parsed.path == "/watch":
            candidate = urllib.parse.parse_qs(parsed.query).get("v", [""])[0]
        elif parsed.path.startswith(("/shorts/", "/live/", "/embed/")):
            parts = [part for part in parsed.path.split("/") if part]
            candidate = parts[1] if len(parts) > 1 else ""
    if 6 <= len(candidate) <= 20 and all(char.isalnum() or char in "_-" for char in candidate):
        return candidate
    return ""


def _walk_heat_markers(value: Any):
    if isinstance(value, dict):
        renderer = value.get("heatMarkerRenderer")
        if isinstance(renderer, dict):
            yield renderer
        elif (
            {"start_time", "end_time", "value"}.issubset(value)
            or {"start", "end", "score"}.issubset(value)
            or {"startMillis", "durationMillis", "intensityScoreNormalized"}.issubset(value)
        ):
            yield value
        for nested in value.values():
            yield from _walk_heat_markers(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from _walk_heat_markers(nested)


def _marker_from_value(value: dict[str, Any]) -> dict[str, Any] | None:
    if "start" in value and "score" in value:
        start = _finite_number(value.get("start"), -1.0)
        end = _finite_number(value.get("end"), start)
        score = _finite_number(value.get("score"), -1.0)
    elif "startMillis" in value:
        start = _finite_number(value.get("startMillis"), -1000.0) / 1000.0
        duration = _finite_number(value.get("durationMillis"), 0.0) / 1000.0
        end = start + max(0.0, duration)
        score = _finite_number(value.get("intensityScoreNormalized"), -1.0)
    elif "start_time" in value:
        start = _finite_number(value.get("start_time"), -1.0)
        end = _finite_number(value.get("end_time"), start)
        score = _finite_number(value.get("value"), -1.0)
    else:
        start = _finite_number(value.get("timeRangeStartMillis"), -1000.0) / 1000.0
        duration = _finite_number(value.get("markerDurationMillis"), 0.0) / 1000.0
        end = start + max(0.0, duration)
        score = _finite_number(value.get("heatMarkerIntensityScoreNormalized"), -1.0)
    if start < 0 or end <= start or score < 0:
        return None
    return {
        "start": round(start, 3),
        "end": round(end, 3),
        "peak_time": round(start + ((end - start) / 2.0), 3),
        "score": round(max(0.0, min(1.0, score)), 6),
        "source": SOURCE,
    }


def normalize_heatmap_markers(value: Any) -> list[dict[str, Any]]:
    """Normalize yt-dlp or YouTube renderer markers into one stable schema."""
    markers = []
    seen = set()
    for raw in _walk_heat_markers(value):
        marker = _marker_from_value(raw)
        if not marker:
            continue
        key = (marker["start"], marker["end"])
        if key in seen:
            continue
        seen.add(key)
        markers.append(marker)
    return sorted(markers, key=lambda item: (item["start"], item["end"]))


def parse_watch_page_markers(html: str) -> list[dict[str, Any]]:
    """Parse known YouTube heatmap shapes embedded in a watch page.

    YouTube has changed the enclosing property name a few times while keeping
    the actual heat-marker renderer stable. Parse those envelopes and let the
    normalizer deduplicate the repeated nested copies.
    """
    decoder = json.JSONDecoder()
    parsed_values = []
    for token in WATCH_PAGE_MARKER_KEYS:
        cursor = 0
        while True:
            index = html.find(token, cursor)
            if index < 0:
                break
            value_start = index + len(token)
            while value_start < len(html) and html[value_start].isspace():
                value_start += 1
            if value_start >= len(html) or html[value_start] != ":":
                cursor = index + len(token)
                continue
            value_start += 1
            while value_start < len(html) and html[value_start].isspace():
                value_start += 1
            try:
                value, consumed = decoder.raw_decode(html[value_start:])
            except (TypeError, ValueError, json.JSONDecodeError):
                cursor = index + len(token)
                continue
            parsed_values.append(value)
            cursor = value_start + consumed
    return normalize_heatmap_markers(parsed_values)


def fetch_watch_page_markers(url: str, timeout: float = 12.0) -> list[dict[str, Any]]:
    video_id = extract_youtube_video_id(url)
    if not video_id:
        return []
    watch_url = f"https://www.youtube.com/watch?v={urllib.parse.quote(video_id)}"
    request = urllib.request.Request(
        watch_url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
            ),
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    attempts = 2
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(request, timeout=max(3.0, float(timeout))) as response:
                html = response.read().decode("utf-8", errors="replace")
            return parse_watch_page_markers(html)
        except Exception as exc:
            retryable = any(
                marker in str(exc).lower()
                for marker in ("timed out", "timeout", "handshake operation", "connection reset", "temporary failure")
            )
            if not retryable or attempt >= attempts:
                if retryable:
                    raise RuntimeError("NETWORK_TLS_TIMEOUT: YouTube Most Replayed tidak dapat diambil.") from exc
                raise
            time.sleep(attempt)
    return []


def _overlaps_ranges(start: float, end: float, ranges: list[tuple[float, float]]) -> bool:
    return any(end > range_start and start < range_end for range_start, range_end in ranges)


def filter_markers_to_ranges(
    markers: list[dict[str, Any]],
    ranges: list[tuple[float, float]] | None,
) -> list[dict[str, Any]]:
    if not ranges:
        return list(markers)
    return [
        marker
        for marker in markers
        if _overlaps_ranges(float(marker["start"]), float(marker["end"]), ranges)
    ]


def select_heatmap_peaks(
    markers: list[dict[str, Any]],
    ranges: list[tuple[float, float]] | None = None,
    min_separation_seconds: float = 12.0,
) -> list[dict[str, Any]]:
    """Keep evidence-rich local maxima without imposing a fixed clip count."""
    filtered = filter_markers_to_ranges(markers, ranges)
    if not filtered:
        return []
    scores = [float(item["score"]) for item in filtered]
    median = statistics.median(scores)
    deviations = [abs(score - median) for score in scores]
    mad = statistics.median(deviations) if deviations else 0.0
    percentile_index = max(0, min(len(scores) - 1, math.ceil(len(scores) * 0.72) - 1))
    percentile = sorted(scores)[percentile_index]
    threshold = min(max(scores), max(0.28, percentile, median + mad * 0.7))

    local_maxima = []
    for index, marker in enumerate(filtered):
        score = float(marker["score"])
        previous_score = float(filtered[index - 1]["score"]) if index else -1.0
        next_score = float(filtered[index + 1]["score"]) if index + 1 < len(filtered) else -1.0
        if score >= threshold and score >= previous_score and score >= next_score:
            local_maxima.append(dict(marker))

    selected = []
    for marker in sorted(local_maxima, key=lambda item: float(item["score"]), reverse=True):
        peak_time = float(marker["peak_time"])
        if any(abs(peak_time - float(existing["peak_time"])) < min_separation_seconds for existing in selected):
            continue
        selected.append(marker)
    return sorted(selected, key=lambda item: float(item["peak_time"]))


def heatmap_evidence_for_interval(
    start: float,
    end: float,
    peaks: list[dict[str, Any]],
) -> dict[str, Any]:
    start = float(start)
    end = float(end)
    matching = [
        marker
        for marker in peaks
        if start <= float(marker["peak_time"]) <= end
        or (float(marker["end"]) > start and float(marker["start"]) < end)
    ]
    if not matching:
        return {
            "available": bool(peaks),
            "supported": False,
            "score": 0.0,
            "peak_count": 0,
            "peak_time": None,
            "source": SOURCE,
        }
    strongest = max(matching, key=lambda item: float(item["score"]))
    return {
        "available": True,
        "supported": True,
        "score": round(float(strongest["score"]), 6),
        "peak_count": len(matching),
        "peak_time": round(float(strongest["peak_time"]), 3),
        "source": SOURCE,
    }


def _text_between(transcript: list[dict[str, Any]], start: float, end: float) -> str:
    return " ".join(
        str(item.get("text") or "").strip()
        for item in transcript
        if _finite_number(item.get("end")) > start and _finite_number(item.get("start")) < end
    ).strip()


def story_bound_heatmap_candidates(
    peaks: list[dict[str, Any]],
    stories: list[dict[str, Any]],
    transcript: list[dict[str, Any]],
    min_duration: float,
    target_duration: float,
    max_duration: float,
) -> list[dict[str, Any]]:
    """Create candidates around peaks while preserving available story bounds."""
    candidates = []
    seen_story_ids = set()
    for peak in peaks:
        peak_time = float(peak["peak_time"])
        containing = [
            story
            for story in stories
            if _finite_number(story.get("start")) <= peak_time <= _finite_number(story.get("end"))
        ]
        if containing:
            story = min(
                containing,
                key=lambda item: max(0.0, _finite_number(item.get("end")) - _finite_number(item.get("start"))),
            )
            story_key = story.get("story_id") or (
                round(_finite_number(story.get("start")), 2),
                round(_finite_number(story.get("end")), 2),
            )
            if story_key in seen_story_ids:
                continue
            seen_story_ids.add(story_key)
            start = _finite_number(story.get("start"))
            end = _finite_number(story.get("end"), start)
            text = str(story.get("text") or "").strip() or _text_between(transcript, start, end)
            candidate = {
                **story,
                "start": start,
                "end": end,
                "text": text,
                "segment_type": "Story",
                "candidate_source": "heatmap_story",
            }
        else:
            start = max(0.0, peak_time - max(min_duration * 0.45, target_duration * 0.42))
            end = start + min(max_duration, max(min_duration, target_duration))
            relevant = [
                item
                for item in transcript
                if _finite_number(item.get("end")) > start and _finite_number(item.get("start")) < end
            ]
            if relevant:
                start = _finite_number(relevant[0].get("start"), start)
                end = _finite_number(relevant[-1].get("end"), end)
            text = _text_between(transcript, start, end)
            if not text:
                continue
            candidate = {
                "start": start,
                "end": end,
                "text": text,
                "segment_type": "Evidence",
                "candidate_source": "heatmap_context",
            }
        candidate["heatmap_metrics"] = heatmap_evidence_for_interval(
            float(candidate["start"]),
            float(candidate["end"]),
            peaks,
        )
        candidate["candidate_sources"] = [candidate["candidate_source"], SOURCE]
        candidates.append(candidate)
    return candidates


def load_or_fetch_heatmap(
    info_heatmap: Any,
    url: str,
    cache_path: str | Path | None = None,
    ranges: list[tuple[float, float]] | None = None,
    timeout: float = 12.0,
) -> dict[str, Any]:
    """Load normalized heatmap data, preferring yt-dlp metadata and cache."""
    path = Path(cache_path) if cache_path else None
    video_id = extract_youtube_video_id(url)
    markers = normalize_heatmap_markers(info_heatmap)
    origin = "yt_dlp" if markers else ""
    if not markers and path and path.exists():
        try:
            cached = json.loads(path.read_text(encoding="utf-8", errors="replace"))
            markers = normalize_heatmap_markers(cached.get("markers") or [])
            origin = "cache" if markers else ""
        except (OSError, ValueError, TypeError):
            markers = []
    warning = ""
    if not markers and not video_id:
        origin = "not_youtube"
    elif not markers:
        try:
            markers = fetch_watch_page_markers(url, timeout=timeout)
            origin = "youtube_watch_page" if markers else "unavailable"
        except Exception as exc:
            warning = (
                "NETWORK_TLS_TIMEOUT"
                if "NETWORK_TLS_TIMEOUT" in str(exc)
                else "NETWORK_UNAVAILABLE"
            )
            origin = "unavailable"
    peaks = select_heatmap_peaks(markers, ranges=ranges)
    if markers and peaks:
        status = "available"
        reason = "Most Replayed publik dipakai sebagai bukti tambahan."
    elif markers and ranges:
        status = "available_outside_selection"
        reason = "Most Replayed tersedia, tetapi tidak ada peak pada area analisa yang dipilih."
    elif markers:
        status = "available_no_distinct_peak"
        reason = "Most Replayed tersedia, tetapi belum ada peak yang cukup berbeda untuk dipakai sebagai bukti tambahan."
    elif not video_id:
        status = "not_youtube"
        reason = "Heatmap hanya tersedia untuk video YouTube publik."
    elif warning:
        status = "network_unavailable"
        reason = "Most Replayed tidak dapat diambil saat ini. Analisa tetap memakai bukti transcript, audio, dan visual."
    else:
        status = "not_public"
        reason = "Most Replayed publik tidak tersedia untuk video ini."
    result = {
        "schema": SCHEMA,
        "video_id": video_id,
        "origin": origin or "unavailable",
        "status": status,
        "reason": reason,
        "available": bool(markers),
        "marker_count": len(markers),
        "peak_count": len(peaks),
        "markers": markers,
        "peaks": peaks,
        "fetched_at": datetime.now().isoformat(),
    }
    if warning:
        result["warning"] = warning
    if path and origin != "cache":
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            pass
    return result

import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None


PLATFORM_DEFAULTS = {
    "youtube_shorts": {"label": "YouTube Shorts", "hour": 19, "minute": 30, "hashtags": ["shorts"]},
    "instagram_reels": {"label": "Instagram Reels", "hour": 18, "minute": 30, "hashtags": ["reels"]},
    "tiktok": {"label": "TikTok", "hour": 19, "minute": 0, "hashtags": ["fyp"]},
}

FIXED_TIMEZONE_OFFSETS = {
    "Asia/Jakarta": 7,
    "Asia/Makassar": 8,
    "Asia/Jayapura": 9,
    "UTC": 0,
}


def clean_text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def safe_hashtag(value):
    return re.sub(r"[^a-z0-9_]", "", clean_text(value).lower().replace(" ", ""))


def contextual_hashtag(value):
    ignored = {
        "yang", "dan", "dari", "untuk", "dengan", "ini", "itu", "ke",
        "di", "pada", "atau", "the", "a", "an", "of", "to", "in",
    }
    words = [
        safe_hashtag(item)
        for item in re.findall(r"[A-Za-z0-9]+", clean_text(value))
    ]
    words = [item for item in words if len(item) >= 3 and item not in ignored]
    return "".join(words[:2])[:36]


def read_metadata(pathname):
    try:
        value = json.loads(Path(pathname).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def successful_render_outputs(outputs):
    """Return only unique, validated MP4 files that still exist on disk."""
    successful = []
    seen = set()
    for output in outputs or []:
        if not isinstance(output, dict) or output.get("validated") is not True:
            continue
        media_probe = output.get("ffprobe")
        if isinstance(media_probe, dict) and media_probe.get("valid") is not True:
            continue
        pathname = Path(str(output.get("video") or ""))
        if pathname.suffix.lower() != ".mp4" or not pathname.is_file():
            continue
        resolved = str(pathname.resolve())
        if resolved in seen:
            continue
        seen.add(resolved)
        successful.append({**output, "video": resolved})
    return successful


def atomic_json_write(pathname, value):
    pathname = Path(pathname)
    pathname.parent.mkdir(parents=True, exist_ok=True)
    temporary = pathname.with_name(f".{pathname.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, pathname)
    return pathname


def normalized_platforms(value):
    if value is None:
        return list(PLATFORM_DEFAULTS)
    if isinstance(value, str):
        values = re.split(r"[,;\s]+", value)
    else:
        values = list(value or [])
    aliases = {
        "youtube": "youtube_shorts",
        "shorts": "youtube_shorts",
        "instagram": "instagram_reels",
        "reels": "instagram_reels",
    }
    result = []
    for item in values:
        key = aliases.get(clean_text(item).lower(), clean_text(item).lower())
        if key in PLATFORM_DEFAULTS and key not in result:
            result.append(key)
    return result


def resolved_timezone(name):
    requested = clean_text(name or "Asia/Jakarta")
    if ZoneInfo:
        try:
            return requested, ZoneInfo(requested)
        except Exception:
            pass
    if requested in FIXED_TIMEZONE_OFFSETS:
        hours = FIXED_TIMEZONE_OFFSETS[requested]
        return requested, timezone(timedelta(hours=hours), name=requested)
    return "UTC", timezone.utc


def clip_readiness(metadata, output):
    score = float(metadata.get("score") or (metadata.get("quality") or {}).get("score") or 0)
    validated = bool(output.get("validated"))
    has_audio = output.get("hasAudio") is not False
    if validated and has_audio and score >= 70:
        return "ready", "high"
    if validated and has_audio and score >= 60:
        return "review", "medium"
    return "not_recommended", "low"


def platform_copy(platform, metadata, output):
    base_title = clean_text(
        metadata.get("youtube_title")
        or metadata.get("title")
        or output.get("title")
        or Path(str(output.get("video") or "clip")).stem
    )
    hook = clean_text(metadata.get("hook_text") or (output.get("hookTimeline") or {}).get("text"))
    seo = metadata.get("seo") if isinstance(metadata.get("seo"), dict) else {}
    source_tags = list(seo.get("hashtags") or metadata.get("youtube_tags") or [])
    tags = []
    topic_tag = contextual_hashtag(base_title)
    for item in PLATFORM_DEFAULTS[platform]["hashtags"] + [topic_tag] + source_tags:
        tag = safe_hashtag(item)
        if tag and tag not in tags:
            tags.append(tag)
    tags = tags[:5]
    if platform == "youtube_shorts":
        title = base_title[:95]
        caption = clean_text(metadata.get("youtube_description") or hook or base_title)[:500]
    elif platform == "instagram_reels":
        title = base_title[:80]
        caption = clean_text(f"{hook or base_title}. {seo.get('category') or ''}")[:350]
    else:
        title = base_title[:70]
        caption = clean_text(hook or base_title)[:220]
    return {
        "platform": platform,
        "label": PLATFORM_DEFAULTS[platform]["label"],
        "title": title,
        "caption": caption,
        "hashtags": [f"#{tag}" for tag in tags],
        "confidence": "medium",
        "reason": "Starting-time heuristic; validate against account history before scaling.",
    }


def schedule_items(clips, platforms, settings, now):
    if not platforms:
        return []
    posts_per_day = max(1, min(6, int(settings.get("postsPerDay") or 2)))
    minimum_gap = max(1, min(24, int(settings.get("minimumGapHours") or 4)))
    cursor = now.replace(second=0, microsecond=0) + timedelta(hours=1)
    day_counts = {}
    schedule = []
    for clip in clips:
        if clip["readiness"] == "not_recommended":
            continue
        primary_platform = platforms[0]
        default = PLATFORM_DEFAULTS[primary_platform]
        candidate = cursor.replace(hour=default["hour"], minute=default["minute"])
        if candidate <= cursor:
            candidate += timedelta(days=1)
        while day_counts.get(candidate.date().isoformat(), 0) >= posts_per_day:
            candidate = (candidate + timedelta(days=1)).replace(
                hour=default["hour"], minute=default["minute"]
            )
        if schedule:
            candidate = max(candidate, schedule[-1]["_time"] + timedelta(hours=minimum_gap))
        while day_counts.get(candidate.date().isoformat(), 0) >= posts_per_day:
            candidate = (candidate + timedelta(days=1)).replace(
                hour=default["hour"], minute=default["minute"]
            )
            if schedule:
                candidate = max(candidate, schedule[-1]["_time"] + timedelta(hours=minimum_gap))
        day_counts[candidate.date().isoformat()] = day_counts.get(candidate.date().isoformat(), 0) + 1
        schedule.append({
            "clipId": clip["id"],
            "filename": clip["filename"],
            "actualFile": clip["actualFile"],
            "title": clip["title"],
            "caption": clip["caption"],
            "hashtags": clip["hashtags"],
            "contentType": clip["contentType"],
            "storyTheme": clip["storyTheme"],
            "momentScore": clip["momentScore"],
            "publishingReadiness": clip["publishingReadiness"],
            "primaryPlatform": primary_platform,
            "platforms": clip["platformKeys"],
            "scheduledAt": candidate.isoformat(),
            "priority": clip["priority"],
            "reason": clip["reason"],
            "publishStatus": clip["publishStatus"],
            "_time": candidate,
        })
        cursor = candidate
    for item in schedule:
        item.pop("_time", None)
    return schedule


def build_publishing_plan(outputs, payload=None, now=None):
    payload = payload or {}
    timezone_name, timezone_value = resolved_timezone(
        payload.get("publishingTimezone") or "Asia/Jakarta"
    )
    now = now or datetime.now(timezone_value)
    platforms = normalized_platforms(payload.get("publishingPlatforms"))
    successful_outputs = successful_render_outputs(outputs)
    clips = []
    for index, output in enumerate(successful_outputs, 1):
        metadata = read_metadata(output.get("metadata"))
        readiness, priority = clip_readiness(metadata, output)
        platform_plans = [platform_copy(platform, metadata, output) for platform in platforms]
        primary_copy = platform_plans[0] if platform_plans else {
            "title": clean_text(metadata.get("title") or output.get("title")),
            "caption": clean_text(metadata.get("youtube_description")),
            "hashtags": [],
        }
        filename = Path(str(output.get("video") or f"clip-{index}.mp4")).name
        metrics = metadata.get("metrics") if isinstance(metadata.get("metrics"), dict) else {}
        moment_score = metadata.get("score")
        story_theme = clean_text((metadata.get("seo") or {}).get("category") or "general")
        clips.append({
            "id": index,
            "filename": filename,
            "actualFile": str(Path(str(output.get("video"))).resolve()),
            "title": primary_copy["title"],
            "caption": primary_copy["caption"],
            "hashtags": primary_copy["hashtags"],
            "hook": clean_text(metadata.get("hook_text") or (output.get("hookTimeline") or {}).get("text")),
            "contentType": story_theme,
            "storyTheme": story_theme,
            "theme": story_theme,
            "topic": clean_text(metadata.get("title") or output.get("title")),
            "tone": clean_text((metadata.get("content_profile") or {}).get("tone") or "natural"),
            "momentScore": moment_score,
            "scores": {
                "moment": moment_score,
                "hook": metrics.get("hook"),
                "story": metrics.get("story_complete"),
                "payoff": metrics.get("payoff"),
            },
            "publishingReadiness": readiness,
            "readiness": readiness,
            "priority": priority,
            "recommendedTime": None,
            "alternativeTimes": [],
            "reason": "Validated final MP4 with reusable final clip metadata.",
            "publishStatus": "draft",
            "platformKeys": list(platforms),
            "platforms": platform_plans,
        })
    settings = {
        "timezone": timezone_name,
        "postsPerDay": max(1, min(6, int(payload.get("publishingPostsPerDay") or 2))),
        "minimumGapHours": max(1, min(24, int(payload.get("publishingMinimumGapHours") or 4))),
        "historyAware": bool(payload.get("publishingHistoryAware", False)),
    }
    daily_plan = schedule_items(clips, platforms, settings, now)
    scheduled_by_clip = {item["clipId"]: item for item in daily_plan}
    for clip in clips:
        scheduled = scheduled_by_clip.get(clip["id"])
        if not scheduled:
            continue
        clip["recommendedTime"] = scheduled["scheduledAt"]
        scheduled_time = datetime.fromisoformat(scheduled["scheduledAt"])
        clip["alternativeTimes"] = [
            (scheduled_time + timedelta(days=offset)).isoformat()
            for offset in (1, 2)
        ]
    render_requested = max(
        len(successful_outputs),
        int(payload.get("_renderRequested") or len(outputs or [])),
    )
    return {
        "schema": 1,
        "feature": "smartPublishingPlannerV1",
        "createdAt": now.isoformat(),
        "mode": "local_evidence",
        "aiEnhanced": False,
        "timezone": timezone_name,
        "settings": settings,
        "platforms": platforms,
        "renderRequested": render_requested,
        "renderSuccessful": len(successful_outputs),
        "plannedClips": len(clips),
        "plannerInputClips": len(successful_outputs),
        "aiUsage": {
            "requests": 0,
            "inputClips": 0,
            "reason": "Reused validated final metadata; no publishing provider call.",
        },
        "clips": clips,
        "dailyPlan": daily_plan,
        "schedule": daily_plan,
        "warnings": [
            "Suggested times are starting heuristics, not guaranteed performance.",
            "Review rights, captions, and platform policy before publishing.",
        ],
    }


def write_publishing_plan(metadata_dir, outputs, payload=None, now=None):
    plan = build_publishing_plan(outputs, payload, now)
    if not plan["plannedClips"]:
        raise ValueError("Publishing Plan requires at least one validated rendered MP4.")
    metadata_dir = Path(metadata_dir)
    plan_path = atomic_json_write(metadata_dir / "publishing-plan.json", plan)
    for clip in plan["clips"]:
        stem = Path(clip["filename"]).stem
        atomic_json_write(metadata_dir / f"{stem}.publishing.json", clip)
    return plan_path, plan

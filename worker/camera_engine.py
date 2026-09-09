import math


FACE_TRACK = "FACE_TRACK"
BODY_TRACK = "BODY_TRACK"
SPLIT_SCREEN = "SPLIT_SCREEN"
CENTER_CROP = "CENTER_CROP"
DIRECTOR_CUT = "DIRECTOR_CUT"
EDITOR_DIRECTOR = "EDITOR_DIRECTOR_V2"
LANDSCAPE_BLUR = "LANDSCAPE_BLUR"
EDITOR_PLAN_SCHEMA = 2

# Editing Profiles
AUTO_EDIT = "AUTO_EDIT"
PODCAST_DYNAMIC = "PODCAST_DYNAMIC"
GAMING_SPLIT = "GAMING_SPLIT"
SUMMARY_COMPOSED = "SUMMARY_COMPOSED"

CONTENT_MODE_TO_EDITING_PROFILE = {
    "auto": AUTO_EDIT,
    "podcast": PODCAST_DYNAMIC,
    "gaming": GAMING_SPLIT,
    "summary": SUMMARY_COMPOSED,
    "landscape_blur": LANDSCAPE_BLUR,
}


def resolve_editing_profile(content_mode="auto"):
    normalized = str(content_mode or "auto").strip().lower()
    return CONTENT_MODE_TO_EDITING_PROFILE.get(normalized, AUTO_EDIT)


# Layout Constants (Section A)
LAYOUT_PORTRAIT_SINGLE = "PORTRAIT_SINGLE"
LAYOUT_GAMING_SPLIT = "GAMING_SPLIT"
LAYOUT_LANDSCAPE_BLUR = "LANDSCAPE_BLUR"
LAYOUT_SUMMARY_COMPOSED = "SUMMARY_COMPOSED"

# Keyframe Event Types (Section C and Legacy UI Contract)
KEYFRAME_STATIC = "KEYFRAME_STATIC"
KEYFRAME_PUNCH_IN = "KEYFRAME_PUNCH_IN"
KEYFRAME_PUNCH_OUT = "KEYFRAME_PUNCH_OUT"
KEYFRAME_REFRAME = "KEYFRAME_REFRAME"
KEYFRAME_PAN = "KEYFRAME_PAN"
KEYFRAME_SPEAKER_FOCUS = "KEYFRAME_SPEAKER_FOCUS"
KEYFRAME_REACTION_FOCUS = "KEYFRAME_REACTION_FOCUS"
KEYFRAME_PRODUCT_FOCUS = "KEYFRAME_PRODUCT_FOCUS"
KEYFRAME_SCREEN_FOCUS = "KEYFRAME_SCREEN_FOCUS"
KEYFRAME_GAMEPLAY_FOCUS = "KEYFRAME_GAMEPLAY_FOCUS"
KEYFRAME_FACECAM_FOCUS = "KEYFRAME_FACECAM_FOCUS"
KEYFRAME_WIDE_RETURN = "KEYFRAME_WIDE_RETURN"

# Section C Unprefixed Constants
STATIC = "STATIC"
PUNCH_IN = "PUNCH_IN"
PUNCH_OUT = "PUNCH_OUT"
REFRAME = "REFRAME"
PAN = "PAN"
SPEAKER_FOCUS = "SPEAKER_FOCUS"
REACTION_FOCUS = "REACTION_FOCUS"
PRODUCT_FOCUS = "PRODUCT_FOCUS"
SCREEN_FOCUS = "SCREEN_FOCUS"
GAMEPLAY_FOCUS = "GAMEPLAY_FOCUS"
FACECAM_FOCUS = "FACECAM_FOCUS"
WIDE_RETURN = "WIDE_RETURN"

VALID_KEYFRAME_TYPES = {
    "STATIC", "PUNCH_IN", "PUNCH_OUT", "REFRAME", "PAN",
    "SPEAKER_FOCUS", "REACTION_FOCUS", "PRODUCT_FOCUS", "SCREEN_FOCUS",
    "GAMEPLAY_FOCUS", "FACECAM_FOCUS", "WIDE_RETURN",
    # Legacy prefixed aliases:
    "KEYFRAME_STATIC", "KEYFRAME_PUNCH_IN", "KEYFRAME_PUNCH_OUT",
    "KEYFRAME_PAN", "KEYFRAME_REFRAME", "KEYFRAME_REACTION_FOCUS",
    "KEYFRAME_PRODUCT_FOCUS", "KEYFRAME_SCREEN_FOCUS",
    "KEYFRAME_GAMEPLAY_FOCUS", "KEYFRAME_FACECAM_FOCUS", "KEYFRAME_WIDE_RETURN",
}


def normalize_keyframe_type(raw_type):
    t = str(raw_type or "STATIC").strip().upper()
    if t.startswith("KEYFRAME_"):
        t = t[9:]
    return t if t in {
        "STATIC", "PUNCH_IN", "PUNCH_OUT", "REFRAME", "PAN",
        "SPEAKER_FOCUS", "REACTION_FOCUS", "PRODUCT_FOCUS", "SCREEN_FOCUS",
        "GAMEPLAY_FOCUS", "FACECAM_FOCUS", "WIDE_RETURN"
    } else "STATIC"


# Internal Semantic Events (Section B)
EVENT_SPEAKER_START = "SPEAKER_START"
EVENT_SPEAKER_HANDOFF = "SPEAKER_HANDOFF"
EVENT_QUESTION = "QUESTION"
EVENT_ANSWER = "ANSWER"
EVENT_IMPORTANT_POINT = "IMPORTANT_POINT"
EVENT_EMPHASIS = "EMPHASIS"
EVENT_REACTION = "REACTION"
EVENT_LAUGH = "LAUGH"
EVENT_PAYOFF = "PAYOFF"
EVENT_TOPIC_CHANGE = "TOPIC_CHANGE"
EVENT_SPEAKER_CHANGE = "SPEAKER_CHANGE"

EVENT_PRODUCT_MENTION = "PRODUCT_MENTION"
EVENT_PRODUCT_SHOW = "PRODUCT_SHOW"
EVENT_PRODUCT_DEMO = "PRODUCT_DEMO"
EVENT_PRODUCT_DETAIL = "PRODUCT_DETAIL"
EVENT_PRODUCT_PROBLEM = "PRODUCT_PROBLEM"
EVENT_VERDICT = "VERDICT"

EVENT_GAME_BUILDUP = "GAME_BUILDUP"
EVENT_GAME_ACTION = "GAME_ACTION"
EVENT_GAME_CLIMAX = "GAME_CLIMAX"
EVENT_GAMEPLAY_CLIMAX = EVENT_GAME_CLIMAX
EVENT_GAME_RESULT = "GAME_RESULT"
EVENT_STREAMER_REACTION = "STREAMER_REACTION"

EVENT_VISUAL_REFERENCE = "VISUAL_REFERENCE"
EVENT_SCREEN_REFERENCE = "SCREEN_REFERENCE"
EVENT_BROLL_OPPORTUNITY = "BROLL_OPPORTUNITY"
EVENT_PAUSE = "PAUSE"
EVENT_TOPIC_SHIFT = "TOPIC_SHIFT"

# Event Priority for Motion Budget (Section E)
# HIGH: 100, MEDIUM: 60, LOW: 20
EVENT_PRIORITY = {
    EVENT_SPEAKER_HANDOFF: 100,
    EVENT_SPEAKER_CHANGE: 100,
    EVENT_GAME_CLIMAX: 100,
    EVENT_PRODUCT_DEMO: 100,
    EVENT_STREAMER_REACTION: 100,
    EVENT_REACTION: 90,
    EVENT_LAUGH: 85,
    EVENT_IMPORTANT_POINT: 65,
    EVENT_ANSWER: 60,
    EVENT_PAYOFF: 60,
    EVENT_PRODUCT_SHOW: 55,
    EVENT_GAME_ACTION: 55,
    EVENT_QUESTION: 50,
    EVENT_EMPHASIS: 25,
    EVENT_PAUSE: 20,
}

# Overlay Event Types
OVERLAY_SOURCE_REGION = "SOURCE_REGION_OVERLAY"
OVERLAY_LOCAL_BROLL = "LOCAL_BROLL"
OVERLAY_SCREEN_FOCUS = "SCREEN_FOCUS"
OVERLAY_PRODUCT_CROP = "PRODUCT_CROP"
OVERLAY_GAMEPLAY_CROP = "GAMEPLAY_CROP"


class SpeakerAttentionMap:
    """Speaker Attention Map combining diarization, speaking activity, and reaction confidence."""

    def __init__(self, regions=None):
        self.regions = regions or []

    @classmethod
    def build(cls, speaker_timeline=None, face_analysis=None, transcript=None, clip_start=0.0, clip_end=0.0):
        turns = (speaker_timeline or {}).get("turns") or []
        subjects = (face_analysis or {}).get("subject_tracks") or []
        subject_map = {str(s.get("speaker")): s for s in subjects if isinstance(s, dict) and s.get("speaker")}

        regions = []
        clip_start_f = float(clip_start or 0.0)
        clip_end_f = float(clip_end or 0.0)

        for turn in turns:
            if not isinstance(turn, dict):
                continue
            ts = float(turn.get("start", 0.0))
            te = float(turn.get("end", ts + 1.0))
            if clip_end_f > clip_start_f:
                if te <= clip_start_f or ts >= clip_end_f:
                    continue
                ts = max(clip_start_f, ts)
                te = min(clip_end_f, te)

            spk = str(turn.get("speaker") or "speaker_1")
            sub = subject_map.get(spk, {})
            text = str(turn.get("text") or "")
            lower = text.lower()

            sem_imp = 0.5
            if any(k in lower for k in ["kuncinya", "rahasianya", "penting", "faktanya", "kesimpulannya", "akhirnya"]):
                sem_imp = 0.95
            elif "?" in text or any(k in lower for k in ["kenapa", "bagaimana", "mengapa"]):
                sem_imp = 0.8
            elif any(k in lower for k in ["jawabannya", "solusinya", "caranya"]):
                sem_imp = 0.85

            react_prob = 0.85 if any(k in lower for k in ["kaget", "wah", "gila", "lucu", "parah", "hah", "shock"]) else 0.15

            regions.append({
                "start": round(ts - clip_start_f, 3),
                "end": round(te - clip_start_f, 3),
                "speakerId": spk,
                "faceBox": sub.get("box") or [round(float(sub.get("focus_x", 0.5)) - 0.15, 3), 0.2, 0.3, 0.4],
                "speakingProbability": float(turn.get("speaking_prob", 0.94)),
                "semanticImportance": sem_imp,
                "reactionProbability": react_prob,
                "confidence": float(sub.get("confidence", 0.90)),
            })
        return cls(regions)


def create_keyframe_event(time, event_type, scale=1.0, duration=0.45, reason="", metadata=None):
    """Event-driven keyframe for intelligent, subtle motion without timer-based random zoom."""
    raw_type = str(event_type or "STATIC").strip().upper()
    return {
        "time": round(float(time or 0.0), 3),
        "type": raw_type,
        "scale": round(float(scale or 1.0), 3),
        "duration": round(float(duration or 0.45), 3),
        "reason": str(reason or ""),
        "metadata": metadata or {},
    }


def create_keyframe(
    start_time=0.0,
    end_time=0.5,
    event_type=KEYFRAME_STATIC,
    start_scale=1.0,
    end_scale=1.0,
    start_x=0.5,
    start_y=0.5,
    end_x=0.5,
    end_y=0.5,
    easing="easeInOut",
    reason="",
    focus_target=None,
    **kwargs,
):
    """Normalized Keyframe Director item (Section C) with full legacy compatibility."""
    st = float(kwargs.get("start", start_time) or 0.0)
    et = float(kwargs.get("end", end_time) or (st + 0.5))
    raw_t = kwargs.get("type", event_type)
    norm_type = normalize_keyframe_type(raw_t)
    sf = float(kwargs.get("scaleFrom", start_scale) or 1.0)
    st_scale = float(kwargs.get("scaleTo", end_scale) or sf)
    target = kwargs.get("focusTarget", focus_target)
    rsn = str(kwargs.get("reason", reason) or "")
    eas = str(kwargs.get("easing", easing) or "easeInOut")
    sx = float(kwargs.get("startX", start_x) or 0.5)
    sy = float(kwargs.get("startY", start_y) or 0.5)
    ex = float(kwargs.get("endX", end_x) or sx)
    ey = float(kwargs.get("endY", end_y) or sy)

    return {
        # Section C Normalized Keyframe Specification
        "start": round(st, 3),
        "end": round(et, 3),
        "type": norm_type,
        "scaleFrom": round(sf, 3),
        "scaleTo": round(st_scale, 3),
        "focusTarget": target,
        "easing": eas,
        "reason": rsn,
        # Legacy compatibility properties for filter expressions and existing tests
        "startTime": round(st, 3),
        "endTime": round(et, 3),
        "startScale": round(sf, 3),
        "endScale": round(st_scale, 3),
        "startX": round(sx, 3),
        "startY": round(sy, 3),
        "endX": round(ex, 3),
        "endY": round(ey, 3),
    }


def create_overlay_event(
    start_time=0.0,
    end_time=1.0,
    overlay_type=OVERLAY_SOURCE_REGION,
    source="source",
    placement="center",
    region=None,
    reason="",
    **kwargs,
):
    """Create normalized source-based overlay event."""
    st = float(kwargs.get("start", start_time) or 0.0)
    et = float(kwargs.get("end", end_time) or (st + 1.0))
    return {
        "start": round(st, 3),
        "end": round(et, 3),
        "startTime": round(st, 3),
        "endTime": round(et, 3),
        "type": str(kwargs.get("type", overlay_type) or OVERLAY_SOURCE_REGION),
        "source": str(kwargs.get("source", source) or "source"),
        "placement": str(kwargs.get("placement", placement) or "center"),
        "region": region or [0.0, 0.0, 1.0, 1.0],
        "reason": str(kwargs.get("reason", reason) or ""),
    }


def validate_edit_plan(edit_plan, clip_duration=None):
    """Validate editPlan structure, bounding boxes, scales, and timelines.

    If corrupted, degrades gracefully to safe fallback without crashing render.
    """
    if not isinstance(edit_plan, dict):
        return _fallback_edit_plan(clip_duration)

    duration = float(clip_duration or edit_plan.get("duration") or 10.0)

    # Validate cuts
    cuts = edit_plan.get("cuts") or []
    valid_cuts = []
    for cut in cuts:
        if not isinstance(cut, dict):
            continue
        try:
            start = max(0.0, min(duration, float(cut.get("start", 0.0))))
            end = max(start, min(duration, float(cut.get("end", duration))))
            valid_cuts.append({
                **cut,
                "start": round(start, 3),
                "end": round(end, 3),
                "focus_x": round(max(0.05, min(0.95, float(cut.get("focus_x", 0.5)))), 3),
                "focus_y": round(max(0.05, min(0.95, float(cut.get("focus_y", 0.5)))), 3),
            })
        except (TypeError, ValueError):
            continue
    valid_cuts.sort(key=lambda c: c["start"])
    edit_plan["cuts"] = valid_cuts

    # Validate keyframes
    keyframes = edit_plan.get("keyframes") or []
    valid_keyframes = []
    for kf in keyframes:
        if not isinstance(kf, dict):
            continue
        try:
            start = max(0.0, min(duration, float(kf.get("start", kf.get("startTime", 0.0)))))
            end = max(start, min(duration, float(kf.get("end", kf.get("endTime", start + 0.5)))))
            start_scale = max(1.0, min(1.15, float(kf.get("scaleFrom", kf.get("startScale", 1.0)))))
            end_scale = max(1.0, min(1.15, float(kf.get("scaleTo", kf.get("endScale", 1.0)))))
            start_x = max(0.0, min(1.0, float(kf.get("startX", 0.5))))
            start_y = max(0.0, min(1.0, float(kf.get("startY", 0.5))))
            end_x = max(0.0, min(1.0, float(kf.get("endX", 0.5))))
            end_y = max(0.0, min(1.0, float(kf.get("endY", 0.5))))
            norm_type = normalize_keyframe_type(kf.get("type"))
            valid_keyframes.append({
                **kf,
                "start": round(start, 3),
                "end": round(end, 3),
                "type": norm_type,
                "scaleFrom": round(start_scale, 3),
                "scaleTo": round(end_scale, 3),
                "focusTarget": kf.get("focusTarget"),
                "easing": str(kf.get("easing") or "easeInOut"),
                "reason": str(kf.get("reason") or ""),
                "startTime": round(start, 3),
                "endTime": round(end, 3),
                "startScale": round(start_scale, 3),
                "endScale": round(end_scale, 3),
                "startX": round(start_x, 3),
                "startY": round(start_y, 3),
                "endX": round(end_x, 3),
                "endY": round(end_y, 3),
            })
        except (TypeError, ValueError):
            continue
    valid_keyframes.sort(key=lambda k: k.get("start", k.get("startTime", 0.0)))
    edit_plan["keyframes"] = valid_keyframes

    # Validate overlays
    overlays = edit_plan.get("overlays") or []
    valid_overlays = []
    for ov in overlays:
        if not isinstance(ov, dict):
            continue
        try:
            start = max(0.0, min(duration, float(ov.get("startTime", 0.0))))
            end = max(start, min(duration, float(ov.get("endTime", start + 1.0))))
            if end > start:
                valid_overlays.append({
                    **ov,
                    "startTime": round(start, 3),
                    "endTime": round(end, 3),
                })
        except (TypeError, ValueError):
            continue
    edit_plan["overlays"] = valid_overlays

    edit_plan.setdefault("qa", {})
    edit_plan["qa"]["valid"] = True
    edit_plan["qa"]["cutCount"] = len(valid_cuts)
    edit_plan["qa"]["keyframeCount"] = len(valid_keyframes)
    edit_plan["qa"]["overlayCount"] = len(valid_overlays)
    edit_plan["qa"]["motionBudgetCompliant"] = len(valid_keyframes) <= max(3, int(duration / 4.0))
    return edit_plan


def _fallback_edit_plan(clip_duration=10.0):
    duration = max(1.0, float(clip_duration or 10.0))
    return {
        "schema": 3,
        "contentMode": "auto",
        "resolvedMode": "auto",
        "editingProfile": AUTO_EDIT,
        "layout": CENTER_CROP,
        "duration": round(duration, 2),
        "cuts": [{"start": 0.0, "end": round(duration, 2), "focus_x": 0.5, "focus_y": 0.5, "shot": "medium", "reason": "safe_fallback"}],
        "keyframes": [],
        "overlays": [],
        "focusEvents": [],
        "safeRegions": [{"type": "center_safe", "region": [0.2, 0.0, 0.6, 1.0]}],
        "transitions": [],
        "fallbackUsed": True,
        "qa": {
            "valid": True,
            "cutCount": 1,
            "keyframeCount": 0,
            "overlayCount": 0,
            "motionBudgetCompliant": True,
            "fallbackReason": "corrupt_or_missing_plan",
        },
    }


def normalized_visual_region(region):
    if isinstance(region, dict):
        region = [region.get(key) for key in ("x", "y", "width", "height")]
    if not isinstance(region, (list, tuple)) or len(region) != 4:
        return None
    try:
        x, y, w, h = map(float, region)
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in (x, y, w, h)):
        return None
    if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > 1.001 or y + h > 1.001:
        return None
    return [x, y, min(w, 1.0 - x), min(h, 1.0 - y)]


MODE_STORYBOARD_SCHEMAS = {
    "auto": [
        {"name": "Hook", "description": "Menarik perhatian", "ratio_range": (0.00, 0.10), "shot": "MEDIUM_SPEAKER", "action": "HOLD"},
        {"name": "Context", "description": "Perkenalan topik", "ratio_range": (0.10, 0.30), "shot": "MEDIUM_SPEAKER", "action": "HOLD"},
        {"name": "Important Point", "description": "Penjelasan utama", "ratio_range": (0.30, 0.56), "shot": "PUNCH_IN", "action": "PUNCH_IN"},
        {"name": "Visual Reference", "description": "Tampilkan contoh", "ratio_range": (0.56, 0.80), "shot": "MEDIUM_SPEAKER", "action": "HOLD"},
        {"name": "Payoff", "description": "Kesimpulan", "ratio_range": (0.80, 1.00), "shot": "PUNCH_IN", "action": "PUNCH_IN"},
    ],
    "podcast": [
        {"name": "Setup", "description": "Wide two shot", "ratio_range": (0.00, 0.10), "shot": "WIDE_TWO_SHOT", "action": "HOLD"},
        {"name": "Question", "description": "Speaker A", "ratio_range": (0.10, 0.33), "shot": "MEDIUM_SPEAKER", "action": "SPEAKER_FOCUS"},
        {"name": "Answer / Insight", "description": "Speaker B", "ratio_range": (0.33, 0.67), "shot": "MEDIUM_SPEAKER", "action": "PUNCH_IN"},
        {"name": "Reaction", "description": "Respons alami", "ratio_range": (0.67, 0.83), "shot": "REACTION_FOCUS", "action": "REACTION_FOCUS"},
        {"name": "Conclusion", "description": "Wide return", "ratio_range": (0.83, 1.00), "shot": "WIDE_RETURN", "action": "WIDE_RETURN"},
    ],
    "gaming": [
        {"name": "Setup", "description": "Split 65/35", "ratio_range": (0.00, 0.13), "shot": "SPLIT_65_35", "action": "HOLD"},
        {"name": "Build-up", "description": "Persiapan / rotasi", "ratio_range": (0.13, 0.33), "shot": "GAMEPLAY_FOCUS", "action": "HOLD"},
        {"name": "Action / Climax", "description": "Gameplay fokus", "ratio_range": (0.33, 0.58), "shot": "GAMEPLAY_FOCUS", "action": "PUNCH_IN"},
        {"name": "Result", "description": "Hasil pertarungan", "ratio_range": (0.58, 0.75), "shot": "GAMEPLAY_FOCUS", "action": "HOLD"},
        {"name": "Streamer Reaction", "description": "Facecam lebih besar", "ratio_range": (0.75, 1.00), "shot": "FACECAM_FOCUS", "action": "FACECAM_FOCUS"},
    ],
    "summary": [
        {"name": "Hook", "description": "Perkenalan produk", "ratio_range": (0.00, 0.14), "shot": "PRESENTER_FOCUS", "action": "HOLD"},
        {"name": "Feature", "description": "Fitur utama", "ratio_range": (0.14, 0.38), "shot": "PRODUCT_FOCUS", "action": "HOLD"},
        {"name": "Demo", "description": "Tunjukkan penggunaan", "ratio_range": (0.38, 0.58), "shot": "SCREEN_FOCUS", "action": "SCREEN_FOCUS"},
        {"name": "Weakness", "description": "Kekurangan jujur", "ratio_range": (0.58, 0.78), "shot": "PRESENTER_FOCUS", "action": "HOLD"},
        {"name": "Verdict", "description": "Rekomendasi akhir", "ratio_range": (0.78, 1.00), "shot": "PUNCH_IN", "action": "PUNCH_IN"},
    ],
    "landscape_blur": [
        {"name": "Establishing", "description": "Tampilkan full frame", "ratio_range": (0.00, 0.13), "shot": "FULL_FRAME", "action": "HOLD"},
        {"name": "Highlight", "description": "Area penting", "ratio_range": (0.13, 0.33), "shot": "FULL_FRAME", "action": "HOLD"},
        {"name": "Detail", "description": "Fokus tanpa crop", "ratio_range": (0.33, 0.67), "shot": "FULL_FRAME", "action": "HOLD"},
        {"name": "Closing", "description": "View stabil", "ratio_range": (0.67, 1.00), "shot": "FULL_FRAME", "action": "HOLD"},
    ],
}


def get_mode_storyboard_beats(mode="auto", duration=60.0):
    norm_mode = str(mode or "auto").strip().lower()
    schema_beats = MODE_STORYBOARD_SCHEMAS.get(norm_mode) or MODE_STORYBOARD_SCHEMAS["auto"]
    total_dur = max(1.0, float(duration or 60.0))
    beats = []
    for item in schema_beats:
        r_start, r_end = item["ratio_range"]
        s_time = round(r_start * total_dur, 2)
        e_time = round(r_end * total_dur, 2)
        beats.append({
            "beat": item["name"],
            "name": item["name"],
            "description": item["description"],
            "start": s_time,
            "end": e_time,
            "timeRange": f"{int(s_time//60):02d}:{int(s_time%60):02d} - {int(e_time//60):02d}:{int(e_time%60):02d}",
            "shotType": item["shot"],
            "cameraAction": item["action"],
            "label": f"{item['name']} ({item['description']})",
        })
    return beats


def build_visual_storyboard(plan):
    """Describe the existing edit timeline without inventing story roles or detections."""
    duration = float(plan.get("duration") or 0.0)
    layout = plan.get("layout") or CENTER_CROP
    resolved_mode = str(plan.get("resolvedMode") or plan.get("contentMode") or "auto").strip().lower()
    events = sorted(plan.get("storyEvents") or [], key=lambda e: float(e.get("time", 0.0)))
    cuts = plan.get("cuts") or []
    keyframes = plan.get("keyframes") or []
    boundaries = {0.0, duration}
    for item in cuts + keyframes:
        for key in ("start", "end"):
            value = float(item.get(key, 0.0))
            if math.isfinite(value) and 0 < value < duration:
                boundaries.add(value)
    for event in events:
        value = float(event.get("time", 0.0))
        if math.isfinite(value) and 0 < value < duration:
            boundaries.add(value)
    safe_region = next((r.get("region") for r in plan.get("safeRegions", [])
                        if r.get("type") == "subtitle_safe"), None)
    scenes = []
    times = sorted(boundaries)
    storyboard_beats = get_mode_storyboard_beats(resolved_mode, duration)

    for start, end in zip(times, times[1:]):
        event = next((e for e in reversed(events) if float(e.get("time", 0)) <= start), {})
        cut = next((c for c in cuts if c["start"] <= start < c["end"]), {})
        keyframe = next((k for k in keyframes if k["start"] <= start < k["end"]), {})
        action = normalize_keyframe_type(keyframe.get("type")) if keyframe else "HOLD"
        shot = "LANDSCAPE_PRESERVE" if layout == LANDSCAPE_BLUR else (
            "BALANCED_SPLIT" if layout == GAMING_SPLIT else "MEDIUM_SPEAKER" if cut.get("speaker") else "STATIC_SAFE")
        reason = keyframe.get("reason") or cut.get("reason") or "preserve_source_composition"

        # Match corresponding storyboard beat
        matching_beat = next(
            (b for b in storyboard_beats if b["start"] <= start < b["end"]),
            storyboard_beats[-1] if storyboard_beats else None
        )
        beat_name = matching_beat["name"] if matching_beat else "Scene"
        beat_desc = matching_beat["description"] if matching_beat else reason

        scenes.append({
            "start": round(start, 3), "end": round(end, 3),
            "storyboardPhase": beat_name,
            "storyboardDesc": beat_desc,
            "storyEvent": event.get("type") or "SOURCE_CONTENT",
            "purpose": event.get("reason") or beat_desc,
            "subject": cut.get("speaker"), "visualPriority": keyframe.get("focusTarget") or "source",
            "shotType": shot, "layout": layout, "cameraAction": action,
            "scaleFrom": keyframe.get("scaleFrom", 1.0), "scaleTo": keyframe.get("scaleTo", 1.0),
            "focusTarget": keyframe.get("focusTarget") or cut.get("speaker"),
            "reason": reason, "priority": EVENT_PRIORITY.get(event.get("type"), 20),
            "confidence": event.get("confidence"), "subtitleSafeRegion": safe_region,
        })
    return {
        "schema": 2,
        "mode": resolved_mode,
        "timeline": "clip_local",
        "storyArc": [e.get("type") for e in events],
        "storyboardBeats": storyboard_beats,
        "scenes": scenes,
    }


class SmartEditDirector:
    """Smart Edit Director V2 that generates a complete editPlan

    driven by story events, speaker changes, and content profile.
    """

    def __init__(self, content_mode="auto"):
        self.content_mode = str(content_mode or "auto").strip().lower()
        self.profile = resolve_editing_profile(self.content_mode)
        self.strategy = ContentModeRouter.get_strategy(self.content_mode)

    def plan_edit(
        self,
        transcript=None,
        speaker_timeline=None,
        start=0.0,
        end=0.0,
        duration=None,
        story_beats=None,
        visual_detections=None,
        source_dims=None,
        face_analysis=None,
        motion_intensity="balanced",
    ):
        start = max(0.0, float(start or 0.0))
        end = max(start, float(end or start))
        clip_duration = max(1.0, float(duration or (end - start) or 10.0))

        # 1. Determine mode
        mode = self.content_mode
        if mode == "auto":
            mode = self._auto_detect_mode(speaker_timeline, face_analysis, visual_detections)

        # 2. Motion budget parameters (Section D & E)
        punch_scale = 1.06 if motion_intensity == "balanced" else (1.04 if motion_intensity == "minimal" else 1.09)
        min_motion_gap = 4.0 if motion_intensity == "balanced" else (6.0 if motion_intensity == "minimal" else 2.8)

        cuts = []
        keyframes = []
        overlays = []
        focus_events = []
        safe_regions = []
        transitions = []
        layout = resolve_editing_profile(mode)

        if mode == "landscape_blur":
            layout = LANDSCAPE_BLUR
            safe_regions.append({"type": "full_landscape", "preserve_ratio": True, "no_crop": True})
            keyframes = self._plan_landscape_keyframes(story_beats, clip_duration, punch_scale, min_motion_gap)

        elif mode == "gaming":
            facecam_region, gameplay_region = self._detect_gaming_regions(visual_detections, face_analysis, source_dims)
            if facecam_region is not None:
                layout = GAMING_SPLIT
                safe_regions.append({"type": "gameplay_hud", "region": gameplay_region})
                safe_regions.append({"type": "facecam", "region": facecam_region})
                # Add HUD protection bounds
                safe_regions.extend([
                    {"type": "hud_crosshair", "region": [0.45, 0.45, 0.10, 0.10]},
                    {"type": "hud_minimap", "region": [0.02, 0.02, 0.22, 0.22]},
                    {"type": "hud_health", "region": [0.02, 0.88, 0.30, 0.08]},
                    {"type": "hud_killfeed", "region": [0.75, 0.02, 0.23, 0.25]},
                ])
                cuts, keyframes, focus_events = self._plan_gaming_events(
                    story_beats, clip_duration, facecam_region, gameplay_region
                )
            else:
                layout = LANDSCAPE_BLUR
                safe_regions.append({"type": "full_landscape", "preserve_ratio": True, "no_crop": True})

        elif mode == "podcast":
            layout = PODCAST_DYNAMIC
            if self._should_preserve_multisubject_frame(speaker_timeline, face_analysis):
                layout = LANDSCAPE_BLUR
                cuts = [{
                    "start": 0.0,
                    "end": clip_duration,
                    "focus_x": 0.5,
                    "focus_y": 0.45,
                    "shot": "wide",
                    "reason": "two_person_preserve_no_speaker_grounding",
                }]
                safe_regions.append({"type": "two_person_wide", "preserve_ratio": True, "no_crop": True})
                keyframes = self._plan_podcast_keyframes(story_beats, cuts, clip_duration, min(1.04, punch_scale), min_motion_gap)
            else:
                cuts, focus_events = self._plan_podcast_cuts(speaker_timeline, face_analysis, clip_duration)
                keyframes = self._plan_podcast_keyframes(story_beats, cuts, clip_duration, punch_scale, min_motion_gap)
            safe_regions.append({"type": "speaker_headroom", "top_margin": 0.15})

        elif mode == "summary":
            layout = SUMMARY_COMPOSED
            cuts, focus_events = self._plan_podcast_cuts(speaker_timeline, face_analysis, clip_duration)
            keyframes = self._plan_review_product_keyframes(story_beats, cuts, clip_duration, punch_scale, min_motion_gap)
            safe_regions.append({"type": "narrative_focus", "preserve_clarity": True})

        else:  # auto / general
            layout = AUTO_EDIT
            cuts, focus_events = self._plan_podcast_cuts(speaker_timeline, face_analysis, clip_duration)
            keyframes = self._plan_podcast_keyframes(story_beats, cuts, clip_duration, punch_scale, min_motion_gap)

        # Subtitle safe region across all modes
        safe_regions.append({
            "type": "subtitle_safe",
            "region": [0.05, 0.78, 0.90, 0.18],
            "description": "Protects lower subtitle bounds and ensures contrast against background.",
        })

        overlays = self._plan_overlays(transcript, visual_detections, clip_duration, story_beats=story_beats)

        story_events = []
        for beat in (story_beats or []):
            if isinstance(beat, dict):
                story_events.append({
                    "time": round(float(beat.get("time", 0.0)), 3),
                    "type": str(beat.get("type") or "EVENT"),
                    "reason": str(beat.get("reason") or ""),
                })

        story_type = self._infer_story_type(story_beats, mode)
        reaction_count = sum(1 for k in keyframes if k.get("type") in {KEYFRAME_REACTION_FOCUS, "REACTION_FOCUS"})
        speaker_switches = max(0, len(cuts) - 1)

        raw_plan = {
            "schema": 3,
            "contentMode": self.content_mode,
            "resolvedMode": mode,
            "editingProfile": resolve_editing_profile(mode),
            "layout": layout,
            "duration": round(clip_duration, 2),
            "storyEvents": story_events,
            "cameraEvents": cuts,
            "keyframes": keyframes,
            "cuts": cuts,
            "overlays": overlays,
            "focusEvents": focus_events,
            "safeRegions": safe_regions,
            "transitions": transitions,
            "fallbackUsed": False,
            "qa": {
                "valid": True,
                "mode": mode,
                "storyType": story_type,
                "layout": layout,
                "cutCount": len(cuts),
                "keyframeCount": len(keyframes),
                "speakerSwitches": speaker_switches,
                "reactions": reaction_count,
                "overlayCount": len(overlays),
                "fallback": False,
                "fallbackUsed": False,
                "motionBudgetCompliant": True,
            },
        }
        plan = validate_edit_plan(raw_plan, clip_duration)
        plan["storyboard"] = build_visual_storyboard(plan)
        return plan

    def _infer_story_type(self, story_beats, mode):
        types = [str(b.get("type") or "").upper() for b in (story_beats or []) if isinstance(b, dict)]
        if mode == "podcast":
            if "QUESTION" in types and ("ANSWER" in types or "PAYOFF" in types):
                return "question_answer"
            return "podcast_discussion"
        if mode == "gaming":
            if any(t in types for t in ["CLIMAX", "KILL", "ACTION"]):
                return "gameplay_climax"
            return "gaming_match"
        if mode == "summary":
            return "product_review"
        if mode == "landscape_blur":
            return "landscape_story"
        return "general_narrative"

    def _auto_detect_mode(self, speaker_timeline, face_analysis, visual_detections):
        """Use detected content evidence; summary composition requires explicit selection."""
        for detection in visual_detections or []:
            if not isinstance(detection, dict) or float(detection.get("confidence", 0.0)) < 0.75:
                continue
            kind = str(detection.get("type") or "").upper()
            if kind in {"GAMEPLAY", "FACECAM"}:
                return "gaming"
            if kind in {"SCREEN", "SCREEN_CAPTURE", "LANDSCAPE", "PRODUCT_DEMO"}:
                return "landscape_blur"
        if isinstance(face_analysis, dict):
            content_type = str(face_analysis.get("content_type") or "").lower()
            if content_type in {"gaming", "gameplay"}:
                return "gaming"
            if content_type in {"podcast", "interview"}:
                return "podcast"
            if content_type in {"screen", "screencast", "landscape", "presentation"}:
                return "landscape_blur"
            if int(face_analysis.get("person_count") or face_analysis.get("face_count") or 0) >= 2:
                return "podcast"

        turns = (speaker_timeline or {}).get("turns") or []
        distinct_speakers = {t.get("speaker") for t in turns if isinstance(t, dict) and t.get("speaker")}
        if len(distinct_speakers) >= 2:
            return "podcast"

        return "auto"

    @staticmethod
    def _should_preserve_multisubject_frame(speaker_timeline, face_analysis):
        """Keep the full conversation frame when multiple people are visible but speaker grounding is absent."""
        analysis = face_analysis or {}
        turns = (speaker_timeline or {}).get("turns") or []
        distinct_speakers = {
            str(turn.get("speaker") or "")
            for turn in turns
            if isinstance(turn, dict) and turn.get("speaker")
        }
        speaker_grounded = bool(
            (speaker_timeline or {}).get("speaker_evidence")
            or (speaker_timeline or {}).get("speaker_visual_mapping")
            or len(distinct_speakers) >= 2
        )
        visible_people = max(
            int(analysis.get("person_count") or 0),
            int(analysis.get("face_count") or 0),
            int((analysis.get("editor_plan") or {}).get("qa", {}).get("rawSubjectCount") or 0),
        )
        validated_subjects = len(analysis.get("subject_tracks") or [])
        average_faces = float(analysis.get("average_faces") or 0.0)
        if speaker_grounded:
            return False
        return visible_people >= 2 and (validated_subjects < 2 or average_faces < 1.5)

    def _plan_landscape_keyframes(self, story_beats, clip_duration, punch_scale, min_motion_gap):
        """Landscape blur keeps full composition; allows subtle punch-in on peak payoffs."""
        keyframes = []
        last_motion = -10.0
        beats = story_beats or []
        for beat in beats:
            if not isinstance(beat, dict):
                continue
            b_type = str(beat.get("type") or "").upper()
            b_time = float(beat.get("time") or 0.0)
            if b_type in {EVENT_PAYOFF, EVENT_IMPORTANT_POINT, "REVEAL", "PUNCHLINE"} and (b_time - last_motion) >= min_motion_gap:
                hold_end = min(clip_duration - 0.2, b_time + 1.8)
                if hold_end > b_time + 0.5:
                    keyframes.append(
                        create_keyframe(
                            start_time=b_time,
                            end_time=hold_end,
                            event_type=KEYFRAME_PUNCH_IN,
                            start_scale=1.00,
                            end_scale=min(1.06, punch_scale),
                            start_x=0.5,
                            start_y=0.5,
                            end_x=0.5,
                            end_y=0.5,
                            reason="landscape_story_emphasis",
                        )
                    )
                    last_motion = hold_end
        return keyframes

    def _detect_gaming_regions(self, visual_detections, face_analysis, source_dims):
        """Detect streamer facecam and gameplay regions safely without hallucinating."""
        analysis = face_analysis if isinstance(face_analysis, dict) else {}
        gameplay_region = [0.0, 0.0, 1.0, 1.0]
        # Only explicit panel detections or measured corner-face bounds may supply a crop.
        region = normalized_visual_region(analysis.get("facecamRegion") or analysis.get("facecam_region"))
        if region:
            return region, gameplay_region
        for detection in visual_detections or []:
            if not isinstance(detection, dict):
                continue
            if str(detection.get("type") or "").upper() != "FACECAM":
                continue
            if float(detection.get("confidence", 0.0)) < 0.75:
                continue
            region = normalized_visual_region(detection.get("region"))
            if region:
                return region, gameplay_region
        tracks = analysis.get("subject_tracks") or []
        for track in tracks:
            if not isinstance(track, dict):
                continue
            kind = track.get("kind")
            if kind is not None and str(kind).lower() not in {"face", "person", "streamer"}:
                continue
            fx = float(track.get("focus_x", 0.5))
            fy = float(track.get("focus_y", 0.5))
            conf = float(track.get("confidence", 0.0))
            is_corner = (fx > 0.60 or fx < 0.40) and (fy > 0.50 or fy < 0.40)
            if not is_corner:
                continue
            region = normalized_visual_region(track.get("detected_region"))
            if not region and (conf >= 0.55 or is_corner):
                box_w = 0.28
                box_h = 0.28
                region = [
                    round(max(0.0, min(1.0 - box_w, fx - box_w / 2)), 4),
                    round(max(0.0, min(1.0 - box_h, fy - box_h / 2)), 4),
                    box_w,
                    box_h,
                ]
            if region and (conf >= 0.55 or is_corner):
                return region, gameplay_region
        return None, gameplay_region

    def _plan_gaming_events(self, story_beats, clip_duration, facecam_region, gameplay_region):
        cuts = []
        keyframes = []
        focus_events = []
        cuts.append({
            "start": 0.0,
            "end": clip_duration,
            "shot": "gaming_split",
            "gameplay_ratio": 0.65,
            "reason": "gaming_split_layout",
        })

        last_motion_start = -10.0
        for beat in story_beats or []:
            if not isinstance(beat, dict):
                continue
            b_time = float(beat.get("time") or 0.0)
            b_type = str(beat.get("type") or "").upper()
            if b_time - last_motion_start < 2.8:
                continue

            hold_end = min(clip_duration, b_time + 2.0)
            if hold_end <= b_time + 0.5:
                continue

            if b_type in {EVENT_GAME_CLIMAX, "EVENT_GAMEPLAY_CLIMAX", "CLIMAX", "ACTION", "KILL", "GAMEPLAY_CLIMAX"}:
                keyframes.append(
                    create_keyframe(
                        start_time=b_time,
                        end_time=hold_end,
                        event_type=KEYFRAME_GAMEPLAY_FOCUS,
                        start_scale=1.00,
                        end_scale=1.08,
                        focus_target="gameplay",
                        reason="gameplay_climax_focus",
                    )
                )
                last_motion_start = b_time
            elif b_type in {EVENT_STREAMER_REACTION, "STREAMER_REACTION"}:
                keyframes.append(
                    create_keyframe(
                        start_time=b_time,
                        end_time=hold_end,
                        event_type=KEYFRAME_FACECAM_FOCUS,
                        start_scale=1.00,
                        end_scale=1.07,
                        focus_target="facecam",
                        reason="streamer_reaction_enlarge",
                    )
                )
                last_motion_start = b_time
            elif b_type in {EVENT_REACTION, "REACTION", "LAUGH"}:
                keyframes.append(
                    create_keyframe(
                        start_time=b_time,
                        end_time=hold_end,
                        event_type=KEYFRAME_REACTION_FOCUS,
                        start_scale=1.00,
                        end_scale=1.06,
                        focus_target="facecam",
                        reason="streamer_reaction_emphasis",
                    )
                )
                last_motion_start = b_time
        return cuts, keyframes, focus_events

    def _plan_review_product_keyframes(self, story_beats, cuts, clip_duration, punch_scale, min_motion_gap):
        """Mode 4 Review / Rangkum: Choreographed presenter -> PRODUCT_FOCUS -> hold -> return presenter, plus verdict punch."""
        keyframes = []
        last_motion = -10.0
        cut_times = [float(c["start"]) for c in cuts if isinstance(c, dict) and "start" in c]

        for beat in (story_beats or []):
            if not isinstance(beat, dict):
                continue
            b_time = float(beat.get("time") or 0.0)
            b_type = str(beat.get("type") or "").upper()

            # Anti-overedit: avoid keyframe within 0.8s of a cut
            if any(abs(b_time - ct) < 0.8 for ct in cut_times):
                continue
            if b_time - last_motion < min_motion_gap:
                continue

            hold_end = min(clip_duration - 0.2, b_time + 2.0)
            if hold_end <= b_time + 0.6:
                continue

            if b_type in {EVENT_PRODUCT_SHOW, EVENT_PRODUCT_DEMO, EVENT_PRODUCT_DETAIL, "PRODUCT_SHOW", "PRODUCT_DEMO", "DEMO"}:
                # 1. Product focus: Presenter -> Product detail
                keyframes.append(
                    create_keyframe(
                        start_time=b_time,
                        end_time=hold_end,
                        event_type=KEYFRAME_PRODUCT_FOCUS,
                        start_scale=1.00,
                        end_scale=min(1.08, punch_scale + 0.02),
                        focus_target="product",
                        reason="product_focus_detail",
                    )
                )
                # 2. Return to presenter after hold if time permits
                return_start = hold_end
                return_end = min(clip_duration - 0.1, return_start + 0.8)
                if return_end > return_start + 0.3 and (clip_duration - return_end) >= 1.0:
                    keyframes.append(
                        create_keyframe(
                            start_time=return_start,
                            end_time=return_end,
                            event_type=KEYFRAME_WIDE_RETURN,
                            start_scale=min(1.08, punch_scale + 0.02),
                            end_scale=1.00,
                            focus_target="presenter",
                            reason="return_to_presenter",
                        )
                    )
                    last_motion = return_end
                else:
                    last_motion = hold_end

            elif b_type in {EVENT_VERDICT, "VERDICT", "CONCLUSION"}:
                keyframes.append(
                    create_keyframe(
                        start_time=b_time,
                        end_time=hold_end,
                        event_type=KEYFRAME_PUNCH_IN,
                        start_scale=1.00,
                        end_scale=min(1.05, punch_scale),
                        focus_target="presenter",
                        reason="verdict_punch",
                    )
                )
                last_motion = hold_end

            elif b_type in {EVENT_SCREEN_REFERENCE, "SCREEN_REFERENCE", "SCREEN_DEMO"}:
                keyframes.append(
                    create_keyframe(
                        start_time=b_time,
                        end_time=hold_end,
                        event_type=KEYFRAME_SCREEN_FOCUS,
                        start_scale=1.00,
                        end_scale=1.06,
                        focus_target="screen",
                        reason="screen_demonstration",
                    )
                )
                last_motion = hold_end

            elif b_type in {EVENT_IMPORTANT_POINT, "IMPORTANT_POINT", EVENT_PAYOFF, "BENEFIT"}:
                keyframes.append(
                    create_keyframe(
                        start_time=b_time,
                        end_time=hold_end,
                        event_type=KEYFRAME_PUNCH_IN,
                        start_scale=1.00,
                        end_scale=punch_scale,
                        focus_target="presenter",
                        reason="important_point_emphasis",
                    )
                )
                last_motion = hold_end

            elif b_type in {EVENT_REACTION, "REACTION", "LAUGH"}:
                keyframes.append(
                    create_keyframe(
                        start_time=b_time,
                        end_time=hold_end,
                        event_type=KEYFRAME_REACTION_FOCUS,
                        start_scale=1.00,
                        end_scale=min(1.05, punch_scale),
                        focus_target="presenter",
                        reason="reaction_hold",
                    )
                )
                last_motion = hold_end

        return keyframes

    def _plan_subtle_action_keyframes(self, story_beats, clip_duration, punch_scale, min_motion_gap):
        keyframes = []
        last_motion = -10.0
        for beat in story_beats or []:
            if not isinstance(beat, dict):
                continue
            b_time = float(beat.get("time") or 0.0)
            if b_time - last_motion >= min_motion_gap:
                hold_end = min(clip_duration - 0.2, b_time + 1.8)
                if hold_end > b_time + 0.5:
                    keyframes.append(
                        create_keyframe(
                            start_time=b_time,
                            end_time=hold_end,
                            event_type=KEYFRAME_PUNCH_IN,
                            start_scale=1.00,
                            end_scale=punch_scale,
                            reason="gameplay_action_punch",
                        )
                    )
                    last_motion = hold_end
        return keyframes

    def _plan_podcast_cuts(self, speaker_timeline, face_analysis, clip_duration):
        """Plan cuts with speaker hysteresis: minimum hold ~1.2s, short interjections ignored."""
        cuts = []
        focus_events = []
        turns = (speaker_timeline or {}).get("turns") or []
        subjects = (face_analysis or {}).get("subject_tracks") or []
        subject_by_speaker = {}
        for track in subjects:
            if isinstance(track, dict) and track.get("speaker"):
                subject_by_speaker[str(track["speaker"])] = track

        default_focus_x = float((face_analysis or {}).get("focus_x", 0.5))
        MIN_HOLD = 1.8
        INTERJECTION_MAX = 0.85
        IGNORABLE_WORDS = {"iya", "oh", "hah", "betul", "oke", "siap", "hmm", "ya", "ah"}

        filtered_turns = []
        for turn in turns:
            if not isinstance(turn, dict):
                continue
            t_start = float(turn.get("start") or 0.0)
            t_end = float(turn.get("end") or t_start + 1.0)
            t_dur = t_end - t_start
            text = str(turn.get("text") or "").strip().lower().strip(".,!?;:")
            # Suppress very brief backchannels
            if t_dur < INTERJECTION_MAX and text in IGNORABLE_WORDS:
                continue
            filtered_turns.append(turn)

        if not filtered_turns:
            cuts.append({
                "start": 0.0,
                "end": clip_duration,
                "focus_x": default_focus_x,
                "focus_y": 0.45,
                "shot": "medium",
                "reason": "stable_talking_head",
            })
            return cuts, focus_events

        current_cut_start = 0.0
        current_speaker = filtered_turns[0].get("speaker") or "speaker_1"
        sub0 = subject_by_speaker.get(current_speaker)
        current_focus_x = float(sub0["focus_x"]) if sub0 and sub0.get("focus_x") is not None else default_focus_x

        for turn in filtered_turns[1:]:
            t_start = max(0.0, min(clip_duration, float(turn.get("start") or 0.0)))
            speaker = turn.get("speaker") or "speaker_1"
            if speaker != current_speaker and (t_start - current_cut_start) >= MIN_HOLD:
                cuts.append({
                    "start": round(current_cut_start, 3),
                    "end": round(t_start, 3),
                    "speaker": current_speaker,
                    "focus_x": current_focus_x,
                    "focus_y": 0.45,
                    "shot": "medium",
                    "reason": "speaker_handoff",
                })
                current_cut_start = t_start
                current_speaker = speaker
                sub = subject_by_speaker.get(speaker)
                current_focus_x = float(sub["focus_x"]) if sub and sub.get("focus_x") is not None else default_focus_x

        cuts.append({
            "start": round(current_cut_start, 3),
            "end": round(clip_duration, 3),
            "speaker": current_speaker,
            "focus_x": current_focus_x,
            "focus_y": 0.45,
            "shot": "medium",
            "reason": "final_speaker_hold",
        })
        return cuts, focus_events

    def _plan_podcast_keyframes(self, story_beats, cuts, clip_duration, punch_scale, min_motion_gap):
        """Plan event-driven punch-in and reaction holds without random timer zoom."""
        keyframes = []
        last_motion = -10.0
        cut_times = [c["start"] for c in cuts if isinstance(c, dict)]

        for beat in story_beats or []:
            if not isinstance(beat, dict):
                continue
            b_time = float(beat.get("time") or 0.0)
            b_type = str(beat.get("type") or "").upper()
            # Anti-overedit: do not punch-in if a cut occurred within 0.8s or last motion was too recent
            if any(abs(b_time - ct) < 0.8 for ct in cut_times):
                continue
            if b_time - last_motion < min_motion_gap:
                continue

            hold_end = min(clip_duration - 0.2, b_time + 2.0)
            if hold_end <= b_time + 0.6:
                continue

            if b_type in {EVENT_IMPORTANT_POINT, EVENT_QUESTION, EVENT_PAYOFF, "PUNCH_IN", "EMPHASIS", "INSIGHT", "KEY_POINT"}:
                is_insight = (b_type == "INSIGHT") or ("insight" in str(beat.get("reason", "")).lower())
                keyframes.append(
                    create_keyframe(
                        start_time=b_time,
                        end_time=hold_end,
                        event_type=KEYFRAME_PUNCH_IN,
                        start_scale=1.00,
                        end_scale=punch_scale,
                        reason="insight_punch_in" if is_insight else "important_point_emphasis",
                    )
                )
                last_motion = hold_end
            elif b_type in {EVENT_REACTION, "REACTION", "LAUGH"}:
                keyframes.append(
                    create_keyframe(
                        start_time=b_time,
                        end_time=hold_end,
                        event_type=KEYFRAME_REACTION_FOCUS,
                        start_scale=1.00,
                        end_scale=min(1.05, punch_scale),
                        reason="reaction_hold",
                    )
                )
                last_motion = hold_end
        return keyframes

    def _plan_overlays(self, transcript, visual_detections, clip_duration, story_beats=None):
        """Source-based overlay foundation for chart, screen, product, or demonstration (Phase H)."""
        overlays = []
        # 1. Checks if visual detection mentions a screen, chart, slide, or product
        detections = visual_detections or []
        for det in detections:
            if not isinstance(det, dict):
                continue
            det_type = str(det.get("type") or "").upper()
            d_time = float(det.get("time") or 0.0)
            d_dur = float(det.get("duration") or 2.5)
            if det_type in {"SCREEN_SHARE", "CHART", "SLIDE"}:
                overlays.append(
                    create_overlay_event(
                        start_time=d_time,
                        end_time=min(clip_duration, d_time + d_dur),
                        overlay_type=OVERLAY_SCREEN_FOCUS,
                        placement="center",
                        region=det.get("region") or [0.1, 0.1, 0.8, 0.8],
                        reason="visual_chart_reference",
                    )
                )
            elif det_type in {"PRODUCT", "PRODUCT_CLOSEUP"}:
                overlays.append(
                    create_overlay_event(
                        start_time=d_time,
                        end_time=min(clip_duration, d_time + d_dur),
                        overlay_type=OVERLAY_PRODUCT_CROP,
                        placement="center",
                        region=det.get("region") or [0.15, 0.15, 0.70, 0.70],
                        reason="product_footage_overlay",
                    )
                )

        # 2. Checks story_beats for source-based screen, b-roll, or visual references
        for beat in (story_beats or []):
            if not isinstance(beat, dict):
                continue
            b_time = float(beat.get("time") or 0.0)
            b_type = str(beat.get("type") or "").upper()
            if b_time >= clip_duration - 0.5:
                continue
            if b_type in {EVENT_SCREEN_REFERENCE, "SCREEN_REFERENCE"}:
                overlays.append(
                    create_overlay_event(
                        start_time=b_time,
                        end_time=min(clip_duration, b_time + 2.5),
                        overlay_type=OVERLAY_SCREEN_FOCUS,
                        placement="center",
                        region=[0.1, 0.1, 0.8, 0.8],
                        reason="source_screen_overlay",
                    )
                )
            elif b_type in {EVENT_BROLL_OPPORTUNITY, "BROLL_OPPORTUNITY", EVENT_VISUAL_REFERENCE, "VISUAL_REFERENCE"}:
                overlays.append(
                    create_overlay_event(
                        start_time=b_time,
                        end_time=min(clip_duration, b_time + 2.5),
                        overlay_type=OVERLAY_SOURCE_REGION,
                        placement="top",
                        region=[0.05, 0.05, 0.90, 0.50],
                        reason="source_broll_overlay",
                    )
                )
        return overlays


class BaseEditStrategy:
    def __init__(self, mode="auto", profile=AUTO_EDIT):
        self.mode = mode
        self.profile = profile

    def configure_render_plan(self, clip_candidate, base_options=None):
        options = dict(base_options or {})
        options["contentMode"] = self.mode
        options["editingProfile"] = self.profile
        return options


class AutoEditStrategy(BaseEditStrategy):
    def __init__(self):
        super().__init__("auto", AUTO_EDIT)


class PodcastEditStrategy(BaseEditStrategy):
    def __init__(self):
        super().__init__("podcast", PODCAST_DYNAMIC)


class GamingEditStrategy(BaseEditStrategy):
    def __init__(self):
        super().__init__("gaming", GAMING_SPLIT)


class SummaryEditStrategy(BaseEditStrategy):
    def __init__(self):
        super().__init__("summary", SUMMARY_COMPOSED)


class LandscapeBlurEditStrategy(BaseEditStrategy):
    def __init__(self):
        super().__init__("landscape_blur", LANDSCAPE_BLUR)

    def configure_render_plan(self, clip_candidate, base_options=None):
        options = super().configure_render_plan(clip_candidate, base_options)
        options["smartCrop"] = False
        options["landscapeBlur"] = True
        return options


class ContentModeRouter:
    _STRATEGIES = {
        "auto": AutoEditStrategy,
        "podcast": PodcastEditStrategy,
        "gaming": GamingEditStrategy,
        "summary": SummaryEditStrategy,
        "landscape_blur": LandscapeBlurEditStrategy,
    }

    @classmethod
    def get_strategy(cls, mode="auto"):
        normalized = str(mode or "auto").strip().lower()
        strategy_cls = cls._STRATEGIES.get(normalized, AutoEditStrategy)
        return strategy_cls()


# Speaker hysteresis to prevent rapid camera switching
# Minimum duration (in seconds) a speaker must be active before camera switches
MIN_SPEAKER_DURATION = 0.8

SHOT_ZOOM = {
    "wide": 1.0,
    "split": 1.0,
    "medium": 1.035,
    "reaction": 1.055,
    "punch_in": 1.105,
    "close": 1.125,
}


class CameraEngine:
    def __init__(self):
        self._last_speaker = None
        self._last_speaker_start = None
        self._last_layout = None
        self._last_zone = None
        self._last_shot = None

    def select_layout(self, speakers=None, scene=None):
        speakers = speakers or []
        scene = scene or {}
        face_count = int(scene.get("face_count") or len(speakers) or 0)
        body_tracking = bool(scene.get("body_tracking"))
        simultaneous = bool(scene.get("simultaneous") or scene.get("split_screen"))
        stability = float(scene.get("stability") or 70)
        average_span = float(scene.get("average_span") or 0)
        speaker_count = max(1, int(scene.get("speaker_count") or face_count or len(speakers) or 1))
        overlap = float(scene.get("overlap_seconds") or 0)
        if speaker_count >= 2 and (simultaneous or overlap > 1.0):
            return SPLIT_SCREEN
        if face_count >= 1:
            return DIRECTOR_CUT
        if body_tracking:
            return BODY_TRACK
        return CENTER_CROP

    def camera_score(self, layout):
        return {
            SPLIT_SCREEN: 20,
            EDITOR_DIRECTOR: 18,
            DIRECTOR_CUT: 15,
            FACE_TRACK: 10,
            BODY_TRACK: 5,
            CENTER_CROP: 0,
        }.get(layout, 0)

    def build_shot_sequence(self, speakers=None, scene=None, duration=10.0):
        """Build camera events from measured subjects and editorial evidence.

        The public method stays backward compatible, but evidence-aware callers
        no longer receive a repeated LEFT/CENTER/RIGHT timer pattern. The full
        plan is available through build_editor_plan().
        """
        return self.build_editor_plan(
            speakers=speakers,
            scene=scene,
            duration=duration,
        )["camera_events"]

    def build_editor_plan(self, speakers=None, scene=None, duration=10.0):
        speakers = speakers or []
        scene = scene or {}
        duration = max(2.0, float(duration or 10.0))
        subjects = self._normalized_subjects(speakers, scene)
        activity_events = self._normalized_activity_events(scene, subjects, duration)
        story_beats = self._normalized_story_beats(scene, duration)

        if not subjects or not activity_events:
            legacy = self._build_legacy_shot_sequence(speakers, scene, duration)
            return {
                "schema": EDITOR_PLAN_SCHEMA,
                "director": "legacy_safe_fallback",
                "evidence_mode": "fallback_pattern",
                "content_type": str(scene.get("content_type") or "general").lower(),
                "camera_style": str(scene.get("camera_style") or "recommended").lower(),
                "subject_tracks": subjects,
                "speaker_subject_map": {},
                "story_beats": story_beats,
                "camera_events": legacy,
                "zoom_events": self._zoom_events(legacy),
                "qa": self._plan_qa(legacy, subjects, duration, rejected=0),
            }

        plan = self._build_evidence_editor_plan(
            speakers,
            scene,
            duration,
            subjects,
            activity_events,
            story_beats,
        )
        return plan

    def _build_evidence_editor_plan(
        self,
        speakers,
        scene,
        duration,
        subjects,
        activity_events,
        story_beats,
    ):
        subject_by_id = {item["subject_id"]: item for item in subjects}
        content_type = str(scene.get("content_type") or "general").lower()
        camera_style = str(scene.get("camera_style") or "recommended").lower()
        grounding_mode = str(scene.get("speaker_grounding_mode") or "STANDARD").upper()
        min_hold, max_hold = self._rhythm_rules(content_type, camera_style)
        zoom_cap = self._resolution_zoom_cap(scene)
        speaker_by_subject = {
            str(item.get("subject_id")): str(item.get("speaker") or "")
            for item in speakers
            if isinstance(item, dict) and item.get("subject_id")
        }
        speaker_subject_map = {
            str(item.get("speaker")): str(item.get("subject_id"))
            for item in speakers
            if isinstance(item, dict) and item.get("speaker") and item.get("subject_id")
        }

        if bool(scene.get("split_screen")) and len(subjects) >= 2:
            split_subjects = sorted(
                subjects,
                key=lambda item: (item.get("visibility", 0), item.get("confidence", 0)),
                reverse=True,
            )[:2]
            event = {
                "start": 0.0,
                "end": round(duration, 3),
                "event": "SPLIT",
                "shot": "split",
                "subject_id": None,
                "subject_ids": [item["subject_id"] for item in split_subjects],
                "speaker": "/".join(
                    speaker_by_subject.get(item["subject_id"]) or item["subject_id"]
                    for item in split_subjects
                ),
                "zone": "CENTER",
                "focus_x": round(
                    sum(item["focus_x"] for item in split_subjects) / len(split_subjects),
                    4,
                ),
                "zoom": 1.0,
                "transition": "hard_cut",
                "transition_ms": 200,
                "reason": "verified_simultaneous_speech",
                "confidence": round(
                    min(item.get("confidence", 0.5) for item in split_subjects),
                    3,
                ),
                "evidence": "subject_tracks+speaker_overlap",
            }
            events = [event]
            return {
                "schema": EDITOR_PLAN_SCHEMA,
                "director": "subject_first_event_director",
                "evidence_mode": "verified_split",
                "content_type": content_type,
                "camera_style": camera_style,
                "subject_tracks": subjects,
                "speaker_subject_map": speaker_subject_map,
                "story_beats": story_beats,
                "camera_events": events,
                "zoom_events": self._zoom_events(events),
                "qa": self._plan_qa(events, subjects, duration, rejected=0),
            }

        proposals = []
        verified_speaker_timing = bool(scene.get("speaker_evidence"))
        first_activity_index = next(
            (
                index
                for index, item in enumerate(activity_events)
                if int(item.get("run_samples") or 1) >= 2
                or float(item.get("confidence") or 0.0) >= 0.80
            ),
            0,
        )
        first_activity = activity_events[first_activity_index]
        first_subject = subject_by_id.get(first_activity["subject_id"])
        if first_subject is not None:
            proposals.append(
                self._subject_event(
                    0.0,
                    first_subject,
                    speaker_by_subject,
                    "medium",
                    "initial_active_subject",
                    first_activity.get("confidence", 0.65),
                    "CUT",
                    priority=100,
                    zoom_cap=zoom_cap,
                )
            )

        last_subject_id = first_activity.get("subject_id")
        last_switch = 0.0
        for activity in activity_events[first_activity_index + 1:]:
            subject_id = activity.get("subject_id")
            if not subject_id or subject_id == last_subject_id:
                continue
            subject = subject_by_id.get(subject_id)
            if subject is None:
                continue
            event_time = max(0.0, min(duration - 0.2, float(activity.get("time") or 0.0)))
            confidence = max(0.0, min(1.0, float(activity.get("confidence") or 0.0)))
            elapsed = event_time - last_switch
            sustained = (
                bool(activity.get("sustained"))
                or int(activity.get("run_samples") or 1) >= 2
                or float(activity.get("run_duration") or 0.0) >= 0.75
            )
            run_duration = max(0.0, float(activity.get("run_duration") or 0.0))
            grounded_turn = bool(activity.get("speaker_verified"))
            high_visual_confidence = confidence >= 0.80
            strong_turn_evidence = (
                max(0.0, min(1.0, float(activity.get("turn_evidence") or 0.0))) >= 0.50
                and sustained
            )
            turn_role = self._turn_role_at(story_beats, event_time)
            editorial_turn = turn_role in {"questioner", "answerer"}
            if grounded_turn and run_duration < 0.65 and not editorial_turn:
                # Backchannels such as "iya", "hm", and a short laugh should
                # not steal the camera from the main answer.
                continue
            if grounded_turn:
                if confidence < 0.60:
                    continue
            elif verified_speaker_timing:
                if (
                    (confidence < 0.68 and not strong_turn_evidence)
                    or not (sustained or high_visual_confidence)
                ):
                    continue
            elif (
                (confidence < 0.72 and not strong_turn_evidence)
                or not (sustained or high_visual_confidence)
            ):
                continue
            effective_min_hold = min_hold
            if grounded_turn and sustained:
                effective_min_hold = min(min_hold, 0.72 if editorial_turn else 1.0)
            if elapsed < effective_min_hold:
                # A visual-only confidence spike is not enough to interrupt a
                # shot early. Only verified speaker grounding may use the
                # high-confidence fast path for a genuine turn boundary.
                if not grounded_turn or confidence < 0.88:
                    continue
            cut_score, cut_threshold, cut_evidence = self._natural_cut_score(
                activity,
                event_time,
                elapsed,
                max_hold,
                story_beats,
                verified_speaker_timing,
                camera_style,
            )
            if cut_score < cut_threshold:
                continue
            proposal = self._subject_event(
                event_time,
                subject,
                speaker_by_subject,
                "medium",
                (
                    "questioner_turn"
                    if verified_speaker_timing and turn_role == "questioner"
                    else (
                        "answerer_turn"
                        if verified_speaker_timing and turn_role == "answerer"
                        else "active_subject_change"
                    )
                ),
                confidence,
                "CUT",
                priority=95,
                zoom_cap=zoom_cap,
            )
            proposal.update(
                {
                    "cut_score": round(cut_score, 3),
                    "cut_threshold": round(cut_threshold, 3),
                    "cut_evidence": cut_evidence,
                }
            )
            proposals.append(proposal)
            last_subject_id = subject_id
            last_switch = event_time

        for beat in story_beats:
            beat_time = max(0.0, min(duration - 0.25, float(beat.get("time") or 0.0)))
            if beat_time < 0.45:
                continue
            beat_subject_id = str(beat.get("subject_id") or "").strip()
            beat_speaker = str(beat.get("speaker") or "").strip()
            if not beat_subject_id and beat.get("speaker_verified") and beat_speaker:
                beat_subject_id = speaker_subject_map.get(beat_speaker) or ""
            # Story-guided observations are sampled just after the transcript
            # boundary so mouth motion is measurable. A tightly bounded
            # look-ahead lets the beat use that evidence without moving normal
            # camera cuts early.
            active = self._activity_at(activity_events, beat_time, lookahead=0.35)
            subject = subject_by_id.get(beat_subject_id or (active or {}).get("subject_id"))
            if subject is None:
                continue
            beat_type = str(beat.get("type") or "emphasis").lower()
            score = max(0.0, min(1.0, float(beat.get("confidence") or 0.6)))
            if beat_type in {"reveal", "payoff", "punchline", "emotion_peak"}:
                shot = "close"
                priority = 82
            elif beat_type in {"question", "conflict", "important_statement", "hook"}:
                shot = "punch_in"
                priority = 76
            else:
                shot = "medium"
                priority = 60
            proposals.append(
                self._subject_event(
                    beat_time,
                    subject,
                    speaker_by_subject,
                    shot,
                    f"story_{beat_type}",
                    score,
                    "PUNCH_IN" if shot in {"close", "punch_in"} else "REFRAME",
                    priority=priority,
                    zoom_cap=zoom_cap,
                )
            )
            if shot in {"close", "punch_in"} and beat_time + 1.8 < duration:
                proposals.append(
                    self._subject_event(
                        min(duration - 0.2, beat_time + 2.0),
                        subject,
                        speaker_by_subject,
                        "medium",
                        "editorial_release",
                        score,
                        "PUNCH_OUT",
                        priority=45,
                        zoom_cap=zoom_cap,
                    )
                )

        proposals = self._dedupe_proposals(proposals, duration)
        # Visual-only tracking is deliberately more conservative than verified
        # speaker grounding. Sparse face samples can briefly swap identities;
        # enforcing an editorial hold prevents nervous one-second ping-pong cuts.
        minimum_event_gap = (
            0.72
            if grounding_mode == "FULL"
            else max(1.10, min_hold * 0.90)
        )
        events, rejected = self._finalize_events(
            proposals,
            subject_by_id,
            duration,
            min_event_gap=minimum_event_gap,
        )

        if not events:
            strongest = max(
                subjects,
                key=lambda item: (
                    item.get("expression_score", 0),
                    item.get("activity_average", 0),
                    item.get("confidence", 0),
                    item.get("visibility", 0),
                ),
            )
            events = [
                self._subject_event(
                    0.0,
                    strongest,
                    speaker_by_subject,
                    "medium",
                    "safe_verified_subject",
                    strongest.get("confidence", 0.6),
                    "CUT",
                    priority=100,
                    zoom_cap=zoom_cap,
                )
            ]
            events[0]["end"] = round(duration, 3)

        evidence_mode = (
            "audio_visual_grounding+story_evidence"
            if grounding_mode == "FULL"
            else "visual_activity+story_evidence"
        )
        return {
            "schema": EDITOR_PLAN_SCHEMA,
            "director": "subject_first_event_director",
            "evidence_mode": evidence_mode,
            "speaker_grounding_mode": grounding_mode,
            "content_type": content_type,
            "camera_style": camera_style,
            "subject_tracks": subjects,
            "speaker_subject_map": speaker_subject_map,
            "story_beats": story_beats,
            "camera_events": events,
            "zoom_events": self._zoom_events(events),
            "qa": self._plan_qa(events, subjects, duration, rejected=rejected),
        }

    @staticmethod
    def _normalized_subjects(speakers, scene):
        raw_subjects = scene.get("subject_tracks") or []
        subjects = []
        seen = set()
        minimum_samples = max(2, int(scene.get("min_subject_samples") or 2))
        for index, item in enumerate(raw_subjects):
            if not isinstance(item, dict):
                continue
            subject_id = str(item.get("subject_id") or item.get("track_id") or f"person_{index + 1:02d}")
            if subject_id in seen:
                continue
            try:
                focus_x = max(0.06, min(0.94, float(item.get("focus_x", item.get("x", 0.5)))))
                visibility = max(0.0, min(1.0, float(item.get("visibility") or 0.0)))
                confidence = max(0.0, min(1.0, float(item.get("confidence") or visibility or 0.5)))
                safe_visibility = max(0.0, min(1.0, float(item.get("safe_visibility") or 0.0)))
                focus_y = (
                    max(0.0, min(1.0, float(item.get("focus_y"))))
                    if item.get("focus_y") is not None
                    else None
                )
                sample_count = (
                    max(0, int(item.get("sample_count")))
                    if item.get("sample_count") is not None
                    else None
                )
            except (TypeError, ValueError):
                continue
            if safe_visibility and safe_visibility < 0.5:
                continue
            if sample_count is not None and sample_count < minimum_samples:
                continue
            if focus_y is not None and str(item.get("kind") or "face").lower() == "face":
                if not 0.10 <= focus_y <= 0.90:
                    continue
            if visibility < 0.08 and confidence < 0.40:
                continue
            seen.add(subject_id)
            subjects.append(
                {
                    **item,
                    "subject_id": subject_id,
                    "focus_x": round(focus_x, 4),
                    "zone": CameraEngine._zone_for_focus(focus_x),
                    "visibility": round(visibility, 4),
                    "confidence": round(confidence, 4),
                    "safe_visibility": round(safe_visibility, 4),
                }
            )
        if subjects:
            return subjects

        for index, speaker in enumerate(speakers or []):
            if not isinstance(speaker, dict) or speaker.get("focus_x") is None:
                continue
            subject_id = str(speaker.get("subject_id") or f"person_{index + 1:02d}")
            focus_x = max(0.06, min(0.94, float(speaker.get("focus_x") or 0.5)))
            subjects.append(
                {
                    "subject_id": subject_id,
                    "focus_x": round(focus_x, 4),
                    "zone": CameraEngine._zone_for_focus(focus_x),
                    "visibility": 1.0,
                    "confidence": max(0.0, min(1.0, float(speaker.get("confidence") or 0.65))),
                    "safe_visibility": 1.0,
                }
            )
        return subjects

    @staticmethod
    def _normalized_activity_events(scene, subjects, duration):
        valid_ids = {item["subject_id"] for item in subjects}
        events = []
        for item in scene.get("activity_events") or []:
            if not isinstance(item, dict):
                continue
            subject_id = str(item.get("subject_id") or item.get("track_id") or "")
            if subject_id not in valid_ids:
                continue
            try:
                event_time = max(0.0, min(duration, float(item.get("time") or 0.0)))
                confidence = max(0.0, min(1.0, float(item.get("confidence") or item.get("activity_score") or 0.5)))
            except (TypeError, ValueError):
                continue
            events.append({**item, "time": round(event_time, 3), "subject_id": subject_id, "confidence": confidence})
        events.sort(key=lambda item: item["time"])
        if events:
            runs = []
            run_start = 0
            for index in range(1, len(events) + 1):
                if index < len(events) and events[index]["subject_id"] == events[run_start]["subject_id"]:
                    continue
                runs.append((run_start, index))
                run_start = index
            for run_index, (start_index, end_index) in enumerate(runs):
                if end_index - start_index != 1 or run_index == 0 or run_index == len(runs) - 1:
                    continue
                previous_subject = events[runs[run_index - 1][0]]["subject_id"]
                next_subject = events[runs[run_index + 1][0]]["subject_id"]
                if previous_subject == next_subject and events[start_index]["confidence"] < 0.78:
                    events[start_index]["subject_id"] = previous_subject
                    events[start_index]["evidence"] = "suppressed_single_sample_challenger"

            run_start = 0
            for index in range(1, len(events) + 1):
                if index < len(events) and events[index]["subject_id"] == events[run_start]["subject_id"]:
                    continue
                run_samples = index - run_start
                run_duration = max(
                    0.0,
                    float(events[index - 1].get("time") or 0.0)
                    - float(events[run_start].get("time") or 0.0),
                )
                for event_index in range(run_start, index):
                    events[event_index].setdefault("run_samples", run_samples)
                    events[event_index].setdefault("run_duration", round(run_duration, 3))
                    events[event_index].setdefault("sustained", run_samples >= 2)
                run_start = index
        if not events and subjects:
            strongest = max(
                subjects,
                key=lambda item: (
                    item.get("expression_score", 0),
                    item.get("activity_average", 0),
                    item.get("confidence", 0),
                    item.get("visibility", 0),
                ),
            )
            events = [{"time": 0.0, "subject_id": strongest["subject_id"], "confidence": strongest.get("confidence", 0.6)}]
        return events

    @staticmethod
    def _normalized_story_beats(scene, duration):
        beats = []
        previous_time = -999.0
        for item in sorted(
            [item for item in scene.get("story_beats") or [] if isinstance(item, dict)],
            key=lambda item: float(item.get("time") or 0.0),
        ):
            try:
                beat_time = max(0.0, min(duration, float(item.get("time") or 0.0)))
                confidence = max(0.0, min(1.0, float(item.get("confidence") or 0.6)))
            except (TypeError, ValueError):
                continue
            if beat_time - previous_time < 1.25:
                continue
            beats.append({**item, "time": round(beat_time, 3), "confidence": confidence})
            previous_time = beat_time
        return beats[:12]

    @staticmethod
    def _rhythm_rules(content_type, camera_style):
        if camera_style == "calm":
            return 2.8, 8.5
        if camera_style == "dynamic":
            return 1.35, 4.8
        if content_type in {"news", "tutorial"}:
            return 3.0, 8.0
        if content_type in {"storytelling", "story"}:
            return 2.6, 7.5
        if content_type in {"music", "performance"}:
            return 2.2, 6.5
        if content_type in {"podcast", "interview"}:
            return 1.8, 6.2
        if content_type in {"comedy", "gaming", "reaction"}:
            return 1.25, 4.5
        return 1.8, 6.5

    @staticmethod
    def _resolution_zoom_cap(scene):
        try:
            source_height = int(scene.get("source_height") or 1080)
        except (TypeError, ValueError):
            source_height = 1080
        if source_height < 900:
            return 1.075
        if source_height < 1440:
            return 1.16
        if source_height < 2160:
            return 1.19
        return 1.22

    @staticmethod
    def _natural_cut_score(
        activity,
        event_time,
        elapsed,
        max_hold,
        story_beats,
        verified_speaker_timing,
        camera_style,
    ):
        confidence = max(0.0, min(1.0, float(activity.get("confidence") or 0.0)))
        sustained = bool(activity.get("sustained")) or int(activity.get("run_samples") or 1) >= 2
        grounded_turn = bool(activity.get("speaker_verified"))
        if grounded_turn and sustained:
            speaker_change = 1.0
        elif verified_speaker_timing:
            speaker_change = confidence * (0.86 if sustained else 0.52)
        else:
            speaker_change = confidence * (1.0 if sustained or confidence >= 0.80 else 0.58)
        story_beat = max(
            [
                max(0.0, min(1.0, float(item.get("confidence") or 0.0)))
                for item in story_beats or []
                if abs(float(item.get("time") or 0.0) - float(event_time or 0.0)) <= 1.35
            ]
            or [0.0]
        )
        reaction = max(0.0, min(1.0, float(activity.get("reaction_score") or 0.0)))
        scene_change = max(0.0, min(1.0, float(activity.get("scene_change") or 0.0)))
        visual_need = max(
            confidence if sustained or confidence >= 0.80 else confidence * 0.6,
            max(0.0, min(1.0, float(activity.get("expression_score") or 0.0))),
        )
        shot_fatigue = max(
            0.0,
            min(1.0, float(elapsed or 0.0) / max(float(max_hold or 1.0), 1.0)),
        )
        run_duration = max(0.0, float(activity.get("run_duration") or 0.0))
        measured_turn = max(
            0.0,
            min(
                1.0,
                float(activity.get("turn_evidence") or 0.0)
                or min(1.0, run_duration / 2.2) * confidence,
            ),
        )
        if grounded_turn and sustained:
            measured_turn = max(measured_turn, confidence * 0.90)
        score = (
            speaker_change * 0.30
            + story_beat * 0.20
            + reaction * 0.12
            + scene_change * 0.08
            + visual_need * 0.12
            + measured_turn * 0.12
            + shot_fatigue * 0.06
        )
        style = str(camera_style or "balanced").lower()
        if style == "calm":
            threshold = 0.48
        elif style == "dynamic":
            threshold = 0.34
        else:
            threshold = 0.38
        return score, threshold, {
            "speakerChange": round(speaker_change, 3),
            "storyBeat": round(story_beat, 3),
            "reaction": round(reaction, 3),
            "sceneChange": round(scene_change, 3),
            "visualNeed": round(visual_need, 3),
            "turnEvidence": round(measured_turn, 3),
            "shotFatigue": round(shot_fatigue, 3),
        }

    @staticmethod
    def _turn_role_at(story_beats, event_time):
        event_time = float(event_time or 0.0)
        nearby = sorted(
            [
                item
                for item in story_beats or []
                if str(item.get("type") or "").lower() == "question"
            ],
            key=lambda item: float(item.get("time") or 0.0),
        )
        for question in nearby:
            question_start = float(question.get("time") or 0.0)
            question_end = max(
                question_start,
                float(question.get("end") or question_start),
            )
            if abs(question_start - event_time) <= 0.95:
                return "questioner"
            if question_end - 0.15 <= event_time <= question_end + 3.5:
                return "answerer"
        return None

    @staticmethod
    def _zone_for_focus(focus_x):
        if float(focus_x) < 0.34:
            return "LEFT"
        if float(focus_x) > 0.66:
            return "RIGHT"
        return "CENTER"

    @staticmethod
    def _activity_at(activity_events, event_time, lookahead=0.0):
        if not activity_events:
            return None
        event_time = float(event_time or 0.0)
        lookahead = max(0.0, min(0.5, float(lookahead or 0.0)))
        active = activity_events[0]
        best_distance = abs(float(active.get("time") or 0.0) - event_time)
        for item in activity_events:
            item_time = float(item.get("time") or 0.0)
            if item_time > event_time + lookahead:
                break
            if item_time <= event_time or lookahead > 0.0:
                distance = abs(item_time - event_time)
                if distance <= best_distance:
                    active = item
                    best_distance = distance
        return active

    @staticmethod
    def _subject_event(
        event_time,
        subject,
        speaker_by_subject,
        shot,
        reason,
        confidence,
        event_type,
        priority,
        zoom_cap,
    ):
        subject_id = subject["subject_id"]
        zoom = CameraEngine._subject_framing_zoom(subject, shot, zoom_cap)
        return {
            "start": round(max(0.0, float(event_time or 0.0)), 3),
            "event": event_type,
            "shot": shot,
            "subject_id": subject_id,
            "subject_ids": [subject_id],
            "speaker": speaker_by_subject.get(subject_id) or subject_id,
            "zone": subject.get("zone") or CameraEngine._zone_for_focus(subject.get("focus_x", 0.5)),
            "focus_x": round(max(0.06, min(0.94, float(subject.get("focus_x") or 0.5))), 4),
            "focus_y": (
                round(max(0.08, min(0.92, float(subject.get("focus_y")))), 4)
                if subject.get("focus_y") is not None
                else None
            ),
            "zoom": round(max(1.0, zoom), 4),
            "transition": "hard_cut" if event_type == "CUT" else "quick_zoom",
            "transition_ms": 180 if event_type == "CUT" else 220,
            "reason": reason,
            "confidence": round(max(0.0, min(1.0, float(confidence or 0.0))), 3),
            "evidence": "verified_subject_track",
            "_priority": int(priority),
        }

    @staticmethod
    def _subject_framing_zoom(subject, shot, zoom_cap):
        """Choose a measured base crop so a distant face is not left tiny.

        Story beats may still request close/punch-in shots, but ordinary medium
        shots receive only the minimum scale needed by the detected face area.
        This is deterministic framing, not a timer-driven decorative zoom.
        """
        zoom = SHOT_ZOOM.get(shot, SHOT_ZOOM["medium"])
        if str(subject.get("kind") or "face").lower() != "face":
            return min(float(zoom_cap), zoom)
        try:
            face_area = max(0.0, float(subject.get("average_area") or 0.0))
        except (TypeError, ValueError):
            face_area = 0.0
        if face_area > 0.0 and shot in {"medium", "reaction"}:
            if face_area < 0.0025:
                zoom = max(zoom, 1.12)
            elif face_area < 0.0045:
                zoom = max(zoom, 1.10)
            elif face_area < 0.0075:
                zoom = max(zoom, 1.075)
            elif face_area < 0.012:
                zoom = max(zoom, 1.05)
        return min(float(zoom_cap), zoom)

    @staticmethod
    def _dedupe_proposals(proposals, duration):
        proposals = sorted(
            [item for item in proposals if float(item.get("start") or 0.0) < duration],
            key=lambda item: (float(item.get("start") or 0.0), -int(item.get("_priority") or 0)),
        )
        deduped = []
        for proposal in proposals:
            if deduped and abs(float(proposal["start"]) - float(deduped[-1]["start"])) < 0.45:
                if int(proposal.get("_priority") or 0) > int(deduped[-1].get("_priority") or 0):
                    deduped[-1] = proposal
                continue
            if (
                deduped
                and proposal.get("subject_id") == deduped[-1].get("subject_id")
                and proposal.get("shot") == deduped[-1].get("shot")
                and abs(float(proposal.get("zoom") or 1.0) - float(deduped[-1].get("zoom") or 1.0)) < 0.01
            ):
                continue
            deduped.append(proposal)
        return deduped

    def _insert_long_take_resets(
        self,
        proposals,
        activity_events,
        subject_by_id,
        speaker_by_subject,
        duration,
        max_hold,
        zoom_cap,
    ):
        if not proposals:
            return proposals
        result = list(proposals)
        starts = sorted(float(item.get("start") or 0.0) for item in proposals)
        starts.append(duration)
        for index in range(len(starts) - 1):
            cursor = starts[index]
            next_start = starts[index + 1]
            reset_index = 0
            while next_start - cursor > max_hold + 0.5:
                cursor += max_hold
                active = self._activity_at(activity_events, cursor)
                subject = subject_by_id.get((active or {}).get("subject_id"))
                if subject is None:
                    break
                shot = "punch_in" if reset_index % 2 == 0 else "medium"
                result.append(
                    self._subject_event(
                        cursor,
                        subject,
                        speaker_by_subject,
                        shot,
                        "long_take_visual_reset",
                        (active or {}).get("confidence", 0.55),
                        "REFRAME",
                        priority=35,
                        zoom_cap=zoom_cap,
                    )
                )
                reset_index += 1
        return self._dedupe_proposals(result, duration)

    @staticmethod
    def _finalize_events(proposals, subject_by_id, duration, min_event_gap):
        events = []
        rejected = {
            "invalid_subject": 0,
            "invalid_crop": 0,
            "timing": 0,
        }
        for proposal in sorted(proposals, key=lambda item: float(item.get("start") or 0.0)):
            subject_id = proposal.get("subject_id")
            subject_ids = proposal.get("subject_ids") or ([subject_id] if subject_id else [])
            if not subject_ids or any(item not in subject_by_id for item in subject_ids):
                rejected["invalid_subject"] += 1
                continue
            focus_x = float(proposal.get("focus_x") or 0.5)
            if not math.isfinite(focus_x) or not 0.05 <= focus_x <= 0.95:
                rejected["invalid_crop"] += 1
                continue
            if events and float(proposal.get("start") or 0.0) - float(events[-1].get("start") or 0.0) < min_event_gap:
                if int(proposal.get("_priority") or 0) <= int(events[-1].get("_priority") or 0):
                    rejected["timing"] += 1
                    continue
                events[-1] = proposal
                continue
            events.append(proposal)

        for index, event in enumerate(events):
            event["start"] = round(0.0 if index == 0 else float(event.get("start") or 0.0), 3)
            event["end"] = round(
                duration if index == len(events) - 1 else max(event["start"] + 0.2, float(events[index + 1].get("start") or duration)),
                3,
            )
            event.pop("_priority", None)
        return events, rejected

    @staticmethod
    def _zoom_events(events):
        return [
            {
                "start": item.get("start"),
                "end": item.get("end"),
                "zoom": item.get("zoom", 1.0),
                "transition_ms": item.get("transition_ms", 180),
                "reason": item.get("reason"),
            }
            for item in events
        ]

    @staticmethod
    def _plan_qa(events, subjects, duration, rejected=0):
        subject_ids = {item.get("subject_id") for item in subjects}
        if isinstance(rejected, dict):
            invalid_subjects = int(rejected.get("invalid_subject") or 0)
            invalid_crops = int(rejected.get("invalid_crop") or 0)
            suppressed_timing = int(rejected.get("timing") or 0)
        else:
            invalid_subjects = int(rejected or 0)
            invalid_crops = 0
            suppressed_timing = 0
        empty = 0
        for event in events:
            event_subjects = event.get("subject_ids") or ([event.get("subject_id")] if event.get("subject_id") else [])
            if not event_subjects or any(item not in subject_ids for item in event_subjects):
                empty += 1
        holds = [
            max(0.0, float(item.get("end") or 0.0) - float(item.get("start") or 0.0))
            for item in events
        ]
        subject_switch_holds = []
        active_subject = None
        active_since = 0.0
        for event in events:
            subject_id = event.get("subject_id")
            if not subject_id:
                continue
            event_start = float(event.get("start") or 0.0)
            if active_subject is None:
                active_subject = subject_id
                active_since = event_start
                continue
            if subject_id == active_subject:
                continue
            subject_switch_holds.append(max(0.0, event_start - active_since))
            active_subject = subject_id
            active_since = event_start
        return {
            "valid": bool(events) and empty == 0,
            "emptyShotCount": empty,
            "wallCropCount": empty + invalid_crops,
            "subjectLostCount": invalid_subjects,
            "wrongSpeakerCount": 0,
            "suppressedFastSwitchCount": suppressed_timing,
            "cameraSwitchCount": max(0, len(events) - 1),
            "subjectSwitchCount": len(subject_switch_holds),
            "rapidSubjectSwitchCount": sum(
                1 for hold in subject_switch_holds if hold < 1.10
            ),
            "minimumSubjectHoldSeconds": round(
                min(subject_switch_holds) if subject_switch_holds else float(duration or 0.0),
                3,
            ),
            "averageShotDuration": round(sum(holds) / max(len(holds), 1), 3),
            "maxShotDuration": round(max(holds) if holds else float(duration or 0.0), 3),
            "zoomEventCount": sum(1 for item in events if float(item.get("zoom") or 1.0) > 1.001),
            "lowConfidenceHardCutCount": sum(
                1
                for item in events
                if item.get("event") == "CUT"
                and item.get("reason") == "active_subject_change"
                and float(item.get("confidence") or 0.0) < 0.72
            ),
            "timerResetCount": sum(
                1
                for item in events
                if item.get("reason") == "long_take_visual_reset"
            ),
            "minimumAcceptedCutScore": round(
                min(
                    [
                        float(item.get("cut_score"))
                        for item in events
                        if item.get("cut_score") is not None
                    ]
                    or [1.0]
                ),
                3,
            ),
            "reactionValidity": "not_requested",
        }

    def _build_legacy_shot_sequence(self, speakers=None, scene=None, duration=10.0):
        speakers = speakers or []
        scene = scene or {}
        speaker_count = max(1, int(scene.get("speaker_count") or len(speakers) or 1))
        overlap = float(scene.get("overlap_seconds") or 0.0)
        emotion = float(scene.get("emotion") or 0.5)
        duration = max(2.0, float(duration or 10.0))
        content_type = str(scene.get("content_type") or "").lower()

        variation_seed = int(scene.get("variation_seed") or 0)
        if content_type == "music":
            shots = self._build_music_sequence(speakers, scene)
        elif content_type in {"review", "news", "vlog", "storytelling", "tutorial", "gaming"}:
            shots = self._build_content_sequence(content_type, speakers, scene, emotion)
        elif speaker_count >= 2 and overlap > 1.0:
            shots = self._build_split_sequence(speakers, scene)
        elif speaker_count == 1:
            shots = self._build_single_sequence(speakers, scene, duration, emotion)
        elif speaker_count == 2:
            shots = self._build_duo_sequence(speakers, scene, duration, emotion)
            if variation_seed % 2:
                shots = [shots[0], shots[2], shots[1], shots[3]]
        else:
            shots = self._build_multi_sequence(speakers, scene, duration, emotion)
            if variation_seed % 3 == 1 and len(shots) >= 4:
                shots = [shots[0], shots[2], shots[3], shots[1]]
            elif variation_seed % 3 == 2 and len(shots) >= 4:
                shots = [shots[0], shots[3], shots[1], shots[2]]

        # A short base pattern is repeated over long clips. Previously four
        # shots were stretched over an entire 2-3 minute clip, leaving one
        # speaker on screen for 30-45 seconds. Keep editorial decisions short
        # while retaining hard cuts and stable speaker zones.
        if content_type == "music":
            max_hold = 8.0
        elif content_type == "news":
            max_hold = 7.5
        elif content_type in {"review", "tutorial"}:
            max_hold = 6.5
        elif speaker_count == 1:
            max_hold = 6.8
        elif overlap > 1.0:
            max_hold = 8.0
        elif speaker_count == 2:
            max_hold = 5.8
        else:
            max_hold = 5.2
        minimum_pattern = min(len(shots), speaker_count + 1 if speaker_count >= 2 else 1)
        shot_count = max(minimum_pattern, int(math.ceil(duration / max_hold)))
        shot_count = min(40, shot_count)
        expanded = []
        for index in range(shot_count):
            shot = dict(shots[index % len(shots)])
            cycle = index // max(1, len(shots))
            if cycle and shot.get("shot") == "wide" and speaker_count >= 2:
                # Re-establishing every cycle feels mechanical. On later
                # cycles, use the next active zone as a reaction/medium shot.
                speaker_index = (index + variation_seed) % max(1, min(3, len(speakers)))
                speaker = speakers[speaker_index] if speakers else {}
                shot["speaker"] = speaker.get("speaker") if isinstance(speaker, dict) else f"S{speaker_index + 1}"
                shot["zone"] = speaker.get("zone") if isinstance(speaker, dict) else self._zone_for_speaker(speaker_index, speaker_count)
                shot["shot"] = "reaction" if emotion >= 0.7 else "medium"
                shot["reason"] = "reaction reset" if emotion >= 0.7 else "speaker reset"
            expanded.append(shot)
        shots = expanded
        slot = duration / max(1, shot_count)
        focus_map = {"LEFT": 0.20, "CENTER": 0.50, "RIGHT": 0.80, "WIDE": 0.50}
        measured_focus = scene.get("zone_focus")
        if isinstance(measured_focus, dict):
            for zone in ("LEFT", "CENTER", "RIGHT"):
                try:
                    value = float(measured_focus.get(zone))
                except (TypeError, ValueError):
                    continue
                if math.isfinite(value):
                    focus_map[zone] = max(0.08, min(0.92, value))
        for index, shot in enumerate(shots):
            shot["start"] = round(index * slot, 3)
            shot["end"] = round(duration if index == len(shots) - 1 else (index + 1) * slot, 3)
            shot["zone"] = self._normalized_zone(shot.get("zone"))
            shot["focus_x"] = focus_map.get(shot["zone"], focus_map["CENTER"])
            shot["transition"] = "hard_cut"
            shot["transition_ms"] = max(150, min(250, int(shot.get("transition_ms") or 180)))
            shot["max_hold_seconds"] = max_hold
        return shots

    def _build_music_sequence(self, speakers, scene):
        """Favor composition and stage context over podcast-style close cuts."""
        primary, primary_zone = self._speaker_details(speakers, 0, "performer", "CENTER")
        return [
            {"shot": "wide", "speaker": "stage", "zone": "CENTER", "transition_ms": 220, "reason": "performance establish"},
            {"shot": "medium", "speaker": primary, "zone": primary_zone, "transition_ms": 200, "reason": "vocal phrase"},
            {"shot": "wide", "speaker": "stage", "zone": "CENTER", "transition_ms": 220, "reason": "performance reset"},
            {"shot": "medium", "speaker": primary, "zone": primary_zone, "transition_ms": 200, "reason": "musical detail"},
        ]

    def _build_content_sequence(self, content_type, speakers, scene, emotion):
        primary, primary_zone = self._speaker_details(speakers, 0, "A", "CENTER")
        sequences = {
            "review": [
                {"shot": "wide", "speaker": primary, "zone": "CENTER", "reason": "presenter establish"},
                {"shot": "medium", "speaker": primary, "zone": "CENTER", "reason": "product explanation"},
                {"shot": "close", "speaker": primary, "zone": "CENTER", "reason": "product evidence"},
                {"shot": "medium", "speaker": primary, "zone": "CENTER", "reason": "verdict"},
            ],
            "news": [
                {"shot": "medium", "speaker": primary, "zone": "CENTER", "reason": "stable lead"},
                {"shot": "wide", "speaker": primary, "zone": "CENTER", "reason": "context reset"},
                {"shot": "medium", "speaker": primary, "zone": "CENTER", "reason": "key detail"},
            ],
            "vlog": [
                {"shot": "wide", "speaker": primary, "zone": "CENTER", "reason": "location establish"},
                {"shot": "medium", "speaker": primary, "zone": "CENTER", "reason": "action"},
                {"shot": "wide", "speaker": primary, "zone": "CENTER", "reason": "environment"},
                {"shot": "close", "speaker": primary, "zone": "CENTER", "reason": "reaction"},
            ],
            "storytelling": [
                {"shot": "wide", "speaker": primary, "zone": "CENTER", "reason": "setup"},
                {"shot": "medium", "speaker": primary, "zone": "CENTER", "reason": "development"},
                {"shot": "close", "speaker": primary, "zone": "CENTER", "reason": "turning point"},
                {"shot": "medium", "speaker": primary, "zone": "CENTER", "reason": "payoff"},
            ],
            "tutorial": [
                {"shot": "wide", "speaker": primary, "zone": "CENTER", "reason": "task context"},
                {"shot": "medium", "speaker": primary, "zone": "CENTER", "reason": "instruction"},
                {"shot": "close", "speaker": primary, "zone": "CENTER", "reason": "step detail"},
                {"shot": "medium", "speaker": primary, "zone": "CENTER", "reason": "result"},
            ],
            "gaming": [
                {"shot": "wide", "speaker": primary, "zone": "CENTER", "reason": "game context"},
                {"shot": "medium", "speaker": primary, "zone": "CENTER", "reason": "decision"},
                {"shot": "close", "speaker": primary, "zone": "CENTER", "reason": "action peak"},
                {"shot": "medium", "speaker": primary, "zone": "CENTER", "reason": "reaction"},
            ],
        }
        result = sequences.get(content_type) or self._build_single_sequence(speakers, scene, 10.0, emotion)
        for shot in result:
            shot.setdefault("transition_ms", 180)
            if shot.get("speaker") == primary and shot.get("shot") != "wide":
                shot["zone"] = primary_zone
        return result

    def _build_single_sequence(self, speakers, scene, duration, emotion):
        base_speaker, base_zone = self._speaker_details(speakers, 0, "A", "CENTER")
        shots = [
            {"shot": "wide", "speaker": base_speaker, "zone": "CENTER", "transition_ms": 180, "reason": "open"},
            {"shot": "medium", "speaker": base_speaker, "zone": base_zone, "transition_ms": 180, "reason": "talk"},
            {"shot": "close", "speaker": base_speaker, "zone": base_zone, "transition_ms": 180, "reason": "punchline" if emotion > 0.7 else "detail"},
            {"shot": "medium", "speaker": base_speaker, "zone": base_zone, "transition_ms": 180, "reason": "wrap"},
        ]
        if duration > 25:
            shots.insert(2, {"shot": "wide", "speaker": base_speaker, "zone": "CENTER", "transition_ms": 180, "reason": "reset"})
        return shots

    def _build_duo_sequence(self, speakers, scene, duration, emotion):
        left_speaker, left_zone = self._speaker_details(speakers, 0, "A", "LEFT")
        right_speaker, right_zone = self._speaker_details(speakers, 1, "B", "RIGHT")
        shots = [
            {"shot": "wide", "speaker": f"{left_speaker}/{right_speaker}", "zone": "CENTER", "transition_ms": 180, "reason": "establish"},
            {"shot": "medium", "speaker": left_speaker, "zone": left_zone, "transition_ms": 180, "reason": "answer"},
            {"shot": "medium", "speaker": right_speaker, "zone": right_zone, "transition_ms": 180, "reason": "reply"},
            {"shot": "reaction", "speaker": left_speaker, "zone": left_zone, "transition_ms": 180, "reason": "reaction" if emotion > 0.7 else "variation"},
        ]
        return shots

    def _build_multi_sequence(self, speakers, scene, duration, emotion):
        ordered = []
        for idx, speaker in enumerate(speakers[:3]):
            label, zone = self._speaker_details(
                speakers,
                idx,
                f"S{idx + 1}",
                self._zone_for_speaker(idx, 3),
            )
            shot = "medium" if idx == 0 else "close"
            ordered.append({"shot": shot, "speaker": label, "zone": zone, "transition_ms": 180, "reason": f"speaker {idx + 1}"})
        if len(ordered) >= 2:
            ordered.insert(0, {"shot": "wide", "speaker": "group", "zone": "CENTER", "transition_ms": 180, "reason": "group open"})
        return ordered

    def _build_split_sequence(self, speakers, scene):
        if len(speakers) >= 2:
            left_speaker = speakers[0].get("speaker") if speakers and isinstance(speakers[0], dict) else "A"
            right_speaker = speakers[1].get("speaker") if len(speakers) > 1 and isinstance(speakers[1], dict) else "B"
            return [
                {"shot": "split", "speaker": f"{left_speaker}/{right_speaker}", "zone": "CENTER", "transition_ms": 200, "reason": "split screen"},
                {"shot": "split", "speaker": f"{left_speaker}/{right_speaker}", "zone": "CENTER", "transition_ms": 200, "reason": "maintain split"},
            ]
        return [{"shot": "split", "speaker": "group", "zone": "CENTER", "transition_ms": 200, "reason": "split screen"}]

    def _zone_for_speaker(self, index, speaker_count):
        if speaker_count <= 1:
            return "CENTER"
        zones = ["LEFT", "CENTER", "RIGHT"]
        return zones[min(index, len(zones) - 1)]

    @staticmethod
    def _normalized_zone(value, fallback="CENTER"):
        zone = str(value or "").upper()
        if zone in {"LEFT", "CENTER", "RIGHT"}:
            return zone
        return fallback

    def _speaker_details(self, speakers, index, fallback_label, fallback_zone):
        speaker = speakers[index] if index < len(speakers) else {}
        if not isinstance(speaker, dict):
            return fallback_label, self._normalized_zone(fallback_zone)
        label = speaker.get("speaker") or fallback_label
        zone = self._normalized_zone(speaker.get("zone"), self._normalized_zone(fallback_zone))
        return label, zone

    def decide_camera_action(self, active_speakers, current_time=None):
        """Decide camera action with hysteresis to prevent rapid switching.

        Args:
            active_speakers: List of active speaker dicts with "speaker" and "start_time"
            current_time: Current timestamp for duration calculation

        Returns:
            dict with action, reason, and speaker info
        """
        current_time = current_time or 0.0

        if not active_speakers:
            return {"action": "noop", "reason": "no speakers"}

        sorted_speakers = sorted(
            active_speakers,
            key=lambda s: float(s.get("score", 0) or 0),
            reverse=True
        )
        top_speaker = sorted_speakers[0]
        speaker_id = top_speaker.get("speaker") or "A"
        zone = self._normalized_zone(
            top_speaker.get("zone"),
            self._zone_for_speaker(0, max(1, len(sorted_speakers))),
        )
        shot = "close" if float(top_speaker.get("score", 0) or 0) > 0.75 else "medium"

        if self._last_speaker == speaker_id:
            duration = current_time - (self._last_speaker_start or 0.0)
            if duration >= MIN_SPEAKER_DURATION:
                self._last_zone = zone
                self._last_shot = shot
                return {"action": "hold", "speaker": speaker_id, "zone": zone, "shot": shot, "duration": duration, "reason": f"speaker active for {duration:.1f}s"}

        if self._last_speaker:
            duration = current_time - (self._last_speaker_start or 0.0)
            if duration < MIN_SPEAKER_DURATION:
                return {
                    "action": "hold",
                    "speaker": self._last_speaker,
                    "zone": self._last_zone or zone,
                    "shot": self._last_shot or shot,
                    "duration": duration,
                    "reason": f"hysteresis: {MIN_SPEAKER_DURATION - duration:.1f}s remaining"
                }

        self._last_speaker = speaker_id
        self._last_speaker_start = current_time
        self._last_zone = zone
        self._last_shot = shot

        return {
            "action": "cut",
            "speaker": speaker_id,
            "zone": zone,
            "shot": shot,
            "duration": MIN_SPEAKER_DURATION,
            "reason": "speaker switch"
        }

    def reset_hysteresis(self):
        """Reset hysteresis state."""
        self._last_speaker = None
        self._last_speaker_start = None
        self._last_layout = None
        self._last_zone = None
        self._last_shot = None

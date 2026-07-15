"""Split Screen Engine v3.3 - Production Ready with Minimum Overlap Duration

Dynamic layout selection untuk multi-speaker scene berdasarkan:
- Face area (prioritas utama)
- Orientation (landscape vs portrait)
- Speaker arrangement
- Minimum overlap duration threshold

Spec: CLIPER STUDIO PLUS V3.3
"""

from typing import List, Dict, Any, Optional

LAYOUT_TOP_BOTTOM = "TOP_BOTTOM"
LAYOUT_LEFT_RIGHT = "LEFT_RIGHT"
LAYOUT_GRID_3 = "GRID_3"
LAYOUT_SINGLE = "SINGLE"

# Minimum overlap duration (seconds) required to consider split screen
DEFAULT_MIN_OVERLAP_DURATION = 0.5


def calculate_face_area(face_box):
    """Calculate face area from bounding box."""
    if not face_box:
        return 0.0
    w = float(face_box.get("w", 0) or 0)
    h = float(face_box.get("h", 0) or 0)
    return w * h


def calculate_face_center(face_box):
    """Calculate center of face from bounding box."""
    if not face_box:
        return {"x": 0.5, "y": 0.5}
    x = float(face_box.get("x", 0) or 0)
    y = float(face_box.get("y", 0) or 0)
    w = float(face_box.get("w", 0) or 0)
    h = float(face_box.get("h", 0) or 0)
    return {"x": x + w / 2, "y": y + h / 2}


def detect_layout(speakers, frame_width=1920, frame_height=1080):
    """Detect optimal split screen layout based on speaker positions and face areas."""
    if not speakers:
        return {"layout": LAYOUT_SINGLE, "speakers": [], "reason": "no speakers"}

    valid_speakers = [s for s in speakers if s.get("face_box")]
    if not valid_speakers:
        valid_speakers = speakers

    face_count = len(valid_speakers)

    if face_count == 1:
        return {"layout": LAYOUT_SINGLE, "speakers": [valid_speakers[0].get("speaker_id", "A")], "reason": "single speaker"}

    total_face_area = sum(calculate_face_area(s.get("face_box")) for s in valid_speakers)

    if face_count == 2:
        face1 = calculate_face_center(valid_speakers[0].get("face_box"))
        face2 = calculate_face_center(valid_speakers[1].get("face_box"))
        horizontal_dist = abs(face1["x"] - face2["x"]) / frame_width
        vertical_dist = abs(face1["y"] - face2["y"]) / frame_height

        if horizontal_dist >= 0.25 and horizontal_dist > vertical_dist:
            return {"layout": LAYOUT_LEFT_RIGHT, "speakers": [s.get("speaker_id", "A") for s in valid_speakers], "ratio": "50_50", "transition_ms": 200, "reason": "horizontal separation"}

        return {"layout": LAYOUT_TOP_BOTTOM, "speakers": [s.get("speaker_id", "A") for s in valid_speakers], "ratio": "50_50", "transition_ms": 200, "reason": "vertical arrangement preferred"}

    if face_count >= 3:
        speaker_ids = [s.get("speaker_id", "A") for s in valid_speakers]
        if len(speaker_ids) == 3:
            return {"layout": LAYOUT_GRID_3, "speakers": speaker_ids, "focus": speaker_ids[0] if speaker_ids else None, "transition_ms": 250, "reason": "3-speaker grid layout"}
        return {"layout": LAYOUT_SINGLE, "speakers": speaker_ids, "mode": "focus_active", "transition_ms": 150, "reason": f"{face_count} speakers - focus on active"}

    return {"layout": LAYOUT_LEFT_RIGHT, "speakers": [s.get("speaker_id", "A") for s in valid_speakers], "ratio": "50_50", "transition_ms": 200, "reason": "default split"}


def get_split_configuration(speakers, active_speaker=None, frame_dims=None):
    """Get full split screen configuration for rendering."""
    frame_dims = frame_dims or {"width": 1920, "height": 1080}
    layout_info = detect_layout(speakers, frame_dims["width"], frame_dims["height"])
    layout = layout_info["layout"]
    speakers_list = layout_info["speakers"]

    if layout == LAYOUT_LEFT_RIGHT:
        left_speaker = speakers_list[0] if len(speakers_list) > 0 else "A"
        right_speaker = speakers_list[1] if len(speakers_list) > 1 else "B"
        return {"layout_info": layout_info, "type": "2SPLIT", "left": {"speaker_id": left_speaker, "focus_x": 0.32, "area": 0.5}, "right": {"speaker_id": right_speaker, "focus_x": 0.68, "area": 0.5}, "mode": "side_by_side"}

    elif layout == LAYOUT_TOP_BOTTOM:
        top_speaker = speakers_list[0] if len(speakers_list) > 0 else "A"
        bottom_speaker = speakers_list[1] if len(speakers_list) > 1 else "B"
        return {"layout_info": layout_info, "type": "2SPLIT", "top": {"speaker_id": top_speaker, "focus_y": 0.33, "area": 0.5}, "bottom": {"speaker_id": bottom_speaker, "focus_y": 0.67, "area": 0.5}, "mode": "vertical_stack"}

    elif layout == LAYOUT_GRID_3:
        primary = active_speaker or speakers_list[0]
        others = [s for s in speakers_list if s != primary]
        return {"layout_info": layout_info, "type": "3SPLIT", "primary": {"speaker_id": primary, "position": "top", "area": 0.5}, "secondary_top_left": others[0] if len(others) > 0 else None, "secondary_bottom_right": others[1] if len(others) > 1 else None, "mode": "priority_focus"}

    else:
        return {"layout_info": layout_info, "type": "FOCUS", "active_speaker": active_speaker, "mode": "single_focus", "transition_ms": 150}


def should_use_split_screen(speakers, overlap_threshold=1.0, min_overlap_duration=None):
    """Determine if split screen should be used based on speaker overlap.

    Args:
        speakers: List of speaker segments with start/end times
        overlap_threshold: Minimum number of overlapping speaker pairs
        min_overlap_duration: Minimum overlap duration to trigger split screen (default: 0.5s)

    Returns:
        dict with should_split, max_overlap, and reason
    """
    if not speakers or len(speakers) < 2:
        return {"should_split": False, "reason": "insufficient speakers"}

    # Use configured or default minimum overlap duration
    min_overlap = float(min_overlap_duration or DEFAULT_MIN_OVERLAP_DURATION)

    overlapping_pairs = 0
    max_overlap = 0.0

    for i, s1 in enumerate(speakers):
        for s2 in speakers[i+1:]:
            s1_start = float(s1.get("start", 0) or 0)
            s1_end = float(s1.get("end", s1_start) or s1_start)
            s2_start = float(s2.get("start", 0) or 0)
            s2_end = float(s2.get("end", s2_start) or s2_start)

            overlap_start = max(s1_start, s2_start)
            overlap_end = min(s1_end, s2_end)
            overlap_duration = max(0.0, overlap_end - overlap_start)

            max_overlap = max(max_overlap, overlap_duration)

            if overlap_duration >= min_overlap:
                overlapping_pairs += 1

    return {
        "should_split": overlapping_pairs >= overlap_threshold and max_overlap >= min_overlap,
        "max_overlap": round(max_overlap, 3),
        "overlapping_pairs": overlapping_pairs,
        "min_overlap_duration": min_overlap,
        "reason": f"overlap {max_overlap:.1f}s detected" if max_overlap > 0 else "no overlap detected"
    }


def build_split_layout(left_speaker=None, right_speaker=None, top_speaker=None, bottom_speaker=None):
    """Build layout configuration (backward compatible)."""
    if left_speaker and right_speaker:
        return {"layout": "LEFT_RIGHT", "left": {"speaker_id": left_speaker, "focus_x": 0.32}, "right": {"speaker_id": right_speaker, "focus_x": 0.68}, "transition_ms": 200}
    elif top_speaker and bottom_speaker:
        return {"layout": "TOP_BOTTOM", "top": {"speaker_id": top_speaker, "focus_y": 0.33}, "bottom": {"speaker_id": bottom_speaker, "focus_y": 0.67}, "transition_ms": 200}
    else:
        return {"layout": "50_50_VERTICAL", "top": left_speaker or {"focus_x": 0.32}, "bottom": right_speaker or {"focus_x": 0.68}, "transition_ms": 520}


class SplitScreen:
    """Split screen configuration provider."""

    def __init__(self, min_overlap_duration=None):
        self.cache = {}
        self.min_overlap_duration = min_overlap_duration or DEFAULT_MIN_OVERLAP_DURATION

    def build_layout(self, **kwargs):
        return build_split_layout(**kwargs)

    def get_configuration(self, speakers, **kwargs):
        return get_split_configuration(speakers, **kwargs)

    def check_overlap(self, speakers, **kwargs):
        return should_use_split_screen(speakers, min_overlap_duration=self.min_overlap_duration, **kwargs)

    def set_min_overlap_duration(self, duration):
        """Set minimum overlap duration threshold."""
        self.min_overlap_duration = float(duration)

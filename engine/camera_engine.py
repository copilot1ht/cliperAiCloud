"""Deterministic story/speaker camera director for production shorts."""
from .zone_mapper import ZONE_LEFT, ZONE_CENTER, ZONE_RIGHT, zone_name

DIRECTOR_CUT = "DIRECTOR_CUT"
SPLIT_SCREEN = "SPLIT_SCREEN"
BODY_TRACK = "BODY_TRACK"
CENTER_CROP = "CENTER_CROP"
ZONE_FOCUS = {"LEFT": 0.20, "CENTER": 0.50, "RIGHT": 0.80, "WIDE": 0.50}


def decide_camera_action(active_speakers: list, overlap_speech: float = 0.0):
    """Decide camera action based on active speakers.

    Returns struct-like dict. Kept for compatibility or direct use.
    """
    if not active_speakers:
        return {"action": "noop", "reason": "no speakers"}
    if len(active_speakers) > 1 and overlap_speech > 1.0:
        return {"action": "split_screen", "speakers": [s.get("speaker") for s in active_speakers]}
    top = active_speakers[0]
    z = top.get("zone")
    if z == ZONE_LEFT:
        return {"action": "cut", "layout": "9:16 crop LEFT", "speaker": top.get("speaker"), "zone": zone_name(z)}
    if z == ZONE_CENTER:
        return {"action": "cut", "layout": "9:16 crop CENTER", "speaker": top.get("speaker"), "zone": zone_name(z)}
    return {"action": "cut", "layout": "9:16 crop RIGHT", "speaker": top.get("speaker"), "zone": zone_name(z)}


class CameraEngine:
    """Face/body trackers provide evidence; this class owns framing decisions."""

    def select_layout(self, speakers=None, scene=None):
        speakers = speakers or []
        scene = scene or {}
        face_count = int(scene.get("face_count") or len(speakers) or 0)
        body_tracking = bool(scene.get("body_tracking"))
        simultaneous = bool(scene.get("simultaneous") or scene.get("split_screen"))
        stability = float(scene.get("stability") or 70)
        average_span = float(scene.get("average_span") or 0)
        overlap = float(scene.get("overlap_seconds") or 0.0)
        if face_count >= 2 and (simultaneous or overlap > 1.0) and stability >= 50 and average_span >= 0.36:
            return SPLIT_SCREEN
        if face_count >= 1:
            return DIRECTOR_CUT
        if body_tracking:
            return BODY_TRACK
        return CENTER_CROP

    def camera_score(self, layout):
        return {
            SPLIT_SCREEN: 20,
            DIRECTOR_CUT: 16,
            BODY_TRACK: 6,
            CENTER_CROP: 0,
        }.get(layout, 0)

    def build_shot_sequence(self, speakers=None, scene=None, duration=10.0):
        speakers = speakers or [{"speaker": "A", "zone": "CENTER"}]
        scene = scene or {}
        duration = max(2.0, float(duration or 10.0))
        count = max(1, int(scene.get("speaker_count") or len(speakers) or 1))
        overlap = float(scene.get("overlap_seconds") or 0.0)
        emotion = float(scene.get("emotion") or 0.0)
        seed = int(scene.get("variation_seed") or 0)
        labels = []
        for index, speaker in enumerate(speakers[:3]):
            labels.append(str(speaker.get("speaker") or chr(65 + index)))
        while len(labels) < min(3, count):
            labels.append(chr(65 + len(labels)))

        if count >= 2 and overlap > 1.0:
            pattern = [("wide", "WIDE", "establish"), ("split", "CENTER", "simultaneous speech"), ("medium", "LEFT", "reply"), ("medium", "RIGHT", "reaction")]
        elif count == 1:
            pattern = [("wide", "WIDE", "story context"), ("medium", "CENTER", "speaker"), ("close", "CENTER", "emotion" if emotion >= 0.65 else "payoff"), ("medium", "CENTER", "wrap")]
        else:
            patterns = [
                [("wide", "WIDE", "story context"), ("medium", "LEFT", "speaker change"), ("medium", "RIGHT", "reply"), ("close", "CENTER", "payoff")],
                [("wide", "WIDE", "story context"), ("medium", "RIGHT", "speaker change"), ("reaction", "LEFT", "reaction"), ("close", "CENTER", "payoff")],
                [("wide", "WIDE", "story context"), ("medium", "CENTER", "speaker"), ("medium", "LEFT", "reply"), ("close", "RIGHT", "emotion")],
            ]
            pattern = patterns[seed % len(patterns)]

        # Keep shots readable: fast speaker cuts are allowed, but camera never
        # drifts continuously between zones.
        shot_count = min(len(pattern), max(1, int(duration // 3.0)))
        chosen = pattern[:shot_count]
        slot = duration / max(1, len(chosen))
        sequence = []
        for index, (shot, zone, reason) in enumerate(chosen):
            start = round(index * slot, 3)
            end = round(duration if index == len(chosen) - 1 else (index + 1) * slot, 3)
            speaker = "group" if zone == "WIDE" else labels[index % len(labels)]
            sequence.append({
                "start": start,
                "end": end,
                "shot": shot,
                "speaker": speaker,
                "zone": zone,
                "focus_x": ZONE_FOCUS.get(zone, 0.50),
                "transition": "hard_cut",
                "transition_ms": 200 if reason == "speaker change" else 180,
                "reason": reason,
            })
        return sequence

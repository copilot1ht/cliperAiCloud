import math


FACE_TRACK = "FACE_TRACK"
BODY_TRACK = "BODY_TRACK"
SPLIT_SCREEN = "SPLIT_SCREEN"
CENTER_CROP = "CENTER_CROP"
DIRECTOR_CUT = "DIRECTOR_CUT"

# Speaker hysteresis to prevent rapid camera switching
# Minimum duration (in seconds) a speaker must be active before camera switches
MIN_SPEAKER_DURATION = 0.8


class CameraEngine:
    def __init__(self):
        self._last_speaker = None
        self._last_speaker_start = None
        self._last_layout = None

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
            DIRECTOR_CUT: 15,
            FACE_TRACK: 10,
            BODY_TRACK: 5,
            CENTER_CROP: 0,
        }.get(layout, 0)

    def build_shot_sequence(self, speakers=None, scene=None, duration=10.0):
        speakers = speakers or []
        scene = scene or {}
        speaker_count = max(1, int(scene.get("speaker_count") or len(speakers) or 1))
        overlap = float(scene.get("overlap_seconds") or 0.0)
        emotion = float(scene.get("emotion") or 0.5)
        duration = max(2.0, float(duration or 10.0))

        variation_seed = int(scene.get("variation_seed") or 0)
        if speaker_count >= 2 and overlap > 1.0:
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
        if speaker_count == 1:
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
        for index, shot in enumerate(shots):
            shot["start"] = round(index * slot, 3)
            shot["end"] = round(duration if index == len(shots) - 1 else (index + 1) * slot, 3)
            shot["focus_x"] = focus_map.get(shot.get("zone"), 0.50)
            shot["transition"] = "hard_cut"
            shot["transition_ms"] = max(150, min(250, int(shot.get("transition_ms") or 180)))
            shot["max_hold_seconds"] = max_hold
        return shots

    def _build_single_sequence(self, speakers, scene, duration, emotion):
        base_speaker = (speakers[0].get("speaker") if speakers and isinstance(speakers[0], dict) else "A") or "A"
        shots = [
            {"shot": "wide", "speaker": base_speaker, "zone": "CENTER", "transition_ms": 180, "reason": "open"},
            {"shot": "medium", "speaker": base_speaker, "zone": "CENTER", "transition_ms": 180, "reason": "talk"},
            {"shot": "close", "speaker": base_speaker, "zone": "CENTER", "transition_ms": 180, "reason": "punchline" if emotion > 0.7 else "detail"},
            {"shot": "medium", "speaker": base_speaker, "zone": "CENTER", "transition_ms": 180, "reason": "wrap"},
        ]
        if duration > 25:
            shots.insert(2, {"shot": "wide", "speaker": base_speaker, "zone": "CENTER", "transition_ms": 180, "reason": "reset"})
        return shots

    def _build_duo_sequence(self, speakers, scene, duration, emotion):
        left_speaker = speakers[0].get("speaker") if speakers and isinstance(speakers[0], dict) else "A"
        right_speaker = speakers[1].get("speaker") if len(speakers) > 1 and isinstance(speakers[1], dict) else "B"
        shots = [
            {"shot": "wide", "speaker": f"{left_speaker}/{right_speaker}", "zone": "CENTER", "transition_ms": 180, "reason": "establish"},
            {"shot": "medium", "speaker": left_speaker, "zone": "LEFT", "transition_ms": 180, "reason": "answer"},
            {"shot": "medium", "speaker": right_speaker, "zone": "RIGHT", "transition_ms": 180, "reason": "reply"},
            {"shot": "reaction", "speaker": left_speaker, "zone": "LEFT", "transition_ms": 180, "reason": "reaction" if emotion > 0.7 else "variation"},
        ]
        return shots

    def _build_multi_sequence(self, speakers, scene, duration, emotion):
        ordered = []
        for idx, speaker in enumerate(speakers[:3]):
            label = speaker.get("speaker") if speakers and isinstance(speaker, dict) else f"S{idx + 1}"
            zone = self._zone_for_speaker(idx, 3)
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
        zone = self._zone_for_speaker(0, max(1, len(sorted_speakers)))
        shot = "close" if float(top_speaker.get("score", 0) or 0) > 0.75 else "medium"

        if self._last_speaker == speaker_id:
            duration = current_time - (self._last_speaker_start or 0.0)
            if duration >= MIN_SPEAKER_DURATION:
                return {"action": "hold", "speaker": speaker_id, "zone": zone, "shot": shot, "duration": duration, "reason": f"speaker active for {duration:.1f}s"}

        if self._last_speaker:
            duration = current_time - (self._last_speaker_start or 0.0)
            if duration < MIN_SPEAKER_DURATION:
                return {
                    "action": "hold",
                    "speaker": self._last_speaker,
                    "zone": zone,
                    "shot": shot,
                    "duration": duration,
                    "reason": f"hysteresis: {MIN_SPEAKER_DURATION - duration:.1f}s remaining"
                }

        self._last_speaker = speaker_id
        self._last_speaker_start = current_time

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

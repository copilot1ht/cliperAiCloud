"""Speaker Engine v3.2 - Production Ready

Active speaker scoring dengan emotion detection, importance scoring,
dan consistent speaker identification berdasarkan transcript analysis.

Spec: CLIPER STUDIO PLUS V3.2
"""

import re
from typing import List, Dict, Any, Optional

EMOTION_KEYWORDS = {
    "kaget": 0.8, "marah": 0.9, "sedih": 0.7, "lucu": 0.6,
    "gila": 0.85, "wah": 0.5, "ngakak": 0.85, "ketawa": 0.75,
    "tertawa": 0.75, "kecewa": 0.7, "senang": 0.65, "benci": 0.9,
    "cinta": 0.6, "frustasi": 0.85, "puas": 0.6, "terkejut": 0.8,
    "terharu": 0.75, "tawa": 0.7,
}

CONFLICT_KEYWORDS = {
    "masalah", "konflik", "berantem", "bentrok", "sengketa", "perselisihan",
    "perbedaan", "ketidaksepakatan", "debat", "tertuduh", "tersangka",
    "tertangkap", "terbongkar", "terungkap", "terjadi", "tertentu",
}

FOCUS_KEYWORDS = {
    "jadi", "karena", "ternyata", "akhirnya", "penting", "masalah", "jawaban",
    "berarti", "makanya", "sebabnya", "alhasil", "nah itu", "intinya",
}

FIRST_PERSON = {"gue", "gua", "aku", "saya", "kami", "kita"}
SECOND_PERSON = {"lo", "lu", "kamu", "anda", "dia", "mereka", "beliau"}


def compute_speaker_score(voice_activity, mouth_motion, body_motion, face_visibility):
    """Compute active speaker score using weighted sum from spec V3.1."""
    def clamp(val):
        try:
            v = float(val)
        except (TypeError, ValueError):
            return 0.0
        return max(0.0, min(1.0, v))

    score = 0.50 * clamp(voice_activity) + 0.20 * clamp(mouth_motion) + 0.15 * clamp(body_motion) + 0.15 * clamp(face_visibility)
    return round(score * 100.0, 2)


def pick_top_speaker(scores):
    """Return speaker with highest score."""
    if not scores:
        return None
    return max(scores.items(), key=lambda x: x[1])[0]


def detect_emotion(text):
    """Detect emotion from text with confidence scores."""
    if not text:
        return {"primary_emotion": "neutral", "emotions": {"neutral": 1.0}, "confidence": 0.5}

    lower = str(text).lower()
    detected = {}

    for emotion, weight in EMOTION_KEYWORDS.items():
        if emotion in lower:
            detected[emotion] = weight

    detected["neutral"] = 0.3

    if not detected:
        return {"primary_emotion": "neutral", "emotions": {"neutral": 1.0}, "confidence": 0.1}

    total = sum(detected.values())
    emotions = {k: round(v / total, 3) for k, v in detected.items()}
    primary = max(emotions.items(), key=lambda x: x[1])

    return {"primary_emotion": primary[0], "emotions": emotions, "confidence": round(primary[1], 3)}


def detect_conflict(text):
    """Detect conflict/controversy in text."""
    if not text:
        return {"has_conflict": False, "score": 0.0, "keywords": []}

    lower = str(text).lower()
    found = [kw for kw in CONFLICT_KEYWORDS if kw in lower]

    return {"has_conflict": len(found) > 0, "score": min(1.0, len(found) * 0.3), "keywords": found}


def detect_focus(text):
    """Detect focus/importance of text segment."""
    if not text:
        return 0.0

    words = re.findall(r"\w+", str(text).lower())
    if not words:
        return 0.0

    focus_words = sum(1 for w in words if w in FOCUS_KEYWORDS)
    return min(1.0, (focus_words / len(words)) * 1.5)


def extract_speaker_from_text(text, previous_speaker="A"):
    """Determine speaker ID from text content."""
    if not text:
        return previous_speaker

    lower = str(text).lower()

    for word in FIRST_PERSON:
        if re.search(rf"\b{word}\b", lower):
            return "A"

    for word in SECOND_PERSON:
        if re.search(rf"\b{word}\b", lower):
            return "B"

    return previous_speaker


def analyze_transcript_segment(item, previous_speaker):
    """Analyze single transcript segment and enrich with metadata."""
    text = str(item.get("text") or "")
    lower = text.lower()

    speaker = extract_speaker_from_text(text, previous_speaker)
    emotion_result = detect_emotion(text)
    emotion_score = round(emotion_result["emotions"].get(emotion_result["primary_emotion"], 0.5) * 100, 2)

    conflict_result = detect_conflict(text)
    conflict_bonus = 15 if conflict_result["has_conflict"] else 0

    focus = detect_focus(text)
    importance_score = round((35 + focus * 65) + conflict_bonus, 2)

    return {
        **item,
        "speaker_id": speaker,
        "emotion": emotion_result,
        "emotion_score": emotion_score,
        "importance_score": min(100, importance_score),
        "has_conflict": conflict_result["has_conflict"],
        "focus": focus
    }


class SpeakerEngine:
    """Main Speaker Engine class for v3.2."""

    def __init__(self):
        self.previous_speaker = "A"
        self.emotion_history = []

    def assign_transcript_speakers(self, transcript):
        """Assign speaker IDs and enrich with emotion/importance scores."""
        if not transcript:
            return []

        result = []
        self.previous_speaker = "A"

        for item in transcript:
            enriched = analyze_transcript_segment(item, self.previous_speaker)
            self.previous_speaker = enriched["speaker_id"]
            self.emotion_history.append(enriched.get("emotion", {}))
            result.append(enriched)

        return result

    def detect_active_speaker(self, audio_segments, face_tracks):
        """Detect currently active speaker combining audio and visual signals."""
        scores = {}

        for segment in audio_segments or []:
            speaker = segment.get("speaker_id") or segment.get("speaker") or "A"
            importance = float(segment.get("importance_score") or 1.0)
            scores[speaker] = scores.get(speaker, 0.0) + importance * 0.6

        for track in face_tracks or []:
            speaker = track.get("speaker_id") or track.get("speaker") or "A"
            visual = float(track.get("visual_score") or track.get("activity") or 1.0)
            scores[speaker] = scores.get(speaker, 0.0) + visual * 0.4

        if not scores:
            return {"speaker": "center", "score": 0.0, "confidence": 0.0}

        speaker, score = max(scores.items(), key=lambda item: item[1])
        return {"speaker": speaker, "score": round(score, 3), "confidence": round(min(1.0, score / 100.0), 3)}

    def reset(self):
        """Reset engine state."""
        self.previous_speaker = "A"
        self.emotion_history = []
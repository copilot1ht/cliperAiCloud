import math
import re
from collections import Counter


def clean_text(text):
    return re.sub(r"\s+", " ", str(text or "")).strip()


def timestamp(item, key, fallback=0.0):
    try:
        return float(item.get(key, fallback) or fallback)
    except Exception:
        return float(fallback)


def clip_segment_text(text, segment_start, segment_end, window_start, window_end):
    """Return only the words estimated to fall inside the requested window."""
    text = clean_text(text)
    words = text.split()
    segment_start = float(segment_start)
    segment_end = float(segment_end)
    window_start = float(window_start)
    window_end = float(window_end)
    if not words or segment_end <= segment_start:
        return text
    overlap_start = max(segment_start, window_start)
    overlap_end = min(segment_end, window_end)
    if overlap_end <= overlap_start:
        return ""
    if overlap_start <= segment_start and overlap_end >= segment_end:
        return text
    span = segment_end - segment_start
    start_ratio = max(0.0, min(1.0, (overlap_start - segment_start) / span))
    end_ratio = max(0.0, min(1.0, (overlap_end - segment_start) / span))
    first = max(0, min(len(words) - 1, int(math.floor(start_ratio * len(words)))))
    last = max(first + 1, min(len(words), int(math.ceil(end_ratio * len(words)))))
    return clean_text(" ".join(words[first:last]))


def transcript_text_between(transcript, start, end):
    parts = []
    for item in transcript or []:
        seg_start = timestamp(item, "start")
        seg_end = timestamp(item, "end", seg_start)
        if seg_end < start or seg_start > end:
            continue
        text = clip_segment_text(item.get("text") or "", seg_start, seg_end, start, end)
        if text:
            parts.append(text)
    return clean_text(" ".join(parts))


STORY_STOPWORDS = {
    "yang", "dan", "atau", "dari", "untuk", "dengan", "jadi", "ini", "itu",
    "ada", "saya", "aku", "gue", "gua", "kamu", "dia", "mereka", "kita",
    "kalau", "kalo", "karena", "terus", "tapi", "ya", "kan", "nah", "gitu",
}


def significant_words(text):
    return [word for word in re.findall(r"\w+", clean_text(text).lower(), flags=re.UNICODE) if len(word) > 3 and word not in STORY_STOPWORDS]


def semantic_similarity(left, right):
    left_words = set(significant_words(left))
    right_words = set(significant_words(right))
    if not left_words or not right_words:
        return 0.0
    return len(left_words & right_words) / max(1, len(left_words | right_words))


def story_metadata(text, segments=None):
    text = clean_text(text)
    lower = text.lower()
    words = significant_words(text)
    keywords = [word for word, _count in Counter(words).most_common(8)]
    emotion_map = {
        "funny": ["lucu", "ketawa", "ngakak", "kocak"],
        "tense": ["marah", "konflik", "ribut", "debat", "masalah"],
        "sad": ["sedih", "nangis", "kecewa", "menyesal"],
        "surprise": ["ternyata", "kaget", "aneh", "rahasia", "mendadak"],
        "educational": ["cara", "tips", "strategi", "fakta", "solusi"],
    }
    emotion_scores = {name: sum(1 for keyword in values if keyword in lower) for name, values in emotion_map.items()}
    emotion = max(emotion_scores, key=emotion_scores.get) if any(emotion_scores.values()) else "neutral"
    conflict = any(keyword in lower for keyword in emotion_map["tense"] + ["ditolak", "bohong", "bullying"])
    question = "?" in text or any(keyword in lower for keyword in ["kenapa", "bagaimana", "siapa", "apa yang"])
    payoff = is_story_finished(text) and any(keyword in " ".join(re.findall(r"\w+", lower)[-32:]) for keyword in ["akhirnya", "ternyata", "makanya", "hasilnya", "intinya", "jadi"])
    people = sorted({word for word in re.findall(r"\b[A-Z][a-zA-Z]{2,}\b", text)})[:6]
    speaker_ids = []
    for item in segments or []:
        speaker = str(item.get("speaker_id") or item.get("speaker") or "")
        if speaker and speaker not in speaker_ids:
            speaker_ids.append(speaker)
    return {
        "topic": " ".join(keyword.title() for keyword in keywords[:3]) or "Pembahasan utama",
        "summary": " ".join(text.split()[:42]),
        "keywords": keywords,
        "emotion": emotion,
        "conflict": conflict,
        "question": question,
        "payoff": payoff,
        "people": people,
        "speakers": speaker_ids,
    }


def build_story_timeline(transcript, config=None):
    """Segment transcript by topic/speaker/gap evidence, not fixed clock blocks."""
    config = config or {}
    items = []
    for item in transcript or []:
        text = clean_text(item.get("text") or "")
        start = timestamp(item, "start")
        end = timestamp(item, "end", start)
        if text and end > start:
            items.append({**item, "start": start, "end": end, "text": text})
    if not items:
        return []

    total_duration = max(1.0, items[-1]["end"] - items[0]["start"])
    desired_count = max(1, min(25, int(round(total_duration / 180.0))))
    target_duration = max(75.0, min(240.0, total_duration / desired_count))
    min_duration = max(35.0, min(90.0, target_duration * 0.38))
    max_duration = max(120.0, min(330.0, target_duration * 1.65))

    stories = []
    current = []
    recent_text = ""
    previous = None
    for item in items:
        if not current:
            current = [item]
            recent_text = item["text"]
            previous = item
            continue
        span = item["end"] - current[0]["start"]
        gap = item["start"] - float(previous.get("end") or item["start"])
        previous_speaker = str(previous.get("speaker_id") or previous.get("speaker") or "")
        speaker = str(item.get("speaker_id") or item.get("speaker") or "")
        speaker_changed = bool(previous_speaker and speaker and previous_speaker != speaker)
        similarity = semantic_similarity(recent_text, item["text"])
        topic_shift = similarity < 0.055 and span >= min_duration and (speaker_changed or gap > 1.2 or re.search(r"[.!?…]$", previous.get("text") or ""))
        should_break = gap > 4.0 or span >= max_duration or (span >= target_duration and topic_shift)
        if should_break:
            text = clean_text(" ".join(part["text"] for part in current))
            meta = story_metadata(text, current)
            stories.append({"start": current[0]["start"], "end": current[-1]["end"], "duration": round(current[-1]["end"] - current[0]["start"], 2), "text": text, **meta})
            current = [item]
            recent_text = item["text"]
        else:
            current.append(item)
            recent_text = clean_text(" ".join(part["text"] for part in current[-6:]))
        previous = item

    if current:
        text = clean_text(" ".join(part["text"] for part in current))
        meta = story_metadata(text, current)
        stories.append({"start": current[0]["start"], "end": current[-1]["end"], "duration": round(current[-1]["end"] - current[0]["start"], 2), "text": text, **meta})

    # A tiny trailing fragment belongs to the prior story.
    if len(stories) > 1 and stories[-1]["duration"] < min_duration * 0.55:
        tail = stories.pop()
        previous_story = stories[-1]
        merged_text = clean_text(f"{previous_story['text']} {tail['text']}")
        previous_story.update(story_metadata(merged_text))
        previous_story["text"] = merged_text
        previous_story["end"] = tail["end"]
        previous_story["duration"] = round(previous_story["end"] - previous_story["start"], 2)
    for index, story in enumerate(stories, 1):
        story["story_id"] = index
    return stories


def is_story_finished(text):
    lower = clean_text(text).lower()
    if not lower:
        return False
    last_words = " ".join(re.findall(r"\w+", lower)[-28:])
    payoff_words = [
        "jadi", "makanya", "akhirnya", "ternyata", "gitu", "loh", "kan",
        "begitu", "selesai", "intinya", "kesimpulannya", "jawabannya",
        "hasilnya", "karena itu", "nah itu",
    ]
    return bool(re.search(r"[.!?…]$", lower)) or any(word in last_words for word in payoff_words)


def snap_to_sentence_start(transcript, start):
    boundary = float(start)
    for item in transcript or []:
        seg_start = timestamp(item, "start")
        seg_end = timestamp(item, "end", seg_start)
        if seg_start <= start <= seg_end or 0 <= start - seg_start <= 2:
            return seg_start
    return boundary


def snap_to_sentence_end(transcript, end):
    boundary = float(end)
    for item in transcript or []:
        seg_start = timestamp(item, "start")
        seg_end = timestamp(item, "end", seg_start)
        if seg_start <= end <= seg_end or 0 <= seg_end - end <= 2:
            return max(boundary, seg_end)
    return boundary

def natural_end_in_range(transcript, preferred_end, minimum_end, maximum_end):
    """Return a transcript end boundary without moving a clip's natural start."""
    preferred = float(preferred_end)
    minimum = float(minimum_end)
    maximum = max(minimum, float(maximum_end))
    boundaries = []
    for item in transcript or []:
        segment_end = timestamp(item, "end")
        if minimum - 0.001 <= segment_end <= maximum + 0.001:
            boundaries.append(segment_end)
    if not boundaries:
        return min(max(preferred, minimum), maximum)
    return min(boundaries, key=lambda value: (abs(value - preferred), -value))



def extend_story_boundary(transcript, start, end, min_duration=30, target_duration=75, max_duration=180, ending_buffer=2.5):
    if not transcript:
        return float(start), float(end), ""
    start = snap_to_sentence_start(transcript, float(start))
    end = snap_to_sentence_end(transcript, float(end))
    max_end = start + float(max_duration)
    minimum_end = start + float(min_duration)
    if end - start > float(max_duration):
        end = natural_end_in_range(transcript, max_end, minimum_end, max_end)
    target_end = start + float(target_duration)
    text = transcript_text_between(transcript, start, end)

    for item in transcript or []:
        seg_start = timestamp(item, "start")
        seg_end = timestamp(item, "end", seg_start)
        if seg_end <= end or seg_start < start:
            continue
        if seg_start - end > 4.5:
            break
        if seg_end > max_end + 0.001:
            break
        candidate_end = seg_end
        candidate_text = clean_text(f"{text} {item.get('text') or ''}")
        end = candidate_end
        text = candidate_text
        if candidate_end >= target_end and is_story_finished(candidate_text):
            break
        if end >= max_end - 0.2:
            break

    if end - start < float(min_duration):
        end = natural_end_in_range(
            transcript,
            min(max_end, start + float(min_duration)),
            minimum_end,
            max_end,
        )
        text = transcript_text_between(transcript, start, end) or text
    if is_story_finished(text):
        extension_limit = min(max_end, end + max(0.0, float(ending_buffer or 0)))
        later_boundaries = [
            timestamp(item, "end")
            for item in transcript or []
            if end + 0.001 < timestamp(item, "end") <= extension_limit + 0.001
        ]
        if later_boundaries:
            end = min(later_boundaries, key=lambda value: abs(value - extension_limit))
            text = transcript_text_between(transcript, start, end) or text
    if end - start > float(max_duration):
        end = natural_end_in_range(transcript, max_end, minimum_end, max_end)
        text = transcript_text_between(transcript, start, end) or text
    return round(start, 2), round(end, 2), clean_text(text)


def extract_anchors_from_transcript(transcript, min_gap=4.0):
    """Extract simple anchors (timestamps) from transcript using sentence boundaries

    Returns list of dicts: {"time": <float>, "type": "sentence_end"}
    """
    anchors = []
    last = None
    for item in transcript or []:
        try:
            s = float(item.get("start", 0) or 0)
            e = float(item.get("end", s) or s)
            text = clean_text(item.get("text") or "")
        except Exception:
            continue
        # if this segment ends with punctuation or is relatively long, mark anchor at end
        if re.search(r"[.!?…]$", text) or len(text.split()) > 20:
            t = round(e, 2)
            if last is None or t - last >= float(min_gap):
                anchors.append({"time": t, "type": "sentence_end"})
                last = t

    # add a few evenly spaced anchors if none found
    if not anchors and transcript:
        duration = timestamp(transcript[-1], "end", 0) or 0
        if duration > 0:
            step = max(15, min(60, int(duration / 10)))
            for t in range(0, int(duration), step):
                anchors.append({"time": float(t), "type": "spaced"})

    return anchors


def segment_into_story_candidates(transcript, config=None):
    """Create candidate story segments using anchors and `extend_story_boundary`.

    Produces many overlapping candidates which the highlight engine will filter.
    """
    config = config or {}
    stories = build_story_timeline(transcript, config)
    anchors = extract_anchors_from_transcript(transcript)
    candidates = []
    for story in stories:
        start = float(story.get("start") or 0)
        end = float(story.get("end") or start)
        profile_duration = max(35.0, min(180.0, float(story.get("duration") or 75)))
        start2, end2, text = extend_story_boundary(
            transcript,
            start,
            min(end, start + profile_duration),
            min_duration=min(60.0, profile_duration),
            target_duration=min(120.0, profile_duration),
            max_duration=180,
        )
        candidates.append({**story, "start": start2, "end": end2, "text": text, "segment_type": "Story"})
    durations = config.get("durations", [35, 50, 75, 90, 120])
    for a in anchors:
        t = float(a.get("time", 0) or 0)
        for d in durations:
            s = max(0, t - d * 0.35)
            e = s + d
            s2, e2, text = extend_story_boundary(transcript, s, e, min_duration=30, target_duration=d)
            candidates.append({"start": s2, "end": e2, "text": text})
    # if no anchors produced, fallback to sliding windows
    if not candidates:
        total = timestamp(transcript[-1], "end", 0) if transcript else 0
        step = max(30, int(config.get("step", 30)))
        for s in range(0, int(total), step):
            e = s + 75
            s2, e2, text = extend_story_boundary(transcript, s, e)
            candidates.append({"start": s2, "end": e2, "text": text})
    return candidates

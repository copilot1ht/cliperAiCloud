import re
import os
import json
import hashlib
import math
from typing import List, Dict, Any

def bounded_score(value, floor=0, ceiling=100):
    try:
        return int(max(floor, min(ceiling, round(float(value)))))
    except Exception:
        return int(floor)


def bounded_score_with_penalty(value, floor=0, ceiling=100, penalties=None):
    """Apply penalties and bound the score."""
    try:
        score = float(value)
        if penalties:
            for penalty in penalties:
                if callable(penalty):
                    score = penalty(score)
                elif isinstance(penalty, (int, float)):
                    score -= float(penalty)
        return int(max(floor, min(ceiling, round(score))))
    except Exception:
        return int(floor)


def filler_ratio(text):
    words = re.findall(r"\w+", str(text or "").lower())
    if not words:
        return 0.0
    filler = {
        "eee", "ee", "emm", "hmm", "hm", "anu", "jadi", "nah",
        "gitu", "kayak", "apa", "ya", "kan",
    }
    filler_count = sum(1 for word in words if word in filler)
    repeated = 0
    for index in range(1, len(words)):
        if words[index] == words[index - 1]:
            repeated += 1
    return min(1.0, (filler_count + repeated) / max(len(words), 1))


def forced_alignment_score(transcript, alignment_offsets=None):
    """Calculate forced alignment confidence score.

    alignment_offsets: list of {start_offset, end_offset, confidence}
    Returns a score from 0-100 based on alignment quality.
    """
    if not transcript:
        return 50.0
    if not alignment_offsets:
        return 50.0

    total_confidence = 0.0
    for offset in alignment_offsets:
        conf = float(offset.get("confidence", 0.5) or 0.5)
        total_confidence += conf

    avg_confidence = total_confidence / max(len(alignment_offsets), 1)
    return round(avg_confidence * 100, 2)


def dynamic_duration_profile(text):
    lower = str(text or "").lower()
    if any(word in lower for word in ["lucu", "ngakak", "ketawa", "kocak", "gila", "wah"]):
        return {"type": "punchline", "min": 25, "target": 42, "max": 65}
    if any(word in lower for word in ["cara", "tutorial", "tips", "strategi", "langkah", "belajar"]):
        return {"type": "tutorial", "min": 45, "target": 75, "max": 110}
    if any(word in lower for word in ["cerita", "dulu", "akhirnya", "karena", "konflik", "masalah", "kejadian"]):
        return {"type": "storytelling", "min": 55, "target": 95, "max": 145}
    return {"type": "general", "min": 30, "target": 60, "max": 90}


def detect_penalties(transcript, duration, metrics=None):
    """Detect penalty conditions and return list of penalty values.

    Penalty types:
    - too_silent: -20 if silence detected
    - too_short: -10 if duration below minimum
    - no_payoff: -15 if story incomplete without payoff
    """
    penalties = []
    metrics = metrics or {}

    # Check for too short
    if duration:
        profile = dynamic_duration_profile(str(transcript or ""))
        min_dur = float(profile.get("min", 35))
        if float(duration) < min_dur:
            penalties.append(-10)

    # Check for no_payoff
    payoff = float(metrics.get("payoff", 0))
    if payoff < 45:
        penalties.append(-15)

    # Check for too_silent (low emotion score)
    emotion = float(metrics.get("emotion", 0))
    if emotion < 30:
        penalties.append(-20)

    return penalties


def score_highlight(metrics):
    metrics = metrics or {}
    hook = float(metrics.get("hook", 0))
    emotion = float(metrics.get("emotion", 0))
    payoff = float(metrics.get("payoff", 0))
    retention = float(metrics.get("flow", metrics.get("retention", 0)))
    story = float(metrics.get("story_complete", 0))
    conflict = float(metrics.get("conflict", 0))
    speaker_energy = float(metrics.get("speaker_energy", metrics.get("dialogue", metrics.get("conversation", 0))))
    visual_activity = float(metrics.get("visual_activity", metrics.get("face_activity", 45)))
    novelty = float(metrics.get("novelty", 0))
    seo_potential = float(metrics.get("seo_potential", metrics.get("knowledge", 0)))
    virality = float(metrics.get("virality", metrics.get("trend", 0)))
    retention_predictor = float(metrics.get("retention_predictor", retention))
    # Prompt V3.3 weights total 105%. Divide by 1.05 so the result remains
    # a real 0-100 score instead of inflating strong candidates to 99.
    score = (
        hook * 0.18
        + story * 0.18
        + conflict * 0.12
        + emotion * 0.12
        + payoff * 0.15
        + retention_predictor * 0.10
        + speaker_energy * 0.05
        + visual_activity * 0.05
        + novelty * 0.05
        + seo_potential * 0.05
    ) / 1.05
    filler = float(metrics.get("filler_ratio", 0) or 0)
    if filler > 0.08:
        score -= min(12, (filler - 0.08) * 85)
    if story < 48:
        score -= 8
    if payoff < 52:
        score -= 5
    # Add penalty scores
    penalties = metrics.get("penalties", [])
    for penalty in penalties:
        score += float(penalty)
    return bounded_score(score, 25, 97)


def score_highlight_v2(metrics):
    """Enhanced highlight scoring with penalties and forced alignment support.

    New features:
    - Penalty scoring (too_silent, too_short, no_payoff)
    - Forced alignment confidence
    - Multi-face confidence boost
    - Real engagement predictor
    """
    metrics = metrics or {}

    # Extract metrics
    hook = float(metrics.get("hook", 0))
    emotion = float(metrics.get("emotion", 0))
    payoff = float(metrics.get("payoff", 0))
    retention = float(metrics.get("flow", metrics.get("retention", 0)))
    story = float(metrics.get("story_complete", 0))
    duration_fit = float(metrics.get("duration_fit", 0))
    surprise = float(metrics.get("surprise", 0))
    conflict = float(metrics.get("conflict", 0))
    dialogue = float(metrics.get("dialogue", metrics.get("conversation", 0)))
    virality = float(metrics.get("virality", metrics.get("trend", 0)))
    retention_predictor = float(metrics.get("retention_predictor", retention))

    # Base score calculation
    score = (
        hook * 0.17
        + emotion * 0.13
        + payoff * 0.16
        + story * 0.14
        + retention_predictor * 0.12
        + surprise * 0.10
        + conflict * 0.08
        + dialogue * 0.05
        + virality * 0.03
        + duration_fit * 0.02
    )

    # Apply filler penalty
    filler = float(metrics.get("filler_ratio", 0) or 0)
    if filler > 0.08:
        score -= min(12, (filler - 0.08) * 85)

    # Apply forced alignment confidence boost
    alignment_score = float(metrics.get("forced_alignment_score", 50))
    if alignment_score > 70:
        score += 3

    # Face tracking is editing evidence, not proof that a story is valuable.
    face_confidence = float(metrics.get("face_confidence", 0))
    if face_confidence > 80:
        score += 1
    elif face_confidence > 60:
        score += 0.5

    # Apply engagement predictor boost
    engagement = float(metrics.get("real_engagement", 0))
    if engagement > 70:
        score += 3

    # Apply story penalties
    if story < 48:
        score -= 8
    if payoff < 52:
        score -= 5

    # Apply additional penalties from detect_penalties
    penalties = metrics.get("penalties", [])
    for penalty in penalties:
        score += float(penalty)

    return bounded_score(score, 25, 97)


def multi_face_confidence(face_tracks):
    """Calculate confidence score for multi-face tracking.

    Args:
        face_tracks: List of face track dicts with "confidence", "visibility", "stability"

    Returns:
        float confidence score from 0-100
    """
    if not face_tracks:
        return 0.0

    total_score = 0.0
    for track in face_tracks:
        confidence = float(track.get("confidence", 0.5) or 0.5)
        visibility = float(track.get("visibility", 0.5) or 0.5)
        stability = float(track.get("stability", 0.5) or 0.5)

        # Weighted combination
        track_score = confidence * 0.5 + visibility * 0.25 + stability * 0.25
        total_score += track_score

    # Average score scaled to 0-100
    avg_score = total_score / max(len(face_tracks), 1)
    return round(min(100.0, avg_score * 100), 2)


def shot_boundary_detection(frames, threshold=0.3):
    """Detect shot boundaries in a sequence of frames.

    Args:
        frames: List of frame metrics with "scene_confidence" or "frame_diff"
        threshold: Difference threshold to detect shot boundary (0-1)

    Returns:
        list of shot boundaries (frame indices)
    """
    boundaries = []
    prev_confidence = None

    for i, frame in enumerate(frames):
        confidence = float(frame.get("scene_confidence", 0) or 0)
        frame_diff = float(frame.get("frame_diff", 0) or 0)

        if prev_confidence is not None:
            diff = abs(confidence - prev_confidence)
            if diff > threshold or frame_diff > threshold * 100:
                boundaries.append(i)

        prev_confidence = confidence

    return boundaries


def real_engagement_predictor(transcript, metrics=None):
    """Predict real engagement score based on content analysis.

    Args:
        transcript: Video transcript text
        metrics: Optional additional metrics

    Returns:
        float engagement score from 0-100
    """
    if not transcript:
        return 30.0

    lower = str(transcript).lower()

    # Engagement indicators
    engagement_factors = {
        "question": 5,
        "ajaib": 8,
        "gila": 7,
        "kaget": 7,
        "wah": 6,
        "ngakak": 8,
        "ketawa": 6,
        "lucu": 7,
        "penting": 5,
        "harus": 6,
        "jangan": 5,
        "kenapa": 7,
        "bagaimana": 6,
        "bener": 5,
        "seru": 7,
        "mantap": 6,
        "keren": 6,
    }

    total_score = 0
    words = re.findall(r"\w+", lower)

    for word in words:
        if word in engagement_factors:
            total_score += engagement_factors[word]

    # Normalize score based on word count
    word_count = len(words)
    normalized_score = min(100.0, (total_score / max(word_count, 1)) * 20)

    # Bonus for short, punchy content
    if word_count < 50:
        normalized_score += 10

    return round(min(100.0, normalized_score), 2)


# -- Caching utilities -------------------------------------------------
CACHE_DIR = os.path.join(os.path.dirname(__file__), "..", ".cache")
CACHE_FILE = os.path.join(CACHE_DIR, "highlight_cache.json")


def _ensure_cache():
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
    except Exception:
        pass
    if not os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "w", encoding="utf-8") as f:
                json.dump({}, f)
        except Exception:
            pass


def _load_cache():
    _ensure_cache()
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_cache(cache):
    _ensure_cache()
    try:
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(cache, f)
    except Exception:
        pass


def transcript_hash(transcript) -> str:
    payload = json.dumps(transcript, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _clip_segment_text(text, segment_start, segment_end, window_start, window_end):
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    words = text.split()
    if not words or segment_end <= segment_start:
        return text
    overlap_start = max(segment_start, window_start)
    overlap_end = min(segment_end, window_end)
    if overlap_end <= overlap_start:
        return ""
    if overlap_start <= segment_start and overlap_end >= segment_end:
        return text
    span = segment_end - segment_start
    first = max(0, min(len(words) - 1, int(math.floor(((overlap_start - segment_start) / span) * len(words)))))
    last = max(first + 1, min(len(words), int(math.ceil(((overlap_end - segment_start) / span) * len(words)))))
    return re.sub(r"\s+", " ", " ".join(words[first:last])).strip()


def transcript_text_between(transcript, start, end):
    parts = []
    for item in transcript or []:
        try:
            seg_start = float(item.get("start") or 0.0)
            seg_end = float(item.get("end") or seg_start)
        except Exception:
            continue
        if seg_end <= float(start) or seg_start >= float(end):
            continue
        text = _clip_segment_text(
            item.get("text") or "",
            seg_start,
            seg_end,
            float(start),
            float(end),
        )
        if text:
            parts.append(text)
    return re.sub(r"\s+", " ", " ".join(parts)).strip()


STOPWORDS = {
    "yang", "dan", "atau", "dari", "untuk", "dengan", "jadi", "ini", "itu",
    "ada", "saya", "aku", "gue", "gua", "kamu", "dia", "mereka", "kita",
    "kalau", "kalo", "karena", "terus", "tapi", "ya", "kan", "nah", "gitu",
}


def keyword_hits(text, keywords):
    lower = str(text or "").lower()
    return sum(1 for keyword in keywords if keyword in lower)


def evidence_metrics(text, duration, segments=None, metadata=None):
    """Build deterministic scores from observable transcript/timeline evidence."""
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    lower = text.lower()
    words = re.findall(r"\w+", lower, flags=re.UNICODE)
    useful = [word for word in words if len(word) > 2 and word not in STOPWORDS]
    unique_ratio = len(set(useful)) / max(1, len(useful))
    duration = max(1.0, float(duration or 1.0))
    density = len(words) / duration
    first = " ".join(words[:22])
    last = " ".join(words[-28:])
    segments = segments or []
    metadata = metadata or {}

    curiosity = keyword_hits(first, ["kenapa", "kok", "gimana", "bagaimana", "siapa", "ternyata", "jangan", "rahasia", "aneh"])
    connectors = keyword_hits(lower, ["karena", "kemudian", "lalu", "setelah", "sebelum", "akhirnya", "makanya", "ternyata"])
    conflict_hits = keyword_hits(lower, ["konflik", "ribut", "debat", "ditolak", "masalah", "marah", "bohong", "bullying", "kontroversi"])
    emotion_hits = keyword_hits(lower, ["ketawa", "ngakak", "lucu", "sedih", "nangis", "marah", "takut", "kaget", "hening", "merinding", "kecewa"])
    payoff_hits = keyword_hits(
        last,
        [
            "akhirnya",
            "ternyata",
            "makanya",
            "intinya",
            "hasilnya",
            "jawabannya",
            "solusinya",
            "berhasil",
            "terbukti",
            "terjawab",
        ],
    )
    setup_hits = curiosity + keyword_hits(
        first,
        ["awalnya", "dulu", "waktu", "ketika", "masalahnya", "ceritanya"],
    )
    value_hits = keyword_hits(lower, ["cara", "tips", "strategi", "alasan", "solusi", "fakta", "pelajaran", "penting", "contoh"])
    question_hits = text.count("?") + keyword_hits(first, ["apa", "kenapa", "bagaimana", "siapa"])
    speakers = {str(item.get("speaker_id") or item.get("speaker") or "") for item in segments if item.get("speaker_id") or item.get("speaker")}
    speaker_changes = 0
    previous_speaker = None
    for item in segments:
        speaker = str(item.get("speaker_id") or item.get("speaker") or "")
        if speaker and previous_speaker and speaker != previous_speaker:
            speaker_changes += 1
        if speaker:
            previous_speaker = speaker

    hook = 30 + curiosity * 8 + min(14, question_hits * 5) + min(6, text.count("!") * 2)
    story = (
        28
        + min(18, setup_hits * 8)
        + min(26, connectors * 5)
        + (18 if payoff_hits else 0)
        + (4 if re.search(r"[.!?]$", text) else 0)
    )
    if not payoff_hits:
        story = min(story, 64)
    conflict = 30 + min(60, conflict_hits * 12)
    emotion = 30 + min(60, emotion_hits * 10 + text.count("!") * 3)
    payoff = 24 + min(56, payoff_hits * 14) + (4 if re.search(r"[.!?]$", text) else 0)
    if not payoff_hits:
        payoff = min(payoff, 46)
    retention = 42 + max(0, 18 - abs(density - 2.2) * 9) + min(18, curiosity * 3 + connectors * 2)
    speaker_energy = 42 + min(34, speaker_changes * 7 + max(0, len(speakers) - 1) * 6)
    visual_activity = float(metadata.get("visual_activity") or metadata.get("face_activity") or 45)
    novelty = 35 + unique_ratio * 50
    seo_potential = 36 + min(42, value_hits * 7 + len(set(useful[:30])) * 0.8)
    surprise = 32 + keyword_hits(lower, ["ternyata", "mendadak", "tiba-tiba", "nggak nyangka", "baru tahu", "aneh"]) * 11
    virality = (hook * 0.30 + emotion * 0.20 + conflict * 0.20 + payoff * 0.20 + novelty * 0.10)

    metrics = {
        "hook": bounded_score(hook, 20, 96),
        "story_complete": bounded_score(story, 20, 96),
        "conflict": bounded_score(conflict, 20, 96),
        "emotion": bounded_score(emotion, 20, 96),
        "payoff": bounded_score(payoff, 20, 96),
        "flow": bounded_score(retention, 25, 95),
        "retention_predictor": bounded_score(retention, 25, 95),
        "speaker_energy": bounded_score(speaker_energy, 25, 95),
        "dialogue": bounded_score(speaker_energy, 25, 95),
        "visual_activity": bounded_score(visual_activity, 20, 95),
        "novelty": bounded_score(novelty, 25, 95),
        "seo_potential": bounded_score(seo_potential, 25, 95),
        "surprise": bounded_score(surprise, 20, 96),
        "virality": bounded_score(virality, 20, 96),
        "duration_fit": bounded_score(95 - abs(duration - 75) * 0.32, 35, 95),
        "filler_ratio": filler_ratio(text),
        "evidence": {
            "word_count": len(words),
            "speaker_changes": speaker_changes,
            "curiosity_hits": curiosity,
            "conflict_hits": conflict_hits,
            "emotion_hits": emotion_hits,
            "payoff_hits": payoff_hits,
            "setup_hits": setup_hits,
        },
    }
    metrics["penalties"] = detect_penalties(text, duration, metrics)
    return metrics


# -- Candidate generation, filtering and selection ---------------------
def generate_highlight_candidates(transcript: List[Dict[str, Any]],
                                  anchors: List[Dict[str, Any]] = None,
                                  metadata: Dict[str, Any] = None,
                                  config: Dict[str, Any] = None) -> List[Dict[str, Any]]:
    """Generate 40-80 highlight candidates from transcript and anchors.

    Args:
        transcript: list of transcript segments with `start`, `end`, `text`.
        anchors: list of important timestamps (e.g., speaker changes, shots)
        metadata: optional video metadata
        config: tuning parameters

    Returns:
        list of candidate dicts with start,end,text,metrics,score
    """
    anchors = anchors or []
    metadata = metadata or {}
    config = config or {}

    # Check cache
    key = transcript_hash({"schema": 3, "transcript": transcript, "anchors": anchors, "meta": metadata, "config": config})
    cache = _load_cache()
    cached = cache.get(key)
    if cached:
        return cached

    # Candidate generation is deterministic. Every seed comes from a transcript,
    # story, or timeline anchor; no random score or random ordering is allowed.
    seeds = []
    story_candidates = metadata.get("story_candidates") or []
    for item in story_candidates:
        try:
            seeds.append((float(item.get("start") or 0), float(item.get("end") or 0), "story"))
        except Exception:
            continue

    for item in transcript or []:
        try:
            start = float(item.get("start", 0) or 0)
            end = float(item.get("end", start) or start)
            if re.search(r"[.!?…]$", str(item.get("text") or "")):
                profile = dynamic_duration_profile(item.get("text") or "")
                target = float(profile.get("target") or 75)
                seeds.append((max(0.0, start - target * 0.18), start + target * 0.82, "sentence"))
        except Exception:
            continue

    # anchors
    for a in anchors:
        try:
            t = float(a.get("time", a.get("timestamp", 0)) or 0)
            seeds.append((max(0, t - 32), t + 43, str(a.get("type") or "anchor")))
        except Exception:
            continue

    # sliding windows around transcript with variable durations
    source_items = list(transcript or [])
    desired_seed_count = max(80, min(240, int(config.get("max_candidates", 80)) * 3))
    stride = max(1, len(source_items) // desired_seed_count)
    for index in range(0, len(source_items), stride):
        item = source_items[index]
        start = float(item.get("start") or 0)
        profile = dynamic_duration_profile(item.get("text") or "")
        target = float(profile.get("target") or 75)
        seeds.append((max(0, start - target * 0.15), start + target * 0.85, "timeline"))

    if not seeds and metadata.get("duration"):
        for start in range(0, int(metadata.get("duration") or 0), 45):
            seeds.append((float(start), min(float(metadata.get("duration") or 0), start + 75.0), "fallback"))

    # Deduplicate seeds and clamp
    normalized = []
    video_duration = float(metadata.get("duration") or 0)
    for s, e, source_type in seeds:
        s = round(max(0.0, float(s)), 2)
        e = round(max(s + 1.0, float(e)), 2)
        if video_duration:
            e = min(video_duration, e)
        if e - s < 20:
            continue
        if e - s > 180:
            e = s + 180
        normalized.append((s, e, source_type))

    normalized = sorted(set(normalized), key=lambda item: (item[0], item[1], item[2]))
    candidates = []
    for s, e, source_type in normalized[:320]:
        text = transcript_text_between(transcript, s, e)
        if len(re.findall(r"\w+", text)) < 18:
            continue
        source_segments = [item for item in transcript or [] if float(item.get("end") or 0) > s and float(item.get("start") or 0) < e]
        metrics = evidence_metrics(text, e - s, source_segments, metadata)
        score = score_highlight(metrics)
        candidates.append({
            "start": s,
            "end": e,
            "duration": round(e - s, 2),
            "text": text,
            "metrics": metrics,
            "score": score,
            "candidate_source": source_type,
        })

    # Normalize and apply diversity & overlap filters
    candidates = normalize_scores(candidates)
    candidates = apply_diversity_filter(candidates)
    ranked_before_overlap = sorted(candidates, key=lambda x: x.get("score", 0), reverse=True)
    candidates = apply_overlap_filter(ranked_before_overlap, overlap_threshold=0.65)

    # Choose final batch: aim 40-80 candidates, ranked
    candidates = sorted(candidates, key=lambda x: x.get("score", 0), reverse=True)
    n_min = int(config.get("min_candidates", 40))
    n_max = int(config.get("max_candidates", 80))
    final = candidates[:n_max]
    if len(final) < n_min:
        seen = {(item.get("start"), item.get("end")) for item in final}
        for item in ranked_before_overlap:
            key_item = (item.get("start"), item.get("end"))
            if key_item in seen:
                continue
            final.append(item)
            seen.add(key_item)
            if len(final) >= min(n_min, n_max):
                break
    # Save to cache
    try:
        cache[key] = final
        _save_cache(cache)
    except Exception:
        pass

    return final


def apply_diversity_filter(candidates: List[Dict[str, Any]], similarity_threshold: float = 0.75) -> List[Dict[str, Any]]:
    """Penalize or drop candidates that are semantically too similar.

    This is a lightweight heuristic: compare normalized text overlap.
    """
    out = []
    texts = []
    for c in sorted(candidates, key=lambda x: x.get("score", 0), reverse=True):
        t = (c.get("text") or "").lower()
        words = set(re.findall(r"\w+", t))
        keep = True
        for ot in texts:
            if not words or not ot:
                continue
            common = len(words & ot)
            union = max(1, len(words | ot))
            sim = common / union
            if sim >= similarity_threshold:
                # penalize by reducing score
                c["score"] = max(0, c.get("score", 0) - 20)
                # if score drops too low, skip
                if c["score"] < 40:
                    keep = False
                    break
        if keep:
            out.append(c)
            texts.append(words)
    return out


def apply_overlap_filter(candidates: List[Dict[str, Any]], overlap_threshold: float = 0.4) -> List[Dict[str, Any]]:
    """Remove or merge overlapping candidates.

    If two candidates overlap more than threshold proportion of the shorter one,
    keep the one with higher score.
    """
    res = []
    for c in sorted(candidates, key=lambda x: x.get("score", 0), reverse=True):
        s1, e1 = float(c.get("start", 0)), float(c.get("end", 0))
        d1 = e1 - s1
        conflict = False
        for kept in res[:]:
            s2, e2 = float(kept.get("start", 0)), float(kept.get("end", 0))
            d2 = e2 - s2
            inter_s = max(s1, s2)
            inter_e = min(e1, e2)
            inter = max(0.0, inter_e - inter_s)
            if inter <= 0:
                continue
            smaller = min(d1, d2)
            if smaller <= 0:
                continue
            if inter / smaller >= overlap_threshold:
                # overlap too large -> keep only higher scored (we iterate high->low)
                conflict = True
                break
        if not conflict:
            res.append(c)
    return res


def normalize_scores(candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Record deterministic rank metadata without altering evidence scores."""
    if not candidates:
        return candidates
    ranked = sorted(enumerate(candidates), key=lambda pair: float(pair[1].get("score", 0)), reverse=True)
    calibrated = list(candidates)
    for rank, (original_index, candidate) in enumerate(ranked):
        raw = float(candidate.get("score", 0))
        candidate["raw_score"] = round(raw, 2)
        candidate["score"] = round(max(25, min(97, raw)), 2)
        candidate["score_calibration"] = {
            "mode": "evidence_only",
            "rank": rank + 1,
            "candidate_count": len(ranked),
            "rank_adjustment": 0,
        }
        calibrated[original_index] = candidate
    return calibrated

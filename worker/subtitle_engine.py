# -*- coding: utf-8 -*-
"""Production subtitle timing engine for Cliper Studio Plus.

This module is intentionally dependency-light. It does not pretend to be
Whisper forced alignment, but it fixes the common production failure: sentence
captions rendered late because absolute/relative timestamps are mixed or hook
intro blocks the first spoken words.
"""

import math
import re

DEFAULT_LEAD = 0.08
DEFAULT_END_PAD = 0.04


def clean_text(value):
    text = re.sub(r"<[^>]+>", " ", str(value or ""))
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"&lt;", "<", text)
    text = re.sub(r"&gt;", ">", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def words_of(text):
    return re.findall(r"\w+", str(text or "").lower(), flags=re.UNICODE)


def srt_time(seconds):
    seconds = max(0.0, float(seconds or 0.0))
    millis = int(round((seconds - int(seconds)) * 1000))
    whole = int(seconds)
    if millis >= 1000:
        whole += 1
        millis = 0
    hours = whole // 3600
    minutes = (whole % 3600) // 60
    secs = whole % 60
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


CAPTION_MAX_CHARS = 32
CAPTION_MAX_WORDS = 5


def subtitle_phrase_chunks(text, max_chars=CAPTION_MAX_CHARS, max_words=CAPTION_MAX_WORDS):
    text = clean_text(text)
    if not text:
        return []
    chunks = []
    current = []
    for raw_word in text.split():
        word = raw_word.strip()
        if not word:
            continue
        proposed = current + [word]
        proposed_text = " ".join(proposed)
        boundary = bool(re.search(r"[,.!?…:]$", word))
        if current and (len(proposed) > max_words or len(proposed_text) > max_chars):
            chunks.append(" ".join(current))
            current = [word]
        else:
            current = proposed
        if boundary and current and (len(current) >= 3 or len(" ".join(current)) >= 12):
            chunks.append(" ".join(current))
            current = []
    if current:
        chunks.append(" ".join(current))

    merged = []
    for chunk in chunks:
        if merged and len(chunk) < 8 and len(f"{merged[-1]} {chunk}") <= max_chars:
            merged[-1] = f"{merged[-1]} {chunk}"
        else:
            merged.append(chunk)
    return merged


def timed_chunks_for_segment(start, end, text, max_chars=CAPTION_MAX_CHARS, max_words=CAPTION_MAX_WORDS):
    chunks = subtitle_phrase_chunks(text, max_chars=max_chars, max_words=max_words)
    if not chunks:
        return []
    duration = max(0.25, float(end) - float(start))
    weights = [max(1, len(words_of(chunk))) for chunk in chunks]
    total = max(1, sum(weights))
    cursor = float(start)
    events = []
    for index, chunk in enumerate(chunks):
        part = duration * weights[index] / total
        min_part = 0.34 if len(chunk) <= 14 else 0.46
        chunk_end = float(end) if index == len(chunks) - 1 else min(float(end), cursor + max(min_part, part))
        if chunk_end <= cursor:
            chunk_end = min(float(end), cursor + 0.34)
        if chunk_end - cursor >= 0.20:
            events.append({"start": round(cursor, 3), "end": round(chunk_end, 3), "text": clean_text(chunk)})
        cursor = chunk_end
        if cursor >= float(end):
            break
    return events


def chunk_word_items(words, max_chars=CAPTION_MAX_CHARS, max_words=CAPTION_MAX_WORDS):
    """Keep a word-aligned caption inside the 9:16 safe text width.

    Whisper can return an entire spoken sentence as one segment with perfectly
    good word timestamps. Rendering that sentence as one karaoke event lets
    libass wrap it unpredictably, which can push text beyond the portrait
    frame. Split only between words, retain their timestamps, and let the
    renderer switch to the next compact phrase at the next spoken word.
    """
    chunks = []
    current = []

    def flush():
        nonlocal current
        if current:
            chunks.append(current)
            current = []

    for raw_item in words or []:
        if not isinstance(raw_item, dict):
            continue
        word = clean_text(raw_item.get("word") or "")
        if not word:
            continue
        item = dict(raw_item)
        item["word"] = word
        proposed = current + [item]
        proposed_text = " ".join(entry["word"] for entry in proposed)
        if current and (len(proposed) > max_words or len(proposed_text) > max_chars):
            flush()
        current.append(item)
        if re.search(r"[,.!?…:]$", word) and (len(current) >= 3 or len(" ".join(entry["word"] for entry in current)) >= 14):
            flush()
    flush()

    # Avoid a one-word flash at the end when it can safely belong to the
    # preceding phrase. Never merge past the same width limits used above.
    merged = []
    for chunk in chunks:
        chunk_text = " ".join(entry["word"] for entry in chunk)
        if merged:
            previous_text = " ".join(entry["word"] for entry in merged[-1])
            if (
                len(chunk) <= 1
                and len(merged[-1]) + len(chunk) <= max_words
                and len(f"{previous_text} {chunk_text}") <= max_chars
            ):
                merged[-1].extend(chunk)
                continue
        merged.append(chunk)
    return merged


def ass_color(value, fallback="#ffffff"):
    text = str(value or fallback).strip()
    if not re.match(r"^#[0-9a-fA-F]{6}$", text):
        text = fallback
    red = text[1:3]
    green = text[3:5]
    blue = text[5:7]
    return f"&H00{blue}{green}{red}&"


def ass_escape(value):
    text = clean_text(value)
    text = text.replace("\\", "\\\\").replace("{", "").replace("}", "")
    return text


def split_ass_tokens(text):
    text = clean_text(text)
    if not text:
        return []
    return re.findall(r"\w+(?:['’\-]\w+)*|[.,!?;:]", text, flags=re.UNICODE)


def build_word_highlight_ass_text(start, end, text, active_color="#19ff47", default_color="#ffffff", words=None):
    start = max(0.0, float(start or 0.0))
    end = max(start + 0.2, float(end or start + 0.2))
    visible_text = clean_text(text or "")
    if not visible_text:
        return ""

    if words:
        token_items = []
        for item in words or []:
            token_text = clean_text((item.get("word") if isinstance(item, dict) else item) or "")
            if not token_text:
                continue
            try:
                token_start = float((item.get("start") if isinstance(item, dict) else None) or 0.0)
                token_end = float((item.get("end") if isinstance(item, dict) else None) or token_start + 0.2)
            except Exception:
                token_start = start
                token_end = end
            token_items.append((token_text, token_start, token_end))
        if token_items:
            total_span = max(0.2, end - start)
            tokens = []
            for token_text, token_start, token_end in token_items:
                token_span = max(0.08, min(total_span, max(0.08, token_end - token_start)))
                tokens.append((token_text, token_span))
        else:
            tokens = [(token, 0.12) for token in split_ass_tokens(visible_text)]
    else:
        tokens = [(token, 0.12) for token in split_ass_tokens(visible_text)]

    parts = []
    active_ass_color = ass_color(active_color, "#19ff47")
    default_ass_color = ass_color(default_color, "#ffffff")
    total_words = sum(1 for token, _ in tokens if re.match(r"\w", token))
    if total_words == 0:
        return ass_escape(visible_text)

    word_index = 0
    for token, token_span in tokens:
        if re.match(r"\w", token):
            word_index += 1
            duration_centis = max(8, min(85, int(round(max(0.08, token_span) * 100))))
            fallback = r"{\c" + default_ass_color + r"\fscx100\fscy100}" + ass_escape(token)
            parts.append(r"{\k" + str(duration_centis) + r"\c" + active_ass_color + r"\fscx110\fscy110}" + ass_escape(token) + r"{\c" + default_ass_color + r"\fscx100\fscy100}")
        else:
            parts.append(ass_escape(token))
    return " ".join(parts).replace(" {", "{").replace("} ", "}")


class SubtitleEngine:
    def __init__(self, lead_seconds=DEFAULT_LEAD, end_pad_seconds=DEFAULT_END_PAD):
        self.lead_seconds = max(0.05, min(0.14, float(lead_seconds)))
        self.end_pad_seconds = max(0.0, min(0.10, float(end_pad_seconds)))

    def finalize_events(self, events, duration):
        finalized = []
        duration = max(0.1, float(duration or 0.1))
        for item in sorted(events or [], key=lambda event: float(event.get("start") or 0.0)):
            start = max(0.0, float(item.get("start") or 0.0))
            end = min(duration, float(item.get("end") or start))
            if finalized and start < float(finalized[-1]["end"]):
                # Lead padding may overlap adjacent captions. Keep the new
                # caption locked to its audio and trim the previous caption,
                # otherwise small corrections accumulate into visible drift.
                previous = finalized[-1]
                if start - float(previous["start"]) >= 0.18:
                    previous["end"] = round(start, 3)
                else:
                    start = float(previous["end"])
            if end <= start:
                end = min(duration, start + 0.24)
            if end - start < 0.18:
                continue
            next_item = dict(item)
            next_item["start"] = round(start, 3)
            next_item["end"] = round(end, 3)
            finalized.append(next_item)
        return finalized

    @staticmethod
    def is_exact_timeline_duplicate(event, events):
        if not events:
            return False
        previous = events[-1]
        return (
            clean_text(previous.get("text") or "").lower() == clean_text(event.get("text") or "").lower()
            and abs(float(previous.get("start") or 0.0) - float(event.get("start") or 0.0)) <= 0.03
            and abs(float(previous.get("end") or 0.0) - float(event.get("end") or 0.0)) <= 0.03
        )

    def normalize_segments(self, moment, transcript, duration):
        duration = max(0.1, float(duration or 0.1))
        clip_start = float((moment or {}).get("start") or 0.0)
        clip_end = clip_start + duration
        raw = []
        for segment in transcript or []:
            try:
                start = float(segment.get("start") or 0.0)
                end = float(segment.get("end") or start)
            except Exception:
                continue
            text = clean_text(segment.get("text") or "")
            if end <= start or not text:
                continue
            raw.append({
                "start": start,
                "end": end,
                "text": text,
                "speaker_id": segment.get("speaker_id") or segment.get("speaker") or "",
                "words": segment.get("words") or [],
            })
        if not raw:
            return []

        absolute_hits = [item for item in raw if item["end"] > clip_start and item["start"] < clip_end]
        max_raw_end = max(item["end"] for item in raw)
        min_raw_start = min(item["start"] for item in raw)
        looks_relative = max_raw_end <= duration + 3.0 and min_raw_start < min(duration, 12.0)
        use_relative = looks_relative and len(absolute_hits) < max(1, len(raw) // 3)
        source = raw if use_relative else absolute_hits

        result = []
        for item in source:
            if use_relative:
                rel_start = item["start"]
                rel_end = item["end"]
            else:
                rel_start = item["start"] - clip_start
                rel_end = item["end"] - clip_start
            rel_start = max(0.0, rel_start - self.lead_seconds)
            rel_end = min(duration, max(rel_start + 0.24, rel_end + self.end_pad_seconds))
            if rel_end <= 0 or rel_start >= duration:
                continue
            result.append({
                "start": round(max(0.0, rel_start), 3),
                "end": round(min(duration, rel_end), 3),
                "text": item["text"],
                "speaker_id": item.get("speaker_id") or "",
                "words": [
                    {
                        "word": clean_text(word.get("word") or ""),
                        "start": round(max(0.0, (float(word.get("start") or 0.0) if use_relative else float(word.get("start") or 0.0) - clip_start) - self.lead_seconds), 3),
                        "end": round(min(duration, max(0.04, (float(word.get("end") or 0.0) if use_relative else float(word.get("end") or 0.0) - clip_start) + self.end_pad_seconds)), 3),
                    }
                    for word in item.get("words") or []
                    if isinstance(word, dict) and clean_text(word.get("word") or "")
                ],
            })
        return sorted(result, key=lambda item: item["start"])

    def build_events(self, moment, transcript, duration, fallback_text="", max_events=32):
        events = []
        for segment in self.normalize_segments(moment, transcript, duration):
            if segment.get("words"):
                # Do not make one full transcript segment a single karaoke
                # caption. A segment can contain 20+ words, while the visual
                # style permits only two compact lines in portrait output.
                word_chunks = chunk_word_items(segment.get("words") or [])
                for chunk_index, word_chunk in enumerate(word_chunks):
                    start = max(float(segment["start"]), float(word_chunk[0].get("start") or segment["start"]))
                    spoken_end = float(word_chunk[-1].get("end") or segment["end"])
                    if chunk_index + 1 < len(word_chunks):
                        # Keep the fully read phrase visible until the next
                        # compact phrase starts; finalize_events trims this
                        # boundary safely if lead padding overlaps it.
                        next_start = float(word_chunks[chunk_index + 1][0].get("start") or spoken_end)
                        end = min(float(segment["end"]), max(spoken_end, next_start))
                    else:
                        # Keep the last phrase through the segment end pad so
                        # the final active word can return to its neutral
                        # color instead of disappearing abruptly.
                        end = float(segment["end"])
                    if end <= start:
                        continue
                    event = {
                        "start": round(start, 3),
                        "end": round(end, 3),
                        "text": clean_text(" ".join(item.get("word") or "" for item in word_chunk)),
                        "speaker_id": segment.get("speaker_id") or "",
                        "words": word_chunk,
                    }
                    if not self.is_exact_timeline_duplicate(event, events):
                        events.append(event)
                    if len(events) >= max_events:
                        return self.finalize_events(events, duration)
                continue
            for event in timed_chunks_for_segment(segment["start"], segment["end"], segment["text"]):
                if not clean_text(event["text"]):
                    continue
                event["speaker_id"] = segment.get("speaker_id") or ""
                if not self.is_exact_timeline_duplicate(event, events):
                    events.append(event)
                if len(events) >= max_events:
                    return self.finalize_events(events, duration)
        if events:
            return self.finalize_events(events, duration)

        fallback_text = clean_text(fallback_text or (moment or {}).get("transcript") or (moment or {}).get("text") or "")
        if not fallback_text:
            return []
        chunks = subtitle_phrase_chunks(" ".join(fallback_text.split()[:110]))[:max_events]
        usable = max(1.0, float(duration or 1.0))
        total_words = max(1, sum(len(words_of(chunk)) for chunk in chunks))
        cursor = 0.05
        for chunk in chunks:
            weight = max(1, len(words_of(chunk)))
            part = usable * weight / total_words
            end = min(float(duration), cursor + max(0.48, part * 0.95))
            if end - cursor >= 0.28:
                events.append({"start": round(cursor, 3), "end": round(end, 3), "text": clean_text(chunk), "speaker_id": ""})
            cursor = end
            if cursor >= float(duration):
                break
        return self.finalize_events(events, duration)

    def create_srt(self, events):
        lines = []
        for index, event in enumerate(events or [], 1):
            lines.append(str(index))
            lines.append(f"{srt_time(event['start'])} --> {srt_time(event['end'])}")
            lines.append(clean_text(event.get("text") or ""))
            lines.append("")
        return "\n".join(lines)

    def generate(self, transcript, moment=None, duration=None):
        duration = duration if duration is not None else max((float(item.get("end") or 0) for item in transcript or []), default=0.0)
        events = self.build_events(moment or {"start": 0}, transcript, duration or 1.0)
        return {
            "subtitles": events,
            "srt": self.create_srt(events),
            "metadata": {
                "total_subtitles": len(events),
                "subtitle_lead": self.lead_seconds,
                "engine": "subtitle_engine_v4_phrase_sync",
            },
        }

import re


class SpeakerEngine:
    def assign_transcript_speakers(self, transcript):
        speakers = []
        previous_speaker = "A"
        for item in transcript or []:
            text = str(item.get("text") or "")
            lower = text.lower()
            if re.search(r"\b(gue|gua|aku|saya)\b", lower):
                speaker = "A"
            elif re.search(r"\b(lo|lu|kamu|anda|dia)\b", lower):
                speaker = "B"
            else:
                speaker = previous_speaker
            previous_speaker = speaker
            enriched = dict(item)
            enriched["speaker_id"] = speaker
            enriched["emotion_score"] = self._emotion_score(lower)
            enriched["importance_score"] = self._importance_score(lower)
            speakers.append(enriched)
        return speakers

    def detect_active_speaker(self, audio_segments, face_tracks):
        scores = {}
        for segment in audio_segments or []:
            speaker = segment.get("speaker_id") or segment.get("speaker") or "A"
            scores[speaker] = scores.get(speaker, 0.0) + float(segment.get("importance_score") or 1.0) * 0.60
        for track in face_tracks or []:
            speaker = track.get("speaker_id") or track.get("speaker") or "A"
            scores[speaker] = scores.get(speaker, 0.0) + float(track.get("visual_score") or track.get("activity") or 1.0) * 0.40
        if not scores:
            return {"speaker": "center", "score": 0.0}
        speaker, score = max(scores.items(), key=lambda item: item[1])
        return {"speaker": speaker, "score": round(score, 3)}

    @staticmethod
    def _emotion_score(lower):
        return min(100, 35 + sum(10 for word in ["kaget", "marah", "lucu", "sedih", "gila", "wah", "ngakak"] if word in lower))

    @staticmethod
    def _importance_score(lower):
        return min(100, 35 + sum(9 for word in ["jadi", "karena", "ternyata", "akhirnya", "penting", "masalah", "jawaban"] if word in lower))

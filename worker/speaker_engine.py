class SpeakerEngine:
    def assign_transcript_speakers(self, transcript):
        speakers = []
        previous_speaker = ""
        for item in transcript or []:
            text = str(item.get("text") or "")
            lower = text.lower()
            explicit_speaker = str(
                item.get("speaker_id")
                or item.get("speaker")
                or item.get("speaker_label")
                or ""
            ).strip()
            # Pronouns identify who is being discussed, not who is speaking.
            # The old aku/kamu heuristic frequently switched the camera to a
            # nonexistent speaker. Preserve diarization labels when available;
            # otherwise hold the last known speaker until audio/visual evidence
            # supplies a real identity.
            speaker = explicit_speaker or previous_speaker
            if explicit_speaker:
                previous_speaker = explicit_speaker
            enriched = dict(item)
            if speaker:
                enriched["speaker_id"] = speaker
                enriched["speaker_verified"] = True
            else:
                enriched.pop("speaker_id", None)
                enriched["speaker_verified"] = False
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

# -*- coding: utf-8 -*-
SUBTITLE_LEAD = 0.14

def generate_subtitles(transcript):
    if not transcript:
        return []
    result = []
    for item in transcript:
        start = float(item.get('start', 0))
        end = float(item.get('end', start))
        text = str(item.get('text', ''))
        speaker = item.get('speaker_id', '')
        result.append({'start': round(max(0, start - SUBTITLE_LEAD), 3), 'end': round(end, 3), 'text': text, 'speaker_id': speaker})
    return result

class SubtitleEngine:
    def generate(self, transcript):
        subs = generate_subtitles(transcript)
        return {'subtitles': subs, 'metadata': {'total_subtitles': len(subs), 'subtitle_lead': SUBTITLE_LEAD}}

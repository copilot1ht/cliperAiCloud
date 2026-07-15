CLIPER STUDIO PLUS V3.1 - HIGHLIGHT ENGINE SPECIFICATION

OVERVIEW
========
Highlight engine scores video segments for virality potential with penalty system.

BASE SCORING (score_highlight_v2)
==================================
Weighted factors:

| Factor              | Weight |
|---------------------|--------|
| Hook                | 0.17   |
| Emotion             | 0.13   |
| Payoff              | 0.16   |
| Story Complete      | 0.14   |
| Retention/Flow      | 0.12   |
| Surprise            | 0.10   |
| Conflict            | 0.08   |
| Dialogue            | 0.05   |
| Virality/Trend      | 0.03   |
| Duration Fit        | 0.02   |

Score = sum(factor * weight)

FILLER RATIO PENALTY
====================
Filler words: eee, emm, hmm, anu, jadi, nah, gitu, kayak

Penalty = min(12, (filler_ratio - 0.08) * 85)
Applied when filler_ratio > 0.08

STORY PENALTIES
===============
- story_complete < 48: -8 points
- payoff < 52: -5 points

DURATION PROFILE
================
Type-specific minimum/target/max durations:

| Type          | Min | Target | Max |
|---------------|-----|--------|-----|
| Punchline     | 35  | 50     | 75  |
| Tutorial      | 60  | 90     | 120 |
| Storytelling  | 90  | 135    | 180 |
| General       | 35  | 75     | 180 |

PENALTY SYSTEM
==============
detect_penalties(transcript, duration, metrics) returns list of penalties:

| Penalty      | Value | Condition                  |
|--------------|-------|----------------------------|
| too_silent   | -20   | emotion < 30               |
| too_short    | -10   | duration < profile min     |
| no_payoff    | -15   | payoff < 45                |

ENHANCED SCORING (score_highlight_v2)
======================================
Bonus factors:

1. Forced Alignment Boost (+3)
   - If alignment_score > 70

2. Multi-Face Confidence Boost (+4 or +2)
   - If face_confidence > 80: +4
   - If face_confidence > 60: +2

3. Engagement Predictor Boost (+5)
   - If real_engagement > 70

4. Speaker Density Boost (+10 per speaker)
   - Engagement = engagement_score + (speaker_density * 10)

FINAL SCORE
===========
bounded_score(score, floor=35, ceiling=99)

SCORE INTERPRETATION
====================
| Score Range | Quality    | Action              |
|-------------|------------|---------------------|
| 90-99       | Excellent  | Auto-render         |
| 80-89       | Good       | Render with priority|
| 70-79       | Average    | Consider rendering  |
| 60-69       | Below Avg  | Review before render|
| < 60        | Poor       | Skip                |

MULTI-FACE CONFIDENCE
=====================
multi_face_confidence(face_tracks):

For each track:
- confidence (0-1) * 0.5
- visibility (0-1) * 0.25
- stability (0-1) * 0.25

Total = average * 100

REAL ENGAGEMENT PREDICTOR
=========================
real_engagement_predictor(transcript):

Engagement indicators:
- question, ajaib, gila, ketawa, lucu, penting
- harus, kenapa, bagaimana, bener, seru, mantap, keren

Score = normalized indicator count * 20 + bonus

BONUS: +10 if word_count < 50

HIGHLIGHT GENERATION REQUIREMENTS
=================================
- Min duration highlight: 3s
- Max overlap 25% antar highlight
- Output: highlights.json (start, end, score, reason)

TESTING
-------
pytest tests/

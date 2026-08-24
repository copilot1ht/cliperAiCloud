# Quality Regression Audit

**Date:** 2026-07-21
**Status:** INVESTIGATION IN PROGRESS

## Critical Regressions Identified

### 1. Score Collapse

**Symptom:** Candidates with high Story (88, 90) receive low final scores (52, 46)

**Examples from Screenshot:**
```
Candidate 1: Story 88 → Final 52 (gap: -36)
Candidate 2: Story 85 → Final 46 (gap: -39)
Candidate 3: Story 84 → Final 43 (gap: -41)
```

**Root Causes to Investigate:**
- [ ] Final score formula weights incorrect (viral/hook overweighted?)
- [ ] Calibration layer applying unexpected penalties
- [ ] Provider disagreement causing score drag
- [ ] Payoff or clarity component undervalued
- [ ] Cache holding old score model

**Affected Functions:**
- `highlight_engine.py` - score calculation
- `ai_router.py` - provider fusion logic
- `score_calibration.py` - calibration layer
- `app.js` - UI presentation

**Previous Good Behavior:**
- [NEEDS GIT LOG AUDIT] - Find commit when Story score matched final score

---

### 2. Face Tracking Left-Right Oscillation

**Symptom:** Camera aggressively switches between speakers or face edges

**Root Causes to Investigate:**
- [ ] Dead zone too small (< 8% width)
- [ ] Hysteresis disabled or too short (< 650ms)
- [ ] Active speaker confidence threshold too low
- [ ] Shot hold minimum reduced (< 2.2s)
- [ ] Kalman/EMA smoothing disabled
- [ ] Frame-by-frame crop update (should be keyframe-based)

**Affected Functions:**
- `camera_engine.py` - face tracking pipeline
- `face_detector.py` - detection → identity association
- `crop_planner.py` - keyframe generation

**Previous Good Behavior:**
- [NEEDS GIT LOG AUDIT] - Find camera config parameters from working version

---

### 3. Multi-Person Camera Instability

**Symptom:** System doesn't distinguish 1-person, 2-person, 3-person, 4-person compositions

**Root Causes to Investigate:**
- [ ] No scene layout detection
- [ ] Face count not tracked
- [ ] Mode selection logic missing or broken
- [ ] Mono-person default applied to all
- [ ] No reaction shot validation

**Affected Functions:**
- `camera_director.py` - mode selection
- `scene_analyzer.py` - layout detection
- `speaker_detector.py` - diarization results

---

### 4. Subtitle Sync Regression

**Symptom:** Subtitles drift or double after clip is cut; previously worked

**Root Causes to Investigate:**
- [ ] Timestamp offset applied twice (candidateStart AND finalStart)
- [ ] Word timestamps mixed with phrase timestamps
- [ ] FFmpeg -ss before input not accounted for
- [ ] Boundary repair applied after ASS generation (wrong order)
- [ ] Hook intro added but subtitle not offset
- [ ] Cached transcript with incompatible source
- [ ] Audio trim != video trim causing A/V desync

**Formula to Validate:**
```
CORRECT:
  clipWordStart = sourceWordStart - finalClipStart
  clipWordEnd = sourceWordEnd - finalClipStart
  clamp to [0, clipDuration]

WRONG:
  clipWordStart = sourceWordStart - candidateStart - finalStart (double offset!)
```

**Affected Functions:**
- `worker/subtitle_engine.py` - timing conversion
- `phrase_grouper.py` - ASS generation
- `ffmpeg_wrapper.py` - trim logic
- `render_engine.py` - timeline management

**Previous Good Behavior:**
- [NEEDS GIT LOG AUDIT] - Find commit before subtitle regression started

---

## Investigation Checklist

### Git Archaeology

- [ ] Run `git log --oneline -20` on key files
- [ ] Find commit when subtitles worked
- [ ] Find commit when camera tracking worked
- [ ] Find commit when scores matched story quality
- [ ] Compare old vs new function signatures

**Key Files to Check:**
```
worker/highlight_engine.py
worker/camera_engine.py
worker/subtitle_engine.py
engine/camera_engine.py
app.js (score presentation)
electron/main.js (worker spawn)
```

### Code Comparison

For each regression, compare:

**Old implementation:**
- Function signature
- Parameter defaults
- Cache invalidation logic
- Score formula
- Timestamp conversion
- Camera smoothing parameters
- UI presentation

**New implementation:**
- Changes made
- Why they were made
- Unintended side effects

### Test Gaps

Regressions likely went unnoticed because:
- [ ] No unit tests for score components
- [ ] No integration test for camera modes
- [ ] No regression test for subtitle offset
- [ ] Cache tests missing
- [ ] Profile-specific scoring tests missing

---

## Fixes to Implement

### Fix #1: Score Component Breakdown

**Status:** NOT STARTED

**Changes Required:**

1. Update score calculation to output:
   ```json
   {
     "candidateId": "c123",
     "rawLocalScore": 76,
     "rawDeepSeekScore": 79,
     "rawOpenAiScore": 81,
     "calibratedScore": 78.4,
     "confidence": 0.88,
     "components": {
       "story": 86,
       "hook": 73,
       "payoff": 84,
       "clarity": 90,
       "emotion": 68,
       "visual": 72,
       "audio": 92,
       "viralPotential": 69,
       "contextCompleteness": 91,
       "technicalQuality": 89
     },
     "penalties": {
       "repetition": -4,
       "weakOpening": -2,
       "cutSentence": 0,
       "missingPayoff": 0,
       "lowVisualVariety": -3,
       "subtitleRisk": 0
     },
     "reasons": []
   }
   ```

2. Validate components sum to final (allow ±5 variance)
3. Flag candidates where gap > 15

**Files to Modify:**
- `worker/highlight_engine.py`
- `worker/ai_router.py`
- `app.js` (UI presentation)

---

### Fix #2: Camera Hysteresis and Dead Zone

**Status:** NOT STARTED

**Configuration Parameters to Implement:**

```python
CAMERA_CONFIG = {
    "FACE_MIN_CONFIDENCE": 0.75,
    "TRACK_MIN_FRAMES": 3,
    "TRACK_MAX_GAP": 300,  # ms
    "DEAD_ZONE_X": 0.10,  # 10% of width
    "DEAD_ZONE_Y": 0.08,  # 8% of height
    "MIN_SHOT_HOLD_MS": 2200,  # 2.2 seconds minimum
    "SWITCH_CONFIRM_MS": 650,  # must maintain confidence for 650ms
    "SWITCH_SCORE_MARGIN": 0.18,  # 18% higher to switch
    "MAX_SPEED_PIXELS_PER_SEC": 320,
    "MAX_ACCELERATION": 160,
    "EMA_ALPHA": 0.15,
    "FALLBACK_MODE": "SAFE_STATIC"  # when tracking fails
}
```

**Files to Modify:**
- `engine/camera_engine.py` - add config parameters
- `worker/camera_engine.py` - use config

---

### Fix #3: Subtitle Timestamp Audit

**Status:** NOT STARTED

**Validation Checklist:**

```python
def validate_subtitle_timing(sourceTranscript, clipStart, clipEnd, phrases):
    """
    Ensure no double-offsetting, cache compatibility, and FFmpeg safety.
    """
    errors = []

    # Check 1: No negative timestamps
    for phrase in phrases:
        if phrase.start < 0 or phrase.end < 0:
            errors.append(f"NEGATIVE: {phrase}")

    # Check 2: Timestamps within clip duration
    clipDuration = clipEnd - clipStart
    for phrase in phrases:
        if phrase.end > clipDuration:
            errors.append(f"OVERFLOW: {phrase} exceeds {clipDuration}")

    # Check 3: No double offset
    for phrase in phrases:
        # verify: phrase.start == sourceWord.start - clipStart
        # NOT: phrase.start == sourceWord.start - candidateStart - clipStart

    # Check 4: Coverage >= 98.5%
    coverage = calculate_word_coverage(phrases)
    if coverage < 0.985:
        errors.append(f"COVERAGE: {coverage} < 0.985")

    # Check 5: Median drift <= 100ms
    drift = calculate_median_timing_drift(phrases, sourceTranscript)
    if drift > 100:
        errors.append(f"DRIFT: {drift}ms > 100ms")

    # Check 6: No duplicate phrases
    texts = [p.text for p in phrases]
    if len(texts) != len(set(texts)):
        errors.append("DUPLICATE: Found duplicate phrase texts")

    return errors, "PASS" if not errors else "FAIL"
```

**Files to Audit:**
- `worker/subtitle_engine.py` - timestamp conversion
- `worker/render_engine.py` - FFmpeg filter graph
- `app.js` - subtitle caching

---

### Fix #4: Multi-Person Camera Director

**Status:** NOT STARTED

**Modes to Implement:**

```python
class CameraDirector:
    def select_mode(self, faces, speakers, activeSpearker):
        faceCount = len(faces)

        if faceCount == 0:
            return "ZERO_FACE"
        elif faceCount == 1:
            return "ONE_PERSON"
        elif faceCount == 2:
            return "TWO_PERSON"
        elif faceCount == 3:
            return "THREE_PERSON"
        elif faceCount == 4:
            return "FOUR_PERSON"
        else:
            return "PANEL"

    def plan_shots(self, mode, transcript, faceTrack, speakers):
        # Generate camera_plan.json with explicit shots
        # Include: start, end, type, subjects, reason
```

**Files to Create/Modify:**
- `worker/camera_director.py` - mode logic
- `worker/shot_planner.py` - generate camera_plan.json

---

## Regression Test Cases

### Scoring Tests

```python
def test_story_score_matches_final():
    """Good story should produce good final score"""
    candidate = create_test_candidate(
        story=88,
        payoff=True,
        setup=True
    )
    assert candidate.finalScore >= 70
    assert abs(candidate.finalScore - candidate.components.story) < 20

def test_score_components_sum_to_final():
    """Components should explain final score"""
    gap = calculate_score_gap(candidate)
    assert gap < 15, f"Score gap {gap} too large"

def test_no_all_low_scores():
    """Avoid score collapse"""
    candidates = analyze_video("podcast.mp4")
    assert max([c.finalScore for c in candidates]) > 70
```

### Camera Tests

```python
def test_one_person_no_oscillation():
    """Single person should not have left-right switching"""
    result = render_segment("one_person_podcast.mp4")
    assert result.metrics.leftRightOscillations == 0

def test_two_person_hold_minimum():
    """Each shot should hold >= 2.2 seconds"""
    result = render_segment("podcast_two_person.mp4")
    assert all(d >= 2.2 for d in result.metrics.shotDurations)

def test_multi_person_mode_detection():
    """Should detect 1, 2, 3, 4 person compositions"""
    for count in [1, 2, 3, 4]:
        video = create_test_video(people=count)
        mode = camera_director.detect_mode(video)
        assert f"{count}_PERSON" in mode
```

### Subtitle Tests

```python
def test_no_double_offset():
    """Timestamp should be offset only once"""
    clip = create_test_clip(sourceStart=100, clipStart=10)
    phrases = generate_subtitle_phrases(clip)
    for phrase in phrases:
        # verify single offset
        assert phrase.start == sourceWord.start - clipStart

def test_subtitle_coverage():
    """Should cover >= 98.5% of spoken words"""
    result = render_segment("podcast.mp4")
    assert result.metrics.subtitleCoverage >= 0.985

def test_no_subtitle_double():
    """Should not repeat subtitle phrases"""
    phrases = generate_subtitle_phrases(clip)
    texts = [p.text for p in phrases]
    assert len(texts) == len(set(texts))
```

---

## Timeline and Ownership

| Item | Owner | Target | Status |
|------|-------|--------|--------|
| Git archaeology | Codex | 2026-07-22 | TODO |
| Score breakdown | Codex | 2026-07-22 | TODO |
| Camera hysteresis | Codex | 2026-07-23 | TODO |
| Subtitle audit | Codex | 2026-07-23 | TODO |
| Multi-person director | Codex | 2026-07-24 | TODO |
| Integration tests | Codex | 2026-07-24 | TODO |
| Real video QA | Human | 2026-07-25 | TODO |
| Final report | Codex | 2026-07-25 | TODO |

---

## Final Acceptance Conditions

- [ ] Score candidates no longer collapse to 20-50 range
- [ ] Story component matches final score (gap < 15)
- [ ] OpenAI contributes to final ranking (Balanced mode)
- [ ] One-person camera stable (no oscillation)
- [ ] Two-person camera natural (>= 2.2s shot hold)
- [ ] Three-person camera correct selection
- [ ] Four-person camera safe
- [ ] Subtitle coverage >= 98.5%
- [ ] Median subtitle drift <= 100ms
- [ ] No subtitle double/negatives
- [ ] Camera plan saved pre-render
- [ ] Subtitle plan saved pre-render
- [ ] Render plan saved pre-render
- [ ] All regression tests pass
- [ ] MP4 valid (ffprobe PASS)
- [ ] Production build passes

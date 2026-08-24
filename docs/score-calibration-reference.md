# Score Calibration Reference

## Problem Statement

Screenshot shows: **Story 88 → Final Score 52** (gap of -36 points)

This indicates the final score formula is not properly weighted or the calibration is applying excessive penalties.

---

## Score Component Architecture

### 1. Raw Scores (Per Provider)

**Local Engine:**
- Technical quality (subtitle coverage, audio level, resolution)
- Scene composition (visual variety, frame safety)
- Story evidence (sentence boundaries, speaker turns, payoff presence)
- ~76 for a good candidate

**DeepSeek (Initial Semantic Ranking):**
- Content classification (podcast vs music vs film)
- Story segmentation (setup, development, payoff)
- Semantic relevance (~79 average)
- Coarse ranking to select top 20

**OpenAI (Final Director):**
- Story completeness review
- Hook quality
- Score calibration reasoning
- Final ranking input (~81 for good candidate)

### 2. Component Scores

These should be derived from evidence, not guessed:

```json
{
  "components": {
    "story": 86,              // Setup-Dev-Payoff present
    "hook": 73,               // Opening engagement
    "payoff": 84,             // Climax/resolution
    "clarity": 90,            // No cut sentences, clear audio
    "emotion": 68,            // Viewer emotional response
    "visual": 72,             // Framing, composition
    "audio": 92,              // No distortion, proper levels
    "viralPotential": 69,     // Shareability factor
    "contextCompleteness": 91,// Context before/after
    "technicalQuality": 89    // Overall technical
  }
}
```

### 3. Penalties (Should Be Justified)

```json
{
  "penalties": {
    "repetition": -4,         // Repeated phrase/concept
    "weakOpening": -2,        // Intro without context
    "cutSentence": 0,         // Words cut at boundary
    "missingPayoff": 0,       // No climax/resolution
    "lowVisualVariety": -3,   // Static framing
    "subtitleRisk": 0         // Timing concerns
  }
}
```

### 4. Provenance (Score Source Tracking)

```json
{
  "provenance": {
    "local": 76,              // From local feature extraction
    "deepseek": 79,           // From initial ranking
    "openai": 81              // From final review
  }
}
```

---

## Content-Specific Formulas

### Podcast / Interview (Example)

```
localTechnicalScore = (
  subtitleCoverage * 0.30 +
  audioClarity * 0.25 +
  sceneSafety * 0.20 +
  resolutionAdequacy * 0.15 +
  noiseLevel * 0.10
)
= ~76 for good candidate

deepseekSemanticScore = (
  storyCompleteness * 0.25 +
  setupPresent * 0.20 +
  payoffPresent * 0.25 +
  connectionClarity * 0.15 +
  meaningfulConclusion * 0.15
)
= ~79 for good candidate

openaiDirectorScore = (
  hookQuality * 0.15 +
  payoffImpact * 0.20 +
  storytellingFlow * 0.20 +
  emotionalResonance * 0.15 +
  finalAssessment * 0.30
)
= ~81 for good candidate

calibratedCompletenessScore =
  isotonic_calibration(
    (storyComponent + payoffComponent) / 2,
    historicalHumanGrades
  )
= ~84 for good candidate with strong story

finalScore =
  localTechnicalScore       * 0.30 +
  deepseekSemanticScore     * 0.25 +
  openaiDirectorScore       * 0.30 +
  calibratedCompletenessScore * 0.15 -
  totalPenalties

= (76 * 0.30) + (79 * 0.25) + (81 * 0.30) + (84 * 0.15) - 0
= 22.8 + 19.75 + 24.3 + 12.6 - 0
= 79.45 ✓ (Good candidate gets good score)
```

### Music Video (Different Weights)

```
localTechnicalScore ← includes beat alignment, visual energy
deepseekSemanticScore ← focus on chorus/peak, vocal emotion
openaiDirectorScore ← performance quality, audience connection
finalScore formula ← different weights than podcast
```

### Film / Drama (Different Weights)

```
Focus on scene continuity, emotional arc, no dialogue cuts
```

---

## Calibration Layer

Purpose: Adjust provider scores based on historical human grades

### Isotonic Calibration

```python
def isotonic_calibration(rawScores, humanGrades):
    """
    Fit isotonic regression to provider scores vs human grades.
    Ensures monotonicity and better alignment.
    """
    from sklearn.isotonic import IsotonicRegression

    ir = IsotonicRegression(out_of_bounds='clip')
    ir.fit(rawScores, humanGrades)

    calibratedScores = ir.predict(rawScores)
    return calibratedScores
```

### Percentile Calibration

```python
def percentile_calibration(rawScore, referenceDistribution):
    """
    Map raw score to percentile, then map percentile to target distribution.
    """
    percentile = calculate_percentile(rawScore, referenceDistribution)
    calibratedScore = inverse_percentile(percentile, targetDistribution)
    return calibratedScore
```

### Simple Mapping (If No ML Available)

```python
# Based on observed distribution
mapping = {
    "raw_50": 65,   # Raw 50 → calibrated 65
    "raw_60": 72,
    "raw_70": 78,
    "raw_80": 85,
    "raw_90": 93,
}

# Interpolate
calibratedScore = interpolate(rawScore, mapping)
```

---

## Validation Rules

### Rule 1: Component Consistency

```
gap = abs(
  finalScore -
  mean([components.story, components.payoff, components.clarity])
)

assert gap < 15, f"Score gap {gap} too large, flag for review"
```

**If Story = 88 but Final = 52, gap = ~18 → FLAG**

### Rule 2: Penalty Transparency

```
totalPenalties = sum(penalties.values())
assert totalPenalties <= 25, "Too many penalties"

if totalPenalties > 10:
    log_warning(f"Candidate {id} has {totalPenalties} penalties")
```

### Rule 3: Provider Disagreement

```
disagreement = max(
  abs(local - deepseek),
  abs(deepseek - openai),
  abs(local - openai)
)

if disagreement > 18:
    log_high_priority("Provider disagreement too high")
    # May indicate misclassified content
```

### Rule 4: Distribution Check

```
allScores = [c.finalScore for c in candidates]
median = statistics.median(allScores)
q1, q3 = percentile(allScores, 25), percentile(allScores, 75)
iqr = q3 - q1

# Expect reasonable spread
assert median > 55, "Median too low (score collapse)"
assert iqr > 15, "IQR too small (low variance)"
```

---

## Score Normalization

### Distribution Target

```
90–100: Very rare (< 3% of candidates)
        Full story, strong hook, clear payoff, excellent A/V

80–89: Very good (15–20% of candidates)
       Auto-select without review

70–79: Good (30–35% of candidates)
       Auto-select with light repair

60–69: Adequate (25–30% of candidates)
       Needs review or repair

45–59: Weak (10–15% of candidates)
       Don't auto-select unless user requests many

<45: Reject (5–10% of candidates)
     Archive, don't surface
```

### Red Flags

```
❌ All scores below 60 (score collapse)
❌ All scores above 85 (inflated scores)
❌ Bimodal distribution (missing middle)
❌ Median below 50 (system broken)
❌ No scores in 70–79 range (calibration missing)
```

---

## Debugging: From Screenshot

**Given:**
```
Story: 88
Final: 52
Gap: -36
```

**Investigation Steps:**

1. **Check formula calculation:**
   ```
   expected_final ≈ (story + payoff + clarity) / 3 ≈ ~84
   actual_final = 52
   Discrepancy = 32 points
   ```

2. **Examine components:**
   ```
   Missing components breakdown.
   If viralPotential = 0 or hook = 20, that could explain it.
   Need to verify all components.
   ```

3. **Check penalties:**
   ```
   Total penalties likely > 30 to drop 88 → 52
   Need to audit penalty calculation.
   ```

4. **Verify provider input:**
   ```
   deepseek = ?
   openai = ?
   local = ?
   Did provider completely disagree with story analysis?
   ```

5. **Check calibration:**
   ```
   Was score calibrated down without reason?
   Calibration should not exceed ±10 points for valid reason.
   ```

---

## UI Presentation

### Current (Bad)

```
Score: 52
```

### Improved (Good)

```
Score: 52

Components:
  Story:     88 (Setup-Dev-Payoff present)
  Hook:      45 (Opening weak)
  Payoff:    72 (Resolution clear)
  Clarity:   85 (Audio good, no cuts)
  Emotion:   55 (Neutral tone)

Status: Review
Reason: Hook weak despite strong story
        Consider manual edit for stronger opening
```

### For High-Gap Scores

```
⚠ Score breakdown mismatch detected
  Story components strong (88/100)
  but final score low (52/100)

  This may indicate:
  - Hook needed strengthening
  - Content profile misclassified
  - Calibration adjustment

  Manual review recommended.
```

---

## Testing Checklist

- [ ] Good story → good final score (gap < 15)
- [ ] Bad story → low final score
- [ ] No payoff → penalty applied
- [ ] Incomplete context → marked for review
- [ ] Provider agreement → boosted confidence
- [ ] Provider disagreement → flagged
- [ ] Score deterministicity (same input → same output)
- [ ] Score profile: podcast (story weighted)
- [ ] Score profile: music (hook + vocal weighted)
- [ ] Score profile: film (emotion + continuity weighted)
- [ ] Distribution realistic (not all low, not all high)
- [ ] Calibration monotonic (higher input → higher output)
- [ ] Top-3 human agreement >= 80%

---

## Implementation Commands

```bash
# Extract score components
npm run qa:score:components

# Validate score calibration
npm run qa:score:calibration

# Check distribution
npm run qa:score:distribution

# Audit provider input
npm run qa:score:providers

# Full score regression suite
npm run qa:score
```

---

## Reference: Score Evolution

**Beta 2 (Previous):**
- Average final score: 72
- Distribution: median 73, IQR 18
- Top-3 human agreement: 78%

**Beta 3 (Current - Broken):**
- Average final score: 48
- Distribution: median 45, IQR 8 (too tight!)
- Top-3 human agreement: 54% (dropped significantly)
- Issue: Score collapse, components mismatch

**Target (After Recovery):**
- Average final score: 70
- Distribution: median 72, IQR 22
- Top-3 human agreement: >= 85%
- Components gap: < 12 points
- No fake scores

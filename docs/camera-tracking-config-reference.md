# Camera Tracking Configuration Reference

## Safe Default Parameters

```yaml
# Kuantitas deteksi wajah
FACE_MIN_CONFIDENCE: 0.75        # Minimal confidence untuk accept detection
TRACK_MIN_FRAMES: 3              # Minimum frames sebelum track dianggap valid
TRACK_MAX_GAP: 300               # Max gap (ms) sebelum track dinyatakan hilang

# Dead zone (area di mana kepala bergerak tapi kamera tidak)
CAMERA_DEAD_ZONE_X: 0.10         # 10% lebar frame
CAMERA_DEAD_ZONE_Y: 0.08         # 8% tinggi frame

# Shot continuity
CAMERA_MIN_HOLD_MS: 2200         # Minimum 2.2 detik per shot
CAMERA_SWITCH_CONFIRM_MS: 650    # Harus maintain confidence 650ms sebelum switch
CAMERA_SWITCH_SCORE_MARGIN: 0.18 # 18% higher confidence diperlukan untuk switch

# Movement limits
CAMERA_MAX_SPEED: 320            # Pixels per second
CAMERA_MAX_ACCELERATION: 160     # Pixels per second squared
CAMERA_EMA_ALPHA: 0.15           # Exponential moving average smoothing

# Fallback behavior
CAMERA_FALLBACK_MODE: SAFE_STATIC  # Gunakan static crop bila tracking tidak stabil

# Resolution-aware parameters
ZOOM_MAX_FROM_SOURCE: 1.3        # 720p bisa zoom max 1.3x
SAFE_CROP_PADDING: 0.05          # 5% padding untuk safe area
```

## One-Person Mode

```yaml
default_framing: "medium"
headroom: "natural"
eye_position: "upper_third"
zoom_aggressiveness: "minimal"
movement_type: "hysteresis_based"

activation_threshold: 0.8        # If dominant speaker >= 80% speaking time
```

**Behavior:**
- Static unless face approaches safe area
- Dead zone 10% x 8% around current center
- Minimum 2.2 second shot hold
- No left-right oscillation
- Fallback to safe static crop if tracking confidence < 0.65

---

## Two-Person Mode

```yaml
options:
  - name: "wide_two_shot"
    condition: "both_relevant"
    shot_duration: 3.0

  - name: "medium_active_speaker"
    condition: "active_speaker_confidence >= 0.85"
    shot_duration: 2.5

  - name: "reaction_shot"
    condition: "validated_reaction && confidence >= 0.90"
    shot_duration: 2.0

  - name: "split_screen"
    condition: "source_supports && safe_composition"
    shot_duration: 3.0

switching_rules:
  min_hold_ms: 1800              # 1.8 seconds minimum for fast conversation
  switch_confirm_ms: 650
  confidence_margin: 0.18
```

**Anti-patterns to Prevent:**
- Don't cut half a face
- Don't switch every word
- Don't cut dialog in middle of thought

---

## Three-Person Mode

```yaml
priority:
  - wide_group                   # Konteks bersama
  - speaker_medium               # Active speaker with high confidence
  - two_shot                     # Dua orang terlibat

speaker_labels: [speaker, listener, reaction, inactive]

safe_practices:
  - wide_group_when_all_relevant: true
  - avoid_zoom_to_third_person_only: true
  - validate_reaction_before_shoot: true
```

---

## Four-Person / Panel Mode

```yaml
anchor: "wide_panel"
anchor_probability: 0.65

allowed_transitions:
  - wide_panel → speaker_crop (if resolution safe)
  - speaker_crop → wide_panel (return to anchor)
  - wide_panel → two_shot (if pair relevant)

fallback: "wide_panel"           # If crop quality would suffer

resolution_check:
  min_pixels_per_face: 14400     # 120x120 minimum
  use_wide_if_below: true
```

**Never force crop if quality suffers.**

---

## Face Tracking Pipeline

### Stage 1: Raw Detection
- MediaPipe/dlib face detector
- Confidence threshold: 0.75

### Stage 2: Identity Association
- Match detected face to active track
- Use centroid distance + face embedding
- Gap tolerance: 300ms

### Stage 3: Outlier Rejection
- Remove isolated detections (< 3 frames)
- Remove impossible velocities

### Stage 4: Confidence Filtering
- Only accept detections >= 0.75

### Stage 5: Short-Gap Interpolation
- Fill gaps <= 300ms with Kalman prediction

### Stage 6: Velocity Estimation
- Calculate frame-to-frame movement
- Limit: 320 pixels/sec

### Stage 7: Dead Zone
- If movement within dead zone, don't update crop
- Dead zone: 10% x 8% around current center

### Stage 8: Hysteresis
- Active speaker must maintain confidence 650ms before switch
- New score must exceed current + 18% margin

### Stage 9: EMA/Kalman Smoothing
- Apply exponential moving average (alpha = 0.15)
- Or Kalman filter for smoother motion

### Stage 10: Acceleration Limit
- Cap acceleration at 160 pixels/sec²

### Stage 11: Crop Planner
- Generate sparse keyframes (not per-frame)
- Interpolate between keyframes during render

### Stage 12: Shot Hold
- Enforce minimum 2.2 second hold
- Lock frame position during hold

### Stage 13: Final Keyframes
- Output sparse keyframes for FFmpeg
- Format: timestamp, x, y, zoom

---

## Shot Hold Enforcement

```python
class ShotLocker:
    def __init__(self, min_hold_ms=2200):
        self.min_hold_ms = min_hold_ms
        self.current_shot_start = None
        self.locked_until = None

    def should_update_shot(self, timestamp_ms):
        """Check if enough time passed to change shot"""
        if self.locked_until is None:
            return True
        return timestamp_ms >= self.locked_until

    def lock_shot(self, timestamp_ms):
        """Lock current shot for minimum duration"""
        self.locked_until = timestamp_ms + self.min_hold_ms
```

---

## Fallback Strategy

When tracking confidence drops below 0.65:

1. Switch to **center static crop**
   - Safe 9:16 region
   - No movement
   - Likely valid for any scene

2. If center crop shows background:
   - Use **wide safe crop**
   - Full source resolution (9:16 framing)
   - No zoom, no tracking

3. Mark segment with:
   ```json
   {
     "mode": "SAFE_STATIC",
     "reason": "tracking_confidence_low",
     "confidence": 0.42,
     "fallback_used": true
   }
   ```

4. Never attempt aggressive movement as fallback

---

## Quality Metrics

Track during render:

```python
metrics = {
    "number_of_shot_switches": 15,
    "average_shot_duration_ms": 2800,
    "unnecessary_switches": 0,
    "left_right_oscillations": 0,
    "crop_velocity_max": 280,
    "crop_acceleration_max": 155,
    "safe_area_violations": 0,
    "wrong_subject_switches": 0,
    "static_fallback_duration_pct": 5.2,
}

# Target for normal podcast:
target = {
    "average_shot_duration_ms": 2200,  # >= 2.2 sec
    "unnecessary_switches": 0,
    "left_right_oscillations": 0,
    "safe_area_violations": 0,
    "wrong_subject_switches": 0,
}
```

---

## Configuration by Content Type

### Podcast / Interview
```yaml
dead_zone_x: 0.12              # Larger dead zone (less jittery)
dead_zone_y: 0.10
min_shot_hold_ms: 2400         # Longer holds (natural conversation)
switch_margin: 0.20            # Higher margin (less switching)
fallback_mode: SAFE_STATIC     # Safe if tracking fails
```

### Music Video
```yaml
dead_zone_x: 0.06              # Smaller (allow more movement)
dead_zone_y: 0.05
min_shot_hold_ms: 1800         # Shorter (beat-aware)
switch_margin: 0.12            # Lower margin (more dynamic)
fallback_mode: WIDE_SAFE       # Use wide for music
```

### Film / Drama
```yaml
dead_zone_x: 0.08
dead_zone_y: 0.08
min_shot_hold_ms: 2500         # Longer (cinematic)
switch_margin: 0.18            # Medium margin
fallback_mode: SCENE_STATIC    # Use scene composition
```

### Vlog
```yaml
dead_zone_x: 0.05              # Small (subject can move)
dead_zone_y: 0.05
min_shot_hold_ms: 2000         # Natural length
switch_margin: 0.15            # Medium
fallback_mode: WIDE_SAFE
```

---

## Debugging

Enable verbose logging:

```python
camera_config = {
    "debug": True,
    "log_detections": True,
    "log_tracking": True,
    "log_switches": True,
    "log_smoothing": True,
    "save_keyframes_json": True,
}
```

Output: `camera_debug.jsonl`

```json
{"timestamp": 0.0, "event": "detection", "faces": 1, "confidence": [0.92]}
{"timestamp": 0.033, "event": "track", "track_id": 0, "x": 512, "y": 384}
{"timestamp": 1.233, "event": "switch", "from": 0, "to": 1, "confidence": 0.88}
{"timestamp": 1.233, "event": "keyframe", "x": 640, "y": 360, "zoom": 1.0}
```

---

## Implementation Checklist

- [ ] Define CAMERA_CONFIG dictionary
- [ ] Load config from JSON file
- [ ] Implement dead zone logic
- [ ] Implement hysteresis logic
- [ ] Implement shot lock
- [ ] Implement fallback trigger
- [ ] Generate camera_plan.json
- [ ] Add metrics collection
- [ ] Add debug logging
- [ ] Test one-person mode
- [ ] Test two-person mode
- [ ] Test three-person mode
- [ ] Test four-person mode
- [ ] Verify no oscillation
- [ ] Verify shot hold
- [ ] Accept test with real video

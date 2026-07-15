CLIPER STUDIO PLUS V3.1 - CAMERA ENGINE SPECIFICATION

OVERVIEW
========
Camera engine manages video framing decisions with hysteresis for stability.

CONFIGURATION
=============
MIN_SPEAKER_DURATION = 0.8  # Hysteresis threshold in seconds

LAYOUTS
-------
1. SPLIT_SCREEN - 2+ speakers with significant overlap (>= 0.7s)
2. FACE_TRACK - Single speaker with visible face
3. BODY_TRACK - Body tracking available, no face
4. CENTER_CROP - Fallback when no tracking available

LAYOUT SELECTION
================
Rule priority (evaluate in order):
1. If face_count >= 2 AND simultaneous AND stability >= 55 AND average_span >= 0.40:
   -> SPLIT_SCREEN

2. If face_count >= 1:
   -> FACE_TRACK

3. If body_tracking enabled:
   -> BODY_TRACK

4. Otherwise:
   -> CENTER_CROP

CAMERA ACTION DECISION
======================
decide_camera_action(active_speakers, current_time) -> dict

Returns action with one of these reasons:
- hold: Continue current speaker (within hysteresis)
- cut: Switch to new speaker (hysteresis passed)
- noop: No speakers detected

Hysteresis Logic:
1. If same speaker as last frame:
   - Check duration since last switch
   - If duration >= MIN_SPEAKER_DURATION: allow cut
   - Otherwise: hold current speaker

2. If different speaker:
   - Check time since last switch
   - If duration >= MIN_SPEAKER_DURATION: allow cut
   - Otherwise: hold previous speaker

SPEAKER HYSERESIS EXAMPLE
=========================
Time 0.0s: Speaker A starts
  -> Cut to A (first time)

Time 0.3s: Speaker A still speaking
  -> Hold (0.3s < 0.8s threshold)

Time 0.5s: Speaker B starts (A still speaking)
  -> Hold A (0.5s < 0.8s, hysteresis active)

Time 0.9s: Speaker A still speaking
  -> Cut to A (0.9s >= 0.8s, hysteresis passed)

Time 1.2s: Speaker B starts
  -> Cut to B (0.9s >= 0.8s, hysteresis passed)

FACE TRACK CONFIGURATION
========================
Crop area: 9:16 aspect ratio
Focus point: Face center
Zoom level: Conservative (5-10% margin)

SPLIT SCREEN CONFIGURATION
==========================
When 2 speakers detected with overlap >= 0.7s:
- LAYOUT_LEFT_RIGHT: Horizontal separation >= 0.25
- LAYOUT_TOP_BOTTOM: Vertical arrangement preferred

Each speaker gets ~50% frame area with smooth transitions.

EMOTION-BASED CAMERA
====================
Detect emotional moments:
- Emotion keywords: kaget, marah, lucu, sedih, gila, wah, ngakak
- Higher emotion score -> More aggressive framing
- Emotional peaks -> Quick cuts
- Neutral -> Slow transitions

STABILITY SCORING
=================
face_tracks.forEach(track => {
  stability += (confidence * 0.5 + visibility * 0.3 + duration * 0.2)
})

Layout thresholds:
- SPLIT_SCREEN: stability >= 55, average_span >= 0.40
- FACE_TRACK: stability >= 30
- BODY_TRACK: stability >= 20

ERROR HANDLING
==============
No face detected:
-> Fallback to CENTER_CROP
-> Log warning for debugging

Face tracking unstable:
-> Use previous frame layout
-> Increase hysteresis duration temporarily

NO SPEAKERS DETECTED:
-> Hold last layout
-> Wait for first speaker detection

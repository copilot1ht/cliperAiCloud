"""Zone mapper for 16:9 frames.

Provides simple zone detection utilities used by the camera decision engine.
"""
ZONE_LEFT = 1
ZONE_CENTER = 2
ZONE_RIGHT = 3


def normalize_x(x, frame_width):
    """Return normalized x coordinate in range [0.0, 1.0].

    x may be center x in pixels or already normalized (0..1).
    """
    try:
        xf = float(x)
    except Exception:
        return 0.5
    if frame_width and frame_width > 1:
        return max(0.0, min(1.0, xf / float(frame_width)))
    return max(0.0, min(1.0, xf))


def detect_zone_from_center_x(face_center_x, frame_width=None):
    """Detect LEFT/CENTER/RIGHT based on normalized or pixel center x.

    Rules:
    - x < 0.33 => LEFT
    - 0.33 <= x < 0.66 => CENTER
    - else => RIGHT
    """
    nx = normalize_x(face_center_x, frame_width)
    if nx < 0.33:
        return ZONE_LEFT
    if nx < 0.66:
        return ZONE_CENTER
    return ZONE_RIGHT


def zone_name(zone):
    return {ZONE_LEFT: "LEFT", ZONE_CENTER: "CENTER", ZONE_RIGHT: "RIGHT"}.get(zone, "UNKNOWN")

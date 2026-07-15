import pytest

from engine import zone_mapper


def test_normalize_and_detect():
    # pixel coordinates with frame width 1920
    assert zone_mapper.detect_zone_from_center_x(100, 1920) == zone_mapper.ZONE_LEFT
    assert zone_mapper.detect_zone_from_center_x(960, 1920) == zone_mapper.ZONE_CENTER
    assert zone_mapper.detect_zone_from_center_x(1800, 1920) == zone_mapper.ZONE_RIGHT


def test_zone_name():
    assert zone_mapper.zone_name(zone_mapper.ZONE_LEFT) == "LEFT"
    assert zone_mapper.zone_name(999) == "UNKNOWN"

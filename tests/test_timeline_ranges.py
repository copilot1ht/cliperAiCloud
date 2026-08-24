import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))
import cliper_worker


def test_full_video_mode_uses_real_source_duration_without_ranges():
    payload = {"selectionMode": "full"}

    assert cliper_worker.parse_timeline_ranges(payload, 300) == []
    assert cliper_worker.analysis_duration_from_ranges(300, []) == 300
    assert cliper_worker.analysis_duration_from_ranges(3600, []) == 3600


def test_selected_range_uses_numeric_ui_contract_and_clamps_to_video_duration():
    payload = {
        "selectionMode": "range",
        "analysisRanges": [[1800, 4200]],
        "rangeStart": "00:01",
        "rangeEnd": "00:02",
    }

    assert cliper_worker.parse_timeline_ranges(payload, 3600) == [(1800.0, 3600.0)]


def test_multiple_ranges_are_merged_and_duration_is_based_on_selected_area():
    payload = {
        "selectionMode": "multiple",
        "analysisRanges": [[1800, 2100], [2050, 2400], [3000, 3300]],
    }

    ranges = cliper_worker.parse_timeline_ranges(payload, 3600)

    assert ranges == [(1800.0, 2400.0), (3000.0, 3300.0)]
    assert cliper_worker.analysis_duration_from_ranges(3600, ranges) == 900


def test_target_clip_count_respects_requested_count_and_continuous_range_capacity():
    transcript = [{"start": index * 5.0, "end": index * 5.0 + 4.0, "text": "dialog"} for index in range(200)]

    assert cliper_worker.resolve_target_clip_count(
        {"autoClipCount": True, "clipCount": 3},
        3600,
        transcript,
        30,
        [],
    ) == 3
    assert cliper_worker.resolve_target_clip_count(
        {"autoClipCount": False, "clipCount": 6},
        65,
        transcript,
        30,
        [],
    ) == 2
    assert cliper_worker.resolve_target_clip_count(
        {"autoClipCount": False, "clipCount": 6},
        40,
        transcript,
        30,
        [(0, 20), (100, 120)],
    ) == 0
    assert cliper_worker.optional_review_limit({"clipCount": 1}, 1) == 1
    assert cliper_worker.optional_review_limit({"clipCount": 6}, 2) == 5
    assert cliper_worker.optional_review_limit({"clipCount": 20}, 10) == 20


def test_all_recommended_mode_has_no_static_ui_cap_but_keeps_timeline_capacity():
    transcript = [{"start": index * 5.0, "end": index * 5.0 + 4.0, "text": "dialog"} for index in range(400)]

    assert cliper_worker.configured_clip_limit({"clipCount": 0, "allRecommendedClips": True}) == 0
    assert cliper_worker.resolve_target_clip_count(
        {"autoClipCount": True, "clipCount": 0, "allRecommendedClips": True},
        3600,
        transcript,
        30,
        [],
    ) == 120
    assert cliper_worker.optional_review_limit({"clipCount": 0, "allRecommendedClips": True}, 120) == 120


def test_transcript_is_clipped_to_selected_range_instead_of_falling_back_full():
    transcript = [
        {"start": 1798.0, "end": 1802.0, "text": "sebelum masuk"},
        {"start": 1850.0, "end": 1854.0, "text": "moment di dalam"},
        {"start": 2398.0, "end": 2402.0, "text": "keluar range"},
        {"start": 2500.0, "end": 2504.0, "text": "di luar"},
    ]

    filtered = cliper_worker.filter_transcript_by_ranges(transcript, [(1800.0, 2400.0)])

    assert [(item["start"], item["end"]) for item in filtered] == [
        (1800.0, 1802.0),
        (1850.0, 1854.0),
        (2398.0, 2400.0),
    ]
    assert all(item["start"] >= 1800 and item["end"] <= 2400 for item in filtered)


def test_candidate_must_be_fully_inside_selected_range():
    ranges = [(1800.0, 2400.0)]

    assert cliper_worker.candidate_in_ranges(1800, 2400, ranges) is True
    assert cliper_worker.candidate_in_ranges(1850, 2200, ranges) is True
    assert cliper_worker.candidate_in_ranges(1799, 1900, ranges) is False
    assert cliper_worker.candidate_in_ranges(2300, 2401, ranges) is False
    assert cliper_worker.clamp_interval_to_ranges(1790, 1850, ranges) == (1800.0, 1850.0)
    assert cliper_worker.clamp_interval_to_ranges(2410, 2500, ranges) is None


def test_final_moments_are_clamped_and_retimed_to_selected_range():
    transcript = [
        {"start": 1800.0, "end": 1830.0, "text": "awal cerita"},
        {"start": 1830.0, "end": 1870.0, "text": "payoff cerita"},
    ]
    moments = [
        {"start": 1790.0, "end": 1870.0, "duration": 80, "text": "teks lama"},
        {"start": 2500.0, "end": 2570.0, "duration": 70, "text": "di luar"},
    ]

    result = cliper_worker.enforce_moments_in_timeline_ranges(
        moments,
        [(1800.0, 2400.0)],
        transcript,
        minimum_duration=30,
    )

    assert len(result) == 1
    assert result[0]["start"] == 1800.0
    assert result[0]["end"] == 1870.0
    assert result[0]["duration"] == 70.0
    assert result[0]["time"] == "30:00 - 31:10"
    assert "awal cerita" in result[0]["transcript"]


def test_find_moments_does_not_use_full_transcript_when_selected_range_is_empty():
    info = {"duration": 3600, "title": "Video satu jam"}
    transcript = [{"start": 0.0, "end": 10.0, "text": "hanya transcript awal"}]
    payload = {
        "selectionMode": "range",
        "analysisRanges": [[1800, 2400]],
        "clipCount": 3,
        "providerType": "local",
        "minDuration": 30,
        "targetDuration": 60,
        "maxDuration": 90,
    }

    assert cliper_worker.find_moments(info, transcript, payload) == []
    assert payload["_timelineRanges"] == [(1800.0, 2400.0)]

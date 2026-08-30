import json
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))

from cliper_worker import (
    build_editorial_candidate_windows,
    candidate_discovery_target,
    candidate_generation_budget,
    candidate_scoring_pool_budget,
    public_heatmap_status,
    score_moment_candidate,
)
import heatmap_engine
from heatmap_engine import (
    filter_markers_to_ranges,
    load_or_fetch_heatmap,
    normalize_heatmap_markers,
    parse_watch_page_markers,
    select_heatmap_peaks,
    story_bound_heatmap_candidates,
)


def upstream_marker(start_ms, duration_ms, score):
    return {
        "heatMarkerRenderer": {
            "timeRangeStartMillis": start_ms,
            "markerDurationMillis": duration_ms,
            "heatMarkerIntensityScoreNormalized": score,
        }
    }


def test_parses_youtube_renderer_markers_from_watch_page():
    payload = {
        "markers": [
            upstream_marker(1_570_000, 5_000, 0.42),
            upstream_marker(1_600_000, 5_000, 0.91),
        ]
    }
    html = f'<script>window.data = {json.dumps(payload)};</script>'

    markers = parse_watch_page_markers(html)

    assert len(markers) == 2
    assert markers[1]["start"] == 1600.0
    assert markers[1]["peak_time"] == 1602.5
    assert markers[1]["score"] == 0.91


def test_parses_current_compact_youtube_marker_shape():
    payload = {
        "markers": [
            {
                "startMillis": "261000",
                "durationMillis": "2140",
                "intensityScoreNormalized": 0.77,
            }
        ],
        "markersMetadata": {"heatmapMetadata": {"maxHeightDp": 40}},
    }
    html = f"<script>window.data = {json.dumps(payload)};</script>"

    markers = parse_watch_page_markers(html)

    assert len(markers) == 1
    assert markers[0]["start"] == 261.0
    assert markers[0]["end"] == 263.14
    assert markers[0]["score"] == 0.77


def test_parses_current_heat_markers_envelope_from_watch_page():
    payload = {
        "heatMarkers": [
            upstream_marker(321_000, 4_000, 0.83),
            upstream_marker(345_000, 4_000, 0.91),
        ]
    }
    html = f"<script>window.player = {json.dumps(payload)};</script>"

    markers = parse_watch_page_markers(html)

    assert [marker["start"] for marker in markers] == [321.0, 345.0]
    assert markers[-1]["score"] == 0.91


def test_normalizes_ytdlp_heatmap_shape():
    markers = normalize_heatmap_markers(
        [
            {"start_time": 10.0, "end_time": 15.0, "value": 0.3},
            {"start_time": 15.0, "end_time": 20.0, "value": 0.8},
        ]
    )

    assert markers == [
        {
            "start": 10.0,
            "end": 15.0,
            "peak_time": 12.5,
            "score": 0.3,
            "source": "youtube_most_replayed",
        },
        {
            "start": 15.0,
            "end": 20.0,
            "peak_time": 17.5,
            "score": 0.8,
            "source": "youtube_most_replayed",
        },
    ]


def test_peak_selection_has_no_fixed_ten_clip_cap():
    markers = []
    for index in range(24):
        score = 0.95 if index % 2 == 0 else 0.2
        start = index * 20.0
        markers.append(
            {
                "start": start,
                "end": start + 5.0,
                "peak_time": start + 2.5,
                "score": score,
                "source": "youtube_most_replayed",
            }
        )

    peaks = select_heatmap_peaks(markers, min_separation_seconds=12.0)

    assert len(peaks) == 12


def test_selected_range_excludes_heatmap_outside_user_area():
    markers = normalize_heatmap_markers(
        [
            {"start_time": 600, "end_time": 605, "value": 0.95},
            {"start_time": 1850, "end_time": 1855, "value": 0.92},
            {"start_time": 2500, "end_time": 2505, "value": 0.99},
        ]
    )

    filtered = filter_markers_to_ranges(markers, [(1800.0, 2400.0)])

    assert [marker["start"] for marker in filtered] == [1850.0]


def test_heatmap_peak_uses_complete_story_boundaries_not_padding():
    peaks = [
        {
            "start": 1600.0,
            "end": 1605.0,
            "peak_time": 1602.5,
            "score": 0.91,
            "source": "youtube_most_replayed",
        }
    ]
    stories = [
        {
            "story_id": 7,
            "start": 1570.0,
            "end": 1628.0,
            "text": "Setup, perkembangan, momen utama, lalu payoff yang lengkap.",
        }
    ]

    candidates = story_bound_heatmap_candidates(peaks, stories, [], 30, 60, 100)

    assert len(candidates) == 1
    assert candidates[0]["start"] == 1570.0
    assert candidates[0]["end"] == 1628.0
    assert candidates[0]["candidate_source"] == "heatmap_story"
    assert candidates[0]["heatmap_metrics"]["peak_time"] == 1602.5


def test_cached_normalized_markers_load_without_network(tmp_path):
    cache_path = tmp_path / "youtube-heatmap.json"
    cache_path.write_text(
        json.dumps(
            {
                "markers": [
                    {
                        "start": 20.0,
                        "end": 25.0,
                        "peak_time": 22.5,
                        "score": 0.88,
                        "source": "youtube_most_replayed",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    result = load_or_fetch_heatmap(
        None,
        "https://www.youtube.com/watch?v=abcdefghijk",
        cache_path=cache_path,
    )

    assert result["available"] is True
    assert result["origin"] == "cache"
    assert result["marker_count"] == 1
    assert result["status"] == "available"


def test_heatmap_reports_not_youtube_without_network_request(monkeypatch):
    def unexpected_fetch(*_args, **_kwargs):
        raise AssertionError("non-YouTube source must not call the watch page")

    monkeypatch.setattr(heatmap_engine, "fetch_watch_page_markers", unexpected_fetch)

    result = load_or_fetch_heatmap(None, "https://example.com/video")

    assert result["available"] is False
    assert result["status"] == "not_youtube"
    assert result["origin"] == "not_youtube"


def test_heatmap_reports_selected_area_without_peak_as_optional_evidence():
    result = load_or_fetch_heatmap(
        [upstream_marker(20_000, 5_000, 0.91)],
        "https://www.youtube.com/watch?v=abcdefghijk",
        ranges=[(120.0, 180.0)],
    )

    assert result["available"] is True
    assert result["peak_count"] == 0
    assert result["status"] == "available_outside_selection"


def test_heatmap_network_timeout_is_safe_and_non_fatal(monkeypatch):
    def timeout(*_args, **_kwargs):
        raise RuntimeError("NETWORK_TLS_TIMEOUT: unavailable")

    monkeypatch.setattr(heatmap_engine, "fetch_watch_page_markers", timeout)

    result = load_or_fetch_heatmap(
        None,
        "https://www.youtube.com/watch?v=abcdefghijk",
    )

    assert result["available"] is False
    assert result["status"] == "network_unavailable"
    assert result["warning"] == "NETWORK_TLS_TIMEOUT"


def test_public_heatmap_status_excludes_raw_markers_and_video_id():
    summary = public_heatmap_status(
        {
            "status": "available",
            "available": True,
            "origin": "youtube_watch_page",
            "marker_count": 18,
            "peak_count": 4,
            "video_id": "abcdefghijk",
            "markers": [{"start": 1}],
            "reason": "Most Replayed publik dipakai sebagai bukti tambahan.",
        }
    )

    assert summary == {
        "status": "available",
        "reason": "Most Replayed publik dipakai sebagai bukti tambahan.",
        "available": True,
        "origin": "youtube_watch_page",
        "markerCount": 18,
        "peakCount": 4,
    }


def test_candidate_generation_budget_scales_for_long_videos_without_unbounded_growth():
    short = candidate_generation_budget(600, 2)
    long = candidate_generation_budget(7_200, 18)

    assert short["min_candidates"] < long["min_candidates"]
    assert short["max_candidates"] < long["max_candidates"] <= 240


def test_expensive_scoring_pool_scales_with_requested_output():
    evidence_budget = candidate_generation_budget(3_700, 10)

    assert candidate_scoring_pool_budget(evidence_budget, 1) == 204
    assert candidate_scoring_pool_budget(evidence_budget, 4) == 204
    assert candidate_scoring_pool_budget(evidence_budget, 6) == 204
    assert candidate_scoring_pool_budget(evidence_budget, 10) == 204
    assert candidate_scoring_pool_budget(evidence_budget, 100) <= 240


def test_discovery_density_depends_on_source_not_requested_clip_count():
    assert candidate_discovery_target(600) == 6
    assert candidate_discovery_target(3_700) == 7
    assert candidate_discovery_target(20_000) == 16


def test_heatmap_cannot_raise_incoherent_candidate_score():
    candidate = {
        "start": 0.0,
        "end": 45.0,
        "text": "dan terus itu dan terus itu dan",
        "heatmap_metrics": {
            "supported": True,
            "score": 1.0,
            "peak_time": 20.0,
        },
    }
    without_heatmap = dict(candidate)
    without_heatmap["heatmap_metrics"] = {}

    supported = score_moment_candidate(candidate, {}, 0, 20.0, 90.0)
    baseline = score_moment_candidate(without_heatmap, {}, 0, 20.0, 90.0)

    assert supported["score"] == baseline["score"]
    assert supported["metrics"]["heatmap_bonus"] == 0.0


def test_editorial_candidate_pool_fuses_story_and_heatmap_sources():
    transcript = [
        {
            "start": float(index * 20),
            "end": float((index + 1) * 20),
            "text": (
                f"Bagian {index + 1} membahas alasan yang spesifik. "
                "Pertanyaannya dijelaskan lalu jawabannya selesai."
            ),
        }
        for index in range(9)
    ]
    info = {
        "duration": 180.0,
        "title": "Percakapan uji",
        "_heatmap_peaks": [
            {
                "start": 80.0,
                "end": 85.0,
                "peak_time": 82.5,
                "score": 0.9,
                "source": "youtube_most_replayed",
            }
        ],
    }

    candidates = build_editorial_candidate_windows(info, transcript, 3, 30, 60, 100)
    supported = [
        candidate
        for candidate in candidates
        if (candidate.get("heatmap_metrics") or {}).get("supported")
    ]

    assert supported
    assert any("youtube_most_replayed" in candidate.get("candidate_sources", []) for candidate in supported)

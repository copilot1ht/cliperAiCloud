import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))
import cliper_worker


def test_four_k_look_is_dimension_safe_and_uses_light_filters():
    payload = {
        "resolutionProfile": "1080p",
        "fpsProfile": "30 FPS",
        "_allowHeavy4KLook": True,
        "_videoEnhancementProfile": "natural_podcast",
        "_availableVideoFilters": ["hqdn3d", "gradfun", "unsharp"],
    }

    filters = cliper_worker.four_k_look_filters(payload, {"metrics": {"noise": 0.7}})
    graph = ",".join(filters)

    assert "hqdn3d=" in graph
    assert "gradfun=" in graph
    assert "unsharp=" in graph
    assert "colorbalance=" not in graph
    assert "scale=" not in graph
    assert "fps=" not in graph
    assert payload["_fourKLookActive"] is True


def test_four_k_look_performance_guard_skips_expensive_filters():
    payload = {
        "resolutionProfile": "2K",
        "fpsProfile": "60 FPS",
        "_videoEnhancementProfile": "gaming",
        "_availableVideoFilters": ["hqdn3d", "gradfun", "unsharp"],
    }

    graph = ",".join(cliper_worker.four_k_look_filters(payload, {"metrics": {"noise": 0.9}}))

    assert "hqdn3d=" not in graph
    assert "gradfun=" not in graph
    assert "colorbalance=" not in graph
    assert "unsharp=" not in graph
    assert payload["_fourKLookBudget"] == "integrated_light"
    assert payload["_fourKLookFilters"] == ["eq", "curves"]


def test_transcript_music_word_does_not_force_music_visual_profile():
    payload = {"_availableVideoFilters": ["eq", "curves"]}
    moment = {
        "category": "Storytelling",
        "title": "Cerita Perjalanan Karier",
        "transcript": "Dia membahas lagu pertamanya dalam obrolan podcast.",
    }

    graph = ",".join(cliper_worker.automatic_video_enhancement_filters(payload, moment))

    assert payload["_videoEnhancementProfile"] == "natural_podcast"
    assert "saturation=1.015" in graph
    assert "saturation=1.070" not in graph


def test_extreme_color_cast_reduces_saturation_instead_of_shifting_channels():
    payload = {
        "_availableVideoFilters": ["eq", "curves"],
        "_videoColorAnalysis": {
            "cast_severity": "extreme",
            "dominant_cast": "blue",
            "y_average": 44,
        },
    }

    graph = ",".join(cliper_worker.automatic_video_enhancement_filters(payload, {"category": "Music"}))

    assert "saturation=0.940" in graph
    assert "contrast=1.010" in graph
    assert "colorbalance=" not in graph


def test_color_cast_classifier_uses_neutral_chroma_distance():
    assert cliper_worker.classify_video_color_cast(129, 130)[0] == "normal"
    severity, dominant, distance = cliper_worker.classify_video_color_cast(150, 127)
    assert severity == "extreme"
    assert dominant == "blue"
    assert distance > 18

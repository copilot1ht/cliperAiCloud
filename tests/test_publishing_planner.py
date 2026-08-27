import json
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))

import publishing_planner


def output_fixture(tmp_path, index, score=82, validated=True):
    video = tmp_path / f"clip-{index}.mp4"
    video.write_bytes(b"validated-render-fixture")
    metadata = tmp_path / f"clip-{index}.json"
    metadata.write_text(
        json.dumps(
            {
                "title": f"Strategi pelanggan {index}",
                "youtube_title": f"Strategi pelanggan {index}",
                "youtube_description": "Penjelasan berbasis hasil nyata.",
                "hook_text": "Perubahan ini membuat penjualan naik",
                "score": score,
                "metrics": {"hook": 80, "story_complete": 84, "payoff": 82},
                "seo": {"category": "bisnis", "hashtags": ["strategi", "penjualan"]},
            }
        ),
        encoding="utf-8",
    )
    return {
        "title": f"Strategi pelanggan {index}",
        "video": str(video),
        "metadata": str(metadata),
        "validated": validated,
        "hasAudio": True,
        "ffprobe": {"valid": validated, "hasAudio": True, "hasVideo": True},
    }


def test_planner_writes_atomic_master_and_per_clip_files(tmp_path):
    outputs = [output_fixture(tmp_path, 1), output_fixture(tmp_path, 2, score=55)]
    metadata_dir = tmp_path / "Metadata"

    plan_path, plan = publishing_planner.write_publishing_plan(
        metadata_dir,
        outputs,
        {
            "publishingPlatforms": ["youtube_shorts", "instagram_reels"],
            "publishingTimezone": "Asia/Jakarta",
        },
        datetime.fromisoformat("2026-08-25T08:00:00+07:00"),
    )

    assert plan_path == metadata_dir / "publishing-plan.json"
    assert plan["mode"] == "local_evidence"
    assert plan["aiEnhanced"] is False
    assert plan["renderRequested"] == 2
    assert plan["renderSuccessful"] == 2
    assert plan["plannedClips"] == 2
    assert plan["timezone"] == "Asia/Jakarta"
    assert plan["aiUsage"]["requests"] == 0
    assert len(list(metadata_dir.glob("*.publishing.json"))) == 2
    assert not list(metadata_dir.glob("*.tmp"))
    assert plan["clips"][1]["readiness"] == "not_recommended"
    assert all(item["clipId"] == 1 for item in plan["dailyPlan"])
    assert all(Path(clip["actualFile"]).is_file() for clip in plan["clips"])
    required_fields = {
        "actualFile",
        "title",
        "caption",
        "hashtags",
        "contentType",
        "storyTheme",
        "momentScore",
        "publishingReadiness",
        "recommendedTime",
        "alternativeTimes",
        "platforms",
        "reason",
        "priority",
        "publishStatus",
    }
    assert all(required_fields.issubset(clip) for clip in plan["clips"])
    assert plan["clips"][0]["recommendedTime"]
    assert len(plan["clips"][0]["alternativeTimes"]) == 2
    assert "#strategipelanggan" in plan["clips"][0]["hashtags"]


def test_schedule_respects_daily_cap_gap_and_selected_platforms(tmp_path):
    outputs = [output_fixture(tmp_path, index) for index in range(1, 5)]
    plan = publishing_planner.build_publishing_plan(
        outputs,
        {
            "publishingPlatforms": ["tiktok"],
            "publishingPostsPerDay": 2,
            "publishingMinimumGapHours": 6,
            "publishingTimezone": "Asia/Jakarta",
        },
        datetime.fromisoformat("2026-08-25T08:00:00+07:00"),
    )
    scheduled = [datetime.fromisoformat(item["scheduledAt"]) for item in plan["schedule"]]
    counts = Counter(item.date().isoformat() for item in scheduled)

    assert plan["platforms"] == ["tiktok"]
    assert all(value <= 2 for value in counts.values())
    assert all((right - left).total_seconds() >= 6 * 3600 for left, right in zip(scheduled, scheduled[1:]))
    assert all(len(copy["hashtags"]) <= 5 for clip in plan["clips"] for copy in clip["platforms"])


def test_explicit_empty_platform_selection_does_not_schedule_anything(tmp_path):
    plan = publishing_planner.build_publishing_plan(
        [output_fixture(tmp_path, 1)],
        {"publishingPlatforms": []},
        datetime.fromisoformat("2026-08-25T08:00:00+07:00"),
    )

    assert plan["platforms"] == []
    assert plan["schedule"] == []


def test_only_successful_validated_renders_enter_plan(tmp_path):
    successful = [output_fixture(tmp_path, index) for index in range(1, 6)]
    failed = output_fixture(tmp_path, 6, validated=False)
    missing = output_fixture(tmp_path, 7)
    Path(missing["video"]).unlink()

    plan = publishing_planner.build_publishing_plan(
        successful + [failed, missing],
        {
            "_renderRequested": 6,
            "_candidateCount": 30,
            "publishingPlatforms": ["youtube_shorts", "instagram_reels", "tiktok"],
        },
        datetime.fromisoformat("2026-08-25T08:00:00+07:00"),
    )

    assert plan["renderRequested"] == 6
    assert plan["renderSuccessful"] == 5
    assert plan["plannedClips"] == 5
    assert plan["plannerInputClips"] == 5
    assert len(plan["dailyPlan"]) <= 5
    assert plan["aiUsage"]["requests"] == 0
    assert all(Path(item["actualFile"]).is_file() for item in plan["clips"])
    assert all(
        item["filename"] not in {"clip-6.mp4", "clip-7.mp4"}
        for item in plan["clips"]
    )


def test_zero_successful_renders_do_not_write_fake_plan(tmp_path):
    output = output_fixture(tmp_path, 1, validated=False)

    try:
        publishing_planner.write_publishing_plan(tmp_path / "Metadata", [output])
    except ValueError as exc:
        assert "validated rendered MP4" in str(exc)
    else:
        raise AssertionError("Planner must reject an empty successful-render set.")

    assert not (tmp_path / "Metadata" / "publishing-plan.json").exists()

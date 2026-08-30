#!/usr/bin/env python3
"""Run evidence-only Moment AI acceptance checks against cached local sources.

The runner disables cloud providers and source URLs. It exercises the same
discovery, story-boundary, scoring, and diversity pipeline as the desktop
worker, then writes a concise report. Fewer than ten results may be valid:
quality gates must not invent weak clips to fill a quota.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
WORKER_ROOT = ROOT / "worker"
for import_root in (ROOT, WORKER_ROOT):
    if str(import_root) not in sys.path:
        sys.path.insert(0, str(import_root))

from worker.cliper_worker import find_moments  # noqa: E402


DEFAULT_CASES = (
    ("podcast", "0K37SYfox7M", "podcast"),
    ("interview", "1QOE4KqnZ9w", "interview"),
    ("storytelling", "9TaJTuG5iSs", "storytelling"),
    ("commentary", "8WH6ut7N5c", "tutorial"),
)


def feature_flags() -> dict[str, Any]:
    contract = read_json(WORKER_ROOT / "settings-contract.json")
    flags = contract.get("featureFlags") if isinstance(contract, dict) else {}
    return dict(flags) if isinstance(flags, dict) else {}


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def cache_root() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        raise RuntimeError("LOCALAPPDATA tidak tersedia; berikan --cache-root.")
    return Path(local_app_data) / "Cliper Studio Plus" / "cache" / "sources"


def source_video(case_dir: Path) -> Path:
    for suffix in ("mp4", "mkv", "webm", "mov"):
        candidate = case_dir / f"source.{suffix}"
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(f"Video source tidak ditemukan pada {case_dir}")


def as_score(value: Any) -> int | None:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return round(max(0.0, min(100.0, numeric)))


def moment_report(moment: dict[str, Any]) -> dict[str, Any]:
    metrics = moment.get("metrics") if isinstance(moment.get("metrics"), dict) else {}
    scorecard = metrics.get("scorecard") if isinstance(metrics.get("scorecard"), dict) else {}
    arc = scorecard.get("arc") if isinstance(scorecard.get("arc"), dict) else {}
    reviewer_status = str(moment.get("reviewer_status") or "").strip().lower()
    return {
        "id": moment.get("id"),
        "title": moment.get("title") or moment.get("titleSuggestion"),
        "start": round(float(moment.get("start") or 0), 2),
        "end": round(float(moment.get("end") or 0), 2),
        "duration": round(float(moment.get("duration") or 0), 2),
        "score": as_score(moment.get("score")),
        "publicScore": as_score(moment.get("public_score")),
        "hook": as_score(metrics.get("hook")),
        "story": as_score(metrics.get("story_complete") or metrics.get("flow")),
        "payoff": as_score(metrics.get("payoff") or arc.get("payoff")),
        "retention": as_score(metrics.get("retention_predictor") or arc.get("retention_proxy")),
        "standalone": as_score(metrics.get("standalone") or arc.get("standalone")),
        "boundary": {
            "danglingStart": bool(metrics.get("dangling_start")),
            "danglingEnd": bool(metrics.get("dangling_end")),
            "cleanEnd": bool(metrics.get("clean_end")),
        },
        "qualityTier": moment.get("quality_tier"),
        "evidenceGate": moment.get("evidence_gate"),
        "aiReviewed": reviewer_status == "approved",
        "reviewerStatus": reviewer_status or "not-requested",
        "reason": moment.get("reason"),
    }


def run_case(
    name: str,
    source_id: str,
    video_type: str,
    root: Path,
    scratch_root: Path,
    target_count: int,
) -> dict[str, Any]:
    case_dir = root / source_id
    metadata_path = case_dir / "metadata.json"
    transcript_path = case_dir / "transcript.json"
    profile_path = case_dir / "content_profile.json"
    for required in (metadata_path, transcript_path, profile_path):
        if not required.is_file():
            raise FileNotFoundError(f"{name}: file cache wajib hilang: {required}")

    metadata = read_json(metadata_path)
    transcript_document = read_json(transcript_path)
    transcript = transcript_document.get("segments") or transcript_document.get("transcript") or []
    if not isinstance(transcript, list) or not transcript:
        raise RuntimeError(f"{name}: transcript cache kosong.")
    profile = read_json(profile_path)
    if not isinstance(profile, dict):
        profile = {}
    profile["videoType"] = video_type
    profile.setdefault("evidence", {})
    profile["evidence"].setdefault("title", str(metadata.get("title") or ""))

    source = source_video(case_dir)
    info = dict(metadata)
    # Empty URLs guarantee no remote metadata or heatmap fetch. Cached heatmap
    # evidence remains available when the worker can load it from this folder.
    info.update(
        {
            "duration": float(metadata.get("duration") or 0),
            "webpage_url": "",
            "original_url": "",
            "_analysis_cache_dir": str(case_dir),
            "_audio_cache_dir": str(case_dir),
            "_heatmap_cache_path": str(scratch_root / f"{source_id}-youtube-heatmap.json"),
            "_source_path": str(source),
        }
    )
    payload: dict[str, Any] = {
        "sourceMode": "local",
        "url": "",
        "clipCount": target_count,
        "allRecommendedClips": False,
        "fullAutoMode": True,
        "autoClipCount": False,
        "minDuration": 30,
        "targetDuration": 75,
        "maxDuration": 180,
        "providerType": "local",
        "featureFlags": feature_flags(),
        "aiFeatures": {
            "highlight": False,
            "ranking": False,
            "caption": False,
            "hook": False,
            "title": False,
            "tts": False,
        },
        "_contentProfile": profile,
    }

    started = time.perf_counter()
    moments = find_moments(info, transcript, payload)
    elapsed = round(time.perf_counter() - started, 2)
    quality_margin = 0 if target_count <= 1 else max(1, round(target_count * 0.2))
    reported = [moment_report(moment) for moment in moments]
    failures: list[str] = []
    if not reported:
        failures.append("Tidak ada kandidat yang lolos quality gate.")
    for item in reported:
        if item["duration"] < 30 or item["end"] <= item["start"]:
            failures.append(f"Kandidat {item['id']} memiliki boundary/durasi tidak valid.")
        if item["score"] is None or any(
            item[key] is None
            for key in ("hook", "story", "payoff", "retention", "standalone")
        ):
            failures.append(f"Kandidat {item['id']} tidak memiliki score evidence lengkap.")
        if item["boundary"]["danglingStart"] or item["boundary"]["danglingEnd"]:
            failures.append(f"Kandidat {item['id']} masih memiliki boundary menggantung.")
        if item["score"] is not None and item["score"] < 65:
            failures.append(f"Kandidat {item['id']} berada di bawah quality gate 65.")
        if item["publicScore"] is None or not 7 <= item["publicScore"] <= 10:
            failures.append(f"Kandidat {item['id']} tidak memiliki public score 7-10 yang valid.")
        if item["evidenceGate"] is not True:
            failures.append(f"Kandidat {item['id']} tidak lolos evidence gate.")
    if len(reported) > target_count + quality_margin:
        failures.append(
            f"Jumlah kandidat {len(reported)} melewati batas adaptif {target_count + quality_margin}."
        )

    durations = [item["duration"] for item in reported]
    scores = [item["score"] for item in reported if item["score"] is not None]
    retention_scores = [
        item["retention"] for item in reported if item["retention"] is not None
    ]
    retention_ceiling_count = sum(score >= 95 for score in retention_scores)
    duration_clustering = len(durations) >= 3 and all(
        round(value) in {90, 120} for value in durations
    )
    if duration_clustering:
        failures.append("Semua kandidat mengelompok pada durasi 90/120 detik.")
    if (
        len(retention_scores) >= 4
        and retention_ceiling_count / len(retention_scores) > 0.70
    ):
        failures.append(
            "Prediksi retention jenuh di plafon; sinyal kandidat tidak terkalibrasi."
        )
    return {
        "case": name,
        "targetCount": target_count,
        "sourceId": source_id,
        "title": metadata.get("title"),
        "videoType": video_type,
        "elapsedSeconds": elapsed,
        "candidateCount": len(reported),
        "available": len(reported),
        "durations": durations,
        "scores": scores,
        "retentionScores": retention_scores,
        "retentionCeilingCount": retention_ceiling_count,
        "durationClustering90or120": duration_clustering,
        "candidates": reported,
        "status": "PASS" if not failures else "FAIL",
        "failures": failures,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-root", type=Path, default=cache_root())
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "Local Test Builds" / "V1.12.0-Release-Candidate" / "moment-acceptance.json",
    )
    parser.add_argument(
        "--case",
        choices=("all",) + tuple(item[0] for item in DEFAULT_CASES),
        default="all",
        help="Run one cached profile while iterating, or all profiles for the release gate.",
    )
    parser.add_argument(
        "--targets",
        default="1,4,6,10",
        help="Comma-separated requested clip targets.",
    )
    args = parser.parse_args()
    targets = tuple(
        sorted({max(1, min(10, int(value.strip()))) for value in args.targets.split(",") if value.strip()})
    )
    selected_cases = (
        DEFAULT_CASES
        if args.case == "all"
        else tuple(item for item in DEFAULT_CASES if item[0] == args.case)
    )
    with tempfile.TemporaryDirectory(prefix="cliper-moment-acceptance-") as scratch:
        scratch_root = Path(scratch)
        results = [
            run_case(
                name,
                source_id,
                video_type,
                args.cache_root,
                scratch_root,
                target_count,
            )
            for target_count in targets
            for name, source_id, video_type in selected_cases
        ]
    summary = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "network": "disabled",
        "provider": "local",
        "status": "PASS" if all(item["status"] == "PASS" for item in results) else "FAIL",
        "cases": results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    for item in results:
        print(
            f"{item['case']} target={item['targetCount']}: {item['status']} | {item['candidateCount']} kandidat | "
            f"{item['elapsedSeconds']:.2f}s | duration={item['durations']} | score={item['scores']}"
        )
        for failure in item["failures"]:
            print(f"  FAIL: {failure}")
    print(f"Acceptance report: {args.output}")
    return 0 if summary["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())

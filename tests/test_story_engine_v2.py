import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))
import story_engine
import cliper_worker


def test_story_engine_v2_semantic_roles():
    """Verify rich semantic role tagging across narrative elements."""
    hook_text = "Tahukah kamu rahasia kenapa banyak orang gagal dalam bisnis ini?"
    setup_text = "Awalnya waktu itu kami hanya memiliki modal kecil dan ruangan sempit."
    conflict_text = "Masalahnya kami ditolak oleh puluhan investor dan hampir menyerah."
    key_point_text = "Kuncinya faktanya adalah memahami kebutuhan riil pelanggan."
    payoff_text = "Akhirnya strategi baru tersebut terbukti berhasil dan mencetak rekor penjualan."
    exit_text = "Itu alasannya kenapa produk ini bertahan sampai sekarang. Nah itu dia."

    assert "hook" in story_engine.story_roles(hook_text)
    assert "question" in story_engine.story_roles(hook_text)
    assert "setup" in story_engine.story_roles(setup_text)
    assert "conflict" in story_engine.story_roles(conflict_text)
    assert "key_point" in story_engine.story_roles(key_point_text)
    assert "payoff" in story_engine.story_roles(payoff_text)
    assert "natural_exit" in story_engine.story_roles(exit_text)


def test_build_story_map_identifies_arc_regions():
    """Verify build_story_map annotates every segment with roles and flags."""
    transcript = [
        {"start": 0.0, "end": 15.0, "text": "Tahukah kamu rahasia terbesar startup sukses?"},
        {"start": 15.0, "end": 35.0, "text": "Awalnya mereka menghadapi masalah besar ketika ditolak investor."},
        {"start": 35.0, "end": 55.0, "text": "Lalu tim mengubah strategi dan fokus pada retensi pelanggan."},
        {"start": 55.0, "end": 75.0, "text": "Akhirnya mereka berhasil mencapai profit dan membuktikan model bisnisnya."},
        {"start": 75.0, "end": 85.0, "text": "Itu alasannya kenapa fokus pada retensi adalah kuncinya."},
    ]

    story_map = story_engine.build_story_map(transcript)
    assert len(story_map) == 5
    assert story_map[0]["has_setup"] is True
    assert story_map[1]["has_conflict"] is True
    assert story_map[2]["has_dev"] is True
    assert story_map[3]["has_payoff"] is True
    assert story_map[4]["has_clean_end"] is True


def test_recover_story_context_backward_expansion():
    """If a candidate starts mid-thought with dependent words, expand backward to setup."""
    transcript = [
        {"start": 0.0, "end": 20.0, "text": "Banyak orang bertanya kenapa proyek ini sempat terhenti."},
        {"start": 20.0, "end": 40.0, "text": "Awalnya biaya operasional membengkak drastis."},
        {"start": 40.0, "end": 65.0, "text": "Karena itu kami harus merestrukturisasi seluruh tim."},
        {"start": 65.0, "end": 90.0, "text": "Akhirnya solusi ini berhasil memulihkan keuangan perusahaan."},
    ]

    # Candidate starts at 40.0 with "Karena itu..." (dependent opening)
    start, end, text = story_engine.recover_story_context(transcript, 40.0, 90.0)

    # Must recover backward to 20.0 or 0.0
    assert start <= 20.0
    assert "Awalnya" in text
    assert "Akhirnya" in text


def test_recover_story_context_forward_payoff():
    """If a candidate is cut off before the payoff, expand forward to complete the resolution."""
    transcript = [
        {"start": 0.0, "end": 20.0, "text": "Kenapa riset ini begitu penting bagi industri?"},
        {"start": 20.0, "end": 45.0, "text": "Masalahnya teknologi lama menghasilkan limbah yang berbahaya."},
        {"start": 45.0, "end": 70.0, "text": "Lalu kami mengembangkan katalis ramah lingkungan."},
        {"start": 70.0, "end": 95.0, "text": "Akhirnya emisi berhasil ditekan hingga nol persen."},
    ]

    # Candidate prematurely cut off at 70.0
    start, end, text = story_engine.recover_story_context(transcript, 0.0, 70.0)

    # Must expand forward to include the payoff at 95.0
    assert end >= 95.0
    assert "Akhirnya emisi berhasil ditekan" in text


def test_story_completeness_validator_dimensions():
    """Verify internal story dimensions and standalone comprehension score."""
    complete_story = (
        "Kenapa produk ini viral? Awalnya kami melihat masalah antrean yang panjang. "
        "Lalu kami membuat sistem otomatis berbasis QR code. "
        "Akhirnya waktu tunggu berkurang drastis dan pelanggan sangat puas."
    )
    report = story_engine.validate_story_completeness(complete_story, duration=60.0)

    assert report["is_complete"] is True
    assert report["has_setup"] is True
    assert report["has_development"] is True
    assert report["has_payoff"] is True
    assert report["has_clean_start"] is True
    assert report["has_clean_end"] is True

    dims = report["internal_dimensions"]
    assert dims["context_completeness"] >= 70
    assert dims["story_coherence"] >= 60
    assert dims["payoff_strength"] >= 70
    assert dims["standalone_quality"] >= 70


def test_candidate_repair_fixes_incomplete_candidate():
    """Candidate repair should automatically expand incomplete boundaries to make it standalone."""
    transcript = [
        {"start": 10.0, "end": 30.0, "text": "Ceritanya bermula saat toko kami sepi pembeli."},
        {"start": 30.0, "end": 50.0, "text": "Terus kami mencoba promosi live streaming di media sosial."},
        {"start": 50.0, "end": 75.0, "text": "Akhirnya pesanan membludak dan omzet naik sepuluh kali lipat."},
    ]

    # Incomplete candidate starting at 30.0 (starts with 'Terus...')
    bad_cand = {
        "start": 30.0,
        "end": 75.0,
        "text": "Terus kami mencoba promosi live streaming di media sosial. Akhirnya pesanan membludak.",
    }

    repaired = story_engine.repair_story_candidate(transcript, bad_cand)
    assert repaired["start"] <= 10.0
    assert "Ceritanya bermula" in repaired["text"]
    assert repaired.get("repaired") is True


def test_deduplicate_story_candidates_retains_best_version():
    """Dedup must prune overlapping boundaries while retaining the best standalone version."""
    candidates = [
        {
            "start": 10.0,
            "end": 60.0,
            "text": "dan terus kami mencoba live streaming.",
            "standalone_quality": 45,
            "score": 60,
        },
        {
            "start": 0.0,
            "end": 65.0,
            "text": "Awalnya toko sepi pembeli. Lalu kami mencoba live streaming. Akhirnya omzet naik pesat.",
            "standalone_quality": 88,
            "score": 78,
            "internal_dimensions": {
                "standalone_quality": 88,
                "payoff_strength": 90,
                "context_completeness": 85,
            },
        },
    ]

    deduped = story_engine.deduplicate_story_candidates(candidates, iou_threshold=0.3)
    assert len(deduped) == 1
    assert deduped[0]["start"] == 0.0
    assert "Awalnya" in deduped[0]["text"]


def test_discover_story_arcs():
    """Verify discover_story_arcs identifies structured narrative patterns."""
    transcript = [
        {"start": 0.0, "end": 15.0, "text": "Awalnya kami ragu apakah strategi ini bisa berjalan."},
        {"start": 15.0, "end": 35.0, "text": "Masalahnya anggaran kami sangat terbatas dan waktu sempit."},
        {"start": 35.0, "end": 55.0, "text": "Lalu tim melakukan otomatisasi proses kerja setiap hari."},
        {"start": 55.0, "end": 75.0, "text": "Akhirnya hasilnya melampaui target dan efisiensi melonjak tinggi."},
        {"start": 75.0, "end": 90.0, "text": "Itu alasannya kenapa otomasi adalah solusi terbaik."},
    ]
    story_map = story_engine.build_story_map(transcript)
    arcs = story_engine.discover_story_arcs(story_map, min_duration=20.0, max_duration=120.0)

    assert len(arcs) >= 1
    arc_types = [a["arc_type"] for a in arcs]
    assert any("PAYOFF" in at or "SOLUTION" in at for at in arc_types)
    first_arc = arcs[0]
    assert first_arc["start"] <= 15.0
    assert first_arc["end"] >= 75.0
    assert first_arc["arc_completeness"] >= 60


def test_shared_story_engine_podcast_strategy():
    """Verify PodcastStoryStrategy ranks insightful and well-resolved arcs higher."""
    engine = story_engine.SharedStoryEngine()
    transcript = [
        {"start": 0.0, "end": 20.0, "text": "Banyak pendengar menanyakan rahasia kepemimpinan yang efektif."},
        {"start": 20.0, "end": 50.0, "text": "Penjelasannya adalah mendengarkan tim sebelum mengambil keputusan besar."},
        {"start": 50.0, "end": 80.0, "text": "Hasilnya kepercayaan meningkat drastis dan performa tim naik dua kali lipat."},
        {"start": 80.0, "end": 95.0, "text": "Itu kesimpulan penting dari pengalaman saya selama memimpin."},
    ]
    ranked = engine.discover_and_rank_stories(transcript, mode="podcast", min_duration=20.0, max_duration=120.0)
    assert len(ranked) >= 1
    top = ranked[0]
    assert top["start"] <= 20.0
    assert top["end"] >= 80.0
    assert "strategy_score" in top
    assert top["strategy_score"] > 60


def test_shared_story_engine_gaming_strategy():
    """Verify GamingStoryStrategy merges action, result, and reaction signals."""
    engine = story_engine.SharedStoryEngine()
    transcript = [
        {"start": 10.0, "end": 25.0, "text": "Lihat posisinya, musuh mulai mengepung dari sayap kiri."},
        {"start": 25.0, "end": 45.0, "text": "Ayo push sekarang, ulti siap! Hajar langsung!"},
        {"start": 45.0, "end": 65.0, "text": "Triple kill berhasil! Luar biasa tembakan terakhir itu!"},
        {"start": 65.0, "end": 80.0, "text": "Gila banget clutch ini! Yes, mantap sekali kawan-kawan!"},
    ]
    ranked = engine.discover_and_rank_stories(transcript, mode="gaming", min_duration=20.0, max_duration=120.0)
    assert len(ranked) >= 1
    top = ranked[0]
    assert "clutch" in top["text"].lower() or "triple kill" in top["text"].lower()
    assert top["strategy_score"] > 50


def test_summary_composer_segment_selection_and_dedup():
    """Verify SummaryComposer clusters duplicates and picks distinct review points."""
    transcript = [
        {"start": 0.0, "end": 20.0, "text": "Ini dia review lengkap smartphone flagship terbaru tahun ini!"},
        {"start": 20.0, "end": 50.0, "text": "Pertama kita bahas desain dan layarnya yang sangat tajam dan terang."},
        {"start": 50.0, "end": 80.0, "text": "Kelebihan utamanya ada pada performa chipset yang sangat kencang tanpa lag."},
        {"start": 80.0, "end": 110.0, "text": "Keunggulannya juga baterai awet seharian penuh dalam pengujian berat."},
        {"start": 110.0, "end": 140.0, "text": "Saat pengujian gaming berat, fps stabil dan tidak panas sama sekali."},
        {"start": 140.0, "end": 170.0, "text": "Kekurangan terbesarnya adalah kameranya agak lambat saat low light."},
        {"start": 170.0, "end": 200.0, "text": "Kesimpulannya dengan harga 5 jutaan ini pilihan terbaik untuk gamer."},
    ]
    story_map = story_engine.build_story_map(transcript)
    composer = story_engine.SummaryComposer()

    # Identify segments
    raw_segments = composer.identify_segments(story_map)
    assert len(raw_segments) >= 3

    # Cluster & dedup
    deduped = composer.cluster_and_deduplicate(raw_segments)
    assert len(deduped) <= len(raw_segments)

    # Continuity & bridges
    valid_segments = composer.validate_continuity(deduped)
    for seg in valid_segments:
        assert "bridge_label" in seg
        assert seg["bridge_label"] in ["Sorotan", "Konteks", "Kelebihan", "Pengujian", "Catatan Penting", "Kekurangan", "Kesimpulan", "Ringkasan"]

    # Plan composition (clamped to 60-180s)
    plan = composer.plan_summary_composition(valid_segments, min_duration=40.0, max_duration=180.0)
    assert 40.0 <= plan["total_duration"] <= 180.0
    assert len(plan["selected_segments"]) >= 2


def test_summary_composer_timeline_and_subtitle_rebase():
    """Verify subtitle rebasing converts source timestamps to 00:00-based composed timeline."""
    composer = story_engine.SummaryComposer()
    segments = [
        {"id": "seg_1", "start": 10.0, "end": 30.0, "duration": 20.0, "role": "hook", "text": "Ini smartphone terbaik."},
        {"id": "seg_2", "start": 100.0, "end": 130.0, "duration": 30.0, "role": "benefit", "text": "Baterai awet seharian penuh."},
    ]
    transcript = [
        {"start": 10.0, "end": 20.0, "text": "Ini smartphone"},
        {"start": 20.0, "end": 30.0, "text": "terbaik."},
        {"start": 100.0, "end": 115.0, "text": "Baterai awet"},
        {"start": 115.0, "end": 130.0, "text": "seharian penuh."},
    ]
    timeline_map, rebased_transcript, total_duration = composer.build_timeline_and_rebase_subtitles(segments, transcript)

    # Timeline mapping checks
    assert len(timeline_map) == 2
    assert timeline_map[0]["outputStart"] == 0.0
    assert timeline_map[0]["outputEnd"] == 20.0
    assert timeline_map[1]["outputStart"] == 20.0
    assert timeline_map[1]["outputEnd"] == 50.0

    # Subtitle rebase checks: all must fall within 0.0 - 50.0
    assert len(rebased_transcript) == 4
    assert rebased_transcript[0]["start"] == 0.0
    assert rebased_transcript[0]["end"] == 10.0
    assert rebased_transcript[1]["start"] == 10.0
    assert rebased_transcript[1]["end"] == 20.0
    assert rebased_transcript[2]["start"] == 20.0
    assert rebased_transcript[2]["end"] == 35.0
    assert rebased_transcript[3]["start"] == 35.0
    assert rebased_transcript[3]["end"] == 50.0


def test_summary_composer_full_compose_returns_single_moment():
    """Verify SummaryComposer.compose returns exactly 1 composed moment with summary metadata."""
    composer = story_engine.SummaryComposer()
    transcript = [
        {"start": 0.0, "end": 25.0, "text": "Inilah review lengkap gadget terbaru yang sedang viral."},
        {"start": 25.0, "end": 55.0, "text": "Kelebihan pertamanya ada pada layar AMOLED yang sangat tajam dan terang."},
        {"start": 55.0, "end": 85.0, "text": "Dalam pengujian gaming, fps sangat stabil tanpa frame drop."},
        {"start": 85.0, "end": 115.0, "text": "Kekurangan utamanya hanya pada kecepatan pengisian daya yang standar."},
        {"start": 115.0, "end": 145.0, "text": "Kesimpulan akhirnya produk ini sangat layak dibeli di kelas harganya."},
    ]
    moment = composer.compose(transcript, duration=150.0)

    assert moment is not None
    assert moment["is_summary_composition"] is True
    assert moment["duration"] > 0
    assert len(moment["summary_segments"]) >= 2
    assert "summary_timeline_map" in moment
    assert "summary_rebased_subtitles" in moment
    assert moment["story_flow"] != ""
    assert moment["public_score"] >= 8.0


def test_build_summary_composition_command():
    """Verify build_summary_composition_command constructs valid multi-segment ffmpeg filtergraph."""
    segments = [
        {"sourceStart": 5.0, "sourceEnd": 25.0, "outputStart": 0.0, "outputEnd": 20.0},
        {"sourceStart": 60.0, "sourceEnd": 85.0, "outputStart": 20.0, "outputEnd": 45.0},
    ]
    class MockEngine:
        ffmpeg_path = "ffmpeg"

    cmd = cliper_worker.build_summary_composition_command(
        engine=MockEngine(),
        source="C:/videos/source.mp4",
        segments=segments,
        output_path="C:/videos/output.mp4",
        encoder="libx264",
        vf="subtitles=C\\:/videos/sub.ass",
    )
    cmd_str = " ".join(cmd)
    assert "ffmpeg" in cmd[0]
    assert "-filter_complex" in cmd
    assert "trim=start=5:end=25" in cmd_str
    assert "trim=start=60:end=85" in cmd_str
    assert "concat=n=2:v=1:a=1" in cmd_str
    assert "subtitles=" in cmd_str
    assert "C:/videos/output.mp4" in cmd


def test_build_clip_render_command_preserves_summary_segments_in_fallbacks():
    """Renderer retries must not turn Summary mode back into one contiguous clip."""
    segments = [
        {"sourceStart": 5.0, "sourceEnd": 8.0},
        {"sourceStart": 20.0, "sourceEnd": 24.0},
    ]

    class MockEngine:
        ffmpeg_path = "ffmpeg"

    cmd = cliper_worker.build_clip_render_command(
        engine=MockEngine(),
        source="C:/videos/source.mp4",
        start=5.0,
        duration=7.0,
        output_path="C:/videos/output.mp4",
        encoder="libx264",
        is_summary_comp=True,
        comp_segments=segments,
    )
    cmd_str = " ".join(cmd)
    assert "-ss" not in cmd
    assert "trim=start=5:end=8" in cmd_str
    assert "trim=start=20:end=24" in cmd_str
    assert "concat=n=2:v=1:a=1" in cmd_str


def test_summary_composition_command_can_apply_logo_overlay():
    segments = [{"sourceStart": 0.0, "sourceEnd": 3.0}]

    class MockEngine:
        ffmpeg_path = "ffmpeg"

    cmd = cliper_worker.build_summary_composition_command(
        engine=MockEngine(),
        source="C:/videos/source.mp4",
        segments=segments,
        output_path="C:/videos/output.mp4",
        encoder="libx264",
        logo_path="C:/assets/logo.png",
        payload={"logoX": 82, "logoY": 14, "logoOpacity": 80},
    )
    cmd_str = " ".join(cmd)
    assert "C:/assets/logo.png" in cmd
    assert "[1:v]scale=" in cmd_str
    assert "overlay=" in cmd_str
    assert "-map [v_final]" in cmd_str


def test_real_smoke_render_summary_composition_with_ffprobe(tmp_path):
    """End-to-end smoke test verifying multi-segment composition renders and ffprobe validates duration & streams."""
    import subprocess
    import json

    # 1. Create a 4-second synthetic test video with audio
    source_video = tmp_path / "synthetic_source.mp4"
    make_source_cmd = [
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", "testsrc=duration=4:size=640x360:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
        "-c:v", "libx264", "-preset", "ultrafast",
        "-c:a", "aac", "-b:a", "128k",
        str(source_video),
    ]
    subprocess.run(make_source_cmd, check=True, capture_output=True)

    # 2. Build summary composition of 2 segments: 0.5s - 1.5s (1.0s) and 2.0s - 3.5s (1.5s) -> total 2.5s
    out_video = tmp_path / "composed_summary.mp4"
    segments = [
        {"sourceStart": 0.5, "sourceEnd": 1.5, "outputStart": 0.0, "outputEnd": 1.0},
        {"sourceStart": 2.0, "sourceEnd": 3.5, "outputStart": 1.0, "outputEnd": 2.5},
    ]

    class MockEngine:
        ffmpeg_path = "ffmpeg"

    render_cmd = cliper_worker.build_summary_composition_command(
        engine=MockEngine(),
        source=str(source_video),
        segments=segments,
        output_path=str(out_video),
        encoder="libx264",
    )
    subprocess.run(render_cmd, check=True, capture_output=True)

    # 3. Probe with ffprobe
    probe_cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration:stream=codec_type,width,height",
        "-of", "json",
        str(out_video),
    ]
    probe = subprocess.run(probe_cmd, check=True, capture_output=True)
    probe_data = json.loads(probe.stdout)

    # Verify duration is ~2.5s (+- 0.2s tolerance)
    duration = float(probe_data["format"]["duration"])
    assert 2.3 <= duration <= 2.7

    # Verify both video and audio streams exist
    stream_types = [s["codec_type"] for s in probe_data.get("streams", [])]
    assert "video" in stream_types
    assert "audio" in stream_types



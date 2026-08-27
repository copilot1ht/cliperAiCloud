import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))
import cliper_worker
import story_engine


def test_content_profile_classifies_supported_creator_formats():
    cases = [
        ("Terlalu Sayang Cover Akustik", "", "", "music"),
        ("Review iPhone Setelah Dipakai 30 Hari", "", "kamera baterai harga", "review"),
        ("Berita Hari Ini: Konferensi Pers Pemerintah", "", "reporter menjelaskan dampak", "news"),
        ("Podcast Bersama Pendiri Startup", "", "ngobrol panjang", "podcast"),
        ("Vlog Perjalanan ke Yogyakarta", "", "hari pertama perjalanan", "vlog"),
        ("Kisah Saya Memulai Usaha dari Nol", "", "awalnya sulit kemudian berubah akhirnya berhasil", "storytelling"),
        ("Cara Mengatur Kamera untuk Pemula", "", "langkah-langkah tutorial", "tutorial"),
        ("Valorant Gameplay Ranked", "", "gaming match", "gaming"),
    ]
    for title, channel, text, expected in cases:
        video_type, _subtype = cliper_worker.classify_content_profile(title, channel, text)
        assert video_type == expected


def test_news_metadata_wins_over_incidental_tutorial_words_in_transcript():
    video_type, subtype = cliper_worker.classify_content_profile(
        "Berapi-api! Prabowo Singgung Dandim dan Kapolres",
        "MerdekaDotCom",
        "Presiden menjelaskan cara memeriksa dapur program pemerintah.",
    )

    assert video_type == "news"
    assert subtype == "current-affairs"


def test_news_metadata_wins_over_repeated_music_caption_markers():
    video_type, subtype = cliper_worker.classify_content_profile(
        "SIDANG JADI SOROTAN! Nadiem Laporkan 4 Hakim ke Komisi Yudisial",
        "Official iNews",
        "[Music] Sidang praperadilan tersangka dimulai. [Music] Hakim memeriksa perkara.",
        lyric_marker_ratio=1.2,
    )

    assert video_type == "news"
    assert subtype == "current-affairs"


def test_explicit_music_title_still_wins_on_news_channel():
    video_type, subtype = cliper_worker.classify_content_profile(
        "Terlalu Sayang Cover Akustik Live Performance",
        "Official iNews",
        "[Music] masuk ke bagian refrain",
        lyric_marker_ratio=1.0,
    )

    assert video_type == "music"
    assert subtype == "performance"


def test_incidental_word_cara_does_not_turn_general_video_into_tutorial():
    video_type, _subtype = cliper_worker.classify_content_profile(
        "Pembahasan Komunitas Kreator",
        "Ruang Kreatif",
        "Mereka membahas cara melihat masalah dari sudut berbeda.",
    )

    assert video_type == "general"


def test_long_episode_with_real_dialogue_is_inferred_as_conversation():
    dialogue = (
        "Kenapa waktu itu kamu memilih pindah? Iya, waktu itu saya masih ragu. "
        "Bagaimana akhirnya kamu yakin? Nah, jawabannya datang setelah keluarga mendukung. "
        "Menurut kamu keputusan itu benar? Betul, karena hasilnya mulai terlihat. "
        "Jadi kamu tidak menyesal? Iya, akhirnya saya menemukan arah yang tepat. "
    ) * 4
    profile = cliper_worker.build_content_profile(
        {
            "title": "Episode 12 Bersama Kreator Daerah",
            "channel": "Ruang Cerita",
            "duration": 1800,
        },
        [{"start": 0, "end": 180, "text": dialogue}],
    )

    assert profile["videoType"] == "podcast"
    assert profile["subtype"] == "conversation"
    assert profile["evidence"]["conversationScore"] >= 5


def test_content_profile_v2_exposes_grounded_editorial_signals():
    transcript = [
        {"start": 0, "end": 8, "text": "Kenapa penjualan produk ini gagal pada bulan pertama?"},
        {"start": 8, "end": 18, "text": "Masalahnya iklan salah sasaran karena data pelanggan belum dibaca."},
        {"start": 18, "end": 28, "text": "Akhirnya strategi baru terbukti berhasil dan penjualan naik 40 persen."},
    ]
    profile = cliper_worker.build_content_profile(
        {"title": "Strategi Penjualan Produk", "channel": "Ruang Bisnis", "duration": 28},
        transcript,
        {"subtitleLang": "auto"},
    )

    assert profile["schema"] == 2
    assert profile["language"] == "id"
    assert profile["topic"]
    assert profile["storyStructure"] in {"question-answer", "problem-solution"}
    assert profile["questions"]
    assert profile["conflicts"]
    assert profile["payoffs"]
    assert profile["keyClaims"]


def test_story_map_marks_question_answer_and_payoff_events():
    transcript = [
        {"start": 0, "end": 8, "text": "Kenapa proyek ini terlambat?"},
        {"start": 8, "end": 18, "text": "Karena pemasok utama berhenti mengirim bahan."},
        {"start": 18, "end": 30, "text": "Akhirnya pemasok baru terbukti menyelesaikan masalah."},
    ]
    profile = cliper_worker.build_content_profile(
        {"title": "Kisah Proyek Terlambat", "duration": 30}, transcript
    )
    story_map = cliper_worker.build_story_map(
        {"title": "Kisah Proyek Terlambat", "duration": 30}, transcript, profile
    )

    assert story_map["schema"] == 1
    assert story_map["summary"]["storyCount"] >= 1
    assert {event["type"] for event in story_map["events"]} >= {"question", "answer", "payoff"}


def test_duration_profile_follows_classified_news_not_incidental_tutorial_word():
    profile = cliper_worker.candidate_duration_profile(
        "Presiden menjelaskan cara memeriksa program pemerintah.",
        {"videoType": "news"},
    )
    bounds = cliper_worker.candidate_duration_bounds(
        "Presiden menjelaskan cara memeriksa program pemerintah.",
        25,
        60,
        120,
        {"videoType": "news"},
    )

    assert profile["type"] == "news"
    # v1.12.0 keeps news concise while allowing a complete 30-110 second story.
    assert bounds == (30.0, 60.0, 110.0, "news")


def test_ai_split_suggestion_requires_two_verified_overlapping_speakers():
    scene = {
        "layout_suggestion": "split",
    }

    assert cliper_worker.should_enable_split_screen(
        scene,
        {"speaker_count": 1, "overlap_seconds": 0.0},
        75,
        4,
        2.4,
        0.6,
        0.1,
    ) is False
    assert cliper_worker.should_enable_split_screen(
        scene,
        {"speaker_count": 2, "overlap_seconds": 1.4},
        75,
        2,
        2.0,
        0.6,
        0.1,
    ) is True


def test_music_prompt_does_not_force_podcast_conflict_logic():
    profile = {
        "videoType": "music",
        "evidence": {"title": "Terlalu Sayang Cover Akustik"},
    }
    prompt = cliper_worker.highlight_batch_prompt(
        [{"id": 1, "text": "bagian refrain", "metrics": {"audio_activity": 80}}],
        1,
        20,
        90,
        "viral",
        1,
        1,
        profile,
    )

    assert "video musik/performance" in prompt.lower()
    assert "jangan memaksakan konflik" in prompt.lower()
    assert "Terlalu Sayang Cover Akustik" in prompt


def test_music_hook_candidates_are_grounded_in_source_title():
    payload = {
        "_contentProfile": {
            "videoType": "music",
            "evidence": {"title": "Terlalu Sayang Cover Akustik"},
        }
    }
    candidates = cliper_worker.content_aware_local_hook_candidates("masuk ke bagian refrain", payload)

    assert any("Vokal" in candidate or "Emosional" in candidate for candidate in candidates)
    assert all("konflik" not in candidate.lower() for candidate in candidates[:2])


def test_music_score_uses_audio_evidence_without_story_penalty():
    score, provenance = cliper_worker.content_weighted_highlight_score(
        {
            "audio_activity": 82,
            "audio_variation": 8,
            "emotion": 76,
            "retention_predictor": 74,
            "visual_activity": 70,
            "duration_fit": 88,
            "hook": 66,
            "cut": 82,
            "story_complete": 25,
            "payoff": 25,
            "filler_ratio": 0.02,
        },
        "music",
    )

    assert score >= 74
    reasons = {item["reason"] for item in provenance["adjustments"]}
    assert "weak_story_boundary" not in reasons
    assert "weak_payoff" not in reasons


def test_podcast_score_exposes_weak_payoff_penalty():
    _score, provenance = cliper_worker.content_weighted_highlight_score(
        {
            "story_complete": 70,
            "payoff": 40,
            "hook": 72,
            "retention_predictor": 74,
            "dialogue": 80,
            "emotion": 65,
            "cut": 78,
            "novelty": 64,
            "duration_fit": 80,
            "filler_ratio": 0.04,
        },
        "podcast",
    )

    assert {"reason": "weak_payoff", "value": -5} in provenance["adjustments"]


def test_rolling_youtube_captions_are_collapsed_without_losing_new_words():
    vtt = """WEBVTT

00:05:04.330 --> 00:05:04.340
mungkin karena terlalu sayang

00:05:04.340 --> 00:05:07.570
mungkin karena terlalu sayang tidak terpikir

00:05:07.570 --> 00:05:07.580
tidak terpikir

00:05:07.580 --> 00:05:11.450
tidak terpikir penyesalan manis
"""
    segments = cliper_worker.parse_vtt(vtt)

    assert len(segments) == 1
    assert segments[0]["start"] == 304.33
    assert segments[0]["end"] == 311.45
    assert segments[0]["text"] == "mungkin karena terlalu sayang tidak terpikir penyesalan manis"


def test_media_interval_never_extends_past_source_duration():
    start, end = cliper_worker.clamp_interval_to_duration(304.33, 364.33, 352.0, 25.0)

    assert start == 304.33
    assert end == 352.0


def test_upload_title_reuses_grounded_final_candidate_without_new_ai_call(monkeypatch):
    def fail_if_called(*_args, **_kwargs):
        raise AssertionError("AI title must not run after a grounded final title is approved")

    monkeypatch.setattr(cliper_worker, "ai_generate_upload_title", fail_if_called)
    moment = {
        "titleSuggestion": "Cek Dapur MBG Tanpa Panggil-Panggil",
        "transcript": "Kepala desa boleh memeriksa semua dapur MBG dan melaporkan masalah tanpa panggil-panggil.",
    }
    payload = {
        "aiTitleEnabled": True,
        "_contentProfile": {
            "videoType": "news",
            "evidence": {"title": "Prabowo Singgung Dandim dan Kapolres"},
        },
    }

    title = cliper_worker.seo_upload_title(moment, 1, payload)

    assert title == "Cek Dapur MBG Tanpa Panggil-Panggil"


def test_low_value_hook_template_is_replaced_by_grounded_spoken_phrase():
    payload = {
        "_contentProfile": {
            "videoType": "news",
            "evidence": {"title": "Prabowo Singgung Dandim dan Kapolres"},
        },
    }
    moment = {
        "hook": "Kenapa Kepala Desa Boleh Jadi Pembahasan Utama",
        "titleSuggestion": "Cek Dapur MBG Tanpa Panggil-Panggil",
        "transcript": (
            "Kepala desa boleh memeriksa semua dapur MBG. "
            "Laporkan ke Kepala BGN kalau perlu lapor langsung ke saya."
        ),
        "score": 77,
    }

    refined = cliper_worker.apply_title_hook_diversity([moment], payload)[0]

    assert "pembahasan utama" not in refined["hook"].lower()
    assert "dapur" in refined["hook"].lower() or "bgn" in refined["hook"].lower()


def test_partial_caption_cue_does_not_leak_unspoken_payoff_into_clip():
    transcript = [{
        "start": 254.19,
        "end": 270.47,
        "text": "Tapi kita mengerti banyak yang menyusup ke MBG untuk jadi maling di situ.",
    }]

    text = cliper_worker.transcript_text_between(transcript, 180.12, 255.12)
    captions = cliper_worker.normalized_caption_segments_for_clip(
        {"start": 180.12},
        transcript,
        75.0,
        {"subtitleLeadSeconds": 0.08},
    )

    assert "maling" not in text.lower()
    assert captions
    assert "maling" not in captions[0][2].lower()


def test_story_boundary_preserves_natural_start_by_shortening_end():
    transcript = [
        {"start": 180.0, "end": 250.0, "text": "Pidato membahas harapan rakyat dan program makan bergizi."},
        {
            "start": 254.19,
            "end": 270.47,
            "text": "Banyak yang menyusup ke MBG untuk jadi maling di situ.",
        },
    ]

    start, end, text = story_engine.extend_story_boundary(
        transcript,
        180.12,
        255.12,
        min_duration=25,
        target_duration=55,
        max_duration=75,
        ending_buffer=0,
    )

    assert start == 180.0
    assert end == 250.0
    assert round(end - start, 2) == 70
    assert "harapan rakyat" in text.lower()
    assert "maling" not in text.lower()

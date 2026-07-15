from worker.highlight_engine import evidence_metrics, generate_highlight_candidates, score_highlight


def test_highlight_scores_are_evidence_based_and_deterministic():
    strong = (
        "Kenapa strategi ini gagal? Saya ditolak, rugi, dan hampir menyerah. "
        "Tapi akhirnya ditemukan solusi, hasilnya penjualan naik tiga kali lipat!"
    )
    weak = "Kita sedang rekaman lalu ngobrol biasa dan belum ada kesimpulan"

    strong_score = score_highlight(evidence_metrics(strong, 45))
    weak_score = score_highlight(evidence_metrics(weak, 45))

    assert strong_score > weak_score
    assert strong_score < 99


def test_candidate_generation_is_repeatable_without_fake_99_scores():
    transcript = []
    for index in range(90):
        topic = "strategi bisnis akhirnya berhasil" if index < 45 else "cerita keluarga konflik akhirnya berdamai"
        transcript.append({
            "start": index * 5.0,
            "end": index * 5.0 + 4.2,
            "text": f"{topic} bagian {index}.",
            "speaker_id": "A" if index % 2 == 0 else "B",
        })

    config = {"min_candidates": 8, "max_candidates": 20}
    first = generate_highlight_candidates(transcript, metadata={"duration": 450}, config=config)
    second = generate_highlight_candidates(transcript, metadata={"duration": 450}, config=config)

    assert [(item["start"], item["end"], item["score"]) for item in first] == [
        (item["start"], item["end"], item["score"]) for item in second
    ]
    assert first
    assert max(item["score"] for item in first) <= 97

from worker.speaker_engine import SpeakerEngine


def test_pronouns_do_not_invent_speaker_identities():
    transcript = [
        {"start": 0, "end": 1, "text": "Aku sudah bilang ke kamu"},
        {"start": 1, "end": 2, "text": "Kamu kemudian menjawab saya"},
    ]

    result = SpeakerEngine().assign_transcript_speakers(transcript)

    assert all("speaker_id" not in item for item in result)
    assert [item["speaker_verified"] for item in result] == [False, False]


def test_explicit_diarization_labels_are_preserved():
    transcript = [
        {"speaker_id": "HOST", "text": "Selamat datang"},
        {"speaker": "GUEST", "text": "Terima kasih"},
    ]

    result = SpeakerEngine().assign_transcript_speakers(transcript)

    assert [item["speaker_id"] for item in result] == ["HOST", "GUEST"]
    assert all(item["speaker_verified"] for item in result)

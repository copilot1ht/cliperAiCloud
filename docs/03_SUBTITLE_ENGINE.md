CLIPER STUDIO PLUS V3.1 - SUBTITLE ENGINE SPECIFICATION

OVERVIEW
========
Subtitle engine manages text synchronization and speaker identification with forced alignment.

KEY FEATURES
============
1. Forced alignment support using librosa + torchaudio (Wav2Vec2)
2. Speaker identification from transcript
3. Emotion and importance scoring
4. Sentence boundary detection

FORCED ALIGNMENT
================
Forced alignment ensures subtitle timing matches audio precisely.

Input:
- Audio waveform
- Text transcript

Output:
- start_offset, end_offset, confidence per word/segment

Alignment Score:
- 0.0-0.3: Poor (manual review needed)
- 0.3-0.6: Acceptable (minor adjustments)
- 0.6-0.8: Good (minor refinement)
- 0.8-1.0: Excellent (production ready)

Alignment confidence boosts final highlight score by +3 if > 0.7.

SPEAKER IDENTIFICATION
======================
Rules (case-insensitive):
- First-person (gue/gua/aku/saya/kami/kita) -> Speaker A
- Second-person (lo/lu/kamu/anda/dia/mereka) -> Speaker B
- Neutral/unclear -> Previous speaker (inheritance)

EMOTION DETECTION
=================
Keywords with confidence scores:
- kaget: 0.8, marah: 0.9, sedih: 0.7
- lucu: 0.6, gila: 0.85, wah: 0.5
- ngakak: 0.85, ketawa: 0.75, tertawa: 0.75
- frustasi: 0.85, puas: 0.6, terkejut: 0.8
- terharu: 0.75

Score: max detected emotion confidence + 0.3 (neutral base)

IMPORTANCE SCORING
==================
Focus keywords boost importance:
- jadi, karena, ternyata, akhirnya, penting, masalah, jawaban
- berarti, makanya, sebabnya, alhasil, intinya

Importance = (focus_words / total_words) * 1.5 + 0.35

CONFLICT DETECTION
==================
Keywords indicating conflict:
- masalah, konflik, berantem, bentrok, sengketa
- perselisihan, perbedaan, ketidaksepakatan, debat
- tertuduh, tersangka, tertangkap, terbongkar

Conflict bonus: +15 to importance score if detected

SUBTITLE TIMING
===============
Optimal timing:
- Lead: 0.14 seconds before speech starts
- Duration: Min 0.5s, Max 5.0s per subtitle
- Pause: 0.3s between subtitles

SILENT GAP HANDLING
===================
- Silent gaps >= 0.3s handled automatically
- Split subtitles at gap boundaries
- Minimum duration per subtitle: 0.5s

TESTING
-------
pytest tests/

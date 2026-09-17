# Cliper Studio Plus v1.14.4

Subtitle karaoke sync restoration release.

## What Changed

- Removed the superseded subtitle branch that could render music captions as full-line-only subtitles.
- Restored word-by-word karaoke highlights for music, speech, and sparse intro captions when word timestamps are available.
- Kept conservative word timing: active highlights end at acoustic word boundaries, with neutral hold text during pauses.
- Renamed the subtitle engine metadata to `subtitle_engine_v4_word_sync` to match the actual behavior.
- Wallet, API keys, editing modes, cloud contracts, and production billing flows are unchanged.

## Validation

- `python -m pytest tests/test_subtitle_validation.py tests/test_subtitle_engine.py tests/test_content_profile.py -q`
- Result: 54 passed.

## Artifacts

- `Cliper-Studio-Plus-Setup-1.14.4.exe`
- `Cliper-Studio-Plus-Portable-1.14.4.exe`
- `SHA256SUMS.txt`

The Windows executables are not Authenticode-signed because a code-signing certificate is not configured for this release.

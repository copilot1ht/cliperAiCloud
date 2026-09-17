# Cliper Studio Plus v1.14.3

## Highlights

- Fixes music subtitle sync by using stable phrase timing instead of unreliable word-by-word karaoke timing when Whisper confidence is low.
- Detects music uploads from metadata such as the `YOU MUSIK` channel, even when the title does not explicitly say "lagu" or "music".
- Keeps v1.14.2 strict word-sync behavior for spoken-word content.
- Prevents sparse song intros from failing subtitle validation when phrase-sync is the correct mode.

## Validation

- The provided YouTube link `jS2S2PsMeuM` rendered a valid 12-second 720x1280 sample.
- The sample subtitle validation passed with `timing_mode=phrase`, 100% coverage, and no ASS `Word` events.
- Focused subtitle/content-profile QA passed with 54 tests.

## Windows Artifacts

- `Cliper-Studio-Plus-Setup-1.14.3.exe`
- `Cliper-Studio-Plus-Portable-1.14.3.exe`
- `latest.yml` and installer blockmap for updater clients
- `SHA256SUMS.txt` for integrity verification

The Windows executables are not Authenticode-signed because a code-signing certificate is not configured for this release.

# Cliper Studio Plus v1.14.1

## Highlights

- Renames the Summary mode UI to `Rangkuman / Highlight Video`.
- Keeps the internal content mode ID as `summary` for compatibility.
- Improves Summary planning so long videos can become one final composed highlight video from multiple source timestamps.
- Adds better story-map scoring, filler suppression, deduplication, chronological continuity, and subtitle rebase metadata.
- Keeps Auto, Podcast, Gaming, Landscape, Cliper Pro quota, wallet fallback, device lease, and billing flows unchanged.

## Validation

- `npm run qa` passed with 325 tests.
- Summary multi-segment render smoke passed ffprobe with valid video and audio streams.
- Real media composition smoke used a 596.46s Big Buck Bunny source and produced a valid 100s composed summary.

## Windows Artifacts

- `Cliper-Studio-Plus-Setup-1.14.1.exe`
- `Cliper-Studio-Plus-Portable-1.14.1.exe`
- `latest.yml` and installer blockmap for updater clients
- `SHA256SUMS.txt` for integrity verification

The Windows executables are not Authenticode-signed because a code-signing certificate is not configured for this release.

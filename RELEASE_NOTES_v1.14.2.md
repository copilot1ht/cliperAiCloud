# Cliper Studio Plus v1.14.2

## Highlights

- Fixes burned-in subtitle timing so word highlights follow the exact spoken word timestamps.
- Keeps phrase-level subtitle padding for readability without shifting the active word sync.
- Holds completed words neutrally during pauses, so captions stay readable while the next highlighted word waits for the real audio timestamp.
- Keeps v1.14.1 Summary/Highlight composition behavior unchanged.

## Validation

- Focused subtitle QA passed with 31 tests.
- Full `npm run qa` passed with 326 tests.
- Windows Electron build passed for Setup and Portable artifacts.

## Windows Artifacts

- `Cliper-Studio-Plus-Setup-1.14.2.exe`
- `Cliper-Studio-Plus-Portable-1.14.2.exe`
- `latest.yml` and installer blockmap for updater clients
- `SHA256SUMS.txt` for integrity verification

The Windows executables are not Authenticode-signed because a code-signing certificate is not configured for this release.

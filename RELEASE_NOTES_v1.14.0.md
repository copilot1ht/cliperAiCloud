# Cliper Studio Plus v1.14.0

## Highlights

- Adds the Cliper Pro entitlement flow for users who have completed at least one successful wallet top-up.
- Keeps the Cloud Key stable during upgrades; keys only rotate through an explicit security action.
- Uses the included Pro daily quota first, then falls back to wallet balance when the daily quota is exhausted.
- Blocks new provider work before cost is incurred when both included quota and wallet balance are unavailable.
- Adds safe content-mode metadata for Smart Summary and Landscape weekly-trial policy without sending local paths, media, transcripts, or source URLs to Cloud billing.
- Preserves local-only Landscape and re-render work as no-charge operations.

## Limits And Safety

- Pro Annual: Rp100.000 for 365 days.
- Included AI usage: 5 jobs per Jakarta day.
- Monthly usage: 60-job telemetry indicator; it does not override the daily billing decision.
- Maximum concurrent Generate job: 1 per user.
- Maximum Pro devices: 2.

## Validation

- Cloud: typecheck, 164 tests, production audit, and 48-page web build passed.
- Studio: 324 tests and Windows installer build passed.
- Production database backup and restore catalog were verified before migration.
- Railway API live/ready checks and Vercel web production checks passed.

## Windows Artifacts

- `Cliper-Studio-Plus-Setup-1.14.0.exe`
- `Cliper-Studio-Plus-Portable-1.14.0.exe`
- `latest.yml` and installer blockmap for updater clients
- `SHA256SUMS.txt` for integrity verification

The Windows executables are not Authenticode-signed because a code-signing certificate is not configured for this release.

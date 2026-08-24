# Pre-deploy USD Wallet Audit - 2026-08-11

## Scope

This audit records the local change that replaces score/credit based job
charging with one USD wallet per account. It does not deploy or mutate Railway,
Vercel, PostgreSQL production data, payment settings, or provider settings.

## Implemented contracts

- User and Electron surfaces use USD balance only. Database micro-USD storage
  remains an internal precision detail.
- A job reserves a per-job protected cost estimate plus configurable headroom,
  settles only a usable result, and releases the remainder on completion,
  failure, or expiry. The maximum job charge remains a safety ceiling only.
- A USD 1.00 balance keeps an active key connected and can start any job whose
  estimated reservation fits the spendable wallet. The server remains
  authoritative for the final decision.
- Score tiers no longer change a member charge. Admin pricing is shown in IDR
  and has a hard 50 percent minimum gross-margin floor.
- Desktop connection validation uses signed session and wallet endpoints; it
  no longer makes a paid AI completion merely to test connectivity.
- API key creation, activation, device validation, refresh, and heartbeat do
  not inspect wallet balance. The server evaluates a specific paid operation
  only when it creates that operation's reservation.
- The local worker retries transient TLS, timeout, reset, and thumbnail/
  subtitle fetch failures with bounded backoff. Cache is retained and a final
  network error is actionable.

## Local verification

- Desktop QA: 175 passed.
- Focused worker/network/subtitle tests: 34 passed.
- Billing tests: 13 passed in 2 files.
- API tests: 135 passed in 28 files.
- Web tests: 5 passed in 3 files.
- Prisma schema validation, Cloud typecheck, API production build, and Web
  production build passed.
- Electron Setup and Portable `1.11.1` built with SHA-256 manifests.

## Required pre-deploy gates

1. Review and apply the additive Prisma migrations
   `20260811234500_protected_usd_job_pricing` and
   `20260811235000_job_reservation_headroom` through the normal production
   deployment process. Do not reset the database.
2. Deploy the matching API and Web revision together. A deployed API using the
   old maximum-reservation contract can still reject a USD 1.00 wallet.
3. Install or run the `1.11.1` desktop build, then activate an API key and
   verify the wallet summary shows USD and permits a capped job reservation.
4. Run one real local video analysis and a batch render. Validate streams,
   subtitles, watermark, camera safety, and isolated failures before calling
   the build stable.
5. Perform one authorized payment settlement and confirm the verified webhook
   credits the USD wallet exactly once.
6. Obtain an Authenticode certificate before public distribution. The local
   Setup and Portable build are checksum-verified but not Authenticode-signed.

## Local release

`dist/release/Cliper-Studio-Plus-1.11.1/`

The directory contains Setup, Portable, SHA-256 checksums, blockmap, and
release notes. It is a locally verified release candidate until all pre-deploy
gates above are completed.

# Copilot Integration Audit - 2026-07-20

## Release Decision

**Local/staging trial: READY**

**Public production: NOT READY**

The desktop and cloud projects compile and their automated test suites pass. The local web/API control plane is usable for the next trial. Public production remains blocked by missing AI-provider configuration, unavailable Redis, memory-backed provider administration, and an unverified public Midtrans settlement flow.

## Corrections Applied

- Restored the gateway-key boundary: member keys are always Cliper AI Cloud keys. Upstream DeepSeek, Gemini, OpenAI, Qwen, or Claude selection remains an admin AI Router responsibility.
- Removed the random QRIS amount suffix. Midtrans receives the exact amount entered by the user and credits cannot change because of a generated suffix.
- Restored the Rp25,000 IDR top-up minimum and removed the unrelated USD-derived minimum.
- Made Midtrans status reconciliation safe while a new Snap token is not yet visible to the Status API. A provider 404 remains pending and never credits the wallet.
- Fixed Nest dependency injection under the local `tsx watch` runtime.
- Fixed bootstrap-admin lookup so an authenticated admin can generate, verify, list, and revoke a Cliper API key.
- Migrated managed accounts, web sessions, member API keys, and device bindings from process memory to PostgreSQL.
- Added Argon2id password storage, audited admin password reset, and automatic session revocation.
- Added an investor role whose admin access is read-only at the backend guard, independent of the UI.
- Added an internal unlimited-credit entitlement without disabling provider-cost safety limits.
- Added patched workspace overrides for known production dependency advisories.
- Updated desktop installer SHA-256 checksums after the verified build.

## Verified Results

### Desktop Electron

- Python tests: 44 passed.
- JavaScript/Python syntax QA: passed.
- Production build: passed.
- NSIS installer and portable executable generated.
- Production dependency audit: no high-severity finding.
- Latest available rendered session passed the production-output validator (requested 1, valid 1, output 1).

### Cliper AI Cloud

- TypeScript typecheck: passed for all workspace packages.
- Unit/integration tests: 93 passed across API, AI Router, Billing, Security, and Web packages.
- Next.js and NestJS production build: passed.
- Prisma schema validation: passed.
- Production dependency audit: no known moderate-or-higher vulnerability after overrides.
- HTTP route smoke: login, member, and admin routes returned successfully.
- Real local API-key lifecycle: generate, verify, revoke, and reject-after-revoke passed.
- PostgreSQL account storage: full admin, read-only investor, unlimited internal member, and zero-credit normal member passed runtime role checks.
- Session persistence: an authenticated member session remained valid after the API watcher replaced the backend process.
- Investor authorization: admin monitoring returned HTTP 200 while a mutation returned HTTP 403.
- Credential source scan: no seeded account email or plaintext password is present in tracked source files.

### Midtrans Sandbox

- Real Sandbox Snap transaction creation: passed.
- Requested amount: exactly Rp25,000.
- Sandbox checkout URL/token: created.
- Invoice persistence in PostgreSQL: passed.
- Status sync before checkout activation: remains pending, accepted, and not credited.
- Settlement/webhook/duplicate-webhook wallet credit: not tested in this audit because no Sandbox payment was simulated.

## Production Blockers

1. No AI provider is active. At least one encrypted provider key and a healthy task route are required.
2. Redis is configured but unreachable. Production must fail closed when rate limiting, distributed locks, or queues cannot use Redis.
3. Provider administration still contains memory-backed state and must be moved to PostgreSQL before public launch.
4. The Vercel project is not linked to this local checkout and has no verified production deployment from the audited commit.
5. The public Railway API, Midtrans webhook, signature verification, settlement, idempotency, and wallet credit flow still need one end-to-end Sandbox run.
6. Visual browser QA was unavailable in this session. Route-level HTTP checks passed, but desktop/mobile screenshots still need review before release.

## Required Release Gate

1. Configure PostgreSQL and Redis on Railway and verify `/health/ready` returns `ok: true`.
2. Configure one AI provider, test every task route, then verify fallback behavior with the primary provider intentionally disabled.
3. Persist provider state in PostgreSQL and prove provider configuration survives an API restart.
4. Deploy the audited commit to Railway and Vercel with correct origins and `CLIPER_API_URL`.
5. Run one Midtrans Sandbox QRIS settlement, replay its webhook, and confirm the wallet is credited exactly once.
6. Run desktop-to-cloud verification using a generated `clip_sk_...` key against the deployed API.
7. Repeat production builds and publish only artifacts whose hashes match `SHA256SUMS.txt`.

Do not label the release production-ready until every release-gate item has evidence in logs or automated tests.

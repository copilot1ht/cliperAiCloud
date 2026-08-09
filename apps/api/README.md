# Cliper Cloud API

NestJS API deployed to Railway from the repository root with `Dockerfile.api`.
The production liveness endpoint is `/health/live`; readiness is `/health/ready`.

Required Railway environment variables and bootstrap commands are documented in
[`../../docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md).

Midtrans Production credentials are accepted only by the API service. Configure
them first through Railway Variables, then optionally rotate them through
**Admin > Settings > Payment Settings** after the database migration has run.
The full callback and credential-handling procedure is in
[`../../docs/MIDTRANS_SETUP.md`](../../docs/MIDTRANS_SETUP.md).

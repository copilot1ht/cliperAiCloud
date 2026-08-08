# Backup and Railway Migration

Cliper AI Cloud stores its control plane in PostgreSQL. Video files, Faster-Whisper data, FFmpeg work, and rendered MP4 files remain on the user's desktop and are not part of a Cloud backup.

## Admin Backup

Open **Admin -> Backup & migration** and create an encrypted backup with a unique passphrase of at least 14 characters.

The downloaded JSON file is encrypted with AES-256-GCM and a per-backup scrypt key. Keep the file and passphrase separately. The archive contains the account control plane, API-key hashes, licenses, wallet and credit ledger, usage, providers' encrypted key bundles, routing, pricing, invoices, payments, and audit records.

The archive intentionally excludes browser sessions, desktop sessions/signing secrets, password-reset tokens, Railway variables, Midtrans credentials, Resend credentials, and diagnostic logs. A backup does not expose raw `clip_sk_` values or raw provider keys.

## Moving to Another Railway Account

1. Provision PostgreSQL and the `@cliper/api` service in the new Railway project.
2. Deploy the same canonical Cliper AI Cloud source and run Prisma migrations.
3. Configure all production environment variables manually in the new Railway project.
4. Keep the same `LICENSE_KEY_PEPPER` if active `clip_sk_` API keys must remain valid.
5. Keep the same `PROVIDER_ENCRYPTION_KEY` if existing provider key bundles must remain readable. Otherwise, restore the database and configure each provider key again from Admin -> Providers.
6. Sign in as an administrator, open **Backup & migration**, upload the archive, inspect it, and verify the table counts.
7. Restore only into a fresh target database or a database intentionally being replaced. Type `RESTORE ALL DATA` exactly to confirm.
8. All browser and desktop sessions are invalidated by restore. Sign in again, verify providers, test one controlled Gateway request, and then point Vercel/Electron to the new API domain.

Never copy Midtrans, email, Railway, or provider secrets inside the backup. Set fresh values in Railway Variables. Rotate any credential that has been shared in a chat, screenshot, repository, or log.

## Midtrans URLs

For the current Snap/Core QRIS integration, copy these values from **Admin -> Backup & migration** after production domains are set:

- Finish Redirect URL: `https://www.cliperaicloud.online/billing`
- Notification URL: `https://api.cliperaicloud.online/api/payments/webhook/midtrans`

Do not configure a BI-SNAP notification URL unless a separate BI-SNAP integration has been implemented. The current payment engine uses the verified Snap/Core webhook above.

## Restore Safety

The API checks the archive format, encryption tag, row limit, and passphrase before writing. Restore runs in one PostgreSQL transaction. If any row fails validation, the database transaction rolls back rather than leaving partial data.

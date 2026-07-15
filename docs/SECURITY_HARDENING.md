# Security Hardening

## Desktop trust flow

1. Desktop mengaktifkan `clip_sk_*` melalui `/api/auth/desktop/activate`.
2. Server mengikat license ke fingerprint perangkat dan menerbitkan access token, refresh token, serta signing secret.
3. Setiap request AI memakai timestamp, nonce, SHA-256 body, dan HMAC-SHA256.
4. Server menolak timestamp di luar 60 detik dan nonce yang dipakai ulang.
5. Response AI memiliki checksum dan HMAC yang diverifikasi desktop sebelum dipakai.

Access token berlaku 15 menit, refresh token 30 hari, dan heartbeat dikirim setiap 15 menit. Nilai dapat diubah melalui environment variables yang terdokumentasi di `.env.example`.

## Secret handling

- API key provider hanya disimpan di server dengan AES-256-GCM.
- Key Cliper desktop disimpan menggunakan Electron `safeStorage`; `localStorage` dan `config.json` tidak menyimpan plaintext.
- Log HTTP hanya memuat request ID, method, path, status, dan latency. Prompt, token, key, dan response AI tidak dicatat.
- Mode production menolak direct API-key gateway secara default. Aktifkan `ALLOW_LEGACY_API_KEY_AUTH` hanya untuk migrasi terkontrol.

## Operations

Jalankan backup harian dari scheduler host:

```powershell
pnpm exec powershell -File scripts/backup-postgres.ps1
```

Backup memerlukan `DATABASE_URL` dan PostgreSQL client `pg_dump`. Uji restore secara berkala; keberadaan file backup saja bukan bukti restore berhasil.

## Remaining deployment controls

- Gunakan TLS dari reverse proxy dan jangan mengekspos port database/Redis ke internet.
- Ganti seluruh development secret sebelum production.
- Jalankan PostgreSQL, Redis, dan object storage yang persisten.
- Tambahkan secret manager serta rotasi key pada platform deployment.
- Hubungkan alert untuk security event critical, provider outage, dan saldo provider rendah.

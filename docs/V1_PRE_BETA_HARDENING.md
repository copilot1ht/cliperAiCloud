# V1 Pre-Beta Hardening Audit

Tanggal: 14 Juli 2026

Status: **layak untuk pengujian lokal terbatas, belum layak public production**.

## Terverifikasi

- Desktop mengaktifkan `clip_sk_*` menjadi access token singkat dan rotating refresh token.
- Device fingerprint terikat ke license dan token lama ditolak setelah refresh.
- Request desktop memiliki timestamp, nonce, checksum, dan HMAC-SHA256.
- Replay nonce dalam jendela 60 detik ditolak dan dicatat sebagai security event critical.
- Response AI memiliki checksum/signature dan diverifikasi oleh worker Python.
- Desktop heartbeat berjalan setiap 15 menit setelah aktivasi.
- Electron menyimpan key dengan OS `safeStorage`; konfigurasi plaintext lama dimigrasikan.
- Provider secret server dienkripsi AES-256-GCM dan tidak dikirim ke browser/member.
- Starter/Pro/Enterprise memiliki rate limit server-side.
- Credit direservasi sebelum provider call, diselesaikan setelah sukses, dan dilepas saat gagal.
- Member Usage berasal dari account sendiri dan tidak mengekspos provider cost/markup.
- Browser auth memakai cookie HttpOnly + SameSite dan origin check untuk request mutasi.
- Admin memiliki halaman System Health dan Security dengan data runtime nyata.
- Structured request log berisi request ID, method, path, status, dan latency tanpa prompt/key.
- Build web menghasilkan semua route admin/member dan smoke HTTP mengembalikan 200.

## Hasil pengujian lokal

- Cloud suite: 34 test API, 5 security, 5 router, 4 billing, dan 3 web lulus.
- Desktop/worker Python: 32 test lulus.
- Signed session integration: activation, refresh rotation, heartbeat, gateway, worker Python, response integrity, anti-replay, dan scoped usage lulus.
- Route smoke: 8 admin route dan 3 member route lulus.
- Provider failover unit test lulus; integration memakai provider mock lokal tanpa biaya.

Jumlah test mengikuti output suite saat audit dan dapat berubah ketika suite ditambah.

## Release blocker

1. Runtime identity, license, session, usage, provider config, dan security events masih memory-backed.
2. Migration Prisma sudah tersedia tetapi belum diaplikasikan dan diuji pada PostgreSQL workstation ini.
3. Rate limit dan nonce store belum terdistribusi melalui Redis.
4. TLS 1.3/HSTS production baru dapat divalidasi setelah reverse proxy/domain tersedia.
5. Object storage, signed URL, upload MIME/checksum/virus scan belum termasuk vertical slice saat ini.
6. Payment webhook, invoice reconciliation, refund idempotency, pajak, dan legal pages belum terhubung.
7. Desktop signed update manifest dan mandatory critical update belum diterapkan.
8. Backup script tersedia, tetapi backup 24 jam dan restore drill belum dijalankan karena PostgreSQL client/service belum tersedia.
9. Admin 2FA, IP reputation, brute-force distributed protection, KMS, SAST/DAST, penetration test, dan load test belum selesai.
10. Visual browser automation tidak tersedia pada sesi audit ini; route dan build tervalidasi, tetapi screenshot responsif perlu diuji pada browser target.

## Keputusan

Jangan gunakan label **production-ready** atau membuka public beta sebelum seluruh blocker kritis di atas selesai. Build saat ini sesuai untuk melanjutkan integrasi PostgreSQL/Redis dan uji desktop lokal dengan user terbatas.

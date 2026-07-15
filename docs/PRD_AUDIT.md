# Audit PRD Cliper AI Cloud

Tanggal audit: 12 Juli 2026

## Keputusan

PRD layak dijadikan arah produk, tetapi implementasinya perlu dibuat sebagai vertical slice agar tidak menghasilkan ratusan file kosong.

### Dipertahankan

- Cloud menjadi satu-satunya pemilik provider API key.
- Desktop hanya menyimpan Cliper key dan Gateway URL.
- Router bekerja per modul, memiliki health check, fallback, usage, cost, dan markup.
- PostgreSQL, Redis, Prisma, BullMQ, Docker, audit log, device binding, serta role-based access tetap menjadi target production.

### Disederhanakan

- Landing, client portal, dan admin portal memakai satu aplikasi Next.js dengan route berbeda. Ini menghindari tiga implementasi auth, layout, dan design system.
- Gateway sinkron dibuat terlebih dahulu. BullMQ dipakai nanti untuk pekerjaan asinkron seperti laporan, billing reconciliation, health sweep, dan webhook retry; chat completion tidak perlu selalu masuk queue.
- Desktop belum dipindah ke monorepo. Pemindahan dilakukan setelah build parity agar release Electron yang stabil tidak rusak.

### Koreksi keamanan

- Provider key tidak boleh berada pada variable `NEXT_PUBLIC_*` atau bundle Electron.
- Key user disimpan sebagai hash; raw key hanya ditampilkan sekali saat dibuat.
- Provider key disimpan terenkripsi dengan key management di luar database.
- Harga provider tidak di-hardcode sebagai kebenaran. Nilai cost harus dikonfigurasi admin dan diperbarui ketika provider mengubah harga.
- Endpoint admin memerlukan autentikasi terpisah, audit log, rate limit, dan 2FA sebelum public launch.

## Scope vertical slice

1. Web operations dashboard untuk client dan admin.
2. OpenAI-compatible gateway `POST /v1/chat/completions`.
3. Router DeepSeek + Gemini dengan multi-key rotation dan provider fallback.
4. Generic provider config agar OpenAI-compatible provider lain dapat ditambahkan.
5. Cliper key validation, provider health, usage, provider cost, billed cost, dan margin.
6. Prisma schema production dan local Docker services.
7. Shared contracts dan desktop SDK.

## Belum boleh diklaim production-ready

- Auth email/password, refresh token rotation, admin 2FA.
- Payment gateway dan webhook reconciliation.
- Database-backed key issuance/revocation pada runtime.
- Redis distributed rate limiting dan queue worker.
- Secret manager/KMS, TLS deployment, backup restore, observability, penetration test, dan load test.
- Terms, privacy policy, tax, refund, dan provider resale/commercial terms.

Status saat ini harus disebut **foundation / private alpha**, bukan public production.

## Validasi lanjutan 12 Juli 2026

- Status gateway web sekarang berasal dari `/health/ready`, bukan label statis.
- UI sample metrics dan example key diberi label jelas agar tidak dianggap data nyata.
- API memuat `.env` secara otomatis.
- Production config gagal start bila secret/infrastructure/provider belum aman.
- Desktop tidak dapat memilih model di luar kebijakan server secara default.
- Batas output token dipaksakan per module untuk mencegah pembengkakan biaya.
- Prompt berukuran berlebihan ditolak sebelum diteruskan ke provider.
- Runtime report hanya menampilkan jumlah key, tidak pernah nilai key.

Urutan pengembangan dan release gate tersedia di `docs/DEVELOPMENT_PLAN.md`.

## SaaS flow foundation

- User dan admin memakai satu route `/login`; role ditentukan server dari akun, bukan pilihan UI.
- Dashboard member tidak lagi menampilkan menu admin.
- API key menggunakan format `clip_sk_*`; raw key hanya untuk user, server menyimpan hash.
- `/api/auth/verify` menjadi kontrak aktivasi desktop.
- Starter dan Pro menggunakan routing policy berbeda dari server.
- Plan dari payload desktop tidak dipercaya.
- Service balance disebut Cliper Credits; provider tetap dihitung memakai raw input/output tokens.
- Session family, plan, credit ledger, payment transaction, provider log, dan routing per plan sudah tersedia di Prisma schema.

Login/registration private-alpha sudah berfungsi dengan Argon2id dan memory session. Akun admin bootstrap berasal dari hash `.env`, sedangkan pendaftaran lain selalu menjadi member. Production tetap menolak development auth dan menunggu migration PostgreSQL serta database-backed session pada Phase 1.

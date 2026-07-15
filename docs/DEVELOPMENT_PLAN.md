# Cliper AI Cloud Development Plan

Status saat ini: **Private Alpha Foundation**  
Target berikutnya: **Internal Alpha dengan database-backed identity dan licensing**

## Hardening yang sudah masuk (14 Juli 2026)

- Signed desktop session, rotating refresh token, device binding, heartbeat, HMAC, dan anti-replay.
- Signed response diverifikasi oleh SDK/worker Python.
- Electron OS secure storage serta penghapusan key dari browser local storage.
- AES-256-GCM provider secret, account-scoped usage, rate limit per plan.
- HttpOnly session cookie, SameSite, origin-based CSRF guard, HSTS production, dan structured request log.
- Admin System Health/Security, reusable integration QA, dan PostgreSQL backup script.

Implementasi ini masih memory-backed. Ia memperkuat kontrak dan alur lokal, tetapi tidak menggantikan pekerjaan database/Redis pada Phase 1-2.

## Arah arsitektur

Repository tetap berisi dua produk dengan batas yang jelas:

```text
Cliper Ai Studio/
|-- Electron desktop                 aplikasi render lokal
`-- WEB PRODUCTION SAAS/             Cliper AI Cloud
    |-- apps/web                     client + admin portal
    |-- apps/api                     gateway dan control plane
    |-- packages/ai-router           routing provider
    |-- packages/contracts           kontrak lintas aplikasi
    |-- packages/sdk                 SDK desktop
    `-- prisma                       data model dan migrations
```

Jangan memindahkan Electron ke workspace Cloud sampai build parity, installer, worker path, cache, dan smoke render lulus pada struktur baru.

## Prinsip produk

1. Provider key hanya berada di server.
2. Desktop hanya mengenal Gateway URL dan satu Cliper key.
3. Model, batas token, routing, dan fallback ditentukan server.
4. Provider cost dan user billing dicatat sebagai dua nilai berbeda.
5. Ledger usage tidak diedit; koreksi menggunakan adjustment entry.
6. UI tidak boleh menampilkan data demo seolah-olah data production.
7. Setiap tahap hanya naik status setelah release gate lulus.

## Phase 1 - Identity, key, dan license (prioritas berikutnya)

Estimasi: 2-3 minggu.

- PostgreSQL migration pertama dan seed Super Admin.
- Register, login, email verification, forgot password.
- Argon2id password hashing.
- Short-lived access JWT dan rotating refresh token.
- RBAC: Super Admin, Admin, Support, Member.
- Database-backed Cliper API key issuance.
- Format raw key `clip_sk_*` dan server-side HMAC pepper.
- Raw key hanya ditampilkan satu kali; database menyimpan hash dan prefix.
- Revoke, expire, last-used, plan, dan device limit.
- Device binding serta admin revoke device.
- API guard membaca key dari database; `CLIPER_DEV_API_KEY` hanya untuk development.

Release gate:

- User A tidak dapat membaca resource User B.
- Key yang dicabut langsung ditolak.
- Raw key tidak ada di database, log, atau response berikutnya.
- Refresh token reuse terdeteksi dan seluruh token family dicabut.
- Audit log mencatat create/revoke key dan device.

## Phase 2 - Provider control plane

Estimasi: 2 minggu.

- Admin CRUD provider dan model.
- Envelope encryption untuk provider key dengan KMS/secret manager.
- Multi-key pool, quota state, cooldown, dan weighted rotation.
- Health sweep terjadwal melalui BullMQ.
- Circuit breaker berdasarkan error rate dan latency.
- Routing rules disimpan di database per module dan plan.
- Redis rate limiting per user, key, IP, dan module.
- Prompt/token budget server-side per plan.
- Request body dan prompt size limit yang konsisten pada gateway/proxy.

Release gate:

- Provider gagal otomatis berpindah tanpa duplikasi billing.
- Provider key tidak muncul di web bundle, Electron, error, atau log.
- Perubahan routing berlaku tanpa update desktop.
- Load test menunjukkan rate limit konsisten pada beberapa API instance.

## Phase 3 - Usage ledger dan billing

Estimasi: 2-3 minggu.

- Immutable request/usage ledger.
- Pricing snapshot per provider/model agar histori biaya tidak berubah.
- Credit reservation sebelum request dan settlement setelah response.
- Refund otomatis untuk request gagal.
- Plan, quota, top-up, subscription, invoice, dan payment webhook.
- Idempotency key untuk request AI dan webhook pembayaran.
- Admin profit report per provider, model, module, user, dan plan.

Formula minimum:

```text
provider_cost = input_cost + output_cost
service_cost  = provider_cost + compute + payment_fee + reserve
user_charge   = service_cost * (1 + markup)
gross_margin  = user_charge - service_cost
```

Mulai dengan target gross margin 30-40%, tetapi harga final harus mengikuti biaya nyata, pajak, kurs, payment fee, support, dan ketentuan komersial setiap provider.

Release gate:

- Tidak ada saldo negatif akibat request paralel.
- Webhook yang dikirim ulang tidak menggandakan saldo.
- Total ledger dapat direkonsiliasi dengan tagihan provider.
- Margin tidak dihitung dari angka hardcoded di frontend.

## Phase 4 - Integrasi desktop resmi

Estimasi: 1-2 minggu.

- Cliper Cloud menjadi preset utama, Custom AI tetap tersedia untuk developer.
- Aktivasi license dan device dari desktop.
- Secure local storage untuk Cliper key.
- Retry, timeout, idempotency, dan clear error message melalui Cloud SDK.
- Offline grace hanya untuk render lokal; fitur AI tetap membutuhkan server.
- Compatibility test pada installer, portable build, update, dan worker Python.

Release gate:

- Provider dapat diganti admin tanpa update desktop.
- Key revoke menghentikan request berikutnya tanpa merusak project lokal.
- API timeout tidak membuat Electron atau worker hang.
- Existing subtitle/render regression suite tetap lulus.

## Phase 5 - Security dan operations

Estimasi: 2 minggu.

- Admin TOTP 2FA dan step-up authentication untuk tindakan sensitif.
- TLS, secure headers, CSRF strategy, CORS allowlist, brute-force protection.
- Structured logs dengan request ID tanpa secret/prompt sensitif.
- Metrics, traces, alerts, provider SLO, queue dashboard.
- Automated PostgreSQL backup dan restore drill.
- Secret rotation runbook dan incident response.
- Dependency, container, SAST, DAST, dan penetration test.

Release gate:

- Restore backup berhasil pada environment kosong.
- Alert provider outage dan billing anomaly teruji.
- Tidak ada critical/high finding yang belum dimitigasi.
- Production deployment tidak memakai development API key.

## Phase 6 - Paid beta

Estimasi: 3-4 minggu observasi dengan pengguna terbatas.

- 20-50 pengguna undangan.
- Limit plan konservatif dan manual support.
- Pantau kualitas highlight/title/hook per provider.
- Ukur cost per completed clip, fallback rate, latency, dan refund rate.
- A/B routing hanya dengan consent dan batas biaya.

Target beta:

- Gateway success rate >= 99% termasuk recovered fallback.
- P95 latency sesuai module SLA.
- Billing discrepancy < 0.5%.
- Crash/corrupt render tidak meningkat dibanding desktop lokal.
- Support ticket dan provider cost masih sesuai unit economics.

## Phase 7 - Public launch

Public launch hanya setelah paid beta stabil, legal pages selesai, provider terms sudah diperiksa, payment reconciliation lulus, backup restore teruji, dan desktop updater tersedia.

## Prioritas 10 pekerjaan berikutnya

1. Jalankan PostgreSQL dan Redis lokal melalui Docker.
2. Terapkan dan uji migration awal `20260714_initial_cloud` pada PostgreSQL kosong.
3. Implementasikan database repository dan connection lifecycle pada API.
4. Implementasikan User/Auth/Session/RefreshToken schema.
5. Implementasikan database-backed API key issuance dan guard.
6. Migrasikan signed desktop session, nonce, heartbeat, dan security event ke repository persisten.
7. Migrasikan dashboard member yang sudah membaca API lokal dari memory service ke query database.
8. Implementasikan Redis rate limiting, nonce anti-replay, idempotency, dan provider cooldown.
9. Terapkan signed object storage serta desktop signed update manifest.
10. Jalankan restore drill, provider sandbox, load test, dan security test pada staging TLS.

## Yang sengaja ditunda

- Memindahkan Electron ke `apps/desktop`.
- Web video editor dan cloud rendering.
- Mobile application dan public API marketplace.
- Dukungan banyak payment provider sekaligus.
- Klaim kapasitas 100.000 request/hari sebelum load test nyata.

Penundaan ini menjaga fokus pada identity, keamanan key, billing yang benar, dan kualitas AI gateway sebagai sumber pendapatan utama.

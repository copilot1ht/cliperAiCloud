# Cliper AI Cloud V2 - Phase 1 Billing Trial

Tanggal uji: 16 Juli 2026

## Arsitektur yang diuji

Billing diterapkan per analysis job:

1. Desktop memeriksa saldo.
2. Server mereservasi maksimum biaya job.
3. Request AI dalam job hanya mencatat provider cost aktual.
4. Clip final dinilai per quality tier.
5. Server menghitung protected price dengan gross-margin formula.
6. Server melakukan satu settlement.
7. Sisa reservation dilepas.

User hanya melihat Cliper Credits. Provider cost, token, routing, dan margin tetap internal.

## Konfigurasi uji

- Credit value: Rp1 per credit
- Minimum gross margin: 50%
- Target gross margin: 60%
- Base analysis: 300 credits
- Optional clip: 50 credits
- Good clip: 100 credits
- Premium clip: 150 credits
- Maximum reservation: 2.000 credits
- PostgreSQL: temporary isolated cluster
- API billing storage: `postgres`

## Hasil

### Job berhasil

- Input score: `72, 80, 84, 91, 93`
- Reservation: 2.000 credits
- Final charge: 850 credits
- Reservation release: 1.150 credits
- Accepted clips: 5
- Duplicate completion: tidak memotong saldo lagi
- Database status: `COMPLETED`
- Ledger:
  - `AI_RESERVATION`
  - `AI_RESERVATION_RELEASE`
  - `AI_SETTLEMENT`

### Job gagal

- Reservation: 2.000 credits
- Final charge: 0 credits
- Reservation release: 2.000 credits
- Database status: `FAILED`

### Saldo tidak cukup

- Saldo tersedia: 1.500 credits
- Kebutuhan reservation: 2.000 credits
- Response: HTTP 402
- Code: `INSUFFICIENT_CREDITS`
- Analysis job tidak dibuat

### Usage provider atomik

Trial kedua dijalankan pada PostgreSQL 17 terisolasi setelah seluruh migration diterapkan.

- Provider request ID: `provider-usage-real-trial`
- Input tokens: 1.000
- Cached input tokens: 400
- Output tokens: 200
- Reasoning tokens: 50
- Provider cost: USD 0,00125 / Rp20
- Usage row tersimpan: 1
- Analysis job request count: 1
- Analysis job module: `highlight: 1`
- Retry count: 1
- Fallback count: 1
- Duplicate request ID: tidak membuat usage row atau biaya job kedua
- Admin/member usage summary membaca storage `postgres`

Penyimpanan usage dan penambahan accumulated provider cost dilakukan dalam satu
transaction serializable. `requestId` menjadi idempotency key.

## Validasi teknis

- Prisma schema: PASS
- Migration database kosong: PASS
- PostgreSQL reservation/settlement: PASS
- Immutable job ledger: PASS
- Idempotent completion: PASS
- Full reservation release on failure: PASS
- Insufficient balance guard: PASS
- Admin Revenue runtime: PASS
- API unit tests: 56 PASS
- Billing unit tests: 12 PASS
- AI Router unit tests: 8 PASS
- Desktop unit tests: 44 PASS
- Cloud monorepo typecheck/test/build: PASS
- Next.js production build: 44 routes PASS
- Electron syntax QA: PASS

## Batas fase 1

Uji ini membuktikan pricing, reservation, settlement, ledger, database migration,
usage persistence, cached/reasoning token accounting, dan idempotent job cost.
Provider AI eksternal nyata belum dipanggil karena belum ada provider aktif dengan
API key dan rate production yang valid pada environment staging.

Sebelum production:

1. Jalankan migration pada PostgreSQL staging.
2. Set `ANALYSIS_BILLING_STORAGE=postgres`.
3. Isi rate input/output provider aktif dengan nilai resmi.
4. Jalankan satu YouTube analysis melalui provider nyata.
5. Cocokkan usage provider, provider cost, job charge, wallet, dan Admin Revenue.
6. Uji dua job paralel pada user yang sama.
7. Migrasikan API key/license store dari memory ke PostgreSQL sebelum production.

Status saat ini: **Phase 1 staging ready**, belum production-ready. Jangan menyatakan
production-ready sebelum provider nyata, API key persistence, dan concurrency
staging lulus.

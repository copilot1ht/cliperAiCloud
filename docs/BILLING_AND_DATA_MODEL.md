# Billing and Data Model

## Pricing rule

Cliper AI Cloud memakai cost-based pricing. Admin mengatur target markup, bukan gross margin langsung.

```text
provider_cost = input_tokens × input_rate + output_tokens × output_rate
service_cost  = provider_cost + compute_cost + payment_fee + risk_reserve
user_charge   = max(service_cost, minimum_charge) × (1 + markup)
gross_profit  = user_charge - service_cost
credits       = ceil(user_charge / credit_value)
```

Markup dan gross margin berbeda. Service cost 100 dengan markup 50% menghasilkan user charge 150, gross profit 50, dan gross margin 33,33%.

Pricing policy menyimpan `markupBps`, `computeCostMicroUsd`, `paymentFeeBps`, `reserveBps`, `minimumChargeMicroUsd`, dan `microUsdPerCredit`. Perubahan policy hanya berlaku untuk request baru; histori production wajib menyimpan pricing snapshot pada setiap usage.

## Request lifecycle

1. API key di-resolve menjadi account dan plan server-side.
2. Gateway mengestimasi batas biaya lalu mereservasi credits.
3. AI Router memilih provider menurut module, plan, health, dan fallback.
4. Usage provider dihitung menjadi provider cost.
5. Pricing policy menghasilkan service cost, user charge, profit, dan debit credits.
6. Reservation diselesaikan secara atomik; request gagal melepaskan reservation.
7. Member menerima respons AI dan `credit_charge_micro` saja.
8. Admin dapat melihat provider cost, service cost, user charge, dan gross profit.

## Database tables

Migration awal membuat 20 tabel. Tabel bisnis inti:

- `users`, `sessions`, `plans`, `subscriptions`
- `user_credits`, `credit_transactions`
- `api_keys`, `licenses`, `devices`
- `providers`, `provider_prices`, `provider_logs`, `provider_usage`
- `pricing_policies`, `ai_routes`
- `payments`, `invoices`, `invoice_items`
- `audit_logs`, `system_logs`

Provider secrets disimpan sebagai encrypted bundle di server. Raw Cliper key hanya ditampilkan sekali; persistence production menyimpan hash dan prefix, bukan raw key.

## Current status

- Prisma schema: validated.
- Prisma Client: generated.
- Initial PostgreSQL migration: generated.
- Local pricing, credit reserve/settle/release, key ownership, and public billing boundary: implemented and unit tested.
- PostgreSQL runtime and Redis: not tested on this workstation because Docker/PostgreSQL is unavailable.
- API repositories: still memory-backed and must be migrated before public deployment.

Jangan menandai deployment sebagai production-ready sebelum migration diuji pada database kosong, concurrency test saldo lulus, webhook payment idempotent, dan backup/restore drill berhasil.

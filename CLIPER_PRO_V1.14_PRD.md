# Cliper Pro v1.14.0 Product Requirements Document

Status: PHASE 2 HARDENING IN PROGRESS - DEPLOYMENT GATED BY QA

Baseline production: Cliper Studio Plus v1.13.0

Target release: v1.14.0

Document scope: Cliper Studio Plus, Cliper AI Cloud API, Cliper AI Cloud Web, Admin, payment, wallet, device security, quota, and provider-cost protection.

## 1. Executive Summary

Cliper Pro adalah paket akses tahunan yang membuka seluruh fitur premium dan memberikan kuota Cloud AI. Paket ini tidak mengganti, menghapus, atau memalsukan saldo wallet user.

Urutan pembiayaan setiap Generate adalah:

```text
NO_CHARGE_LOCAL
  -> tidak memakai kuota Pro
  -> tidak memakai saldo

SUBSCRIPTION INCLUDED QUOTA
  -> dipakai lebih dahulu selama kuota harian tersedia
  -> kuota bulanan hanya telemetry fair-usage, bukan hard blocker
  -> saldo tidak dipotong

WALLET FALLBACK
  -> dipakai otomatis setelah limit Pro tercapai
  -> memakai saldo AVAILABLE wallet yang sudah ada
  -> hanya bila pengaturan fallback aktif dan saldo cukup

NO AVAILABLE FUNDING
  -> Generate ditolak sebelum provider dipanggil
  -> saldo tidak boleh minus
```

User baru tidak melihat menu Upgrade. Menu Upgrade baru muncul setelah akun memiliki minimal satu top-up sukses yang tidak direfund. Syarat ini wajib diperiksa frontend dan backend.

Dokumen ini mengunci rencana dan mencatat implementasi lokal Phase 1. Tidak ada commit, push, tag, release, atau deployment sampai hasil lokal direview dan disetujui secara eksplisit.

## 2. Goals

1. Menambahkan paket Cliper Pro Annual tanpa merusak wallet dan billing production.
2. Menjaga saldo lama user tetap utuh ketika upgrade aktif.
3. Memakai kuota Pro terlebih dahulu dan wallet sebagai cadangan otomatis.
4. Mencegah tagihan provider melebihi pendapatan paket.
5. Membatasi sharing akun dengan device binding dan generation lease.
6. Menjaga kompatibilitas Cliper Studio v1.13.x selama rollout Cloud v1.14.0.
7. Memberikan konfigurasi harga dan limit dari Cloud/Admin, bukan hardcode Electron.

## 3. Non-Goals

1. Tidak mengubah algoritma lima Content Mode v1.13.0.
2. Tidak merombak Story Engine, Smart Edit, Camera, Keyframe, atau Renderer.
3. Tidak membuat saldo palsu atau wallet unlimited.
4. Tidak menjanjikan unlimited provider usage.
5. Tidak mengaktifkan paket dari browser redirect tanpa webhook tervalidasi.
6. Tidak menghapus API key hanya karena user membeli paket.

## 4. Product Definition

### 4.1 Free / Wallet User

- Auto, Podcast, dan Gaming mengikuti kebijakan wallet existing.
- Smart Summary dan Landscape mendapat shared trial dua unique source per minggu.
- Setelah trial habis, mode premium terkunci dan menawarkan Upgrade.
- Cloud AI dibayar melalui wallet memakai reserve, settle, dan release existing.
- Saldo tidak pernah boleh negatif.

### 4.2 Cliper Pro Annual

Default awal, seluruh nilai wajib configurable dari Admin:

| Policy | Default |
| --- | ---: |
| Harga | Rp100.000 |
| Durasi | 365 hari |
| Included Cloud AI per hari | 5 logical jobs |
| Included Cloud AI per bulan | 60 logical jobs |
| Maksimum clip per job | 10 |
| Registered device | 2 |
| Concurrent AI Generate | 1 |
| Shared premium-source weekly limit | Tidak berlaku |
| Wallet fallback | Aktif secara default, dapat dimatikan user |

Nama pemasaran yang disarankan:

```text
Cliper Pro Annual
Cloud AI Fair Usage
```

Jangan menggunakan klaim `Unlimited AI`.

### 4.3 Benefits

- Semua Content Mode terbuka.
- Smart Summary dan Landscape tidak terkena free weekly trial limit.
- Story Engine dan Smart Editing premium.
- Natural keyframe dan active-speaker framing.
- Render dan re-render lokal tanpa quota AI.
- Maksimal dua perangkat terdaftar.
- Satu Cloud AI Generate aktif pada satu waktu.
- Update aplikasi selama entitlement aktif.
- Wallet tetap tersedia sebagai saldo cadangan.

## 5. Upgrade Eligibility

### 5.1 Eligibility Rule

User eligible bila terdapat minimal satu transaksi:

```text
purpose = TOPUP
status = PAID
paidAt != null
not refunded
not reversed
belongs to the current user
```

Transaksi upgrade bukan pengganti syarat top-up pertama.

### 5.2 Menu Visibility State

| Account state | Upgrade menu |
| --- | --- |
| Belum pernah top-up sukses | Hidden |
| Memiliki top-up sukses | Visible |
| Checkout Pro pending | Visible, tampilkan status pending |
| Pro active | Visible sebagai Pro Status |
| Pro expired | Visible sebagai Renew Pro |
| Pro revoked | Visible dengan status dan support action |

Frontend hanya mengatur tampilan. Backend tetap menolak checkout user yang tidak eligible dengan error code `UPGRADE_NOT_ELIGIBLE`.

### 5.3 Refund Edge Case

- Top-up yang sudah `REFUNDED` tidak memenuhi eligibility.
- Bila ada top-up paid lain, eligibility tetap aktif.
- Entitlement Pro yang sudah aktif tidak boleh hilang diam-diam hanya karena top-up lama direfund; tandai akun untuk risk review.
- Refund pembayaran Pro mengikuti kebijakan entitlement refund, bukan top-up eligibility.

## 6. Wallet and Token Policy

### 6.1 Wallet Balance

Saldo user tidak berubah ketika upgrade diaktifkan.

Contoh:

```text
Sebelum upgrade:
Saldo Rp35.000

Setelah upgrade:
Cliper Pro Active
Saldo cadangan Rp35.000
```

Wallet tetap menjadi durable financial ledger. Jangan mengubah balance menjadi nilai besar, null, atau unlimited.

Saldo yang memenuhi fallback adalah seluruh saldo wallet berstatus `AVAILABLE`, baik berasal dari top-up pertama maupun top-up berikutnya. Sistem tidak membuat kantong khusus bernama "saldo top-up pertama", tidak mewajibkan top-up baru setiap hari, dan tidak mereset saldo ketika kuota subscription direset.

### 6.2 Cloud Key and Session Token

- Cloud Key tetap menjadi kredensial autentikasi perangkat.
- Upgrade tidak membuat Cloud Key baru.
- Status Pro tidak ditanam permanen di key atau Electron.
- Cloud harus mengecek entitlement aktif pada saat policy refresh dan job authorization.
- Key rotation hanya dilakukan atas permintaan user, admin action, atau security event.
- Raw key hanya ditampilkan sekali dan backend menyimpan hash.

### 6.3 Expiry

Saat Pro berakhir:

- User tidak logout.
- Device dan Cloud Key tetap valid sesuai security policy.
- Saldo lama tetap tersedia.
- Billing kembali ke wallet.
- Mode premium mengikuti Free/Wallet policy.
- UI menampilkan tombol Perpanjang.

## 7. Billing Priority and Decision Logic

### 7.1 Billing Sources

Resolver mengembalikan tepat satu hasil keputusan:

```text
NO_CHARGE_LOCAL
SUBSCRIPTION_INCLUDED
WALLET_FALLBACK
WALLET_STANDARD
BLOCKED
```

`WALLET_STANDARD` hanya berlaku untuk user non-Pro atau entitlement yang sudah berakhir. `BLOCKED` adalah hasil otorisasi dan tidak membuat provider job. Job yang benar-benar dibuat menyimpan satu billing source non-`BLOCKED` yang bersifat sticky sampai selesai.

`FREE_PREMIUM_TRIAL` berlaku untuk user Free/Wallet pada Smart Summary dan Landscape saja, maksimal dua unique source bersama per minggu, reset Senin 00:00 Asia/Jakarta. Re-render source yang sama dalam minggu yang sama tidak memakan slot tambahan.

Satu job tidak boleh memotong kuota Pro dan saldo sekaligus. Retry, provider fallback, reviewer, reconnect, atau pengiriman ulang request dengan `logicalJobId` yang sama tidak boleh memilih billing source baru.

### 7.2 Decision Algorithm

```text
authorizeGenerate(user, request):
  validate authentication
  validate device
  validate feature access
  classify whether provider AI is required

  if provider AI is not required:
    return NO_CHARGE_LOCAL

  enforce global security and provider cost circuit breakers

  if active Pro entitlement exists:
    enforce one concurrent generation lease

    if daily included quota available
       and internal Pro cost budget available:
      reserve one logical Pro quota unit
      persist sticky billing source SUBSCRIPTION_INCLUDED
      return SUBSCRIPTION_INCLUDED

    monthly included usage is telemetry_only:
      show AI bulan ini in UI/admin
      do not block the job solely because monthly count reached 60

    if wallet fallback is disabled:
      return BLOCKED with PRO_QUOTA_EXHAUSTED

    estimate protected wallet charge
    if spendable wallet balance is insufficient:
      return BLOCKED with DAILY_SUBSCRIPTION_LIMIT_AND_INSUFFICIENT_WALLET

    reserve wallet funds
    persist sticky billing source WALLET_FALLBACK
    return WALLET_FALLBACK

  estimate protected wallet charge
  if spendable wallet balance is insufficient:
    return BLOCKED with INSUFFICIENT_BALANCE

  reserve wallet funds
  persist sticky billing source WALLET_STANDARD
  return WALLET_STANDARD
```

The decision and its reservation must be created atomically. Two concurrent requests that see `used = 4/5` may not both claim the final included slot.

### 7.3 Completion Logic

```text
completeJob(job, actualUsage):
  record actual provider calls, tokens, model, and cost

  if billingSource = SUBSCRIPTION_INCLUDED:
    consume the reserved logical quota unit
    customerCharge = 0

  if billingSource = WALLET_FALLBACK or WALLET_STANDARD:
    settle actual protected charge
    release unused reservation

  release generation lease
```

### 7.4 Failure Logic

```text
failJob(job):
  record provider cost already incurred

  if no billable provider result was produced:
    release Pro quota reservation
    release wallet reservation

  otherwise:
    settle according to the existing usable-result policy

  release generation lease
```

Repeated failed attempts must be protected by a separate cooldown/risk limit so a user cannot create unlimited provider cost by intentionally causing failures.

## 8. Quota Semantics

### 8.1 Logical AI Job

One user action that requests Cloud AI equals one logical job.

```text
Generate clicked once
  -> DeepSeek attempt
  -> retry
  -> OpenAI fallback

User quota = 1 logical job
Provider calls = 3 calls
```

Provider calls and customer quota must be recorded separately.

### 8.2 Zero-Quota Operations

The following do not consume Pro AI quota when no provider is called:

- Render local.
- Re-render local.
- Export.
- Subtitle burn-in from existing subtitle data.
- Landscape preserve-frame plus blur processed locally.
- Local keyframe application.
- Opening or previewing an existing project.

### 8.3 Reset

- Daily reset: 00:00 Asia/Jakarta.
- Monthly reset: every calendar month at 00:00 Asia/Jakarta on day 1.
- Store timestamps in UTC.
- Backend performs timezone calculation.
- Never trust the Electron clock.
- Reset is derived from the active Jakarta billing window; it does not require a global midnight update or mutation of every user row.
- Reset never changes, expires, moves, or recreates wallet balance.

### 8.4 Daily Versus Monthly Limit

- If daily quota is exhausted, wallet fallback may run even when monthly quota remains.
- Included daily quota becomes available again at the next daily reset when monthly included quota is still available.
- If monthly quota is exhausted, wallet fallback continues until monthly reset.
- Unused quota does not roll over in v1.14.0.

Expected cycle:

```text
Day 1: Subscription 1/5 ... 5/5 -> Wallet -> Wallet
00:00 WIB: daily window changes; wallet is untouched
Day 2: Subscription 1/5 ... 5/5 -> Wallet again
Monthly 60/60: Wallet until the monthly window resets
Wallet insufficient + included quota exhausted: BLOCKED
```

## 9. Wallet Fallback UX

Default preference, disclosed during Pro checkout and always visible in Billing Settings:

```text
[x] Gunakan saldo otomatis setelah kuota Pro habis
```

Do not interrupt every quota period with another confirmation. Before a Generate that will use wallet, show the estimated charge and resulting source in the Generate state:

```text
Kuota Pro hari ini telah habis.
Generate berikutnya akan memakai saldo cadangan.

Estimasi biaya: Rp1.250
Saldo tersedia: Rp35.000

[Generate dengan Wallet]
[Matikan fallback otomatis]
```

Backend still rechecks balance and policy atomically when Generate starts. Electron cannot force `WALLET_FALLBACK` from cached UI state.

If balance is insufficient:

```text
Kuota AI harian Cliper Pro Anda telah habis.

Kuota akan reset pada <date/time>.
Saldo Wallet tidak mencukupi untuk melanjutkan.

[Top Up Wallet]
[Tunggu Reset Harian]
```

This state means daily or monthly included quota is exhausted; it must not be described as an expired subscription.

## 10. Unit Economics and Cost Guard

Daily and monthly job counts alone are not sufficient because source duration, token volume, model, and fallback count can vary.

### 10.1 Launch Formula

Before finalizing the included monthly quota:

```text
netAnnualRevenue
  = planPrice
  - paymentFee
  - taxReserve
  - refundAndFraudReserve

maximumIncludedProviderBudget
  = netAnnualRevenue * targetProviderCostRatio

recommended targetProviderCostRatio
  = maximum 35 percent

monthlyProviderBudget
  = maximumIncludedProviderBudget / 12

safeIncludedJobs
  = floor(monthlyProviderBudget / measuredP75LogicalJobCost)
```

The proposed `60 jobs/month` is a configurable starting hypothesis, not a permanent promise. It may launch only after real cost simulation confirms the target margin.

### 10.2 Required Cost Guards

- Per-job estimated provider cost limit.
- Per-user daily provider cost limit.
- Per-user monthly included provider cost limit.
- Global daily provider cost circuit breaker.
- Provider/model-specific limit.
- Maximum source duration or chunk budget when necessary.
- Retry and fallback ceiling.
- Risk cooldown for abnormal failure loops.
- Admin override with mandatory audit log.

When an internal cost budget is reached before the visible job count, do not silently charge wallet. Return a structured `PRO_COST_GUARD_REACHED` response and offer wallet fallback with a clear estimate.

## 11. Current Architecture Reuse

The current Cloud schema already provides reusable foundations:

- `Plan` for package definition.
- `Subscription` for active period and status.
- `UserCreditAccount` for real wallet balance and reservation.
- `CreditLedger` for reserve, settle, release, refund, and idempotency.
- `AnalysisJob` for logical request identity, source duration, provider cost, and final charge.
- `PaymentTransaction` and `Invoice` for checkout and webhook settlement.
- `AiUsage` and provider logs for actual provider usage.
- `Device`, `License`, and `DesktopSession` for device binding and desktop authentication.
- Redis and rate-limit infrastructure for ephemeral lease and counters.

Do not build a second parallel wallet or payment engine.

## 12. Proposed Additive Data Changes

Exact names may follow current Prisma conventions after implementation audit.

### 12.1 Plan Policy

Extend `Plan` or add a one-to-one policy model containing:

```text
dailyIncludedAiJobs
monthlyIncludedAiJobs
weeklyPremiumSources
maxClipsPerJob
maxDevices
maxConcurrentAiJobs
walletFallbackDefault
providerCostRatioBps
dailyProviderCostHardLimit
monthlyProviderCostHardLimit
policyVersion
```

### 12.2 Subscription as Entitlement

Reuse `Subscription` as the durable entitlement source of truth:

```text
planCode = PRO
status = ACTIVE
currentPeriodStart
currentPeriodEnd
activationPaymentId
cancelAtPeriodEnd
autoRenew
```

Do not add another entitlement table unless the implementation audit proves Subscription cannot safely express the required lifecycle.

The current Cloud schema already has `Plan`, `Subscription`, payment, invoice, wallet, ledger, and analysis-job models. Therefore the approved direction is to extend those models additively, not create a parallel `user_entitlements` system.

### 12.3 Payment Purpose

Add an additive payment purpose classification:

```text
TOPUP
PLAN_PURCHASE
PLAN_RENEWAL
```

Existing production payment rows migrate safely to `TOPUP` only when that matches existing behavior. No payment history may be deleted or rewritten destructively.

### 12.4 Billing Preference

Store per-user preference:

```text
autoWalletFallback = true
walletFallbackConfirmedAt
walletFallbackPolicyVersion
```

The policy version allows the app to request confirmation again if billing terms materially change.

### 12.5 Quota Ledger

Add an append-friendly and idempotent quota ledger:

```text
id
userId
subscriptionId
analysisJobId
logicalJobId
quotaType
quotaUnits
status: RESERVED | CONSUMED | RELEASED
periodStart
periodEnd
idempotencyKey
createdAt
updatedAt
```

Required uniqueness:

```text
one quota reservation per logicalJobId + quotaType
```

### 12.6 Analysis Job Billing Source

Extend `AnalysisJob` with:

```text
billingSource
quotaUnits
quotaReservationId
walletReservationId if not already derivable
leaseId
policySnapshot
```

The policy snapshot preserves auditability if Admin changes limits later.

### 12.7 Free Premium Source Usage

Track unique weekly source access:

```text
userId
sourceIdentityHash
periodStart
periodEnd
firstMode
createdAt
```

Unique key:

```text
userId + sourceIdentityHash + periodStart
```

Do not store raw source URLs when a stable hash is sufficient.

## 13. Feature Policy Service

Create one Cloud source of truth:

```text
resolveFeaturePolicy(userId, deviceId?)
```

Response concept:

```json
{
  "plan": "PRO",
  "subscriptionStatus": "ACTIVE",
  "expiresAt": "2027-09-09T00:00:00.000Z",
  "upgradeEligible": true,
  "showUpgradeMenu": true,
  "features": {
    "auto": "unlocked",
    "podcast": "unlocked",
    "gaming": "unlocked",
    "smartSummary": "pro",
    "landscape": "pro"
  },
  "weeklyPremium": {
    "used": 0,
    "limit": null,
    "resetsAt": null
  },
  "dailyAi": {
    "used": 2,
    "limit": 5,
    "remaining": 3,
    "resetsAt": "..."
  },
  "monthlyAi": {
    "used": 18,
    "limit": 60,
    "remaining": 42,
    "resetsAt": "..."
  },
  "wallet": {
    "availableMicroUsd": 35000000,
    "autoFallback": true
  },
  "billing": {
    "subscriptionAvailable": true,
    "walletFallbackEnabled": true,
    "walletSufficient": true,
    "nextBillingSource": "SUBSCRIPTION_INCLUDED"
  },
  "devices": {
    "used": 1,
    "limit": 2
  },
  "maxConcurrentAiJobs": 1,
  "policyVersion": 1
}
```

Web and Electron must not independently recalculate entitlement or limits.

Wallet sufficiency in this compact response is only a display hint based on the current policy estimate. The Generate authorization endpoint must re-estimate and recheck the real available balance inside the billing transaction.

## 14. API Contract Plan

Prefer extending current routes where appropriate.

```text
GET   /api/member/feature-policy
GET   /api/member/pro/status
PATCH /api/member/billing-preferences
POST  /api/payments/plan-checkout
POST  /api/payments/webhook/:provider
POST  /v1/jobs/start
POST  /v1/jobs/complete
POST  /v1/jobs/:id/fail
POST  /api/auth/desktop/heartbeat
```

Admin:

```text
GET   /api/admin/plans
PATCH /api/admin/plans/:code
GET   /api/admin/subscriptions
PATCH /api/admin/subscriptions/:id
GET   /api/admin/pro-usage
GET   /api/admin/devices
POST  /api/admin/devices/:id/revoke
```

Required error codes:

```text
UPGRADE_NOT_ELIGIBLE
PRO_QUOTA_EXHAUSTED
PRO_MONTHLY_QUOTA_EXHAUSTED
PRO_COST_GUARD_REACHED
PRO_QUOTA_EXHAUSTED_AND_BALANCE_INSUFFICIENT
INSUFFICIENT_BALANCE
DEVICE_LIMIT_REACHED
GENERATION_ALREADY_ACTIVE
ENTITLEMENT_EXPIRED
PAYMENT_PENDING
PAYMENT_ALREADY_PROCESSED
```

## 15. Payment and Activation

Reuse the existing provider abstraction and currently configured production payment provider.

```text
Eligible user
  -> opens Upgrade
  -> requests plan checkout
  -> Cloud creates invoice and payment transaction
  -> provider checkout
  -> provider webhook
  -> signature and amount validation
  -> idempotent payment settlement
  -> activate or extend Subscription
  -> refresh feature policy
```

Never activate from browser redirect alone.

### 15.1 Renewal

```text
if currentPeriodEnd > now:
  newPeriodEnd = currentPeriodEnd + 365 days
else:
  newPeriodEnd = now + 365 days
```

Concurrent duplicate webhooks must activate or extend exactly once.

### 15.2 Refund

- Refund must be idempotent.
- Full refund may revoke or shorten entitlement according to Admin policy.
- Partial refund requires manual review in v1.14.0 unless a precise proportional policy is defined.
- Never modify wallet history to hide the refund.

## 16. Device and Generation Lease

### 16.1 Device Rule

- Maximum two active registered devices for Pro.
- A third device must replace one existing device.
- Device replacement default cooldown: one replacement per 24 hours.
- Admin can override with audit logging.
- Reinstall recovery must be supported.

### 16.2 Concurrent Generate Rule

- Maximum one active Cloud AI Generate per user.
- Local render does not require an AI generation lease.
- Lease stored in Redis with TTL and heartbeat.
- Durable job status remains in PostgreSQL.
- Missing heartbeat releases the slot after TTL.
- Application crash must not create a permanent lock.

Suggested lease lifecycle:

```text
REQUESTED -> ACTIVE -> COMPLETED
                    -> FAILED
                    -> EXPIRED
                    -> RELEASED
```

## 17. UI Requirements

### 17.1 Ineligible New User

Navigation:

```text
Dashboard
Saldo
Top Up
Transactions
Settings
```

No Upgrade menu, badge, or hidden clickable placeholder.

### 17.2 Eligible User

Navigation adds:

```text
Upgrade
```

Plan card:

```text
CLIPER PRO ANNUAL
Rp100.000 / 12 bulan

Semua Content Mode
Cloud AI Fair Usage
Render lokal tanpa batas
Maksimal 2 perangkat
Update selama paket aktif

[Upgrade Sekarang]
```

### 17.3 Active Pro

```text
Cliper Pro Aktif
AI hari ini: 2/5
AI bulan ini: 18/60
Saldo cadangan: Rp35.000
Saldo otomatis: Aktif
Perangkat: 1/2
Aktif hingga: 9 September 2027

[Kelola Saldo Otomatis]
[Perpanjang 12 Bulan]
```

### 17.4 Quota Warning

- Show warning at 80 percent daily/monthly usage.
- Show exact reset time at 100 percent.
- Clearly mark when billing switches to wallet.
- Never label the real wallet as unlimited.

## 18. Admin Requirements

Admin must be able to:

- Enable or disable Pro sales.
- Configure price, duration, daily quota, monthly quota, device limit, concurrency, and cost guards.
- Inspect subscription status and expiry.
- Inspect daily/monthly logical jobs.
- Compare customer charge, included usage, provider cost, and gross margin.
- Inspect device registrations and active lease.
- Revoke a device or key.
- Extend, expire, or revoke entitlement with reason.
- Inspect payment and webhook idempotency.
- Flag abnormal sharing, automation, failure loops, and cost spikes.
- Audit every manual change.

Admin must never display provider secrets or reusable raw session tokens.

## 19. Security Requirements

- Backend is authoritative for eligibility, entitlement, quota, balance, and device state.
- Never trust `PRO=true`, quota counters, price, or expiry from Electron.
- Verify webhook signature, provider reference, amount, currency, and final status.
- Use idempotency keys for checkout, webhook, entitlement activation, quota, reserve, settle, release, and refund.
- Prevent cross-user access to subscription, wallet, device, and source usage.
- Rate-limit checkout, policy refresh, device replacement, and generation start.
- Store timestamps in UTC.
- Do not log keys, cookies, full payment payloads, source URLs, or provider secrets.

## 20. Performance Requirements

- Feature policy should be returned by one lightweight authenticated request.
- Fetch policy on login, Cloud reconnect, successful payment, plan change, and stale preflight.
- Do not poll policy continuously.
- Do not request policy per frame, candidate, subtitle, keyframe, or FFmpeg operation.
- PostgreSQL is durable truth.
- Redis is only cache, counter, rate limit, and lease acceleration.
- Redis cache miss must fall back safely to PostgreSQL.
- Avoid N+1 queries in member and Admin screens.

## 21. Migration and Backward Compatibility

- All migrations are additive.
- No reset and no destructive migration.
- No historical ledger rewrite.
- Existing wallet balances remain unchanged.
- Existing v1.13 clients continue using wallet flow safely.
- New Cloud fields have safe defaults.
- Feature enforcement can be enabled using server-side rollout flags.
- Deploy Cloud schema and compatibility layer before releasing Electron v1.14.0.

Recommended rollout flags:

```text
PRO_POLICY_ENABLED
PRO_CHECKOUT_ENABLED
PRO_QUOTA_ENFORCEMENT_ENABLED
PRO_WALLET_FALLBACK_ENABLED
PRO_DEVICE_ENFORCEMENT_ENABLED
PRO_GENERATION_LEASE_ENABLED
```

## 22. Implementation Roadmap

### Phase 1: Local Billing Foundation

Scope is implementation and automated testing in local/dev only:

- Audit and reuse the existing `Plan`, `Subscription`, `PaymentTransaction`, `UserCreditAccount`, `CreditLedger`, and `AnalysisJob` architecture.
- Add configurable plan-policy fields and payment-purpose classification using additive migrations.
- Add top-up eligibility and Subscription-based entitlement resolvers.
- Add one backend-authoritative feature-policy endpoint.
- Add shared weekly premium-source accounting for Free/Wallet users.
- Add race-safe daily/monthly included-quota ledger and Jakarta billing windows.
- Add centralized billing resolver with `NO_CHARGE_LOCAL`, `SUBSCRIPTION_INCLUDED`, `WALLET_FALLBACK`, `WALLET_STANDARD`, and `BLOCKED` outcomes.
- Persist one sticky billing source per `logicalJobId`.
- Reuse existing wallet reserve, settle, release, and refund paths without redesign.
- Add minimal Electron policy cache and Pro/quota/fallback status only.
- Stop after tests and a Phase 1 report. Do not deploy, tag, publish a release, or begin Phase 2 automatically.

Acceptance:

```text
ELIGIBILITY = PASS
ENTITLEMENT = PASS
FEATURE POLICY = PASS
FREE PREMIUM 2/WEEK = PASS
PRO DAILY 5 = PASS
PRO MONTHLY 60 = PASS
PRO -> WALLET -> RESET -> PRO = PASS
STICKY BILLING SOURCE = PASS
IDEMPOTENCY AND RACE SAFETY = PASS
LOCAL NO-CHARGE = PASS
WALLET LEDGER UNCHANGED = PASS
MIGRATION ADDITIVE = PASS
V1.13 COMPATIBILITY = PASS
```

### Phase 2: Device, Lease, and Cost Guard

- Enforce two registered devices with replacement and cooldown.
- Add Redis generation lease and heartbeat for one concurrent Cloud AI job.
- Add per-job, per-user, per-plan, provider/model, and global provider-cost guards.
- Add retry/fallback ceilings, failure-loop cooldowns, risk events, and operational metrics.
- Keep all changes local/dev. No production deploy.

Acceptance:

```text
DEVICE LIMIT = PASS
DEVICE RECOVERY = PASS
ONE GENERATE = PASS
LEASE TTL = PASS
CRASH RECOVERY = PASS
COST GUARD = PASS
FAILURE LOOP PROTECTION = PASS
```

### Phase 3: Checkout, Web, Admin, and Electron UX

- Add conditional Upgrade navigation after valid paid top-up history.
- Add Pro checkout, verified webhook activation, renewal, expiry, and refund handling.
- Add Pro status, daily/monthly usage, wallet-source indicator, and fallback preference UI.
- Add Admin plan, subscription, usage, device, margin, risk, and audit controls.
- Complete Electron status and structured blocked-state actions.
- Keep sales disabled and test only against local/test payment mode.

Acceptance:

```text
MENU VISIBILITY = PASS
DIRECT ROUTE AUTHORIZATION = PASS
CHECKOUT = PASS
WEBHOOK IDEMPOTENCY = PASS
RENEWAL = PASS
EXPIRY = PASS
ADMIN = PASS
ELECTRON SYNC = PASS
```

### Phase 4: Staging and Release Rehearsal

- Deploy only to an isolated staging environment after explicit approval.
- Rehearse additive migration against a sanitized production-like backup.
- Verify rollback, payment sandbox/test mode, concurrency, security, and policy flags.
- Measure P50, P75, and P95 provider cost per logical job.
- Confirm price and included quotas meet the target gross-margin gate.
- Run full Cloud/Web/Electron regression and real-render QA for all five Content Modes.
- Do not alter production or publish a public release.

Acceptance:

```text
STAGING MIGRATION = PASS
ROLLBACK REHEARSAL = PASS
UNIT ECONOMICS = PASS
SECURITY = PASS
PERFORMANCE = PASS
FULL REGRESSION = PASS
REAL RENDER QA = PASS
PRODUCTION APPROVAL = REQUIRED
```

### Phase 5: Controlled Production Release

This phase starts only after explicit user approval and every previous gate is green:

- Back up and verify production data.
- Deploy the backward-compatible Cloud schema and API behind disabled rollout flags.
- Deploy Web with Pro sales still disabled, then run smoke tests.
- Enable policy, quota, wallet fallback, checkout, device, and lease flags gradually.
- Release Electron v1.14.0, publish the download catalog and checksums, and create the GitHub release.
- Monitor billing decisions, wallet reconciliation, provider cost, errors, and rollback signals.

Production may proceed only when all acceptance gates pass. A successful Phase 1, 2, 3, or 4 never implies permission to deploy Phase 5.

## 23. Test Matrix

### Eligibility

- New user has no Upgrade menu.
- Direct checkout by new user returns `UPGRADE_NOT_ELIGIBLE`.
- Paid top-up makes Upgrade visible.
- Pending, failed, expired, or refunded top-up does not qualify.

### Entitlement

- Paid Pro webhook activates exactly once.
- Duplicate webhook does not extend twice.
- Renewal adds 365 days to remaining period.
- Expired and revoked Pro fall back safely.
- Wallet remains unchanged during activation and expiry.

### Quota and Wallet

- Pro job 1-5 uses included daily quota.
- Job 6 uses wallet when fallback enabled and balance sufficient.
- Job 6 is blocked when fallback disabled.
- Job 6 is blocked before provider call when balance is insufficient.
- Monthly quota exhaustion uses the same fallback behavior.
- After the Jakarta daily reset, the next eligible job returns to subscription while monthly quota remains.
- Daily and monthly reset never changes wallet balance or wallet history.
- Old available balance can fund fallback without requiring a new top-up.
- Once a job selects subscription or wallet, a reset during execution does not change its billing source.
- Retry and provider fallback count as one logical job.
- Duplicate Electron requests with the same `logicalJobId` consume and charge at most once.
- Concurrent claims cannot move included usage beyond the configured limit.
- Failed pre-provider job releases quota and wallet reservation.
- One job never consumes both quota and wallet.
- Wallet never becomes negative.

### Local Operations

- Local render consumes zero quota and zero wallet.
- Re-render consumes zero quota and zero wallet.
- Landscape local-only consumes premium feature access but zero AI quota.

### Device and Lease

- Device one and two register successfully.
- Device three requires replacement.
- Concurrent Generate from device two is rejected while device one owns the lease.
- Lease expires after missing heartbeat.
- Successful, failed, and canceled job release the lease.

### Cost and Abuse

- Hard provider-cost limit stops the call before overspend.
- Retry ceiling prevents loops.
- Global circuit breaker blocks new included usage safely.
- Actual provider cost remains visible to Admin even when customer charge is zero.

### Non-Regression

- Wallet grant/reserve/settle/release/refund.
- Payment and invoice flow.
- Cloud Key and Desktop Session.
- AI Router fallback and usage accounting.
- Auto, Podcast, Gaming, Summary, and Landscape.
- Story Engine, Smart Edit, keyframe, subtitle, render, and ffprobe.

## 24. Observability and Alerts

Required metrics:

- Active Pro subscriptions.
- Upgrade eligibility conversion.
- Checkout created, paid, failed, expired, and refunded.
- Included logical jobs per user/day/month.
- Wallet fallback count and value.
- Provider calls per logical job.
- Provider cost per job and per active Pro user.
- Gross margin by plan.
- Quota rejection reasons.
- Insufficient balance rate.
- Active and expired leases.
- Device replacement rate.
- Risk flags and circuit-breaker activations.

Required alerts:

- Provider cost above daily global threshold.
- Pro gross margin below configured target.
- Duplicate webhook anomaly.
- Reservation or lease stuck beyond TTL.
- Sudden fallback-call amplification.
- Database, Redis, payment, or provider degradation.

## 25. Release Gate

```text
PLAN POLICY: PASS/FAIL
UPGRADE ELIGIBILITY: PASS/FAIL
MENU VISIBILITY: PASS/FAIL
ENTITLEMENT: PASS/FAIL
PAYMENT WEBHOOK: PASS/FAIL
RENEWAL: PASS/FAIL
EXPIRY: PASS/FAIL
DAILY QUOTA: PASS/FAIL
MONTHLY QUOTA: PASS/FAIL
WALLET FALLBACK: PASS/FAIL
NO DOUBLE CHARGE: PASS/FAIL
NO NEGATIVE BALANCE: PASS/FAIL
LOCAL ZERO-COST: PASS/FAIL
DEVICE LIMIT: PASS/FAIL
GENERATION LEASE: PASS/FAIL
COST GUARD: PASS/FAIL
ADMIN: PASS/FAIL
ELECTRON SYNC: PASS/FAIL
BACKWARD COMPATIBILITY: PASS/FAIL
UNIT ECONOMICS: PASS/FAIL
SECURITY: PASS/FAIL
PERFORMANCE: PASS/FAIL
FULL REGRESSION: PASS/FAIL
REAL RENDER QA: PASS/FAIL
PRODUCTION SMOKE: PASS/FAIL

READY FOR v1.14.0 RELEASE: YES/NO
```

## 26. Final Decisions

1. Saldo user tetap ada dan tidak diubah saat upgrade.
2. Kuota Pro selalu dipakai sebelum wallet.
3. Wallet fallback otomatis memakai seluruh saldo `AVAILABLE` yang sah, transparan, dan dapat dimatikan.
4. Saldo tidak cukup berarti Generate ditolak sebelum provider dipanggil.
5. Cloud Key tidak diganti ketika upgrade.
6. Upgrade menu hanya muncul setelah top-up paid yang valid.
7. Pro bukan unlimited provider usage.
8. Daily quota adalah blocker utama; monthly quota adalah telemetry fair-usage dan bahan admin review.
9. PostgreSQL menjadi durable truth; Redis hanya untuk state ephemeral.
10. v1.13.0 Content Engine tetap baseline dan tidak direfaktor tanpa regression nyata.
11. Billing source dipilih sekali secara atomik dan sticky untuk satu `logicalJobId`.
12. Reset harian mengembalikan prioritas ke subscription; wallet tidak pernah ikut direset.
13. Existing `Subscription` digunakan sebagai entitlement; tidak dibuat tabel entitlement paralel tanpa kebutuhan teknis yang terbukti.
14. Tidak ada implementasi atau deployment sampai dokumen ini mendapat persetujuan eksplisit.

## 27. Validasi Terbuka Sebelum Phase 1

Nilai berikut wajib divalidasi memakai data biaya production nyata sebelum penjualan dibuka:

- Final public price: Rp99.000 or Rp100.000.
- Final monthly included logical jobs.
- Per-job source duration policy.
- Target gross margin.
- Payment fee and refund reserve assumptions.
- Final checkout disclosure wording and placement of the wallet-fallback toggle.

Implementasi lanjutan boleh dimulai hanya setelah persetujuan eksplisit, dengan default yang configurable. Penjualan production wajib tetap nonaktif sampai Unit Economics berstatus PASS.

## 28. Billing Decision Examples

### A. Pro 2/5 and Wallet Available

```text
Next billing source: SUBSCRIPTION_INCLUDED
Daily usage after successful claim: 3/5
Wallet: unchanged
```

### B. Pro 5/5 and Wallet Sufficient

```text
Next billing source: WALLET_FALLBACK
Daily included usage: remains 5/5
Wallet: reserve -> settle/release using the existing lifecycle
```

### C. Pro 5/5 and Wallet Insufficient

```text
Decision: BLOCKED
Reason: DAILY_SUBSCRIPTION_LIMIT_AND_INSUFFICIENT_WALLET
Provider call: not allowed
Actions: Top Up Wallet or Wait for Daily Reset
```

### D. After Jakarta Daily Reset

```text
Next billing source: SUBSCRIPTION_INCLUDED
Daily usage starts from the new billing window
Monthly usage remains visible as telemetry
Wallet: unchanged
```

### E. Local Landscape or Re-render

```text
Next billing source: NO_CHARGE_LOCAL
Subscription quota: unchanged
Wallet: unchanged
Provider usage: zero
```

## 29. Planning Approval Gate

Current state:

```text
PRD PREPARED: YES
SOURCE CODE CHANGED: YES, PHASE 1 AND PHASE 2 COMPLETE
DATABASE MIGRATION CREATED: YES, APPLIED TO PRODUCTION
CLOUD COMMIT AND PUSH: YES
GITHUB DESKTOP RELEASE: EXECUTED AFTER THIS RELEASE COMMIT
RAILWAY API DEPLOY: SUCCESS
VERCEL WEB DEPLOY: READY
READY FOR PRODUCTION: YES, RELEASE GATES PASSED
```

The completed approval sequence is:

```text
Review Phase 1 local implementation
-> Harden Phase 2 billing, security, and desktop contract
-> Run full Cloud and Studio release gates
-> Create and verify production database backup
-> Apply additive migration and deploy API/web
-> Verify production health and publish desktop release
```

## 30. Phase 1 Local Implementation Notes

Implemented locally in Cliper AI Cloud only:

1. Backend billing source resolver for analysis jobs.
2. Prisma enum and additive `analysis_jobs` fields for sticky billing source, Pro quota day/month keys, and optional subscription link.
3. Feature policy endpoint for Upgrade menu visibility, Pro status, quota usage, reset times, and wallet fallback state.
4. Pro Annual catalog draft: Rp100.000 for 365 days, 5 included AI jobs/day, 60 included AI jobs/month, max 2 devices, wallet fallback enabled.
5. Web sidebar reads backend policy before showing the Upgrade menu.
6. Billing page displays active Pro quota and saldo cadangan.

Verification completed locally:

```text
pnpm --filter @cliper/api test -- src/billing/pro-entitlement.service.test.ts src/billing/analysis-job.service.test.ts src/gateway/gateway.service.test.ts
```

Targeted Phase 1 verification passed locally. The full release gate was rerun after Phase 2 hardening before production deployment.

## 31. Phase 2 Hardening Notes

Implemented locally after engine review:

1. Monthly Pro usage is telemetry-only; daily Pro usage controls included quota exhaustion.
2. Free/Wallet Smart Summary and Landscape share a two-unique-source weekly trial reset every Monday 00:00 Asia/Jakarta.
3. `contentMode` is sent from desktop to Cloud for billing policy without sending raw source URL/path/transcript/media.
4. AI concurrency defaults to one active Generate for Free, Wallet, Starter, and Pro. A second active job returns `BLOCKED_BUSY` before provider work starts.
5. Desktop key rotation is explicit. Upgrade does not rotate keys automatically.
6. Explicit rotation revokes previous active desktop keys, bound devices, and active desktop sessions.
7. Production member UI no longer labels the deployment as beta.

Current release gate status:

```text
TARGETED BILLING TESTS: PASS
TARGETED DESKTOP CONTRACT TESTS: PASS
TARGETED LICENSE/RATE LIMIT TESTS: PASS
FULL CLOUD TYPECHECK: PASS
FULL CLOUD TEST: PASS (157 API + 7 WEB)
FULL CLOUD BUILD: PASS (48 WEB PAGES)
FULL STUDIO QA: PASS (324 TESTS)
FULL STUDIO BUILD: PASS
PRODUCTION BACKUP: PASS (CUSTOM FORMAT, 226 TOC ENTRIES, SHA-256 VERIFIED)
CLOUD COMMIT AND PUSH: PASS
RAILWAY API DEPLOY: SUCCESS (d821fff8-377c-4f61-a236-ba8288cc3ba9)
VERCEL WEB DEPLOY: READY (dpl_5Fih5Zcc4ZaZzsfQ4kYbftZgqMcx)
PRODUCTION LIVE/READY HEALTH: HTTP 200
```

## 32. Production Release Evidence

Release verification captured on 15 September 2026:

1. The production backup is `cliper-cloud-20260915-113520.dump`, size 201832 bytes, with SHA-256 `f12b0b8c2d074d7369c21fe3d9605552918175f4d9781003cf961d695b51ecfd`.
2. The temporary PostgreSQL TCP proxy used for backup was removed after verification.
3. Prisma reported 16 migrations and no pending migrations after deployment.
4. Production readiness confirmed PostgreSQL and Redis reachable, secure origins enabled, and two stored providers healthy.
5. The web production aliases are `cliperaicloud.online` and `www.cliperaicloud.online`.
6. The duplicate Vercel Git integration for the NestJS API was disconnected; the production API remains owned by Railway.
7. Installer checksums are recorded in `SHA256SUMS.txt`. Windows signing remains a separate follow-up because no code-signing certificate is configured.

> Historical note: this document contains the original Phase 1 proposal below. The current production contract in this section overrides any conflicting legacy wording.

# Current Production Contract: USD Wallet and Per-Job Billing

## Product boundary

Cliper AI Cloud is the account, key, wallet, AI routing, payment, and usage service for the local-first Cliper Studio desktop application. Video download, transcription, analysis, rendering, and export remain on the user's computer.

## API key and connection

- A `clip_sk` key is valid when it is active, belongs to an active account, and satisfies device/session rules.
- Wallet balance is never a requirement to create, activate, validate, refresh, or heartbeat an API key.
- Electron connection checks authenticate the key, session, and wallet endpoint only. They never make a paid AI request.
- A wallet with US$0 remains connected. The UI asks the user to top up only before a paid operation.

## Canonical wallet contract

- Currency is USD, stored as integer micro-USD for exact arithmetic.
- Server responses expose `availableUsd`, `reservedUsd`, and `spendableUsd`, where `spendable = available - reserved`.
- The minimum top-up is US$1.00. It is a payment rule, not a minimum balance required to use a key.
- Legacy database and ledger column names may remain for migration compatibility, but user-facing product language is wallet balance, reservation, settlement, and USD.

## Paid analysis job

1. Electron starts a local analysis and asks Cloud to create one analysis job before the first paid provider call.
2. Cloud estimates the job from source duration and requested output count.
3. Cloud reserves `estimated protected cost + reservation headroom` atomically.
4. If `spendableUsd` is smaller than that specific reservation, Cloud returns `PAYMENT_REQUIRED` with the available and required USD values. The key and session remain valid.
5. All provider calls for that analysis job use the same reservation. The job is never charged once per provider request.
6. On success, Cloud settles the actual protected cost once and releases the remainder. On failure, Cloud releases the complete reservation.
7. A configured maximum job charge is a safety ceiling, never a blanket reservation or login gate.

## Cost guard

- Provider calls stop before their projected cost would exceed the job reservation or the hard provider cost limit.
- Optional enrichment stages use local fallbacks when budget guards are reached.
- Admin can configure margin, infrastructure allocation, buffers, retry allowance, per-job reservation headroom, and the maximum job charge safety ceiling.
- Admin accounts marked unlimited do not draw down wallet balance, while provider usage remains auditable.

## Required acceptance matrix

- A valid key with US$1.00 connects and starts a normal estimated job.
- A valid key with US$0.00 connects successfully but receives `PAYMENT_REQUIRED` only when a paid job is too expensive.
- A wallet with US$0.01 can run a US$0.005 operation.
- A wallet with US$0.01 cannot run a US$0.05 operation.
- Wallet top-up accumulates balance and existing keys work after top-up without reactivation.
- Concurrent job starts reserve atomically and cannot overdraw spendable balance.
- Duplicate job requests reuse the same reservation; duplicate settlement cannot charge twice.

---

Ya. Saya justru menyarankan **dibuat sebagai project baru 100%**, jangan menjadi bagian dari Cliper Studio Plus.

Kalau target Anda memang ingin menjual Cliper Studio Plus, maka ini harus menjadi **backend SaaS** yang berdiri sendiri.

Saya akan memberi nama project ini:

> **Cliper AI Cloud (Codename: Orion)**

Karena nanti bukan hanya untuk Cliper Studio, tetapi bisa dipakai untuk semua aplikasi AI Anda.

---

# PRD PHASE 1

## Cliper AI Cloud V1.0

### AI Gateway • License Server • AI Router • Billing Engine

---

# OBJECTIVE

Bangun platform web SaaS terpisah yang menjadi pusat seluruh layanan AI untuk Cliper Studio Plus.

Desktop tidak lagi menyimpan API Key provider.

Semua request AI harus melewati server Cliper AI Cloud.

Desktop hanya mengenal:

* License Key
* Gateway URL

Provider AI seperti Gemini, DeepSeek, GPT, Claude, OpenRouter hanya diketahui oleh server.

---

# PRODUCT GOAL

Membangun platform AI Gateway yang:

* Mengelola API Provider
* Mengelola License Desktop
* Mengelola User
* Mengelola Billing
* Mengelola Token
* Mengelola AI Router
* Mengelola Analytics
* Mengelola Cost Provider
* Mengelola Profit

Target:

Menjadi backend resmi seluruh produk Cliper Studio.

---

# PRODUCT

Nama

```text
Cliper AI Cloud
```

---

# ROLE

```text
Super Admin

↓

Admin

↓

Support

↓

Member

↓

Desktop Client
```

---

# PACKAGE

```text
FREE

STARTER

PRO

TEAM

ENTERPRISE
```

---

# TECHNOLOGY

Frontend

```text
Next.js

TypeScript

Tailwind

Shadcn UI
```

---

Backend

```text
NestJS

TypeScript
```

---

Database

```text
PostgreSQL
```

---

ORM

```text
Prisma
```

---

Cache

```text
Redis
```

---

Queue

```text
BullMQ
```

---

Realtime

```text
Socket.IO
```

---

Storage

```text
S3 Compatible

atau

Cloudflare R2
```

---

Deployment

```text
Docker

Railway

Coolify

VPS
```

---

# PROJECT STRUCTURE

```text
cliper-ai-cloud/

apps/

admin/

api/

landing/

packages/

ai-router/

provider/

billing/

license/

analytics/

database/

shared/

services/

gateway/

worker/

scheduler/

queue/

storage/

docs/

docker/

scripts/

prisma/

README.md
```

---

# MODULE

## Authentication

* Login
* Register
* Forgot Password
* Email Verification
* JWT
* Refresh Token
* 2FA

---

## License Server

Menghasilkan

```text
CLS-XXXX-XXXX-XXXX
```

Setiap key mempunyai

* Plan
* Expired
* Device Limit
* Token Limit

---

## Device Manager

Desktop pertama login

↓

Device Fingerprint

↓

Disimpan

↓

Aktif

Jika melebihi batas device

↓

Reject

---

## AI Gateway

Semua request AI masuk ke sini.

Contoh

```text
Desktop

↓

AI Gateway

↓

AI Router

↓

Gemini

↓

DeepSeek

↓

GPT

↓

Response
```

---

# AI PROVIDER

Support

```text
Gemini

DeepSeek

OpenAI

Claude

OpenRouter

Groq

Qwen

Mistral
```

---

# AI ROUTER

AI tidak dipilih oleh desktop.

Router menentukan otomatis.

Contoh

Story Segmentation

↓

Gemini

Jika gagal

↓

DeepSeek

---

Ranking

↓

DeepSeek

↓

Gemini

---

Subtitle Cleanup

↓

DeepSeek

↓

Gemini

---

Title Generator

↓

GPT

↓

Gemini

↓

DeepSeek

---

Semua otomatis.

---

# HEALTH CHECK

Setiap provider dicek

```text
Latency

Status

Error Rate

Quota

Remaining Balance
```

Jika

```text
Provider Down
```

↓

otomatis pindah provider lain.

---

# COST ENGINE

Setiap request dicatat.

Misalnya

```text
Gemini

Input Token

Output Token

Harga

Margin

Profit
```

Semua masuk database.

---

# TOKEN ENGINE

Setiap user memiliki

```text
AI Token
```

Bukan API Key provider.

Misalnya

```text
Starter

500.000 Token

Pro

5.000.000 Token
```

---

# TOKEN CALCULATOR

Contoh

Story

```text
1200 token
```

Ranking

```text
800 token
```

Subtitle

```text
500 token
```

Title

```text
300 token
```

Total

```text
2800 token
```

↓

Kurangi saldo user.

---

# AI ORCHESTRATOR

Pipeline

```text
Desktop

↓

Gateway

↓

Authentication

↓

License

↓

Plan

↓

Quota

↓

AI Router

↓

Provider

↓

Result

↓

Billing

↓

Analytics
```

---

# BILLING

Tidak menghitung clip.

Tetapi

```text
AI Token

+

Provider Cost

+

Compute Unit
```

---

# ANALYTICS

Dashboard

Menampilkan

* Total User
* Total License
* Provider Cost
* Revenue
* Profit
* Token Usage
* Daily Request
* AI Success Rate
* Average Latency

---

# ADMIN PANEL

Menu

```text
Dashboard

Users

Plans

License

Device

AI Providers

AI Router

Token

Billing

Payments

Analytics

Announcements

Logs

Settings
```

---

# PROVIDER DASHBOARD

Misalnya

```text
Gemini

Healthy

Latency

530 ms

Usage

32%

Cost

$23

------------

DeepSeek

Healthy

Latency

380 ms

Usage

51%

Cost

$9

------------

GPT

Healthy

Latency

720 ms

Usage

17%

Cost

$14
```

---

# ROUTER RULE

Admin dapat mengatur

```text
Story

Gemini

↓

DeepSeek

↓

Claude
```

Ranking

```text
DeepSeek

↓

Gemini
```

Subtitle

```text
DeepSeek

↓

Gemini
```

Title

```text
GPT

↓

Gemini
```

Tanpa update Desktop.

---

# DESKTOP CONFIG

Desktop hanya menyimpan

```json
{
  "gateway":"https://api.cliper.ai",
  "license":"CLS-XXXX-XXXX"
}
```

Tidak ada

```text
Gemini Key

DeepSeek Key

GPT Key
```

---

# SECURITY

* HTTPS wajib.
* Password menggunakan Argon2id.
* JWT + Refresh Token.
* 2FA (TOTP) untuk admin.
* Audit Log semua aktivitas admin.
* Device fingerprint untuk lisensi desktop.
* Rate limiting dan proteksi brute-force.
* API provider key hanya tersimpan di server dalam bentuk terenkripsi dan tidak pernah dikirim ke desktop.

---

# TARGET

Platform harus mampu:

* Menangani lebih dari 100.000 request AI per hari.
* Mendukung banyak provider AI secara bersamaan.
* Berpindah provider otomatis jika ada kegagalan.
* Menghitung biaya provider secara akurat.
* Menampilkan profit per provider dan per paket.
* Menjadi backend resmi Cliper Studio Plus dan aplikasi AI lain di masa depan.

---

## Prompt Codex (Implementasi)

Gunakan PRD di atas sebagai acuan implementasi. Bangun **project baru** bernama **Cliper AI Cloud** dengan arsitektur monorepo (Next.js + NestJS + PostgreSQL + Prisma + Redis + BullMQ). Fokus pada fondasi production-ready: autentikasi, lisensi, AI Gateway, AI Router, Billing Engine, Token Engine, Provider Manager, Admin Panel, dan API untuk desktop. Pastikan desktop hanya menggunakan `gateway URL` dan `license key`; seluruh API provider, routing, fallback, pencatatan biaya, dan logika AI berada di server. Terapkan clean architecture, modular design, validasi menyeluruh, logging terstruktur, pengujian dasar, dan dokumentasi API agar siap dikembangkan ke fase berikutnya.

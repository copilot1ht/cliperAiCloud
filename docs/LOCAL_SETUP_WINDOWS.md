# Local Setup - Windows

Dokumen ini menyiapkan Cliper AI Cloud untuk development lokal. Jangan gunakan konfigurasi development untuk server publik.

## 1. Software wajib

- Node.js LTS yang memenuhi `>=20.19.0`.
- pnpm 10.34.5.
- Git.
- Docker Desktop dengan WSL 2 backend.
- PostgreSQL client opsional untuk debugging.

Verifikasi:

```powershell
node --version
pnpm --version
docker version
docker compose version
```

## 2. Siapkan environment

```powershell
Set-Location "C:\Users\USER\Desktop\Cliper Ai Studio\WEB PRODUCTION SAAS"
Copy-Item .env.example .env
```

Buat secret acak dengan PowerShell:

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
```

Gunakan hasil berbeda untuk:

- `JWT_SECRET`
- `REFRESH_TOKEN_SECRET`
- `ADMIN_API_KEY`
- `PROVIDER_ENCRYPTION_KEY`
- `CLIPER_DEV_API_KEY`

Jangan commit `.env`. Jangan memakai secret yang sama untuk dua fungsi.

## 3. Provider awal

Isi minimal salah satu:

```text
GEMINI_API_KEYS=key_pertama,key_kedua
DEEPSEEK_API_KEYS=key_pertama,key_kedua
```

Beberapa key dipisahkan koma. Jangan menaruh key pada `NEXT_PUBLIC_*`, source frontend, Electron, screenshot, atau log.

Harga per satu juta token wajib diisi dari harga provider yang berlaku saat deployment:

```text
GEMINI_INPUT_USD_PER_M=
GEMINI_OUTPUT_USD_PER_M=
DEEPSEEK_INPUT_USD_PER_M=
DEEPSEEK_OUTPUT_USD_PER_M=
```

Jangan menjual layanan sebelum nilai biaya dan ketentuan penggunaan komersial provider diverifikasi.

## 4. Jalankan infrastructure

```powershell
docker compose up -d
docker compose ps
```

PostgreSQL berjalan pada port `5432`, Redis pada `6379`.

## 5. Install dan database

```powershell
pnpm install
pnpm config:check
pnpm db:validate
pnpm db:generate
pnpm db:migrate
```

`pnpm config:check` harus menghasilkan `"ready": true`. Report hanya menampilkan jumlah provider key, bukan nilainya.

## 6. Jalankan aplikasi

```powershell
pnpm dev
```

- Web: `http://localhost:3000/dashboard`
- API live: `http://localhost:4100/health/live`
- API readiness: `http://localhost:4100/health/ready`

Status `live=true` hanya berarti proses hidup. Status `ready=true` berarti provider, konfigurasi minimum, koneksi PostgreSQL, dan koneksi Redis tersedia.

## 7. Hubungkan Electron

Di Settings AI Cliper Studio Plus:

```text
Provider Type: Cliper Cloud Gateway
Base URL: http://localhost:4100/v1
API key: nilai CLIPER_DEV_API_KEY
Model: auto
```

Model dan batas token tetap ditentukan server. Development key harus dihapus ketika database-backed API key sudah aktif.

## 8. QA sebelum commit

```powershell
pnpm qa
pnpm db:validate
```

Jangan lanjut deployment bila typecheck, test, build, environment check, atau migration gagal.

## Troubleshooting

### `docker` tidak dikenali

Install Docker Desktop, aktifkan WSL 2, restart terminal, lalu jalankan `docker version`.

### Readiness `false`

Periksa array `errors`, `warnings`, jumlah key provider, `DATABASE_URL`, dan `REDIS_URL` dari `/health/ready`.

### Provider content kosong

Gateway otomatis mencoba ulang dan fallback. Periksa model, quota, key, dan response provider di log server tanpa mencetak key.

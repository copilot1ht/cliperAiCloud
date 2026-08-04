# Local Cloud + Electron Trial

Dokumen ini adalah urutan uji fase pertama sebelum deploy. Provider key tidak pernah dimasukkan ke Electron. Electron hanya menerima Cliper key (`clip_sk_...`) dan berkomunikasi dengan gateway lokal.

## Endpoint lokal

- Web: `http://localhost:3000`
- API health: `http://127.0.0.1:4100/health`
- Endpoint Electron: `http://127.0.0.1:4100/v1`

`/v1` wajib dipertahankan pada endpoint Electron. API akan memakai host yang sama untuk aktivasi desktop, heartbeat, analysis job, wallet, dan AI Router.

## 1. Jalankan Cloud lokal

```powershell
cd "C:\Users\USER\Desktop\Cliper Ai Cloud"
pnpm install
if (-not (Test-Path .env)) { pnpm env:local }
pnpm db:generate
pnpm exec prisma migrate deploy
pnpm dev
```

PostgreSQL wajib aktif. `.env` lokal menggunakan `ANALYSIS_BILLING_STORAGE=postgres`, sehingga provider, router, usage, reservation, dan margin tidak hilang saat API restart.

Smoke test account/license tanpa memanggil provider:

```powershell
$env:CLIPER_TEST_PASSWORD = "password-akun-unlimited-lokal"
pnpm qa:local-cloud -CreateKey
```

Password hanya dibaca dari environment atau prompt dan tidak disimpan oleh script. Script menguji health API, login, generate key, verify license, desktop activation, signed heartbeat, dan `/v1/models`. Tambahkan `-RequireAi` setelah provider sudah aktif untuk memaksa test chat nyata.

## 2. Setup provider sebagai admin

1. Login ke `http://localhost:3000/login` memakai akun admin lokal.
2. Buka **Providers**.
3. Tambahkan DeepSeek dan OpenAI satu per satu.
4. Tempel provider API key hanya di halaman admin.
5. Isi tarif model terbaru dalam USD per 1 juta token: input, cached input, output, dan reasoning.
6. Klik **Test API**, lalu **Simpan**.

Provider tanpa tarif tidak akan dipakai oleh AI Router. Pengaman ini mencegah provider cost dan margin tercatat nol secara palsu.

Jika memakai DeepSeek + OpenAI, kedua key dimasukkan dari menu Admin **Providers**. Jangan mengisi key provider pada `.env` atau Electron kecuali untuk bootstrap server lokal; Electron selalu memakai satu key Cliper user.

## 3. Validasi AI Router

1. Buka **AI Router**.
2. Pastikan default task-based routing masuk akal:
   - Story, ranking, highlight, dan caption: DeepSeek primary.
   - Title, hook, dan metadata: OpenAI primary.
   - Provider kedua menjadi fallback.
3. Klik **Test auto route**.
4. Hasil yang benar: `Connected`, latency nyata, token usage lebih dari nol, dan respons `OK`.

Test ini memakai akun owner unlimited. Saldo tidak dipotong, tetapi provider cost tetap tercatat sebagai biaya internal.

## 4. Buat Cliper key sebagai user

1. Buka tab/incognito baru dan login memakai akun user unlimited lokal.
2. Buka **API Keys**.
3. Klik **Create key**.
4. Salin raw key saat ditampilkan. Raw key hanya ditampilkan satu kali.

Jangan memasukkan DeepSeek/OpenAI key ke Electron. Electron hanya menerima key berawalan `clip_sk_`.

## 5. Jalankan Electron ke Cloud lokal

```powershell
cd "C:\Users\USER\Desktop\Cliper Ai Studio"
npm run start:local-cloud
```

Di **Settings > API**:

1. Endpoint harus tampil `http://127.0.0.1:4100/v1`.
2. Tempel `clip_sk_...`.
3. Model tetap `auto`.
4. Klik **Hubungkan & Test Cloud**.

Tombol tersebut menguji seluruh rantai: aktivasi key, device binding, signed desktop session, heartbeat, AI Router, provider call, dan usage persistence.

## 6. Verifikasi dashboard

Setelah satu test atau Find Highlight:

- Dashboard user: input/output token dan request bertambah.
- Akun unlimited: saldo tidak berkurang.
- Admin Revenue: provider cost bertambah.
- Admin Revenue untuk akun unlimited: billed revenue tetap nol dan gross profit turun sebesar biaya internal. Ini bukan kerugian palsu, tetapi biaya pemakaian owner.
- Akun biasa: wallet direservasi dan dipotong melalui ledger PostgreSQL.
- Admin Providers: latency dan health berasal dari request provider, bukan angka contoh.

## Batas latency

Gateway lokal hanya mengurangi overhead koneksi antara Electron dan Cloud. Latency internet ke DeepSeek/OpenAI tetap ada dan tidak dapat dibuat nol. Target yang benar adalah overhead gateway kecil, timeout jelas, serta fallback otomatis bila primary gagal.

## Syarat lulus fase pertama

- Provider dan routing tetap ada setelah API restart.
- Electron menolak key selain Cliper key.
- Test Cloud menghasilkan respons AI nyata.
- Usage user dan admin bertambah dari request yang sama.
- Akun unlimited tidak dipotong tetapi provider cost tetap tercatat.
- Setelah provider aktif dan tarifnya terisi, akun biasa tanpa saldo menerima `402 INSUFFICIENT_CREDITS` sebelum provider dipanggil.
- Tidak ada provider key di browser bundle, Electron config, atau log.

## Hasil smoke test lokal yang sudah diverifikasi

- API health: PASS di `http://127.0.0.1:4100/health`.
- Web login: PASS di `http://localhost:3000/login`.
- User unlimited login dan generate `clip_sk_...`: PASS.
- License verify: PASS (`enterprise`, unlimited).
- Desktop activation + signed heartbeat: PASS.
- AI provider/model call: menunggu admin mengisi dan mengetes minimal satu provider; tanpa provider, status `NOT READY` adalah perilaku yang benar dan tidak dianggap sukses palsu.

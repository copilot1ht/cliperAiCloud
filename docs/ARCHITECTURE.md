# Arsitektur Cliper AI Cloud

```text
Cliper Studio Plus Desktop
        |
        | Bearer clip_sk_* key + OpenAI-compatible request
        v
NestJS Gateway /v1/chat/completions
        |
        +-- key, quota, device, rate-limit validation
        +-- module-aware routing policy
        +-- usage and cost ledger
        |
        v
AI Router
   |          |          |        |        |
   v          v          v        v        v
DeepSeek   Gemini     OpenAI    Qwen    Claude native
```

## Routing

Provider dipilih berdasarkan modul, status, prioritas, kegagalan terakhir, dan ketersediaan key. Respons kosong dianggap gagal dan diteruskan ke provider berikutnya. Satu provider dapat mempunyai banyak key yang dirotasi.

Plan tidak boleh dipercaya dari payload desktop. Gateway mengambil plan dari API key/subscription server-side lalu menimpa metadata request sebelum routing.

User juga tidak boleh memilih plan atau device limit ketika membuat key. Key issuance mengambil kedua nilai tersebut dari account server-side. Respons publik menormalkan provider/model menjadi `cliper-cloud`/`auto` dan hanya membawa `credit_charge_micro`; provider cost, service cost, markup, dan gross profit tetap berada di control plane admin.

## Cliper API key

User menerima raw key sekali dengan format `clip_sk_*`. Database hanya menyimpan prefix untuk pencarian/tampilan dan HMAC-SHA256 hash menggunakan server-side pepper. Gemini, DeepSeek, OpenAI, atau provider key lain tidak pernah dikirim ke browser member maupun desktop.

## Credits

Cliper Credits bukan raw model tokens. Raw input/output tokens dipakai untuk menghitung provider cost. Provider cost ditambah compute, payment fee, reserve, dan markup lalu dikonversi ke service credits menggunakan pricing snapshot yang berlaku ketika request dibuat.

Markup 50% berbeda dengan gross margin 50%. Cost 80 dan charge 120 menghasilkan markup 50%, profit 40, tetapi gross margin terhadap revenue adalah 33,3%.

Provider Manager memakai katalog backend, bukan konfigurasi endpoint bebas dari browser. Admin hanya memilih provider dan menempel API key. API menjalankan `GET /models` dengan autentikasi resmi provider, menyaring model chat yang kompatibel, mengukur latency, lalu menyimpan base URL, protocol, model, health, dan waktu pemeriksaan. DeepSeek, Gemini, OpenAI, dan Qwen dirutekan melalui Chat Completions; Claude memakai Anthropic Messages API native.

Setiap penambahan key wajib lolos validasi provider. Default model hanya dapat dipilih dari model hasil discovery. Kegagalan test mengubah health menjadi offline tanpa menghapus key terakhir yang masih tersimpan.

Di production, key dari database harus didekripsi sesaat sebelum pemanggilan provider. Jangan menyimpan JSON berisi raw key di repository.

## Billing

Gateway menyimpan empat angka terpisah:

- `provider_cost`: estimasi biaya asli provider berdasarkan usage yang dikembalikan.
- `service_cost`: provider cost ditambah compute, payment fee, dan reserve.
- `billed_cost`: service cost ditambah target markup.
- `gross_profit`: billed cost dikurangi service cost.

Ledger harus immutable. Koreksi dilakukan dengan adjustment entry, bukan mengubah usage lama.

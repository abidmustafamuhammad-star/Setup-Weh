# ReceOTP (nokos-otp-v2) — Panduan Deploy

## Perbaikan yang sudah dilakukan
1. **Bug kritis MongoDB driver v6**: semua `findOneAndUpdate(...).value` diperbaiki karena driver v6 sudah tidak membungkus hasil dalam `.value`. Ini sebelumnya membuat proses deposit, order, refund, dan adjust saldo admin gagal diam-diam.
2. **Index database**: ditambahkan pembuatan index otomatis (unique username/email/token/invoice, TTL session, unique webhook log) lewat `lib/db.js` agar idempotency webhook & integritas data benar-benar berjalan.
3. **Endpoint admin setup**: `POST /api/auth/admin-setup` untuk menjadikan akun (yang sudah register) sebagai admin pakai `ADMIN_SETUP_KEY`, tanpa tergantung "user pertama otomatis admin".
4. **Bersihkan file/folder sampah** (`api/webhooks/jeeyhosting/...`) dan kredensial yang ter-commit di `.env.example`.
5. **.gitignore** ditambahkan agar `.env`, `node_modules`, dll tidak ikut ter-commit.

## ⚠️ Wajib dilakukan sebelum deploy
Karena repo lama Anda sempat menyimpan kredensial asli di `.env.example` secara publik:
1. Ganti password user MongoDB Atlas Anda.
2. Regenerate API token SMSCode.gg.
3. Regenerate API key Pakasir.
4. Jangan pernah commit `.env` berisi nilai asli — isi env var hanya lewat dashboard Vercel.

## Cara login sebagai admin
Sistem login admin & user **sama** (email/username + password), dibedakan lewat field `role` di database. Dua cara membuat akun admin:

- **Otomatis**: user pertama yang register lewat `/api/auth/register` otomatis jadi `role: admin`.
- **Manual (disarankan)**: setelah user biasa register, jadikan admin lewat:
  ```bash
  curl -X POST https://domain-anda.com/api/auth/admin-setup \
    -H "Content-Type: application/json" \
    -d '{"setup_key":"ISI_ADMIN_SETUP_KEY_ANDA","login":"email_atau_username_user"}'
  ```
  Setelah itu login seperti biasa di halaman `/login`, lalu otomatis diarahkan ke `/admin`.

Data user (saldo, riwayat order, nomor OTP) tetap mengikuti alur normal lewat respons API SMSCode.gg — tidak ada perubahan di sana, hanya bagian auth/admin yang diperjelas.

## Deploy ke Vercel
1. Push repo ini ke GitHub (akun baru/repo baru disarankan karena repo lama sudah terekspos kredensial).
2. Di Vercel: **New Project** → import repo.
3. Buka **Settings → Environment Variables**, isi semua variabel berikut (untuk Production & Preview):
   - `MONGODB_URI`
   - `MONGODB_DB`
   - `SMSCODE_API_TOKEN`
   - `PAKASIR_SLUG`
   - `PAKASIR_API_KEY`
   - `BASE_URL` (isi dengan domain final Anda, contoh `https://receotp.web.id`)
   - `APP_NAME`
   - `ADMIN_SETUP_KEY` (string acak panjang, contoh hasil `openssl rand -hex 32`)
4. Deploy. Vercel otomatis mendeteksi `vercel.json` (rewrite semua request ke `api/index.js`, Express dijalankan sebagai serverless function).
5. Pastikan IP Vercel diizinkan di MongoDB Atlas → **Network Access** → tambahkan `0.0.0.0/0` (allow from anywhere), karena IP serverless Vercel dinamis.
6. Cek `https://nama-project.vercel.app/health` → harus muncul `{"ok":true}`.

## Pakai domain dari Cloudflare
1. Di Vercel: **Settings → Domains** → tambahkan domain Anda (contoh `receotp.web.id`).
2. Vercel akan kasih target, biasanya:
   - Untuk root domain: `A` record ke `76.76.21.21`
   - Untuk subdomain (`www`/`app`): `CNAME` ke `cname.vercel-dns.com`
3. Login ke Cloudflare dashboard → DNS → tambahkan record sesuai instruksi Vercel.
4. **Penting**: di Cloudflare, set proxy status record tersebut ke **"DNS only"** (awan abu-abu, bukan oranye) saat pertama setup, sampai Vercel memverifikasi domain & menerbitkan SSL. Setelah status "Valid Configuration" di Vercel, baru boleh diaktifkan proxy oranye Cloudflare kalau mau pakai CDN/proteksi Cloudflare.
5. Tunggu propagasi DNS (beberapa menit – beberapa jam), lalu cek `https://domain-anda.com/health`.

## Catatan rate-limit & login-attempt
`rateStore` dan `loginAttempts` disimpan in-memory per instance serverless — akan reset saat cold start (instance baru). Ini cukup untuk skala kecil-menengah; kalau traffic besar dan butuh rate-limit konsisten, sebaiknya pindah ke Redis (Upstash, tersedia gratis & cocok untuk Vercel).

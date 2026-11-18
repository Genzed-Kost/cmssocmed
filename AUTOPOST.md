# Posting Otomatis Multi-Platform

CMS bisa memposting konten sendiri ke **Instagram, Facebook, YouTube, dan TikTok** saat jadwalnya tiba. Web CMS tidak perlu dibuka.

## Cara kerja

1. Di form konten, centang **⚡ Posting Otomatis**, lalu isi jam tayang (WIB) dan link file final di Google Drive.
2. Ubah status konten ke **ACC** atau **Done**. Konten berstatus lain tidak akan diposting.
3. GitHub Actions (`.github/workflows/auto-post.yml`) memeriksa jadwal tiap 15 menit. Konten yang jatuh tempo diunduh lalu diposting ke setiap platform yang dicentang.
4. Link postingan otomatis masuk ke kolom link platform. Kalau semua platform berhasil, status berubah jadi **Published**. Setiap kejadian juga dicatat di Activity Log oleh pengguna "Auto-Post".

**Caption:** diambil dari kolom *Caption Medsos*. Kalau caption punya bagian `=== INSTAGRAM ===`, `=== TIKTOK ===`, `=== FACEBOOK ===`, atau `=== YOUTUBE ===`, setiap platform memakai bagiannya sendiri. Kalau tidak ada, dipakai cadangan yang paling mirip (misalnya Facebook memakai bagian Instagram). Catatan SEO setelah `---` tidak ikut diposting.

**Pengaman supaya tidak terposting dobel:** konten ditandai "sedang diposting" sebelum proses dimulai. Kalau proses mati di tengah jalan, status berubah jadi **❗ Perlu dicek** dan sistem tidak mencoba lagi sendiri. Cek dulu di platform apakah konten sudah tayang. Kalau belum, klik **Coba lagi** lalu simpan.

**Batas percobaan:** setiap platform dicoba maksimal 3 kali. Kesalahan setting, seperti token kosong atau link Drive yang salah, tidak diulang dan langsung ditampilkan. Konten yang terlambat lebih dari 48 jam dari jadwal dilewati.

> Jadwal GitHub Actions bisa telat 5–15 menit saat server GitHub sedang ramai. Jadi postingan yang dijadwalkan jam 19:00 biasanya tayang sekitar 19:00–19:20.

## ⚠️ Batasan platform yang perlu diketahui

| Platform | Yang dibutuhkan | Catatan penting |
|---|---|---|
| Instagram | Akun **Business/Creator** yang terhubung ke Facebook Page | Bisa Reels dan foto. Foto diambil langsung oleh Instagram dari link Drive. |
| Facebook | Admin Page | Format *Short* diposting sebagai Reels; format lain sebagai video biasa. |
| YouTube | Project Google Cloud + OAuth | Selama project API **belum lolos audit YouTube**, semua video yang diupload lewat API **terkunci privat**. Ajukan audit lewat formulir *YouTube API Services – Audit and Quota Extension*. |
| TikTok | Aplikasi di developers.tiktok.com + produk *Content Posting API* | Sebelum aplikasi **lolos audit TikTok**, postingan hanya bisa **privat (SELF_ONLY)**, akun tujuan harus berstatus privat, dan maksimal 5 akun per 24 jam. Isi `privacyLevel: "SELF_ONLY"` sampai audit lolos. |
| X (Twitter) | — | Belum didukung. API X berbayar. |

## Setup (sekali saja)

Semua token disimpan di **GitHub Secret**, bukan di `data/settings.json`. Repo ini **publik**, jadi apa pun yang ada di folder `data/` bisa dibaca siapa saja.

### 1. Siapkan kredensial

Jalankan helper di **laptop Anda sendiri** (perlu Node 18+):

**Facebook + Instagram**
1. Buat aplikasi tipe *Business* di developers.facebook.com. Tambahkan produk *Facebook Login for Business* dan *Instagram*.
2. Buka *Graph API Explorer*, pilih aplikasi tadi, lalu buat **User Token** dengan izin: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `business_management`, `instagram_basic`, `instagram_content_publish`.
3. Jalankan:
   ```
   node .github/scripts/autopost/get-token.js meta <APP_ID> <APP_SECRET> <USER_TOKEN>
   ```
   Hasilnya adalah `pageId`, page token permanen, dan `igUserId` untuk setiap Page.
4. Untuk memakainya di akun resmi selain akun Anda sendiri, aplikasi perlu melalui **App Review** Meta untuk izin-izin di atas. Selama masih tahap pengembangan, aplikasi hanya berfungsi untuk akun yang punya role di aplikasi tersebut.

**YouTube**
1. Di console.cloud.google.com, aktifkan *YouTube Data API v3*. Buat **OAuth Client ID** tipe *Desktop app*.
2. Jalankan:
   ```
   node .github/scripts/autopost/get-token.js youtube <CLIENT_ID> <CLIENT_SECRET>
   ```
   Login dengan akun pemilik channel, lalu pilih channel yang benar.
3. Kalau OAuth consent screen masih *Testing*, refresh token kedaluwarsa dalam 7 hari. Ubah ke **In production**.

**TikTok**
1. Di developers.tiktok.com, buat aplikasi. Tambahkan produk *Login Kit* dan *Content Posting API* (aktifkan *Direct Post*). Daftarkan Redirect URI, misalnya alamat web CMS Anda (`https://<domain-cms>/`).
2. Jalankan:
   ```
   node .github/scripts/autopost/get-token.js tiktok <CLIENT_KEY> <CLIENT_SECRET> <REDIRECT_URI>
   ```
3. Refresh token TikTok berlaku sekitar 1 tahun. Ulangi langkah ini sebelum habis.

### 2. Gabungkan jadi satu JSON

Kunci di level atas harus sama dengan **ID akun** di CMS (`penjaga-harapan`, `33-official`, `jaga-asa`, …). Platform yang tidak dipakai boleh dihapus.

```json
{
  "penjaga-harapan": {
    "instagram": { "igUserId": "1784…", "accessToken": "EAAG…" },
    "facebook":  { "pageId": "1029…", "pageToken": "EAAG…" },
    "youtube":   { "clientId": "…apps.googleusercontent.com", "clientSecret": "…", "refreshToken": "1//…", "categoryId": "25", "privacy": "public" },
    "tiktok":    { "clientKey": "…", "clientSecret": "…", "refreshToken": "rft.…", "privacyLevel": "SELF_ONLY" }
  },
  "33-official": { "instagram": { "igUserId": "…", "accessToken": "…" } }
}
```

Opsi tambahan:
- `youtube.categoryId`: `25` = News & Politics, `22` = People & Blogs.
- `facebook.useReels: false`: posting video Short sebagai video biasa, bukan Reels.

### 3. Simpan sebagai GitHub Secret

Repo → **Settings → Secrets and variables → Actions → New repository secret**
- Name: `AUTOPOST_CREDENTIALS`
- Value: seluruh JSON di atas

### 4. Uji coba

Repo → **Actions → Auto-Post Multi Platform → Run workflow**, biarkan *Uji coba* tercentang.
Mode ini mengunduh file dan memeriksa kredensial tanpa memposting dan tanpa mengubah data. Kalau ingin menguji satu konten tertentu, isi *ID konten*.

Setelah lolos, buat satu konten percobaan di akun uji, aktifkan Posting Otomatis dengan jam 5 menit dari sekarang, lalu tunggu workflow terjadwal berjalan.

## Arti status di form konten

| Status | Arti | Tindakan |
|---|---|---|
| ⏳ Sedang diposting | Sedang diproses sistem | Tunggu |
| ✅ Tayang | Berhasil, link tersedia | — |
| ⚠️ Gagal | Gagal. Dicoba ulang otomatis sampai 3x kecuali kesalahan setting | Baca pesannya, perbaiki, lalu klik **Coba lagi** dan simpan |
| ❗ Perlu dicek | Proses terputus di tengah | Cek manual di platform. Klik **Coba lagi** hanya kalau konten belum tayang |
| ⏭️ Dilewati | Sudah lewat >48 jam dari jadwal | Ubah jadwal, klik **Coba lagi**, lalu simpan |

## File terkait

- `.github/workflows/auto-post.yml`: jadwal 15 menit dan uji coba manual
- `.github/scripts/autopost/run.js`: alur claim → post → apply
- `.github/scripts/autopost/platforms/`: integrasi Meta, YouTube, TikTok
- `.github/scripts/autopost/get-token.js`: helper untuk mengambil token
- Tes: `node --test .github/scripts/autopost/test/autopost.test.js`

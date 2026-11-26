/* ================================================================
   Info versi & pembaruan — terbaru di atas. Perbarui setiap rilis.
   - items      : pembaruan yang dirasakan SEMUA user → tampil di halaman login
   - adminItems : pembaruan khusus Admin → muncul sebagai pop up saat Admin
                  masuk (maksimal sekali sehari)
   ================================================================ */
window.APP_INFO = {
  name: 'Penjaga Harapan CMS',
  tagline: 'Platform manajemen konten tim',
  version: '2.6.5',
  changelog: [
    {
      version: '2.6.5', date: '2026-11-19',
      items: [
        '📺 Stock Contents: slot tayang tiap program otomatis muncul di kalender sesuai hari tayangnya',
        '🔎 Stock Contents: filter kalender Semua / Tayang / Produksi',
        '📊 Statistik: unduhan Grafik (JPG) kini berisi grafik batang Views, Followers & Engagement per platform tiap akun',
        '📰 Info Presiden kini 20 berita: 15 berita presiden + 5 berita teknologi global (prioritas China)',
      ],
      adminItems: [
        '📺 Slot tayang otomatis di kalender Stock Contents (Podcast PH & JA Selasa, Situation Room & Belajar Koperasi Rabu, Liputan PH & Gimana Kabarnya Kamis, Liputan JA Jumat, Productive Hangout Sabtu, Konsultasi Hukum Keluarga Minggu)',
        '👆 Klik slot untuk memilih konten tayang dari stok program itu, atau buat konten baru',
        '🗓 Hari tayang & pola minggu (setiap minggu / 2 minggu sekali) tiap program bisa diubah di API Setup → Daftar Program; Rabu: Belajar Koperasi & Situation Room selang-seling',
        '🔒 Konten yang sudah tayang tidak bisa dipindah tanggal tayangnya',
      ],
    },
    {
      version: '2.6.4', date: '2026-11-18',
      items: [
        '▶️ Stock Contents: setelah tanggal tayang, link video YouTube (Penjaga Harapan & Jaga Asa) otomatis muncul di detail konten (ikon ▶ di kalender)',
      ],
      adminItems: [
        '▶️ Link YouTube otomatis: konten yang sudah lewat tanggal tayang dicocokkan dengan video channel @PenjagaHarapan dan @JagaAsaPodcast berdasarkan judul & deskripsi video serta tanggal terbit',
        '🗒 Activity Log kini mencatat seluruh aktivitas: Stock Contents, Aset, link platform, pengaturan (API, token, URL, KPI, Daftar Program, akun), import & unduhan statistik, serta fitur AI',
        '🏷 Link YouTube yang diisi manual kini otomatis menampilkan judul video & nama channel',
        '✍️ Link YouTube bisa diubah manual di form Ubah Stock Content; dikosongkan = tidak ditautkan otomatis lagi',
        '💡 Agar cocok otomatis, sertakan judul konten (atau nama narasumber) di judul/deskripsi video YouTube',
      ],
    },
    {
      version: '2.6.1', date: '2026-11-18',
      items: [
        '🗒 Activity Log lebih ringkas: 2 kolom, tiap aktivitas 2 baris, nomor halaman ‹ 1 2 3 … 23 24 25 ›',
        '📊 Statistik: filter periode Mingguan (4/8/12 minggu) kini benar-benar mengubah grafik & ringkasan',
        '👥 Facebook & Instagram: Follows (pengikut baru selama periode) dan Followers (total pengikut hingga akhir periode) kini dibedakan',
        '📘 Statistik Facebook & Instagram disederhanakan: Views, Viewers/Reach, Total Eng/Reactions, Visits Profile, Followers, Follows (+ Jumlah Konten untuk IG)',
      ],
      adminItems: [
        '👥 Follows = pengikut baru selama periode (isi manual); Followers = total pengikut hingga akhir periode',
        '🔁 Followers mingguan terisi otomatis: Followers minggu lalu + Follows minggu ini (minggu pertama diisi manual sebagai titik awal)',
        '📅 Data Bulanan dari mingguan: Follows dijumlah, Followers diambil dari minggu terakhir — angka manual tetap tidak ditimpa',
        '📊 Filter Mingguan 4/8/12 minggu kini memfilter grafik, ringkasan, dan analisis (berdasarkan minggu terakhir yang ada datanya)',
        '🔔 Pop up pembaruan ini muncul lagi setiap ada pembaruan baru, selain sekali sehari',
      ],
    },
    {
      version: '2.6.0', date: '2026-11-16',
      items: [
        '💬 Pesan antar user: teks, emoji, foto & file (maks 10 MB), hapus ≤ 60 menit, foto sekali lihat',
        '✨ Tampilan baru yang lebih modern: Dashboard, Planner, Statistik, Aset, New Post & Login',
        '🎨 Logo resmi Penjaga Harapan di login, sidebar, dan ikon browser',
        '📅 Stock Contents tampil sebagai kalender, lengkap dengan jam produksi',
        '✍️ Auto-Caption AI bergaya berita + SEO, dibuat terpisah sesuai platform distribusi yang dipilih',
        '📰 Info Presiden: berita lebih baru & berganti setiap refresh (jeda 5 menit)',
        '🖨 PDF Laporan Planner lebih rapi dengan nomor halaman',
        '📈 Kurs USD/IDR & IHSG live di sidebar',
        '🧭 Menu samping baru: klik tepi sidebar untuk membuka/menutup (HP: tab tepi kiri / usap)',
      ],
      adminItems: [
        '📊 Statistik: Data Bulanan terisi otomatis dari Data Mingguan — angka yang diisi manual tidak ditimpa',
        '🧮 ER % dihitung otomatis (Total Engagement ÷ Views); kolom ditandai AUTO',
        '📘 Statistik Facebook & Instagram disederhanakan (Views, Viewers/Reach, Total Eng/Reactions, Visits Profile, Followers, Follows, Jumlah Konten)',
        '👥 Follows = pengikut baru selama periode (isi manual); Followers = total pengikut hingga akhir periode — mingguan otomatis: followers minggu lalu + Follows',
        '🗂 Tabel Data Bulanan kini berupa dropdown; form edit data jadi pop up ringkas',
        '🎙 Daftar Program (kelompok Stock Contents) bisa diatur di API Setup',
        '💬 Fitur Pesan berjalan di Cloudflare (D1 + R2); pesan & file tidak masuk repo GitHub',
        '🧹 Kode Netlify & file lama di root repo sudah dihapus — hosting: Cloudflare Pages',
      ],
    },
    {
      version: '2.0.0', date: '',
      items: [
        '🚀 Rilis CMS v2: Planner, Bank Konten, Statistik, Aset, Activity Log',
      ],
    },
  ],
};

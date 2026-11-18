/* ================================================================
   Info versi & pembaruan — terbaru di atas. Perbarui setiap rilis.
   - items      : pembaruan yang dirasakan SEMUA user → tampil di halaman login
   - adminItems : pembaruan khusus Admin → muncul sebagai pop up saat Admin
                  masuk (maksimal sekali sehari)
   ================================================================ */
window.APP_INFO = {
  name: 'Penjaga Harapan CMS',
  tagline: 'Platform manajemen konten tim',
  version: '2.6.0',
  changelog: [
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

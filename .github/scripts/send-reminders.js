/**
 * send-reminders.js — WA Reminder otomatis jam 08:00 WIB
 * Dijalankan GitHub Actions. Tidak perlu membuka web.
 *
 * Alur:
 * 1. Baca data/contentBank.json & data/settings.json
 * 2. Decode Fonnte token dari settings (XOR encode, sama dengan app.js)
 * 3. Filter konten: publishDate = hari ini & belum diingatkan
 * 4. Kirim WA per creator dengan format LENGKAP semua field Bank Konten
 * 5. Tandai remindedDate & simpan kembali
 */

const fs   = require('fs');
const path = require('path');

/* ── Konfigurasi ─────────────────────────────────────────────────── */
const BK_ACCOUNTS = {
  'penjaga-harapan': 'Penjaga Harapan',
  '33-official':     '33 Official',
  'jaga-asa':        'Jaga Asa'
};

/* XOR decode — identik dengan _decodeToken() di app.js */
const _TK = 'cmsph_ph_2024_xk';
function decodeToken(s) {
  if (!s) return '';
  if (/^[0-9a-f]+$/.test(s) && s.length % 2 === 0) {
    try {
      const bytes = s.match(/.{2}/g).map(h => parseInt(h, 16));
      const r = bytes.map((b, i) =>
        String.fromCharCode(b ^ _TK.charCodeAt(i % _TK.length))
      ).join('');
      if (r) return r;
    } catch {}
  }
  try { return Buffer.from(s, 'base64').toString('latin1'); } catch {}
  return s;
}

/* ── Tanggal ─────────────────────────────────────────────────────── */
function todayWIB() {
  const now = new Date();
  const wib = new Date(now.getTime() + 7 * 3600 * 1000);
  return wib.toISOString().slice(0, 10);
}

function fmtDateLong(str) {
  if (!str) return str;
  const DAYS   = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
  const MONTHS = ['Januari','Februari','Maret','April','Mei','Juni',
                  'Juli','Agustus','September','Oktober','November','Desember'];
  const [y, m, d] = str.split('-').map(Number);
  const day = new Date(y, m - 1, d).getDay();
  return `${DAYS[day]}, ${d} ${MONTHS[m - 1]} ${y}`;
}

/* ── Format Pesan Lengkap ────────────────────────────────────────── */
function buildMessage(creatorName, items, today) {
  const tgl  = fmtDateLong(today);
  const line = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

  let msg = `🔔 *REMINDER KONTEN HARI INI*\n`;
  msg    += `📅 ${tgl}\n\n`;
  msg    += `Halo *${creatorName}*! 👋\n\n`;

  if (items.length === 1) {
    msg += `Kontenmu dijadwalkan tayang hari ini:\n`;
  } else {
    msg += `Kamu punya *${items.length} konten* yang jadwal tayang hari ini:\n`;
  }

  items.forEach((item, i) => {
    const acctName = BK_ACCOUNTS[item.account] || item.account || '—';
    msg += `\n${line}\n`;
    if (items.length > 1) msg += `*${i + 1}.*\n`;
    msg += `📝 *${(item.title || '(tanpa judul)').toUpperCase()}*\n`;
    msg += `📌 Akun     : *${acctName}*\n`;
    if (item.reference) msg += `🔗 Referensi : ${item.reference}\n`;
    if (item.linkDrive) msg += `📂 Drive     : ${item.linkDrive}\n`;
    msg += `⏰ Tayang   : ${tgl}\n`;
    if (item.createdBy && item.createdBy !== creatorName) {
      msg += `👤 Di-input  : ${item.createdBy}\n`;
    }
  });

  msg += `\n${line}\n`;
  msg += `📊 Total: *${items.length} konten* hari ini\n\n`;
  msg += `_Segera selesaikan & upload kontenmu! 🚀_\n`;
  msg += `_— Penjaga Harapan CMS_`;
  return msg;
}

/* ── Kirim WA via Fonnte ─────────────────────────────────────────── */
async function sendWA(token, phone, message) {
  if (!token || !phone) return false;
  const clean  = String(phone).replace(/\D/g, '');
  const target = clean.startsWith('0') ? '62' + clean.slice(1) : clean;
  if (!target) return false;

  const fd = new FormData();
  fd.append('target', target);
  fd.append('message', message);

  try {
    const r   = await fetch('https://api.fonnte.com/send', {
      method: 'POST', headers: { Authorization: token }, body: fd
    });
    const res = await r.json();
    console.log(`    → ${target}: ${res.status ? '✅ OK' : '❌ GAGAL'} — ${JSON.stringify(res)}`);
    return !!res.status;
  } catch (e) {
    console.error(`    → ${target}: ERROR — ${e.message}`);
    return false;
  }
}

/* ── Main ────────────────────────────────────────────────────────── */
async function main() {
  const today = todayWIB();
  console.log(`\n⏰  WA Reminder — ${today} (08:00 WIB)\n`);

  /* Baca data dari repo */
  const root        = process.cwd();
  const bankKonten  = JSON.parse(fs.readFileSync(path.join(root, 'data', 'contentBank.json'), 'utf8'));
  const settings    = JSON.parse(fs.readFileSync(path.join(root, 'data', 'settings.json'),   'utf8'));
  const users       = settings.users || [];

  /* Fonnte token: dari settings.json (encoded) ATAU env FONNTE_TOKEN (fallback) */
  const fonnteRaw   = settings.fonnte || '';
  const fonnteToken = fonnteRaw ? decodeToken(fonnteRaw) : (process.env.FONNTE_TOKEN || '');

  if (!fonnteToken) {
    console.warn('⚠️  Fonnte token belum dikonfigurasi.\n   → Isi di API Setup → WhatsApp Notifikasi, lalu Simpan Token.');
    return;
  }

  /* Filter: publishDate = hari ini, belum diingatkan, ada creator */
  const toRemind = bankKonten.filter(item =>
    item.publishDate === today &&
    item.remindedDate !== today &&
    item.creator
  );

  if (!toRemind.length) {
    console.log('Tidak ada konten yang jadwal tayang hari ini. Selesai.');
    return;
  }

  console.log(`${toRemind.length} item akan diingatkan:\n`);
  toRemind.forEach(i => console.log(`  - [${i.account}] ${i.title} → ${i.creator}`));

  /* Kelompokkan per creator */
  const byCreator = {};
  for (const item of toRemind) {
    const creators = Array.isArray(item.creator)
      ? item.creator
      : [item.creator].filter(Boolean);

    for (const name of creators) {
      if (!byCreator[name]) byCreator[name] = [];
      byCreator[name].push(item);
    }
  }

  let totalSent = 0;
  console.log();

  for (const [creatorName, items] of Object.entries(byCreator)) {
    /* Cari nomor HP creator */
    const userObj = users.find(u => {
      const n = u.name || u.username || u.displayName || '';
      return n === creatorName;
    });

    if (!userObj?.phone) {
      console.log(`⚠️  ${creatorName}: nomor HP tidak ditemukan di settings — dilewati`);
      continue;
    }

    const msg = buildMessage(creatorName, items, today);
    console.log(`📨 Mengirim ke ${creatorName} (${userObj.phone})...`);
    console.log(`   Judul: ${items.map(i => i.title).join(', ')}`);

    const ok = await sendWA(fonnteToken, userObj.phone, msg);
    if (ok) totalSent++;
  }

  /* Tandai remindedDate */
  for (const item of bankKonten) {
    if (toRemind.find(r => r.id === item.id)) {
      item.remindedDate = today;
    }
  }
  fs.writeFileSync(path.join(root, 'data', 'contentBank.json'),
    JSON.stringify(bankKonten, null, 2), 'utf8');

  console.log(`\n✅  ${totalSent}/${Object.keys(byCreator).length} pesan terkirim.`);
  console.log(`   remindedDate tersimpan di contentBank.json.`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

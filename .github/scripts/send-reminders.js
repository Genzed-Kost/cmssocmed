/**
 * send-reminders.js
 * Dijalankan oleh GitHub Actions setiap jam 08:00 WIB.
 * - Baca data/contentBank.json & data/settings.json dari repo
 * - Kirim WA via Fonnte ke creator yang publishDate-nya = hari ini
 * - Tandai remindedDate & push kembali ke repo
 */

const fs   = require('fs');
const path = require('path');

const FONNTE_TOKEN = process.env.FONNTE_TOKEN || '';

/* ── Helpers ─────────────────────────────────────────────────────── */

function todayWIB() {
  // WIB = UTC+7
  const now = new Date();
  const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return wib.toISOString().slice(0, 10);   // "YYYY-MM-DD"
}

function normPhone(phone) {
  const clean = String(phone || '').replace(/\D/g, '');
  return clean.startsWith('0') ? '62' + clean.slice(1) : clean;
}

function fmtDate(str) {
  if (!str) return str;
  const [y, m, d] = str.split('-');
  const months = ['Jan','Feb','Mar','Apr','Mei','Jun',
                  'Jul','Agu','Sep','Okt','Nov','Des'];
  return `${parseInt(d)} ${months[parseInt(m) - 1]} ${y}`;
}

async function sendWA(phone, message) {
  if (!FONNTE_TOKEN || !phone) return false;
  const target = normPhone(phone);
  if (!target) return false;

  const fd = new FormData();
  fd.append('target', target);
  fd.append('message', message);

  try {
    const r = await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: { Authorization: FONNTE_TOKEN },
      body: fd
    });
    const res = await r.json();
    console.log(`  → ${target}: ${res.status ? 'OK' : 'GAGAL'} ${JSON.stringify(res)}`);
    return !!res.status;
  } catch (e) {
    console.error(`  → ${target}: ERROR`, e.message);
    return false;
  }
}

/* ── Main ─────────────────────────────────────────────────────────── */

async function main() {
  const today = todayWIB();
  console.log(`\n⏰  WA Reminder — ${today} (08:00 WIB)\n`);

  // Baca file dari repo (path relatif ke root repo)
  const bankPath     = path.join(process.cwd(), 'data', 'contentBank.json');
  const settingsPath = path.join(process.cwd(), 'data', 'settings.json');

  const bankKonten = JSON.parse(fs.readFileSync(bankPath, 'utf8'));
  const settings   = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const users      = settings.users || [];

  // Filter konten yang jadwal tayang hari ini & belum diingatkan
  const toRemind = bankKonten.filter(item =>
    item.publishDate === today &&
    item.remindedDate !== today &&
    item.creator
  );

  if (!toRemind.length) {
    console.log('Tidak ada konten yang perlu diingatkan hari ini.');
    return;
  }

  console.log(`${toRemind.length} konten akan diingatkan:\n`);

  if (!FONNTE_TOKEN) {
    console.warn('⚠️  FONNTE_TOKEN belum diset di GitHub Secrets — pesan tidak terkirim.');
    toRemind.forEach(i => console.log(`  - ${i.title} (creator: ${i.creator})`));
    return;
  }

  let sent = 0;
  for (const item of toRemind) {
    // creator bisa string atau array
    const creatorNames = Array.isArray(item.creator)
      ? item.creator
      : [item.creator].filter(Boolean);

    for (const name of creatorNames) {
      const userObj = users.find(u => {
        const n = u.name || u.username || u.displayName || '';
        return n === name;
      });
      const phone = userObj?.phone;
      if (!phone) {
        console.log(`  ⚠️  ${name}: nomor HP tidak ditemukan di settings`);
        continue;
      }

      const refLine = item.reference ? `\n🔗 *Referensi:* ${item.reference}` : '';
      const msg =
        `Halo ${name}! ⏰ *Jadwal Tayang Hari Ini*\n\n` +
        `Konten *${item.title || '(tanpa judul)'}* dijadwalkan tayang *${fmtDate(item.publishDate)}*.` +
        `${refLine}\n\nSegera siapkan kontennya! 🚀\n\n_- Penjaga Harapan CMS_`;

      console.log(`  Mengirim ke ${name} (${phone})...`);
      const ok = await sendWA(phone, msg);
      if (ok) sent++;
    }

    // Tandai sudah diingatkan
    item.remindedDate = today;
  }

  // Simpan kembali contentBank.json
  fs.writeFileSync(bankPath, JSON.stringify(bankKonten, null, 2), 'utf8');
  console.log(`\n✅  ${sent} pesan terkirim. remindedDate tersimpan.`);

  // Commit & push dilakukan oleh GitHub Actions (lihat workflow)
}

main().catch(e => { console.error(e); process.exit(1); });

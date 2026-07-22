'use strict';
/**
 * sync-youtube.js — Auto-fetch YouTube channel stats via Data API v3
 * Dipanggil oleh GitHub Actions (bulanan & mingguan).
 *
 * Secrets yang dibutuhkan di GitHub repo:
 *   YOUTUBE_API_KEY  — API key dari Google Cloud Console (YouTube Data API v3)
 *
 * Config per-akun disimpan di data/settings.json → autoSync:
 *   { "penjaga-harapan": { "youtube": { "channelId": "UCxxxx" } }, ... }
 *
 * Mode:
 *   SYNC_MODE=monthly  → simpan ke analytics[acct].youtube[]   (key: month)
 *   SYNC_MODE=weekly   → simpan ke analytics[acct].youtube_w[] (key: week, format YYYY-Www)
 */

const fs = require('fs');

const API_KEY   = process.env.YOUTUBE_API_KEY;
const MODE      = process.env.SYNC_MODE || 'monthly';   // 'monthly' | 'weekly' | 'live'
const OVERRIDE  = process.env.OVERRIDE_PERIOD || '';

const SETTINGS_PATH  = 'data/settings.json';
const ANALYTICS_PATH = 'data/analytics.json';

/* ── ISO week helper ─────────────────────────────────────────────────────── */
function toISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function resolvePeriod() {
  if (OVERRIDE) return OVERRIDE;
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm   = String(now.getUTCMonth() + 1).padStart(2, '0');

  if (MODE === 'live' || MODE === 'monthly') {
    // Bulan berjalan — live update setiap 8 jam, monthly tutup di akhir bulan
    return `${yyyy}-${mm}`;
  }
  if (MODE === 'weekly') {
    // Minggu berjalan (Minggu 23:59 = akhir minggu ini)
    return toISOWeek(now);
  }
  return `${yyyy}-${mm}`;
}

/* ── Fetch channel stats ─────────────────────────────────────────────────── */
async function fetchChannelStats(channelId) {
  const url = `https://www.googleapis.com/youtube/v3/channels` +
    `?part=statistics&id=${encodeURIComponent(channelId)}&key=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const item = data.items?.[0];
  if (!item) throw new Error(`Channel "${channelId}" tidak ditemukan.`);
  return item.statistics;
}

/* ── Upsert satu entri ke array rows ────────────────────────────────────── */
function upsertEntry(rows, periodKey, newEntry) {
  const idx = rows.findIndex(r => (r.month || r.week) === periodKey);
  if (idx >= 0) {
    rows[idx] = { ...rows[idx], ...newEntry };
    console.log(`  🔄 Update entri ${periodKey}`);
  } else {
    rows.push(newEntry);
    console.log(`  ➕ Tambah entri ${periodKey}`);
  }
}

/* ── Sync satu akun ──────────────────────────────────────────────────────── */
async function syncAccount(acctId, channelId, analytics, period) {
  console.log(`\n▶ Sync ${acctId} (${channelId}) — ${MODE} — ${period}`);
  const stats = await fetchChannelStats(channelId);
  console.log('  Raw stats:', stats);

  if (!analytics[acctId])         analytics[acctId]         = {};

  const isWeekly  = MODE === 'weekly';
  const dataKey   = isWeekly ? 'youtube_w' : 'youtube';
  const periodKey = isWeekly ? 'week' : 'month';

  if (!analytics[acctId][dataKey]) analytics[acctId][dataKey] = [];
  const rows   = analytics[acctId][dataKey];
  const sorted = [...rows].sort((a, b) => (a[periodKey] || '').localeCompare(b[periodKey] || ''));

  // Delta dari entri sebelumnya
  const prev = sorted.filter(r => (r[periodKey] || '') < period).pop() || null;

  const subsEOM         = parseInt(stats.subscriberCount) || 0;
  const totalVidCumul   = parseInt(stats.videoCount)      || 0;
  const totalViewCumul  = parseInt(stats.viewCount)       || 0;

  // Entri yang sudah ada untuk periode ini (live mode: bisa sudah ada di bulan berjalan)
  const existing = rows.find(r => (r[periodKey] || '') === period) || null;

  const prevSubsEOM    = prev?.subsEOM || 0;
  const prevMonthCumul = (typeof prev?._cumulativeViews === 'number') ? prev._cumulativeViews : null;

  // jmlVideo = total video di channel (kumulatif, sama dengan yang tampil di YouTube)
  const jmlVideo = totalVidCumul;

  // totalViews = views bulan ini
  // Prioritas 1: delta dari kumulatif akhir bulan lalu (paling akurat)
  // Prioritas 2: incremental — tambahkan selisih dari _cumulativeViews sync terakhir bulan ini
  // Prioritas 3: pertahankan nilai yang sudah ada
  let totalViews;
  if (prevMonthCumul !== null) {
    totalViews = Math.max(0, totalViewCumul - prevMonthCumul);
  } else {
    const lastSyncCumul = (typeof existing?._cumulativeViews === 'number') ? existing._cumulativeViews : null;
    if (lastSyncCumul !== null && totalViewCumul > lastSyncCumul) {
      totalViews = (existing?.totalViews || 0) + (totalViewCumul - lastSyncCumul);
    } else {
      totalViews = existing?.totalViews || 0;
    }
  }
  const subsGained = subsEOM - prevSubsEOM;

  const entry = {
    // Pertahankan semua field existing (manual: watchHours, likes, dll)
    ...(existing || {}),
    [periodKey]:      period,
    // Hanya overwrite field yang bisa diambil dari API
    jmlVideo,
    totalViews,
    subsEOM,
    subsGained,
    avgViewsPerVideo: jmlVideo > 0 ? Math.round(totalViews / jmlVideo) : (existing?.avgViewsPerVideo || 0),
    _cumulativeViews:  totalViewCumul,
    _cumulativeVideos: totalVidCumul,
    _syncedAt:         new Date().toISOString(),
  };

  upsertEntry(rows, period, entry);
  analytics[acctId][dataKey] = rows.sort((a, b) =>
    (a[periodKey] || '').localeCompare(b[periodKey] || ''));

  console.log(`  ✅ subsEOM=${subsEOM}, views=${totalViews}, video baru=${jmlVideo}, subsGained=${subsGained}`);
}

/* ── Main ─────────────────────────────────────────────────────────────────── */
async function main() {
  if (!API_KEY) throw new Error('Set YOUTUBE_API_KEY sebagai GitHub repo secret.');

  const settings  = JSON.parse(fs.readFileSync(SETTINGS_PATH,  'utf8'));
  const analytics = JSON.parse(fs.readFileSync(ANALYTICS_PATH, 'utf8'));
  const autoSync  = settings.autoSync || {};
  const period    = resolvePeriod();

  console.log(`🗓️  Mode: ${MODE} | Period: ${period}`);

  // Fallback ke env var lama jika belum ada config di settings.json
  const legacyId = process.env.YOUTUBE_CHANNEL_ID;
  if (legacyId && !autoSync['penjaga-harapan']?.youtube?.channelId) {
    autoSync['penjaga-harapan'] = { youtube: { channelId: legacyId } };
  }

  let synced = 0;
  for (const [acctId, cfg] of Object.entries(autoSync)) {
    const channelId = cfg?.youtube?.channelId;
    if (!channelId) continue;
    await syncAccount(acctId, channelId, analytics, period);
    synced++;
  }

  if (synced === 0) {
    console.log('⚠️  Tidak ada akun yang dikonfigurasi untuk auto-sync YouTube.');
    console.log('   Buka CMS → API Setup → Auto-Sync untuk menambahkan Channel ID.');
    return;
  }

  fs.writeFileSync(ANALYTICS_PATH, JSON.stringify(analytics, null, 2));
  console.log(`\n🏁 Selesai — ${synced} akun disinkronisasi.`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });

'use strict';
/**
 * sync-youtube.js — Auto-fetch YouTube channel stats via Data API v3
 * Dipanggil oleh GitHub Actions setiap tanggal 1.
 *
 * Secrets yang dibutuhkan di GitHub repo:
 *   YOUTUBE_API_KEY    — API key dari Google Cloud Console (YouTube Data API v3)
 *   YOUTUBE_CHANNEL_ID — ID channel, cth: UCxxxxxx (buka youtube.com/@nama → About → Share → Copy channel ID)
 */

const fs = require('fs');

const ACCT_ID   = 'penjaga-harapan';
const DATA_PATH = 'data/analytics.json';

/* ── Fetch channel stats dari YouTube Data API v3 ────────────────────────── */
async function fetchChannelStats(apiKey, channelId) {
  const url = `https://www.googleapis.com/youtube/v3/channels` +
    `?part=statistics&id=${encodeURIComponent(channelId)}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube API ${res.status}: ${body}`);
  }
  const data = await res.json();
  const item = data.items?.[0];
  if (!item) throw new Error(
    `Channel "${channelId}" tidak ditemukan. Cek YOUTUBE_CHANNEL_ID secret.`
  );
  return item.statistics;
}

/* ── Tentukan bulan target ────────────────────────────────────────────────── */
function resolveTargetMonth() {
  if (process.env.OVERRIDE_MONTH?.match(/^\d{4}-\d{2}$/)) {
    return process.env.OVERRIDE_MONTH;
  }
  // Default: bulan lalu (script jalan tanggal 1 bulan baru)
  const d = new Date();
  d.setDate(0); // mundur ke bulan lalu
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/* ── Main ─────────────────────────────────────────────────────────────────── */
async function main() {
  const apiKey    = process.env.YOUTUBE_API_KEY;
  const channelId = process.env.YOUTUBE_CHANNEL_ID;
  if (!apiKey || !channelId) {
    throw new Error('Set YOUTUBE_API_KEY dan YOUTUBE_CHANNEL_ID sebagai GitHub repo secrets.');
  }

  const month = resolveTargetMonth();
  console.log(`📅 Target bulan: ${month}`);

  const stats = await fetchChannelStats(apiKey, channelId);
  console.log('📊 Raw stats:', stats);

  // Baca analytics.json
  const analytics = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  if (!analytics[ACCT_ID])          analytics[ACCT_ID]          = {};
  if (!analytics[ACCT_ID].youtube)  analytics[ACCT_ID].youtube  = [];

  const rows   = analytics[ACCT_ID].youtube;
  const sorted = [...rows].sort((a, b) => a.month.localeCompare(b.month));

  // Cari entri bulan sebelumnya untuk hitung delta
  const prevEntry = sorted.filter(r => r.month < month).pop() || null;

  const subsEOM          = parseInt(stats.subscriberCount) || 0;
  const totalVideosCumul = parseInt(stats.videoCount)      || 0;
  const totalViewsCumul  = parseInt(stats.viewCount)       || 0;

  const prevSubsEOM      = prevEntry?.subsEOM             || 0;
  const prevVideosCumul  = prevEntry?._cumulativeVideos   || totalVideosCumul;
  const prevViewsCumul   = prevEntry?._cumulativeViews    || totalViewsCumul;

  const jmlVideo   = Math.max(0, totalVideosCumul - prevVideosCumul);
  const totalViews = Math.max(0, totalViewsCumul  - prevViewsCumul);
  const subsGained = subsEOM - prevSubsEOM;

  const newEntry = {
    month,
    jmlVideo,
    totalViews,
    uniqueViewers:   prevEntry?.uniqueViewers   || 0,
    subsEOM,
    subsGained,
    totalLikes:      prevEntry?.totalLikes      || 0,
    totalComments:   prevEntry?.totalComments   || 0,
    totalEngagement: prevEntry?.totalEngagement || 0,
    erPct:           prevEntry?.erPct           || 0,
    watchHours:      prevEntry?.watchHours      || 0,
    impressions:     prevEntry?.impressions     || 0,
    adImpressions:   prevEntry?.adImpressions   || 0,
    avgViewsPerVideo: jmlVideo > 0 ? Math.round(totalViews / jmlVideo) : 0,
    peakViews:       prevEntry?.peakViews       || 0,
    // Penanda internal untuk delta bulan depan (tidak ditampilkan di UI)
    _cumulativeViews:  totalViewsCumul,
    _cumulativeVideos: totalVideosCumul,
    _syncedAt:         new Date().toISOString(),
  };

  // Upsert
  const idx = rows.findIndex(r => r.month === month);
  if (idx >= 0) {
    rows[idx] = { ...rows[idx], ...newEntry };
    console.log(`🔄 Update entri ${month}`);
  } else {
    rows.push(newEntry);
    console.log(`➕ Tambah entri ${month}`);
  }

  analytics[ACCT_ID].youtube = rows.sort((a, b) => a.month.localeCompare(b.month));
  fs.writeFileSync(DATA_PATH, JSON.stringify(analytics, null, 2));

  console.log(`✅ Sync selesai — ${month}: subsEOM=${subsEOM}, views=${totalViews}, video baru=${jmlVideo}, subsGained=${subsGained}`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });

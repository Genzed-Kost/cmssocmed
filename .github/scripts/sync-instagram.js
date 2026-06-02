'use strict';
/**
 * sync-instagram.js — Auto-fetch Instagram Business/Creator stats via Meta Graph API
 * Dipanggil oleh GitHub Actions setiap tanggal 1 (bulanan) & tiap Senin (mingguan).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  SETUP YANG DIBUTUHKAN (sekali saja):
 * ═══════════════════════════════════════════════════════════════════════════
 *  1. Buat Meta App di https://developers.facebook.com
 *  2. Tambahkan produk "Instagram Graph API"
 *  3. Hubungkan Instagram Business/Creator account ke Facebook Page
 *  4. Generate Long-Lived Page Access Token (berlaku 60 hari — perlu diperbarui)
 *     atau gunakan System User Token (tidak expired) di Business Manager.
 *  5. Tambahkan secrets berikut di GitHub repo → Settings → Secrets → Actions:
 *
 *  Secrets per akun (ganti PH/33/JA sesuai akun):
 *    INSTAGRAM_TOKEN_PH   — Page Access Token akun Penjaga Harapan
 *    INSTAGRAM_ID_PH      — Instagram Business Account ID (bukan username)
 *    INSTAGRAM_TOKEN_33   — Page Access Token akun 33 Official
 *    INSTAGRAM_ID_33      — Instagram Business Account ID 33 Official
 *    INSTAGRAM_TOKEN_JA   — Page Access Token akun Jaga Asa
 *    INSTAGRAM_ID_JA      — Instagram Business Account ID Jaga Asa
 *
 *  Cara dapat Instagram Business Account ID:
 *    GET https://graph.facebook.com/v19.0/me/accounts?access_token=<token>
 *    → lihat nilai "instagram_business_account.id" dari page yang terhubung.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

const fs = require('fs');

const DATA_PATH = 'data/analytics.json';
const API_VER   = 'v19.0';
const BASE_URL  = `https://graph.facebook.com/${API_VER}`;

/* ── Pemetaan akun CMS → environment secrets ────────────────────────────── */
const ACCOUNT_MAP = [
  { id: 'penjaga-harapan', tokenEnv: 'INSTAGRAM_TOKEN_PH', idEnv: 'INSTAGRAM_ID_PH' },
  { id: '33-official',     tokenEnv: 'INSTAGRAM_TOKEN_33', idEnv: 'INSTAGRAM_ID_33' },
  { id: 'jaga-asa',        tokenEnv: 'INSTAGRAM_TOKEN_JA', idEnv: 'INSTAGRAM_ID_JA' },
];

/* ── Tentukan mode & periode target ────────────────────────────────────── */
function resolveMode() {
  // MODE env: 'monthly' (default) | 'weekly'
  return (process.env.SYNC_MODE || 'monthly').toLowerCase();
}

function resolveTargetMonth() {
  if (process.env.OVERRIDE_MONTH?.match(/^\d{4}-\d{2}$/)) return process.env.OVERRIDE_MONTH;
  const d = new Date(); d.setDate(0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function resolveTargetWeek() {
  if (process.env.OVERRIDE_WEEK?.match(/^\d{4}-W\d{2}$/)) return process.env.OVERRIDE_WEEK;
  // Minggu lalu (script jalan tiap Senin)
  const d = new Date();
  d.setDate(d.getDate() - 7);
  const jan4 = new Date(d.getFullYear(), 0, 4);
  const week = Math.ceil(((d - jan4) / 86400000 + jan4.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

/* ── Helper: date range untuk periode target ────────────────────────────── */
function monthDateRange(month) {
  const [y, m] = month.split('-').map(Number);
  const since  = `${month}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const until  = `${month}-${String(lastDay).padStart(2, '0')}`;
  return { since, until };
}

function weekDateRange(week) {
  // "2025-W23" → Monday–Sunday
  const [yr, wStr] = week.split('-W');
  const y = parseInt(yr);
  const w = parseInt(wStr);
  const jan4 = new Date(y, 0, 4);
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - jan4.getDay() + 1 + (w - 1) * 7);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  const fmt = d => d.toISOString().slice(0, 10);
  return { since: fmt(monday), until: fmt(sunday) };
}

/* ── Fetch dari Meta Graph API ─────────────────────────────────────────── */
async function fetchJson(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(`Meta API error: ${data.error.message} (code ${data.error.code})`);
  return data;
}

async function fetchInsights(igId, token, since, until) {
  /* Metrics yang didukung Instagram Insights API (akun bisnis):
     - follower_count         : Followers saat ini
     - reach                  : Total akun unik yang melihat konten
     - impressions            : Total tayangan
     - profile_views          : Kunjungan profil
     Catatan: engagement, likes, comments, shares per-post harus di-aggregate dari /media */
  const metricsPage = ['follower_count', 'reach', 'impressions', 'profile_views'].join(',');

  const insightsUrl = `${BASE_URL}/${igId}/insights`
    + `?metric=${metricsPage}`
    + `&period=day`
    + `&since=${since}&until=${until}`
    + `&access_token=${token}`;

  const insData = await fetchJson(insightsUrl);

  // Aggregate nilai dari semua hari dalam periode
  const totals = {};
  for (const metric of (insData.data || [])) {
    const sum = (metric.values || []).reduce((acc, v) => acc + (v.value || 0), 0);
    const last = (metric.values || []).slice(-1)[0]?.value || 0;
    if (metric.name === 'follower_count') {
      totals.followersEOM = last;     // ambil nilai terakhir (end of period)
    } else {
      totals[metric.name] = sum;
    }
  }

  return totals;
}

async function fetchMediaStats(igId, token, since, until) {
  /* Fetch semua media dalam periode, aggregate engagement per post */
  const mediaUrl = `${BASE_URL}/${igId}/media`
    + `?fields=id,media_type,timestamp,like_count,comments_count`
    + `&access_token=${token}&limit=100`;

  const mediaData = await fetchJson(mediaUrl);
  const posts = (mediaData.data || []).filter(p => {
    const ts = new Date(p.timestamp).toISOString().slice(0, 10);
    return ts >= since && ts <= until;
  });

  let totalLikes    = 0;
  let totalComments = 0;
  let totalEngagement = 0;
  let reelViews     = 0;
  let imageViews    = 0;
  let carouselViews = 0;
  const jmlPost     = posts.length;

  // Fetch insights per post untuk views & shares
  for (const post of posts) {
    totalLikes    += post.like_count    || 0;
    totalComments += post.comments_count || 0;

    // Per-post insights
    try {
      const metricsPost = post.media_type === 'VIDEO'
        ? 'plays,saved,shares'
        : 'impressions,saved,shares';
      const piUrl = `${BASE_URL}/${post.id}/insights?metric=${metricsPost}&access_token=${token}`;
      const pi = await fetchJson(piUrl);
      const vals = {};
      for (const m of (pi.data || [])) vals[m.name] = m.values?.[0]?.value || 0;

      const postViews = vals.plays || vals.impressions || 0;
      const postSaves = vals.saved || 0;
      const postShares = vals.shares || 0;

      if (post.media_type === 'VIDEO')    reelViews     += postViews;
      else if (post.media_type === 'IMAGE') imageViews  += postViews;
      else                                carouselViews += postViews; // CAROUSEL_ALBUM

      totalEngagement += (post.like_count || 0) + (post.comments_count || 0) + postSaves + postShares;
    } catch (e) {
      // Beberapa post lama mungkin tidak support insights — skip
      console.warn(`  ⚠ Gagal fetch insights post ${post.id}: ${e.message}`);
      totalEngagement += (post.like_count || 0) + (post.comments_count || 0);
    }
  }

  const totalViews  = reelViews + imageViews + carouselViews;
  const erPct       = totalEngagement > 0 && jmlPost > 0
    ? parseFloat((totalEngagement / jmlPost).toFixed(2))
    : 0;
  const avgViews    = jmlPost > 0 ? Math.round(totalViews / jmlPost) : 0;
  const avgEng      = jmlPost > 0 ? Math.round(totalEngagement / jmlPost) : 0;
  const peakViews   = Math.max(reelViews, imageViews, carouselViews, 0);

  return {
    jmlPost,
    totalLikes,
    totalComments,
    totalEngagement,
    totalViews,
    reelViews,
    imageViews,
    carouselViews,
    avgViews,
    avgEng,
    peakViews,
    erPct
  };
}

/* ── Sync satu akun ─────────────────────────────────────────────────────── */
async function syncAccount(acctCfg, mode) {
  const token = process.env[acctCfg.tokenEnv];
  const igId  = process.env[acctCfg.idEnv];

  if (!token || !igId) {
    console.log(`  ⏭ ${acctCfg.id}: secrets tidak dikonfigurasi (${acctCfg.tokenEnv}, ${acctCfg.idEnv}) — skip`);
    return null;
  }

  let periodKey, since, until, dataKey, rowKey;

  if (mode === 'weekly') {
    periodKey = resolveTargetWeek();
    ({ since, until } = weekDateRange(periodKey));
    dataKey = 'instagram_w';
    rowKey  = 'week';
  } else {
    periodKey = resolveTargetMonth();
    ({ since, until } = monthDateRange(periodKey));
    dataKey = 'instagram';
    rowKey  = 'month';
  }

  console.log(`  📅 ${acctCfg.id}: ${mode} — ${periodKey} (${since} → ${until})`);

  // Fetch data
  const [insights, mediaStats] = await Promise.all([
    fetchInsights(igId, token, since, until).catch(e => {
      console.warn(`  ⚠ Insights gagal: ${e.message}`);
      return {};
    }),
    fetchMediaStats(igId, token, since, until).catch(e => {
      console.warn(`  ⚠ Media stats gagal: ${e.message}`);
      return {};
    })
  ]);

  const followersEOM    = insights.followersEOM || 0;
  const totalReach      = insights.reach        || 0;

  // Hitung followers gained (delta dari entri sebelumnya)
  const analytics   = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const existing    = analytics[acctCfg.id]?.[dataKey] || [];
  const sorted      = [...existing].sort((a, b) => (a[rowKey]||'').localeCompare(b[rowKey]||''));
  const prevEntry   = sorted.filter(r => (r[rowKey]||'') < periodKey).pop() || null;
  const followersGained = followersEOM - (prevEntry?.followersEOM || followersEOM);

  const newEntry = {
    [rowKey]:        periodKey,
    followersEOM,
    followersGained: Math.max(0, followersGained),
    jmlPost:         mediaStats.jmlPost        || 0,
    totalViews:      mediaStats.totalViews     || 0,
    totalReach,
    totalLikes:      mediaStats.totalLikes     || 0,
    totalComments:   mediaStats.totalComments  || 0,
    totalShares:     0,   // shares tidak tersedia via Insights API — update manual
    totalSaves:      0,   // idem — fetch terpisah via per-post insights jika diperlukan
    totalEngagement: mediaStats.totalEngagement || 0,
    erPct:           mediaStats.erPct          || 0,
    avgViews:        mediaStats.avgViews       || 0,
    avgEng:          mediaStats.avgEng         || 0,
    peakViews:       mediaStats.peakViews      || 0,
    reelViews:       mediaStats.reelViews      || 0,
    carouselViews:   mediaStats.carouselViews  || 0,
    imageViews:      mediaStats.imageViews     || 0,
    _syncedAt:       new Date().toISOString(),
  };

  // Upsert ke analytics.json
  if (!analytics[acctCfg.id])            analytics[acctCfg.id]          = {};
  if (!analytics[acctCfg.id][dataKey])   analytics[acctCfg.id][dataKey] = [];

  const rows = analytics[acctCfg.id][dataKey];
  const idx  = rows.findIndex(r => r[rowKey] === periodKey);
  if (idx >= 0) {
    rows[idx] = { ...rows[idx], ...newEntry };
    console.log(`  🔄 Update ${acctCfg.id} instagram ${periodKey}`);
  } else {
    rows.push(newEntry);
    console.log(`  ➕ Tambah ${acctCfg.id} instagram ${periodKey}`);
  }

  analytics[acctCfg.id][dataKey] = rows.sort((a, b) => (a[rowKey]||'').localeCompare(b[rowKey]||''));
  fs.writeFileSync(DATA_PATH, JSON.stringify(analytics, null, 2));

  console.log(`  ✅ followersEOM=${followersEOM}, totalViews=${newEntry.totalViews}, engagement=${newEntry.totalEngagement}`);
  return newEntry;
}

/* ── Main ─────────────────────────────────────────────────────────────────── */
async function main() {
  const mode = resolveMode();
  console.log(`\n🚀 Sync Instagram — mode: ${mode}\n`);

  let synced = 0;
  for (const acct of ACCOUNT_MAP) {
    try {
      const result = await syncAccount(acct, mode);
      if (result) synced++;
    } catch (e) {
      console.error(`❌ ${acct.id}: ${e.message}`);
    }
  }

  if (synced === 0) {
    console.log('\n⚠  Tidak ada akun yang di-sync. Pastikan secrets sudah dikonfigurasi di GitHub repo.');
    console.log('   Lihat komentar di bagian atas file ini untuk panduan setup.\n');
  } else {
    console.log(`\n✅ Selesai — ${synced} akun berhasil di-sync.\n`);
  }
}

main().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });

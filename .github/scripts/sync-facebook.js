'use strict';
/**
 * sync-facebook.js — Auto-fetch Facebook Page stats via Meta Graph API
 * Dipanggil oleh GitHub Actions setiap tanggal 1 (bulanan) & tiap Senin (mingguan).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  SETUP YANG DIBUTUHKAN (sekali saja):
 * ═══════════════════════════════════════════════════════════════════════════
 *  1. Buat Meta App di https://developers.facebook.com
 *  2. Tambahkan produk "Facebook Login" dan aktifkan "Pages API"
 *  3. Minta permission: pages_show_list, pages_read_engagement,
 *     pages_read_user_content, read_insights
 *  4. Generate Long-Lived Page Access Token (via Graph API Explorer) atau
 *     gunakan System User Token di Business Manager (tidak expired).
 *  5. Tambahkan secrets berikut di GitHub repo → Settings → Secrets → Actions:
 *
 *  Secrets per akun:
 *    FACEBOOK_TOKEN_PH   — Page Access Token Penjaga Harapan
 *    FACEBOOK_PAGE_PH    — Facebook Page ID Penjaga Harapan
 *    FACEBOOK_TOKEN_33   — Page Access Token 33 Official
 *    FACEBOOK_PAGE_33    — Facebook Page ID 33 Official
 *    FACEBOOK_TOKEN_JA   — Page Access Token Jaga Asa
 *    FACEBOOK_PAGE_JA    — Facebook Page ID Jaga Asa
 *
 *  Cara dapat Page ID:
 *    Buka halaman Facebook → About → Page ID (di bagian bawah)
 *    atau: GET https://graph.facebook.com/me?access_token=<token>&fields=id,name
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

const fs = require('fs');

const DATA_PATH = 'data/analytics.json';
const API_VER   = 'v19.0';
const BASE_URL  = `https://graph.facebook.com/${API_VER}`;

/* ── Pemetaan akun CMS → environment secrets ────────────────────────────── */
const ACCOUNT_MAP = [
  { id: 'penjaga-harapan', tokenEnv: 'FACEBOOK_TOKEN_PH', pageEnv: 'FACEBOOK_PAGE_PH' },
  { id: '33-official',     tokenEnv: 'FACEBOOK_TOKEN_33', pageEnv: 'FACEBOOK_PAGE_33' },
  { id: 'jaga-asa',        tokenEnv: 'FACEBOOK_TOKEN_JA', pageEnv: 'FACEBOOK_PAGE_JA' },
];

/* ── Mode & periode target ──────────────────────────────────────────────── */
function resolveMode() {
  return (process.env.SYNC_MODE || 'monthly').toLowerCase();
}

function resolveTargetMonth() {
  if (process.env.OVERRIDE_MONTH?.match(/^\d{4}-\d{2}$/)) return process.env.OVERRIDE_MONTH;
  const d = new Date(); d.setDate(0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function resolveTargetWeek() {
  if (process.env.OVERRIDE_WEEK?.match(/^\d{4}-W\d{2}$/)) return process.env.OVERRIDE_WEEK;
  const d = new Date(); d.setDate(d.getDate() - 7);
  const jan4 = new Date(d.getFullYear(), 0, 4);
  const week = Math.ceil(((d - jan4) / 86400000 + jan4.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function monthDateRange(month) {
  const [y, m] = month.split('-').map(Number);
  const since  = `${month}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const until  = `${month}-${String(lastDay).padStart(2, '0')}`;
  return { since, until };
}

function weekDateRange(week) {
  const [yr, wStr] = week.split('-W');
  const y = parseInt(yr); const w = parseInt(wStr);
  const jan4 = new Date(y, 0, 4);
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - jan4.getDay() + 1 + (w - 1) * 7);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  const fmt = d => d.toISOString().slice(0, 10);
  return { since: fmt(monday), until: fmt(sunday) };
}

/* ── Fetch JSON dari Graph API ──────────────────────────────────────────── */
async function fetchJson(url) {
  const res  = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(`Meta API: ${data.error.message} (code ${data.error.code})`);
  return data;
}

/* ── Fetch Page Insights (statistik halaman) ────────────────────────────── */
async function fetchPageInsights(pageId, token, since, until) {
  /* Metrics yang tersedia di Facebook Page Insights:
     - page_fans                : Total followers/likes saat ini
     - page_impressions         : Total tayangan konten halaman
     - page_reach               : Akun unik yang melihat konten
     - page_post_engagements    : Total engagement semua post
     - page_views_total         : Total kunjungan halaman
  */
  const metrics = [
    'page_fans',
    'page_impressions',
    'page_reach',
    'page_post_engagements',
    'page_views_total',
  ].join(',');

  const url = `${BASE_URL}/${pageId}/insights`
    + `?metric=${metrics}`
    + `&period=day`
    + `&since=${since}&until=${until}`
    + `&access_token=${token}`;

  const data = await fetchJson(url);

  const result = {};
  for (const metric of (data.data || [])) {
    const values = metric.values || [];
    if (metric.name === 'page_fans') {
      // Followers = nilai terakhir (end of period)
      result.pageFollowers = values[values.length - 1]?.value || 0;
    } else {
      // Sum semua hari
      result[metric.name] = values.reduce((acc, v) => acc + (v.value || 0), 0);
    }
  }

  return result;
}

/* ── Fetch stats post-level (reactions, comments, shares) ───────────────── */
async function fetchPostStats(pageId, token, since, until) {
  const url = `${BASE_URL}/${pageId}/posts`
    + `?fields=id,created_time,reactions.summary(true),comments.summary(true),shares`
    + `&access_token=${token}&limit=100`;

  const data = await fetchJson(url);
  const posts = (data.data || []).filter(p => {
    const ts = new Date(p.created_time).toISOString().slice(0, 10);
    return ts >= since && ts <= until;
  });

  let totalReactions = 0;
  let totalComments  = 0;
  let totalShares    = 0;

  for (const p of posts) {
    totalReactions += p.reactions?.summary?.total_count || 0;
    totalComments  += p.comments?.summary?.total_count  || 0;
    totalShares    += p.shares?.count || 0;
  }

  const totalPost      = posts.length;
  const totalEngagement = totalReactions + totalComments + totalShares;
  const avgEngPerPost  = totalPost > 0 ? Math.round(totalEngagement / totalPost) : 0;

  return { totalPost, totalReactions, totalComments, totalShares, totalEngagement, avgEngPerPost };
}

/* ── Sync satu akun ─────────────────────────────────────────────────────── */
async function syncAccount(acctCfg, mode) {
  const token  = process.env[acctCfg.tokenEnv];
  const pageId = process.env[acctCfg.pageEnv];

  if (!token || !pageId) {
    console.log(`  ⏭ ${acctCfg.id}: secrets tidak dikonfigurasi (${acctCfg.tokenEnv}, ${acctCfg.pageEnv}) — skip`);
    return null;
  }

  let periodKey, since, until, dataKey, rowKey;

  if (mode === 'weekly') {
    periodKey = resolveTargetWeek();
    ({ since, until } = weekDateRange(periodKey));
    dataKey = 'facebook_w';
    rowKey  = 'week';
  } else {
    periodKey = resolveTargetMonth();
    ({ since, until } = monthDateRange(periodKey));
    dataKey = 'facebook';
    rowKey  = 'month';
  }

  console.log(`  📅 ${acctCfg.id}: ${mode} — ${periodKey} (${since} → ${until})`);

  const [pageInsights, postStats] = await Promise.all([
    fetchPageInsights(pageId, token, since, until).catch(e => {
      console.warn(`  ⚠ Page insights gagal: ${e.message}`); return {};
    }),
    fetchPostStats(pageId, token, since, until).catch(e => {
      console.warn(`  ⚠ Post stats gagal: ${e.message}`); return {};
    }),
  ]);

  const pageFollowers  = pageInsights.pageFollowers            || 0;
  const totalViews     = pageInsights.page_impressions         || 0;
  const totalReach     = pageInsights.page_reach               || 0;
  const totalPost      = postStats.totalPost                   || 0;
  const totalReactions = postStats.totalReactions              || 0;
  const totalComments  = postStats.totalComments               || 0;
  const totalShares    = postStats.totalShares                 || 0;
  const totalEngagement = postStats.totalEngagement            || 0;
  const avgEngPerPost  = postStats.avgEngPerPost               || 0;
  const avgViewsPerPost = totalPost > 0 ? Math.round(totalViews / totalPost) : 0;
  const erPct          = pageFollowers > 0
    ? parseFloat((totalEngagement / pageFollowers * 100).toFixed(2))
    : 0;

  const newEntry = {
    [rowKey]: periodKey,
    pageFollowers,
    totalPost,
    totalViews,
    totalReach,
    totalReactions,
    totalComments,
    totalShares,
    totalEngagement,
    avgViewsPerPost,
    avgEngPerPost,
    maxViewsSingle: 0,   // tidak tersedia via batch API — bisa diisi manual
    erPct,
    _syncedAt: new Date().toISOString(),
  };

  // Baca & upsert analytics.json
  const analytics = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  if (!analytics[acctCfg.id])          analytics[acctCfg.id]         = {};
  if (!analytics[acctCfg.id][dataKey]) analytics[acctCfg.id][dataKey] = [];

  const rows = analytics[acctCfg.id][dataKey];
  const idx  = rows.findIndex(r => r[rowKey] === periodKey);
  if (idx >= 0) {
    rows[idx] = { ...rows[idx], ...newEntry };
    console.log(`  🔄 Update ${acctCfg.id} facebook ${periodKey}`);
  } else {
    rows.push(newEntry);
    console.log(`  ➕ Tambah ${acctCfg.id} facebook ${periodKey}`);
  }

  analytics[acctCfg.id][dataKey] = rows.sort((a, b) => (a[rowKey]||'').localeCompare(b[rowKey]||''));
  fs.writeFileSync(DATA_PATH, JSON.stringify(analytics, null, 2));

  console.log(`  ✅ pageFollowers=${pageFollowers}, totalViews=${totalViews}, engagement=${totalEngagement}`);
  return newEntry;
}

/* ── Main ─────────────────────────────────────────────────────────────────── */
async function main() {
  const mode = resolveMode();
  console.log(`\n🚀 Sync Facebook — mode: ${mode}\n`);

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

'use strict';
/**
 * sync-twitter.js — Auto-fetch X (Twitter) stats via Twitter API v2
 * Dipanggil oleh GitHub Actions setiap tanggal 1 (bulanan) & tiap Senin (mingguan).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  SETUP YANG DIBUTUHKAN (sekali saja):
 * ═══════════════════════════════════════════════════════════════════════════
 *  1. Buat akun di https://developer.twitter.com
 *  2. Buat Project + App di Developer Portal
 *  3. Set App permissions ke "Read" (cukup untuk analytics)
 *  4. Generate Bearer Token (dari tab "Keys and Tokens")
 *
 *  CATATAN PENTING tentang Twitter API v2 tiers:
 *    - Free tier  : Hanya bisa baca tweet terbaru, TIDAK bisa akses tweet metrics
 *    - Basic tier ($100/bln): Dapat akses tweet metrics (impressions, engagements)
 *    - Pro tier   ($5000/bln): Full analytics
 *
 *  Script ini menggunakan endpoint yang tersedia di Basic tier:
 *    - GET /2/users/:id — followers count (tersedia di Free)
 *    - GET /2/users/:id/tweets — tweet list + public_metrics (Basic+)
 *
 *  Jika hanya punya Free tier, script tetap jalan tapi hanya dapat followers.
 *  Metrics lain (impressions, engagements) akan bernilai 0.
 *
 *  Secrets yang dibutuhkan di GitHub repo:
 *    TWITTER_BEARER_TOKEN_PH  — Bearer Token akun Penjaga Harapan
 *    TWITTER_USER_ID_PH       — User ID (bukan username), cth: 123456789
 *    TWITTER_BEARER_TOKEN_33  — Bearer Token akun 33 Official
 *    TWITTER_USER_ID_33       — User ID 33 Official
 *    TWITTER_BEARER_TOKEN_JA  — Bearer Token akun Jaga Asa
 *    TWITTER_USER_ID_JA       — User ID Jaga Asa
 *
 *  Cara dapat User ID dari username:
 *    GET https://api.twitter.com/2/users/by/username/<username>
 *    Header: Authorization: Bearer <token>
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

const fs = require('fs');

const DATA_PATH = 'data/analytics.json';
const API_BASE  = 'https://api.twitter.com/2';

/* ── Pemetaan akun CMS → environment secrets ────────────────────────────── */
const ACCOUNT_MAP = [
  { id: 'penjaga-harapan', tokenEnv: 'TWITTER_BEARER_TOKEN_PH', userIdEnv: 'TWITTER_USER_ID_PH' },
  { id: '33-official',     tokenEnv: 'TWITTER_BEARER_TOKEN_33', userIdEnv: 'TWITTER_USER_ID_33' },
  { id: 'jaga-asa',        tokenEnv: 'TWITTER_BEARER_TOKEN_JA', userIdEnv: 'TWITTER_USER_ID_JA' },
];

/* ── Mode & periode ─────────────────────────────────────────────────────── */
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
  return {
    since: new Date(y, m - 1, 1).toISOString(),
    until: new Date(y, m, 0, 23, 59, 59).toISOString(),
  };
}

function weekDateRange(week) {
  const [yr, wStr] = week.split('-W');
  const y = parseInt(yr); const w = parseInt(wStr);
  const jan4 = new Date(y, 0, 4);
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - jan4.getDay() + 1 + (w - 1) * 7);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { since: monday.toISOString(), until: sunday.toISOString() };
}

/* ── Fetch helper ──────────────────────────────────────────────────────── */
async function twitterGet(path, token, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.errors && !data.data) {
    throw new Error(`Twitter API: ${data.errors[0]?.message || JSON.stringify(data.errors)}`);
  }
  return data;
}

/* ── Fetch follower count ───────────────────────────────────────────────── */
async function fetchFollowers(userId, token) {
  const data = await twitterGet(`/users/${userId}`, token, {
    'user.fields': 'public_metrics',
  });
  return data.data?.public_metrics?.followers_count || 0;
}

/* ── Fetch tweets & aggregate metrics ──────────────────────────────────── */
async function fetchTweetStats(userId, token, since, until) {
  /* public_metrics: retweet_count, reply_count, like_count, quote_count, impression_count
     impression_count hanya tersedia di Basic tier ke atas.
     Untuk Free tier, field ini tidak muncul (akan jadi 0). */
  let totalPost      = 0;
  let impressions    = 0;
  let totalLikes     = 0;
  let totalRetweets  = 0;
  let totalReplies   = 0;
  let totalEngagement = 0;

  let paginationToken = null;
  let hasMore = true;

  while (hasMore) {
    const params = {
      max_results: 100,
      start_time: since,
      end_time:   until,
      'tweet.fields': 'public_metrics,created_at',
      exclude: 'retweets,replies',  // hanya tweet original
    };
    if (paginationToken) params.pagination_token = paginationToken;

    let data;
    try {
      data = await twitterGet(`/users/${userId}/tweets`, token, params);
    } catch (e) {
      // Free tier mungkin tidak support date range filter — fallback ke tanpa filter
      console.warn(`  ⚠ Tweet fetch dengan filter tanggal gagal (${e.message}), mencoba tanpa filter...`);
      try {
        data = await twitterGet(`/users/${userId}/tweets`, token, {
          max_results: 100,
          'tweet.fields': 'public_metrics,created_at',
          exclude: 'retweets,replies',
        });
      } catch (e2) {
        console.warn(`  ⚠ Tweet fetch gagal total: ${e2.message}`);
        break;
      }
      hasMore = false;  // tanpa pagination jika fallback
    }

    const tweets = data.data || [];
    if (tweets.length === 0) break;

    for (const t of tweets) {
      // Filter manual jika API tidak support date range (Free tier)
      if (t.created_at) {
        const ts = new Date(t.created_at).toISOString();
        if (ts < since || ts > until) continue;
      }

      const m = t.public_metrics || {};
      totalPost++;
      impressions     += m.impression_count || 0;
      totalLikes      += m.like_count       || 0;
      totalRetweets   += m.retweet_count    || 0;
      totalReplies    += m.reply_count      || 0;
    }

    paginationToken = data.meta?.next_token;
    if (!paginationToken) hasMore = false;
  }

  totalEngagement = totalLikes + totalRetweets + totalReplies;
  const erPct = totalPost > 0
    ? parseFloat((totalEngagement / totalPost).toFixed(2))
    : 0;

  return { totalPost, impressions, totalLikes, totalRetweets, totalEngagement, erPct };
}

/* ── Sync satu akun ─────────────────────────────────────────────────────── */
async function syncAccount(acctCfg, mode) {
  const token  = process.env[acctCfg.tokenEnv];
  const userId = process.env[acctCfg.userIdEnv];

  if (!token || !userId) {
    console.log(`  ⏭ ${acctCfg.id}: secrets tidak dikonfigurasi (${acctCfg.tokenEnv}, ${acctCfg.userIdEnv}) — skip`);
    return null;
  }

  let periodKey, since, until, dataKey, rowKey;
  if (mode === 'weekly') {
    periodKey = resolveTargetWeek();
    ({ since, until } = weekDateRange(periodKey));
    dataKey = 'twitter_w';
    rowKey  = 'week';
  } else {
    periodKey = resolveTargetMonth();
    ({ since, until } = monthDateRange(periodKey));
    dataKey = 'twitter';
    rowKey  = 'month';
  }

  console.log(`  📅 ${acctCfg.id}: ${mode} — ${periodKey}`);

  const [followers, tweetStats] = await Promise.all([
    fetchFollowers(userId, token).catch(e => { console.warn(`  ⚠ Followers gagal: ${e.message}`); return 0; }),
    fetchTweetStats(userId, token, since, until).catch(e => { console.warn(`  ⚠ Tweet stats gagal: ${e.message}`); return {}; }),
  ]);

  const newEntry = {
    [rowKey]:        periodKey,
    totalPost:       tweetStats.totalPost      || 0,
    impressions:     tweetStats.impressions    || 0,
    totalEngagement: tweetStats.totalEngagement || 0,
    erPct:           tweetStats.erPct          || 0,
    totalLikes:      tweetStats.totalLikes     || 0,
    totalRetweets:   tweetStats.totalRetweets  || 0,
    followers,
    _syncedAt: new Date().toISOString(),
  };

  const analytics = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  if (!analytics[acctCfg.id])          analytics[acctCfg.id]         = {};
  if (!analytics[acctCfg.id][dataKey]) analytics[acctCfg.id][dataKey] = [];

  const rows = analytics[acctCfg.id][dataKey];
  const idx  = rows.findIndex(r => r[rowKey] === periodKey);
  if (idx >= 0) { rows[idx] = { ...rows[idx], ...newEntry }; console.log(`  🔄 Update ${acctCfg.id} twitter ${periodKey}`); }
  else           { rows.push(newEntry);                       console.log(`  ➕ Tambah ${acctCfg.id} twitter ${periodKey}`); }

  analytics[acctCfg.id][dataKey] = rows.sort((a, b) => (a[rowKey]||'').localeCompare(b[rowKey]||''));
  fs.writeFileSync(DATA_PATH, JSON.stringify(analytics, null, 2));
  console.log(`  ✅ followers=${followers}, impressions=${newEntry.impressions}, engagement=${newEntry.totalEngagement}`);
  return newEntry;
}

/* ── Main ─────────────────────────────────────────────────────────────────── */
async function main() {
  const mode = resolveMode();
  console.log(`\n🚀 Sync X (Twitter) — mode: ${mode}\n`);

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
    console.log('\n⚠  Tidak ada akun yang di-sync. Pastikan secrets sudah dikonfigurasi.');
    console.log('   Lihat komentar di bagian atas file ini untuk panduan setup.\n');
  } else {
    console.log(`\n✅ Selesai — ${synced} akun berhasil di-sync.\n`);
  }
}

main().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });

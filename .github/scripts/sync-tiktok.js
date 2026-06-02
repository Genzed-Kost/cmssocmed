'use strict';
/**
 * sync-tiktok.js — Auto-fetch TikTok stats via TikTok Business API
 * Dipanggil oleh GitHub Actions setiap tanggal 1 (bulanan) & tiap Senin (mingguan).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  SETUP YANG DIBUTUHKAN (sekali saja):
 * ═══════════════════════════════════════════════════════════════════════════
 *  1. Daftar TikTok for Business: https://business.tiktok.com
 *  2. Buat App di TikTok Developer Portal: https://developers.tiktok.com
 *  3. Request scope: user.info.basic, video.list, analytics
 *  4. Dapatkan Access Token via OAuth 2.0 flow.
 *     CATATAN: TikTok Access Token berlaku 24 jam, Refresh Token 365 hari.
 *     Untuk automasi, simpan TIKTOK_REFRESH_TOKEN dan script akan refresh otomatis.
 *  5. Tambahkan secrets di GitHub repo → Settings → Secrets → Actions:
 *
 *  Secrets per akun:
 *    TIKTOK_CLIENT_KEY_PH      — Client Key (App ID) dari developer portal
 *    TIKTOK_CLIENT_SECRET_PH   — Client Secret dari developer portal
 *    TIKTOK_REFRESH_TOKEN_PH   — Refresh Token akun Penjaga Harapan
 *    TIKTOK_CLIENT_KEY_33      — Client Key 33 Official
 *    TIKTOK_CLIENT_SECRET_33   — Client Secret 33 Official
 *    TIKTOK_REFRESH_TOKEN_33   — Refresh Token 33 Official
 *    TIKTOK_CLIENT_KEY_JA      — Client Key Jaga Asa
 *    TIKTOK_CLIENT_SECRET_JA   — Client Secret Jaga Asa
 *    TIKTOK_REFRESH_TOKEN_JA   — Refresh Token Jaga Asa
 *
 *  Alternatif lebih simpel: jika semua akun pakai App yang sama, cukup satu
 *  TIKTOK_CLIENT_KEY dan TIKTOK_CLIENT_SECRET, bedakan hanya refresh token-nya.
 *
 *  Cara dapat Refresh Token:
 *    Ikuti OAuth flow di: https://developers.tiktok.com/doc/oauth-user-access-token-management
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

const fs = require('fs');

const DATA_PATH  = 'data/analytics.json';
const API_BASE   = 'https://open.tiktokapis.com/v2';
const TOKEN_URL  = 'https://open.tiktokapis.com/v2/oauth/token/';

/* ── Pemetaan akun CMS → environment secrets ────────────────────────────── */
const ACCOUNT_MAP = [
  {
    id:              'penjaga-harapan',
    clientKeyEnv:    'TIKTOK_CLIENT_KEY_PH',
    clientSecretEnv: 'TIKTOK_CLIENT_SECRET_PH',
    refreshTokenEnv: 'TIKTOK_REFRESH_TOKEN_PH',
  },
  {
    id:              '33-official',
    clientKeyEnv:    'TIKTOK_CLIENT_KEY_33',
    clientSecretEnv: 'TIKTOK_CLIENT_SECRET_33',
    refreshTokenEnv: 'TIKTOK_REFRESH_TOKEN_33',
  },
  {
    id:              'jaga-asa',
    clientKeyEnv:    'TIKTOK_CLIENT_KEY_JA',
    clientSecretEnv: 'TIKTOK_CLIENT_SECRET_JA',
    refreshTokenEnv: 'TIKTOK_REFRESH_TOKEN_JA',
  },
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
    since: `${month}-01`,
    until: `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`,
  };
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

/* ── Refresh Access Token ───────────────────────────────────────────────── */
async function refreshAccessToken(clientKey, clientSecret, refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key:    clientKey,
      client_secret: clientSecret,
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  });
  const data = await res.json();
  if (data.error) throw new Error(`TikTok token refresh: ${JSON.stringify(data.error)}`);
  return data.data?.access_token || data.access_token;
}

/* ── Fetch user info (followers) ────────────────────────────────────────── */
async function fetchUserInfo(accessToken) {
  const res = await fetch(`${API_BASE}/user/info/?fields=follower_count,following_count,video_count`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (data.error?.code && data.error.code !== 'ok') {
    throw new Error(`TikTok user info: ${data.error.message}`);
  }
  return data.data?.user || {};
}

/* ── Fetch video list & aggregate stats dalam range tanggal ─────────────── */
async function fetchVideoStats(accessToken, since, until) {
  /* TikTok Video List API — fetch semua video, filter berdasarkan create_time */
  const fields = [
    'id', 'create_time', 'view_count', 'like_count',
    'comment_count', 'share_count',
  ].join(',');

  let cursor = null;
  let hasMore = true;
  const sinceTs = new Date(since).getTime() / 1000;
  const untilTs = new Date(until + 'T23:59:59').getTime() / 1000;

  let totalViews    = 0;
  let totalLikes    = 0;
  let totalComments = 0;
  let totalShares   = 0;
  let videoCount    = 0;

  while (hasMore) {
    const body = { max_count: 20, fields };
    if (cursor) body.cursor = cursor;

    const res = await fetch(`${API_BASE}/video/list/`, {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error?.code && data.error.code !== 'ok') {
      throw new Error(`TikTok video list: ${data.error.message}`);
    }

    const videos = data.data?.videos || [];
    hasMore = data.data?.has_more === true;
    cursor  = data.data?.cursor;

    for (const v of videos) {
      if (v.create_time < sinceTs || v.create_time > untilTs) {
        // Jika sudah melewati range (list urut terbaru duluan), bisa berhenti
        if (v.create_time < sinceTs) { hasMore = false; break; }
        continue;
      }
      totalViews    += v.view_count    || 0;
      totalLikes    += v.like_count    || 0;
      totalComments += v.comment_count || 0;
      totalShares   += v.share_count   || 0;
      videoCount++;
    }

    if (!hasMore || !cursor) break;
  }

  const totalEngagement = totalLikes + totalComments + totalShares;

  return { totalVideoViews: totalViews, totalLikes, totalComments, totalShares, totalEngagement, videoCount };
}

/* ── Sync satu akun ─────────────────────────────────────────────────────── */
async function syncAccount(acctCfg, mode) {
  const clientKey    = process.env[acctCfg.clientKeyEnv];
  const clientSecret = process.env[acctCfg.clientSecretEnv];
  const refreshToken = process.env[acctCfg.refreshTokenEnv];

  if (!clientKey || !clientSecret || !refreshToken) {
    console.log(`  ⏭ ${acctCfg.id}: secrets tidak dikonfigurasi — skip`);
    return null;
  }

  let periodKey, since, until, dataKey, rowKey;
  if (mode === 'weekly') {
    periodKey = resolveTargetWeek();
    ({ since, until } = weekDateRange(periodKey));
    dataKey = 'tiktok_w';
    rowKey  = 'week';
  } else {
    periodKey = resolveTargetMonth();
    ({ since, until } = monthDateRange(periodKey));
    dataKey = 'tiktok';
    rowKey  = 'month';
  }

  console.log(`  📅 ${acctCfg.id}: ${mode} — ${periodKey} (${since} → ${until})`);

  // Refresh token dulu
  const accessToken = await refreshAccessToken(clientKey, clientSecret, refreshToken);

  const [userInfo, videoStats] = await Promise.all([
    fetchUserInfo(accessToken).catch(e => { console.warn(`  ⚠ User info gagal: ${e.message}`); return {}; }),
    fetchVideoStats(accessToken, since, until).catch(e => { console.warn(`  ⚠ Video stats gagal: ${e.message}`); return {}; }),
  ]);

  // Baca analytics untuk delta followers
  const analytics = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const existing  = analytics[acctCfg.id]?.[dataKey] || [];
  const sorted    = [...existing].sort((a, b) => (a[rowKey]||'').localeCompare(b[rowKey]||''));
  const prevEntry = sorted.filter(r => (r[rowKey]||'') < periodKey).pop() || null;

  const followersEOM    = userInfo.follower_count  || 0;
  const followersGained = Math.max(0, followersEOM - (prevEntry?.followersEOM || followersEOM));
  const totalEngagement = videoStats.totalEngagement || 0;
  const videoCount      = videoStats.videoCount || 0;
  const totalVideoViews = videoStats.totalVideoViews || 0;
  const erPct = followersEOM > 0 && videoCount > 0
    ? parseFloat(((totalEngagement / videoCount / followersEOM) * 100).toFixed(2))
    : 0;

  const newEntry = {
    [rowKey]:        periodKey,
    totalVideoViews,
    profileViews:    0,   // tidak tersedia via API — update manual jika perlu
    followersEOM,
    followersGained,
    totalViewers:    0,   // tidak tersedia via Video List API
    newViewers:      0,
    returningViewers: 0,
    totalLikes:      videoStats.totalLikes    || 0,
    totalComments:   videoStats.totalComments || 0,
    totalShares:     videoStats.totalShares   || 0,
    totalEngagement,
    erPct,
    _syncedAt: new Date().toISOString(),
  };

  if (!analytics[acctCfg.id])          analytics[acctCfg.id]         = {};
  if (!analytics[acctCfg.id][dataKey]) analytics[acctCfg.id][dataKey] = [];

  const rows = analytics[acctCfg.id][dataKey];
  const idx  = rows.findIndex(r => r[rowKey] === periodKey);
  if (idx >= 0) { rows[idx] = { ...rows[idx], ...newEntry }; console.log(`  🔄 Update ${acctCfg.id} tiktok ${periodKey}`); }
  else           { rows.push(newEntry);                       console.log(`  ➕ Tambah ${acctCfg.id} tiktok ${periodKey}`); }

  analytics[acctCfg.id][dataKey] = rows.sort((a, b) => (a[rowKey]||'').localeCompare(b[rowKey]||''));
  fs.writeFileSync(DATA_PATH, JSON.stringify(analytics, null, 2));
  console.log(`  ✅ followersEOM=${followersEOM}, totalVideoViews=${totalVideoViews}, engagement=${totalEngagement}`);
  return newEntry;
}

/* ── Main ─────────────────────────────────────────────────────────────────── */
async function main() {
  const mode = resolveMode();
  console.log(`\n🚀 Sync TikTok — mode: ${mode}\n`);

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

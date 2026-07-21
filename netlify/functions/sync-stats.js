/**
 * Netlify Function: sync-stats
 * Fetch stats dari platform (YouTube dll) lalu kembalikan data ke frontend.
 * Frontend yang menyimpan ke analytics.json via GitHub API (pakai PAT yang sudah ada).
 *
 * POST body: { platform, channelId, apiKey, mode }
 * Response:  { ok, data: { ...fields } }
 */

const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpsGet(res.headers.location).then(resolve).catch(reject);
      if (res.statusCode !== 200)
        return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/* ── YouTube ─────────────────────────────────────────────────────────────── */
async function fetchYouTube(channelId, apiKey) {
  const url = `https://www.googleapis.com/youtube/v3/channels` +
    `?part=statistics&id=${encodeURIComponent(channelId)}&key=${encodeURIComponent(apiKey)}`;
  const raw  = await httpsGet(url);
  const json = JSON.parse(raw);
  const item = json.items?.[0];
  if (!item) throw new Error(`Channel "${channelId}" tidak ditemukan. Cek Channel ID.`);
  const s = item.statistics;
  return {
    subsEOM:           parseInt(s.subscriberCount) || 0,
    _cumulativeVideos: parseInt(s.videoCount)      || 0,
    _cumulativeViews:  parseInt(s.viewCount)       || 0,
    _syncedAt:         new Date().toISOString()
  };
}

/* ── Instagram Graph API ─────────────────────────────────────────────────── */
async function fetchInstagram(userId, accessToken) {
  const fields = 'followers_count,media_count';
  const url = `https://graph.instagram.com/${encodeURIComponent(userId)}` +
    `?fields=${fields}&access_token=${encodeURIComponent(accessToken)}`;
  const raw  = await httpsGet(url);
  const json = JSON.parse(raw);
  if (json.error) throw new Error(json.error.message);
  return {
    followersEOM:   json.followers_count || 0,
    _cumulativeMedia: json.media_count   || 0,
    _syncedAt:      new Date().toISOString()
  };
}

/* ── Facebook Graph API ──────────────────────────────────────────────────── */
async function fetchFacebook(pageId, accessToken) {
  const fields = 'fan_count,followers_count';
  const url = `https://graph.facebook.com/${encodeURIComponent(pageId)}` +
    `?fields=${fields}&access_token=${encodeURIComponent(accessToken)}`;
  const raw  = await httpsGet(url);
  const json = JSON.parse(raw);
  if (json.error) throw new Error(json.error.message);
  return {
    pageFollowers: json.followers_count || json.fan_count || 0,
    _syncedAt:     new Date().toISOString()
  };
}

/* ── Handler ─────────────────────────────────────────────────────────────── */
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { platform, mode = 'monthly' } = body;

  try {
    let data;
    if (platform === 'youtube') {
      if (!body.channelId) throw new Error('channelId wajib diisi');
      if (!body.apiKey)    throw new Error('YouTube API Key wajib diisi');
      data = await fetchYouTube(body.channelId, body.apiKey);

    } else if (platform === 'instagram') {
      if (!body.userId)      throw new Error('Instagram User ID wajib diisi');
      if (!body.accessToken) throw new Error('Access Token wajib diisi');
      data = await fetchInstagram(body.userId, body.accessToken);

    } else if (platform === 'facebook') {
      if (!body.pageId)      throw new Error('Page ID wajib diisi');
      if (!body.accessToken) throw new Error('Access Token wajib diisi');
      data = await fetchFacebook(body.pageId, body.accessToken);

    } else {
      throw new Error(`Platform "${platform}" belum didukung untuk sync otomatis.`);
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, data, mode }) };
  } catch (e) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

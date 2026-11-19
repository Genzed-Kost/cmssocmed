/**
 * Cloudflare Pages Function: GET /api/youtube[?handle=PenjagaHarapan]
 * Daftar video terbaru satu channel YouTube (handle: PenjagaHarapan, JagaAsaPodcast, …) (tanpa API key) untuk mencocokkan
 * Stock Contents yang sudah tayang dengan videonya.
 *  1. Halaman https://www.youtube.com/@<handle>/videos → channelId + daftar video (judul)
 *  2. RSS https://www.youtube.com/feeds/videos.xml?channel_id=<id> → 15 video terbaru
 *     lengkap dengan tanggal terbit & deskripsi
 * Hasil di-cache di edge 30 menit.
 *
 * GET /api/youtube?video=<videoId> → { ok, title, channel } judul & channel satu video
 * (oEmbed YouTube) — dipakai untuk link YouTube yang diisi manual. Cache 7 hari.
 * Salinan identik ada di public/functions/api/youtube.js (lihat catatan di news.js).
 */
const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=900',
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const YT_HEADERS = { 'User-Agent': UA, 'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8', Cookie: 'CONSENT=YES+cb; SOCS=CAI' };

const decodeXml = s => (s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return m ? decodeXml(m[1]).trim() : ''; };

function parseRss(xml) {
  return (xml.match(/<entry>[\s\S]*?<\/entry>/g) || []).map(e => {
    const id = tag(e, 'yt:videoId');
    return id && {
      id, title: tag(e, 'title'), description: tag(e, 'media:description'),
      published: tag(e, 'published'), url: `https://www.youtube.com/watch?v=${id}`,
    };
  }).filter(Boolean);
}

/* Ambil objek ytInitialData dari HTML halaman channel */
function initialData(html) {
  const i = html.indexOf('ytInitialData');
  if (i < 0) return null;
  const start = html.indexOf('{', i);
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { try { return JSON.parse(html.slice(start, j + 1)); } catch { return null; } }
  }
  return null;
}
const txt = t => t?.simpleText || (t?.runs || []).map(r => r.text).join('') || t?.content || '';

/* "10 hari yang lalu" / "2 weeks ago" → perkiraan tanggal ISO */
const UNIT_MS = { detik: 1e3, second: 1e3, menit: 6e4, minute: 6e4, jam: 36e5, hour: 36e5, hari: 864e5, day: 864e5,
  minggu: 6048e5, week: 6048e5, bulan: 2592e6, month: 2592e6, tahun: 31536e6, year: 31536e6 };
function approxDate(t) {
  const m = (t || '').toLowerCase().match(/(\d+)\s*(detik|second|menit|minute|jam|hour|hari|day|minggu|week|bulan|month|tahun|year)/);
  return m ? new Date(Date.now() - +m[1] * UNIT_MS[m[2]]).toISOString() : '';
}

/* Kumpulkan video dari halaman /videos (videoRenderer lama & lockupViewModel baru) */
function pageVideos(data) {
  const out = [], seen = new Set();
  const walk = o => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    const vr = o.videoRenderer;
    if (vr?.videoId && !seen.has(vr.videoId)) {
      seen.add(vr.videoId);
      out.push({ id: vr.videoId, title: txt(vr.title), description: txt(vr.descriptionSnippet), publishedText: txt(vr.publishedTimeText) });
    }
    const lv = o.lockupViewModel;
    if (lv?.contentId && lv.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && !seen.has(lv.contentId)) {
      seen.add(lv.contentId);
      const md = lv.metadata?.lockupMetadataViewModel;
      const parts = (md?.metadata?.contentMetadataViewModel?.metadataRows || [])
        .flatMap(r => (r.metadataParts || []).map(p => txt(p.text)));
      out.push({ id: lv.contentId, title: txt(md?.title), description: '', publishedText: parts.find(p => /lalu|ago/i.test(p)) || '' });
    }
    for (const k in o) if (k !== 'videoRenderer' && k !== 'lockupViewModel') walk(o[k]);
  };
  walk(data);
  return out.map(v => ({ ...v, publishedApprox: approxDate(v.publishedText), url: `https://www.youtube.com/watch?v=${v.id}` }));
}

/* Judul & channel satu video lewat oEmbed */
async function videoInfo(id) {
  if (!/^[\w-]{11}$/.test(id)) return new Response(JSON.stringify({ ok: false, error: 'id tidak valid' }), { status: 400, headers: HEADERS });
  const cache = caches.default;
  const key = new Request(`https://yt-cache.local/video/${id}`);
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, { headers: HEADERS });
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`,
      { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const body = JSON.stringify({ ok: true, id, title: j.title || '', channel: j.author_name || '' });
    await cache.put(key, new Response(body, { headers: { ...HEADERS, 'Cache-Control': 'public, max-age=604800' } }));
    return new Response(body, { headers: HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 502, headers: HEADERS });
  }
}

export async function onRequestGet({ request }) {
  const u = new URL(request.url);
  const vid = (u.searchParams.get('video') || '').trim();
  if (vid) return videoInfo(vid);
  const handle = (u.searchParams.get('handle') || 'PenjagaHarapan').replace(/[^\w.-]/g, '').slice(0, 60);
  const cache = caches.default;
  const key = new Request(`https://yt-cache.local/${handle.toLowerCase()}`);
  if (!u.searchParams.has('fresh')) {
    const hit = await cache.match(key);
    if (hit) return new Response(hit.body, { headers: HEADERS });
  }
  try {
    let channelId = '', page = [];
    try {
      const res = await fetch(`https://www.youtube.com/@${handle}/videos`, { headers: YT_HEADERS });
      if (res.ok) {
        const html = await res.text();
        channelId = (html.match(/"externalId":"(UC[\w-]{22})"/) || html.match(/channel_id=(UC[\w-]{22})/) ||
                     html.match(/"channelId":"(UC[\w-]{22})"/) || [])[1] || '';
        page = pageVideos(initialData(html));
      }
    } catch (_) { /* lanjut ke RSS bila channelId sudah ada */ }
    if (!channelId) throw new Error('channel tidak ditemukan');

    let rss = [];
    const r2 = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { headers: { 'User-Agent': UA } });
    if (r2.ok) rss = parseRss(await r2.text());

    // Gabung: RSS (punya tanggal & deskripsi) diutamakan, sisanya dari halaman
    const byId = new Map(rss.map(v => [v.id, v]));
    page.forEach(v => {
      const r = byId.get(v.id);
      if (r) { if (!r.description && v.description) r.description = v.description; }
      else byId.set(v.id, v);
    });
    const body = JSON.stringify({ ok: true, handle, channelId, fetchedAt: new Date().toISOString(), videos: [...byId.values()] });
    const resp = new Response(body, { headers: { ...HEADERS, 'Cache-Control': 'public, max-age=1800' } });
    await cache.put(key, resp.clone());
    return new Response(body, { headers: HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message, videos: [] }), { status: 502, headers: HEADERS });
  }
}

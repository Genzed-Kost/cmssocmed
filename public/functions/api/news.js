/**
 * Cloudflare Pages Function: GET /api/news?q=...
 * Mengambil berita dari Google News RSS (cadangan: Bing News RSS)
 * dan mengembalikannya sebagai JSON { items: [...] } untuk panel Info Presiden.
 *
 * File ini ada di dua tempat dengan isi sama: functions/api/news.js dan
 * public/functions/api/news.js — supaya tetap jalan apa pun "Root directory"
 * proyek Cloudflare Pages (root repo atau folder public).
 */
const DEFAULT_Q = 'Prabowo Subianto kebijakan pemerintah';
const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=60',
};

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .trim();
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? decode(m[1]) : '';
}
function parseRss(xml, max = 30) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < max) {
    const b = m[1];
    const title = tag(b, 'title');
    const link  = tag(b, 'link') || tag(b, 'guid');
    if (!title || !link) continue;
    const desc = tag(b, 'description').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    items.push({ title, link, pubDate: tag(b, 'pubDate'), source: tag(b, 'source'), desc });
  }
  return items;
}
async function getText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CMSBot/1.0)', 'Accept': 'application/rss+xml, application/xml, text/xml' },
    cf: { cacheTtl: 240, cacheEverything: true },   // < 5 menit agar tiap refresh dapat berita baru
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function onRequestGet({ request }) {
  const params = new URL(request.url).searchParams;
  const q = params.get('q') || DEFAULT_Q;
  const n = Math.min(Math.max(parseInt(params.get('n'), 10) || 7, 1), 40);
  const sources = [
    `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=id&gl=ID&ceid=ID:id`,
    `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setlang=id&cc=ID`,
  ];
  const errors = [];
  for (const url of sources) {
    try {
      const items = parseRss(await getText(url), n);
      if (items.length) return new Response(JSON.stringify({ items }), { headers: HEADERS });
      errors.push(`${new URL(url).hostname}: kosong`);
    } catch (e) {
      errors.push(`${new URL(url).hostname}: ${e.message}`);
    }
  }
  return new Response(JSON.stringify({ error: 'Sumber berita tidak merespons (' + errors.join('; ') + ')' }),
    { status: 502, headers: { ...HEADERS, 'Cache-Control': 'no-store' } });
}

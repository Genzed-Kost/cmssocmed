/**
 * Cloudflare Pages Function: GET /api/market
 * Data pasar untuk sidebar: IHSG (^JKSE) dan kurs USD/IDR.
 * Sumber: Yahoo Finance chart API (tanpa key). Disimpan di cache edge 60 detik.
 * Salinan identik ada di public/functions/api/market.js (lihat catatan di news.js).
 */
const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=60',
};
const SYMBOLS = { ihsg: '^JKSE', usdidr: 'USDIDR=X' };

async function quote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CMSBot/1.0)', Accept: 'application/json' },
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const m = j?.chart?.result?.[0]?.meta;
  const price = +m?.regularMarketPrice;
  if (!price) throw new Error('data kosong');
  const prev = +(m.chartPreviousClose ?? m.previousClose) || null;
  return {
    price,
    prev,
    change: prev ? price - prev : null,
    changePct: prev ? (price - prev) / prev * 100 : null,
    time: m.regularMarketTime ? m.regularMarketTime * 1000 : Date.now(),
    marketState: m.marketState || null,
  };
}

/* Cadangan bila Yahoo menolak: stooq.com (CSV, tanpa data penutupan kemarin) */
const STOOQ = { ihsg: '^jkse', usdidr: 'usdidr' };
async function stooq(sym) {
  const res = await fetch(`https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlc&h&e=csv`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CMSBot/1.0)' }, cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`stooq HTTP ${res.status}`);
  const [, line] = (await res.text()).trim().split(/\r?\n/);
  const c = (line || '').split(',');
  const price = +c[6];
  if (!price) throw new Error('stooq kosong');
  return { price, prev: null, change: null, changePct: null, time: Date.now(), marketState: null, source: 'stooq' };
}

export async function onRequestGet() {
  const out = { now: Date.now() };
  const errors = {};
  await Promise.all(Object.entries(SYMBOLS).map(async ([k, sym]) => {
    try { out[k] = await quote(sym); }
    catch (e) {
      try { out[k] = await stooq(STOOQ[k]); }
      catch (e2) { errors[k] = `${e.message}; ${e2.message}`; }
    }
  }));
  if (Object.keys(errors).length) out.errors = errors;
  const ok = out.ihsg || out.usdidr;
  return new Response(JSON.stringify(out), { status: ok ? 200 : 502, headers: ok ? HEADERS : { ...HEADERS, 'Cache-Control': 'no-store' } });
}

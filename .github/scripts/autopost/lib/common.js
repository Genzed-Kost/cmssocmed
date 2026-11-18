/**
 * common.js — utilitas bersama untuk auto-post
 */

const SUPPORTED_PLATFORMS = ['instagram', 'facebook', 'youtube', 'tiktok'];
const APPROVED_STATUSES   = ['ACC', 'Done'];   // hanya konten yang sudah disetujui
const MAX_ATTEMPTS        = 3;                 // percobaan per platform
const STALE_PROCESSING_MS = 2 * 3600 * 1000;   // "processing" > 2 jam = macet
const MAX_LATE_MS         = 48 * 3600 * 1000;  // lewat jadwal > 48 jam = tidak diposting
const WIB_OFFSET_MS       = 7 * 3600 * 1000;

/* ── Error dengan jenis ─────────────────────────────────────────────
   kind 'config' = salah setting (token kosong, link salah) → tidak di-retry
   kind 'api'    = gagal dari platform → boleh di-retry                 */
class PostError extends Error {
  constructor(message, kind = 'api') { super(message); this.kind = kind; }
}

/* ── Jadwal ──────────────────────────────────────────────────────── */
/** "2026-11-25" + "19:30" (WIB) → epoch ms UTC */
function scheduledAtMs(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return NaN;
  const t = /^\d{2}:\d{2}$/.test(time || '') ? time : '00:00';
  return Date.parse(`${date}T${t}:00Z`) - WIB_OFFSET_MS;
}

/* ── Caption per platform ─────────────────────────────────────────
   Caption di CMS bisa berisi bagian:
     === INSTAGRAM ===  ...  === TIKTOK ===  ...
   lalu "---" + catatan SEO di akhir (tidak ikut diposting).          */
function parseCaptions(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  // buang blok catatan setelah garis "---" terakhir yang berisi "kata kunci"/"SEO"
  const cleaned = text.replace(/\n-{3,}\n[\s\S]*?(kata kunci|seo)[\s\S]*$/i, '').trim();

  const re = /^===\s*([^=\n]+?)\s*===\s*$/gm;
  const marks = [...cleaned.matchAll(re)];
  if (!marks.length) return { _default: cleaned };

  const out = {};
  const head = cleaned.slice(0, marks[0].index).trim();
  if (head) out._default = head;
  marks.forEach((m, i) => {
    const key = normPlatform(m[1]);
    const end = i + 1 < marks.length ? marks[i + 1].index : cleaned.length;
    out[key] = cleaned.slice(m.index + m[0].length, end).trim();
  });
  return out;
}

function normPlatform(s) {
  const k = String(s).toLowerCase().replace(/[^a-z]/g, '');
  if (k.startsWith('ig') || k.includes('instagram')) return 'instagram';
  if (k.startsWith('fb') || k.includes('facebook')) return 'facebook';
  if (k.startsWith('yt') || k.includes('youtube')) return 'youtube';
  if (k.includes('tiktok')) return 'tiktok';
  if (k === 'x' || k.includes('twitter')) return 'twitter';
  return k;
}

/** Caption untuk platform tertentu, dengan urutan cadangan yang masuk akal */
function captionFor(platform, raw) {
  const c = parseCaptions(raw);
  const order = {
    instagram: ['instagram', 'facebook', '_default', 'tiktok'],
    facebook:  ['facebook', 'instagram', '_default', 'tiktok'],
    youtube:   ['youtube', 'instagram', 'facebook', '_default', 'tiktok'],
    tiktok:    ['tiktok', 'instagram', '_default', 'facebook']
  }[platform] || ['_default'];
  for (const k of order) if (c[k]) return c[k];
  return '';
}

/** Potong teks ke maksimal n karakter tanpa memotong di tengah kata bila bisa */
function truncate(s, n) {
  s = String(s || '');
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

/* ── Link media → URL unduhan langsung ────────────────────────────── */
function directMediaUrl(url) {
  url = String(url || '').trim();
  if (!url) throw new PostError('Link file media belum diisi', 'config');
  let u;
  try { u = new URL(url); } catch { throw new PostError(`Link media tidak valid: ${url}`, 'config'); }

  if (/(^|\.)drive\.google\.com$/.test(u.hostname) || u.hostname === 'docs.google.com') {
    if (u.pathname.includes('/folders/'))
      throw new PostError('Link media adalah folder Google Drive — isi dengan link FILE video/gambarnya', 'config');
    const m = u.pathname.match(/\/d\/([A-Za-z0-9_-]{10,})/);
    const id = m ? m[1] : u.searchParams.get('id');
    if (!id) throw new PostError('Tidak bisa membaca ID file dari link Google Drive', 'config');
    return { url: `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`, source: 'gdrive' };
  }
  if (u.hostname.endsWith('dropbox.com')) {
    u.searchParams.delete('dl'); u.searchParams.set('raw', '1');
    return { url: u.toString(), source: 'dropbox' };
  }
  return { url: u.toString(), source: 'direct' };
}

/* ── HTTP helper: fetch + JSON + pesan error yang jelas ───────────── */
async function http(url, opts = {}, label = 'request') {
  let res;
  try { res = await fetch(url, opts); }
  catch (e) { throw new PostError(`${label}: koneksi gagal (${e.message})`); }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch { /* bukan JSON */ }
  if (!res.ok) {
    const msg = json?.error?.error_user_msg || json?.error?.message || json?.error_description
             || json?.error?.code && `${json.error.code}` || text.slice(0, 300) || `HTTP ${res.status}`;
    const err = new PostError(`${label}: ${msg}`);
    err.status = res.status; err.body = json || text;
    throw err;
  }
  return { json: json ?? {}, res, text };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Ulangi fn() sampai mengembalikan nilai truthy, atau habis waktu */
async function poll(fn, { intervalMs = 5000, timeoutMs = 10 * 60 * 1000, label = 'proses' } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new PostError(`${label}: melebihi batas waktu tunggu`);
    await sleep(intervalMs);
  }
}

/** Sembunyikan token di pesan error/log */
function redact(s, secrets = []) {
  let out = String(s || '');
  for (const sec of secrets) if (sec && sec.length > 6) out = out.split(sec).join('***');
  return out.replace(/(access_token=)[^&\s"]+/g, '$1***');
}

module.exports = {
  SUPPORTED_PLATFORMS, APPROVED_STATUSES, MAX_ATTEMPTS, STALE_PROCESSING_MS, MAX_LATE_MS,
  PostError, scheduledAtMs, parseCaptions, captionFor, normPlatform, truncate,
  directMediaUrl, http, poll, sleep, redact
};

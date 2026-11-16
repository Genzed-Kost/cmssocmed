/**
 * Cloudflare Pages Function — Pesan antar user
 *   /api/chat/*   (salinan identik di public/functions/api/chat/[[path]].js)
 *
 * Butuh pengaturan di Cloudflare (Pages → project → Settings):
 *   - Binding D1 database   : CHAT_DB
 *   - Binding R2 bucket     : CHAT_FILES
 *   - Variable (secret)     : CHAT_SECRET   (teks acak panjang, untuk menandatangani token)
 *   - Variable (opsional)   : SETTINGS_URL  (default: data/settings.json repo GitHub)
 *
 * Login memakai nama + password yang sama dengan login CMS; server memeriksa
 * hash-nya terhadap settings.json, lalu memberi token bertanda tangan (30 hari).
 */

const DEFAULT_SETTINGS_URL = 'https://raw.githubusercontent.com/Genzed-Kost/cmssocmed/main/data/settings.json';
const MAX_FILE  = 10 * 1024 * 1024;   // 10 MB
const MAX_TEXT  = 4000;
const TOKEN_TTL = 30 * 24 * 3600;     // detik

const J = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});
const err = (msg, status = 400, extra = {}) => J({ error: msg, ...extra }, status);

/* ── util ─────────────────────────────────────────────────────────────── */
const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlStr = s => b64url(enc.encode(s));
const fromB64url = s => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));

async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
async function makeToken(env, user) {
  const payload = b64urlStr(JSON.stringify({ n: user.name, r: user.role, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL }));
  return payload + '.' + await hmac(env.CHAT_SECRET, payload);
}
async function readToken(env, token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (await hmac(env.CHAT_SECRET, payload) !== sig) return null;
  try {
    const p = JSON.parse(fromB64url(payload));
    if (!p.exp || p.exp < Date.now() / 1000) return null;
    return { name: p.n, role: p.r };
  } catch { return null; }
}

async function loadSettings(env) {
  const url = env.SETTINGS_URL || DEFAULT_SETTINGS_URL;
  const res = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Math.floor(Date.now() / 60000), {
    cf: { cacheTtl: 60 },
  });
  if (!res.ok) throw new Error('Tidak bisa membaca daftar user (HTTP ' + res.status + ')');
  return res.json();
}
function teamList(settings) {
  const list = (settings.users || []).map(u => ({ name: String(u.name || '').trim(), role: u.role || 'creator', hash: u.passwordHash }))
    .filter(u => u.name);
  if (settings.adminName) list.unshift({ name: settings.adminName, role: 'admin', hash: settings.adminHash });
  return list;
}
const low = s => String(s || '').trim().toLowerCase();
const convOf = (a, b) => b === '#all' ? 'all' : 'dm:' + [low(a), low(b)].sort().join('|');

/* ── database ─────────────────────────────────────────────────────────── */
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT NOT NULL, sender TEXT NOT NULL,
      recipient TEXT NOT NULL, body TEXT, files TEXT, ts INTEGER NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conv, id)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS reads (
      user TEXT NOT NULL, conv TEXT NOT NULL, last_id INTEGER NOT NULL, PRIMARY KEY (user, conv))`),
  ]);
  schemaReady = true;
}
const rowOut = r => ({ id: r.id, conv: r.conv, from: r.sender, to: r.recipient, text: r.body || '',
  files: r.files ? JSON.parse(r.files) : [], ts: r.ts });

/* ── handler ──────────────────────────────────────────────────────────── */
export async function onRequest({ request, env, params }) {
  const route = '/' + [].concat(params.path || []).join('/');
  const url   = new URL(request.url);
  const method = request.method;

  if (!env.CHAT_DB || !env.CHAT_FILES || !env.CHAT_SECRET) {
    return err('Fitur pesan belum diaktifkan di Cloudflare (butuh CHAT_DB, CHAT_FILES, CHAT_SECRET).', 503, { code: 'not_configured' });
  }
  const db = env.CHAT_DB;

  try {
    await ensureSchema(db);

    /* Login: nama + password CMS → token */
    if (route === '/login' && method === 'POST') {
      const { name, password } = await request.json().catch(() => ({}));
      if (!name || !password) return err('Nama dan password wajib diisi');
      const team = teamList(await loadSettings(env));
      const u = team.find(x => low(x.name) === low(name));
      if (!u || !u.hash) return err('Nama tidak terdaftar', 401);
      if (await sha256hex(password + ':cmsph:2024') !== u.hash) return err('Password salah', 401);
      return J({ token: await makeToken(env, u), name: u.name, role: u.role });
    }

    /* Semua rute lain butuh token (header Authorization atau ?t= untuk unduh file) */
    const raw  = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('t') || '';
    const me   = await readToken(env, raw);
    if (!me) return err('Sesi pesan habis, silakan masuk lagi', 401, { code: 'auth' });
    const meL  = low(me.name);

    /* Daftar anggota tim */
    if (route === '/users' && method === 'GET') {
      const team = teamList(await loadSettings(env));
      return J({ me: me.name, users: team.filter(u => low(u.name) !== meL).map(u => ({ name: u.name, role: u.role })) });
    }

    /* Ringkasan percakapan: pesan terakhir + jumlah belum dibaca */
    if (route === '/inbox' && method === 'GET') {
      const like = `%${meL}%`;
      const { results } = await db.prepare(`
        SELECT m.*, (
          SELECT COUNT(*) FROM messages x
          WHERE x.conv = m.conv AND lower(x.sender) <> ?1
            AND x.id > COALESCE((SELECT last_id FROM reads WHERE user = ?1 AND conv = m.conv), 0)
        ) AS unread
        FROM messages m
        JOIN (SELECT conv, MAX(id) AS mid FROM messages
              WHERE conv = 'all' OR (conv LIKE 'dm:%' AND conv LIKE ?2) GROUP BY conv) t
          ON t.mid = m.id`).bind(meL, like).all();
      // Pastikan conv DM benar-benar milik user (bukan sekadar substring nama)
      const mine = results.filter(r => r.conv === 'all' || r.conv.slice(3).split('|').includes(meL));
      return J({ convs: mine.map(r => ({ ...rowOut(r), unread: r.unread })) });
    }

    /* Isi percakapan */
    if (route === '/messages' && method === 'GET') {
      const withName = url.searchParams.get('with') || '#all';
      const conv  = convOf(me.name, withName);
      const after = parseInt(url.searchParams.get('after') || '0', 10) || 0;
      const q = after
        ? db.prepare(`SELECT * FROM messages WHERE conv = ? AND id > ? ORDER BY id ASC LIMIT 200`).bind(conv, after)
        : db.prepare(`SELECT * FROM (SELECT * FROM messages WHERE conv = ? ORDER BY id DESC LIMIT 100) ORDER BY id ASC`).bind(conv);
      const { results } = await q.all();
      return J({ conv, messages: results.map(rowOut) });
    }

    /* Tandai sudah dibaca */
    if (route === '/read' && method === 'POST') {
      const { with: withName, lastId } = await request.json().catch(() => ({}));
      const conv = convOf(me.name, withName || '#all');
      await db.prepare(`INSERT INTO reads (user, conv, last_id) VALUES (?, ?, ?)
        ON CONFLICT(user, conv) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)`).bind(meL, conv, +lastId || 0).run();
      return J({ ok: true });
    }

    /* Unggah file (maks 10 MB) → R2 */
    if (route === '/upload' && method === 'POST') {
      const len = +request.headers.get('Content-Length') || 0;
      if (len > MAX_FILE + 1024 * 1024) return err('File melebihi 10 MB', 413);
      const form = await request.formData();
      const file = form.get('file');
      if (!file || typeof file === 'string') return err('File tidak ditemukan');
      if (file.size > MAX_FILE) return err('File melebihi 10 MB', 413);
      const to   = String(form.get('to') || '#all');
      const conv = convOf(me.name, to);
      const safe = String(file.name || 'file').replace(/[^\w.\- ()]+/g, '_').slice(-120);
      const key  = `${conv}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safe}`;
      await env.CHAT_FILES.put(key, file.stream(), {
        httpMetadata: { contentType: file.type || 'application/octet-stream' },
        customMetadata: { name: safe, by: me.name },
      });
      return J({ key, name: safe, size: file.size, type: file.type || 'application/octet-stream' });
    }

    /* Kirim pesan */
    if (route === '/send' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const to   = String(body.to || '#all');
      const text = String(body.text || '').slice(0, MAX_TEXT);
      const conv = convOf(me.name, to);
      const files = (Array.isArray(body.files) ? body.files : []).slice(0, 10)
        .filter(f => f && typeof f.key === 'string' && f.key.startsWith(conv + '/'))
        .map(f => ({ key: f.key, name: String(f.name || ''), size: +f.size || 0, type: String(f.type || '') }));
      if (!text.trim() && !files.length) return err('Pesan kosong');
      if (to !== '#all') {
        const team = teamList(await loadSettings(env));
        const target = team.find(u => low(u.name) === low(to));
        if (!target) return err('Penerima tidak ditemukan', 404);
      }
      const ts  = Date.now();
      const res = await db.prepare(`INSERT INTO messages (conv, sender, recipient, body, files, ts) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(conv, me.name, to, text, files.length ? JSON.stringify(files) : null, ts).run();
      const id = res.meta?.last_row_id;
      await db.prepare(`INSERT INTO reads (user, conv, last_id) VALUES (?, ?, ?)
        ON CONFLICT(user, conv) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)`).bind(meL, conv, id || 0).run();
      return J({ message: { id, conv, from: me.name, to, text, files, ts } });
    }

    /* Unduh / tampilkan file — hanya peserta percakapan */
    if (route === '/file' && method === 'GET') {
      const key  = url.searchParams.get('key') || '';
      const conv = key.split('/')[0];
      const allowed = conv === 'all' || (conv.startsWith('dm:') && conv.slice(3).split('|').includes(meL));
      if (!allowed) return err('Tidak diizinkan', 403);
      const obj = await env.CHAT_FILES.get(key);
      if (!obj) return err('File tidak ditemukan', 404);
      const name = obj.customMetadata?.name || key.split('/').pop();
      const dl   = url.searchParams.get('dl') === '1';
      return new Response(obj.body, { headers: {
        'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
        'Content-Length': String(obj.size),
        'Content-Disposition': `${dl ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'private, max-age=86400',
      } });
    }

    return err('Rute tidak dikenal', 404);
  } catch (e) {
    return err('Kesalahan server: ' + (e.message || e), 500);
  }
}

#!/usr/bin/env node
/**
 * run.js — Auto-post CMS ke Instagram, Facebook, YouTube, TikTok
 * Dijalankan GitHub Actions (.github/workflows/auto-post.yml) tiap 15 menit.
 *
 *   node run.js claim   → pilih konten yang jatuh tempo, tandai "processing"
 *   node run.js post    → unduh media & posting ke tiap platform
 *   node run.js apply   → tulis hasil (link, status) ke data/contents.json
 *
 * Klaim di-commit SEBELUM posting supaya kalau job mati di tengah jalan,
 * konten tidak terposting dua kali (statusnya jadi "needs-check").
 *
 * Env:
 *   AUTOPOST_CREDENTIALS  JSON kredensial per akun (GitHub Secret)
 *   DRY_RUN=1             uji tanpa posting & tanpa mengubah data
 *   ONLY_ID=<id>          proses satu konten saja
 *   AUTOPOST_NOW=<iso>    (uji) paksa waktu "sekarang"
 */
const fs   = require('fs');
const path = require('path');
const C    = require('./lib/common');
const { downloadMedia } = require('./lib/media');
const { postInstagram, postFacebook } = require('./platforms/meta');
const { postYouTube } = require('./platforms/youtube');
const { postTikTok }  = require('./platforms/tiktok');

const ROOT      = process.env.AUTOPOST_ROOT || path.resolve(__dirname, '../../..');
const DATA_DIR  = path.join(ROOT, 'data');
const CONTENTS  = path.join(DATA_DIR, 'contents.json');
const ACTIVITY  = path.join(DATA_DIR, 'activity.json');
const WORK      = process.env.AUTOPOST_WORKDIR || '/tmp/autopost';
const CLAIMED   = path.join(WORK, 'claimed.json');
const RESULTS   = path.join(WORK, 'results.json');
const DRY       = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');
const ONLY_ID   = (process.env.ONLY_ID || '').trim();
const MAX_ITEMS = Number(process.env.AUTOPOST_MAX_ITEMS || 5);
const RUN_ID    = process.env.GITHUB_RUN_ID || `local-${Date.now()}`;

const POSTERS = { instagram: postInstagram, facebook: postFacebook, youtube: postYouTube, tiktok: postTikTok };
const PLATFORM_NAME = { instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube', tiktok: 'TikTok' };

const readJSON  = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n'); };
const nowMs     = () => process.env.AUTOPOST_NOW ? Date.parse(process.env.AUTOPOST_NOW) : Date.now();
const setOutput = (k, v) => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };

/* ═══════════════════════════ CLAIM ══════════════════════════════════ */
function claim(contents, now = nowMs()) {
  const claimed = [];
  let changed = false;
  const iso = new Date(now).toISOString();

  for (const c of contents) {
    const ap = c.autoPost;
    if (!ap?.enabled) continue;
    if (ONLY_ID && c.id !== ONLY_ID) continue;
    // Published diizinkan: untuk mencoba ulang platform yang sebelumnya gagal
    if (!C.APPROVED_STATUSES.includes(c.status) && c.status !== 'Published') continue;

    const due = C.scheduledAtMs(c.publishDate, ap.time || c.publishTime);
    if (Number.isNaN(due) || due > now) continue;

    ap.results = ap.results || {};
    const todo = [];
    for (const p of (c.platforms || []).filter(x => C.SUPPORTED_PLATFORMS.includes(x))) {
      const r = ap.results[p];
      if (r && ['done', 'needs-check', 'skipped'].includes(r.status)) continue;
      if (r?.status === 'processing') {
        if (now - Date.parse(r.claimedAt || 0) > C.STALE_PROCESSING_MS) {
          ap.results[p] = { ...r, status: 'needs-check', at: iso,
            error: 'Proses terhenti di tengah jalan. Cek manual di platform apakah sudah tayang; bila belum, klik "Coba lagi".' };
          changed = true;
        }
        continue;
      }
      if (r?.status === 'error' && (r.attempts || 0) >= C.MAX_ATTEMPTS) continue;
      if (!r && now - due > C.MAX_LATE_MS) {
        ap.results[p] = { status: 'skipped', at: iso, error: 'Sudah lewat >48 jam dari jadwal — tidak diposting otomatis' };
        changed = true;
        continue;
      }
      todo.push(p);
    }
    if (!todo.length) continue;
    if (claimed.length >= MAX_ITEMS) break;

    for (const p of todo) {
      ap.results[p] = { status: 'processing', claimedAt: iso, runId: RUN_ID, attempts: (ap.results[p]?.attempts || 0) + 1 };
    }
    changed = true;
    claimed.push({ id: c.id, title: c.title, platforms: todo });
  }
  return { claimed, changed };
}

/* ═══════════════════════════ POST ═══════════════════════════════════ */
async function post(contents, claimed, creds) {
  const results = [];
  const secrets = collectSecrets(creds);

  for (const item of claimed) {
    const c = contents.find(x => x.id === item.id);
    if (!c) continue;
    const ap = c.autoPost || {};
    const acc = creds[c.account] || {};
    const base = { id: c.id, at: new Date().toISOString() };
    console.log(`\n▶ ${c.title}  [${c.account}]  → ${item.platforms.join(', ')}`);

    let media;
    try {
      media = await downloadMedia(ap.mediaUrl || c.outputLink, WORK, ap.mediaType);
      console.log(`  media: ${media.kind} ${(media.size / 1e6).toFixed(1)} MB`);
    } catch (e) {
      const msg = C.redact(e.message, secrets);
      console.log(`  ✗ media: ${msg}`);
      item.platforms.forEach(p => results.push({ ...base, platform: p, status: 'error', kind: e.kind || 'api', error: msg }));
      continue;
    }

    for (const p of item.platforms) {
      const caption = C.captionFor(p, c.caption);
      if (DRY) {
        const missing = !acc[p] ? ' (KREDENSIAL BELUM ADA)' : '';
        console.log(`  [dry-run] ${p}: caption ${caption.length} karakter${missing}`);
        results.push({ ...base, platform: p, status: 'dry-run', error: missing.trim() || undefined });
        continue;
      }
      try {
        const r = await POSTERS[p]({ cred: acc[p], media, caption, content: c });
        console.log(`  ✓ ${p}: ${r.url || r.id}`);
        results.push({ ...base, platform: p, status: 'done', postId: r.id, url: r.url, note: r.note, at: new Date().toISOString() });
      } catch (e) {
        const msg = C.redact(e.message, secrets);
        console.log(`  ✗ ${p}: ${msg}`);
        results.push({ ...base, platform: p, status: 'error', kind: e.kind || 'api', error: msg, at: new Date().toISOString() });
      }
    }
    try { fs.unlinkSync(media.path); } catch {}
  }
  return results;
}

function collectSecrets(obj, out = []) {
  if (obj && typeof obj === 'object') Object.values(obj).forEach(v => collectSecrets(v, out));
  else if (typeof obj === 'string' && obj.length > 12) out.push(obj);
  return out;
}

/* ═══════════════════════════ APPLY ══════════════════════════════════ */
function apply(contents, results, activity) {
  const iso = new Date().toISOString();
  const touched = new Set();
  for (const r of results) {
    const c = contents.find(x => x.id === r.id);
    if (!c) continue;
    c.autoPost = c.autoPost || { enabled: true };
    c.autoPost.results = c.autoPost.results || {};
    const prev = c.autoPost.results[r.platform] || {};
    if (r.status === 'done') {
      c.autoPost.results[r.platform] = { status: 'done', postId: r.postId, url: r.url, note: r.note, at: r.at, attempts: prev.attempts || 1 };
      if (r.url) { c.platformLinks = c.platformLinks || {}; c.platformLinks[r.platform] = r.url; }
      activity.unshift({ id: uid(), user: 'Auto-Post', role: 'Sistem', action: 'posting otomatis',
        target: `"${c.title}" tayang di ${PLATFORM_NAME[r.platform]}${r.url ? ` — ${r.url}` : ''}`, timestamp: iso });
    } else if (r.status === 'error') {
      const attempts = r.kind === 'config' ? C.MAX_ATTEMPTS : (prev.attempts || 1);
      c.autoPost.results[r.platform] = { status: 'error', error: r.error, kind: r.kind, at: r.at, attempts };
      if (attempts >= C.MAX_ATTEMPTS) {
        activity.unshift({ id: uid(), user: 'Auto-Post', role: 'Sistem', action: 'posting otomatis gagal',
          target: `"${c.title}" ke ${PLATFORM_NAME[r.platform]}: ${r.error}`, timestamp: iso });
      }
    }
    touched.add(c);
  }
  for (const c of touched) {
    const targets = (c.platforms || []).filter(p => C.SUPPORTED_PLATFORMS.includes(p));
    const allDone = targets.length && targets.every(p => c.autoPost.results[p]?.status === 'done');
    if (allDone && c.status !== 'Published') c.status = 'Published';
    c.updatedAt = iso;
  }
  if (activity.length > 500) activity.length = 500;
  return touched.size;
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

/* ═══════════════════════════ CLI ════════════════════════════════════ */
async function main() {
  const mode = process.argv[2];
  const contents = readJSON(CONTENTS, null);
  if (!Array.isArray(contents)) throw new Error(`Tidak bisa membaca ${CONTENTS}`);

  if (mode === 'claim') {
    const { claimed, changed } = claim(contents);
    writeJSON(CLAIMED, claimed);
    if (changed && !DRY) writeJSON(CONTENTS, contents);
    console.log(claimed.length
      ? `Konten jatuh tempo: ${claimed.length}\n` + claimed.map(c => `  • ${c.title} → ${c.platforms.join(', ')}`).join('\n')
      : 'Tidak ada konten yang jatuh tempo.');
    setOutput('count', claimed.length);
    setOutput('changed', changed && !DRY ? 'true' : 'false');
    return;
  }

  if (mode === 'post') {
    const claimed = readJSON(CLAIMED, []);
    let creds = {};
    try { creds = JSON.parse(process.env.AUTOPOST_CREDENTIALS || '{}'); }
    catch { throw new Error('Secret AUTOPOST_CREDENTIALS bukan JSON yang valid'); }
    const results = await post(contents, claimed, creds);
    writeJSON(RESULTS, results);
    const failed = results.filter(r => r.status === 'error').length;
    console.log(`\nSelesai: ${results.filter(r => r.status === 'done').length} berhasil, ${failed} gagal.`);
    if (failed) console.log(`::warning::${failed} posting gagal — lihat detail di CMS`);
    return;
  }

  if (mode === 'apply') {
    const results = readJSON(RESULTS, []);
    const activity = readJSON(ACTIVITY, []);
    const n = apply(contents, results, Array.isArray(activity) ? activity : []);
    writeJSON(CONTENTS, contents);
    if (Array.isArray(activity)) writeJSON(ACTIVITY, activity);
    console.log(`Hasil disimpan untuk ${n} konten.`);
    return;
  }

  console.error('Pakai: node run.js claim|post|apply');
  process.exit(2);
}

if (require.main === module) {
  main().catch(e => { console.error('✗', e.message); process.exit(1); });
}

module.exports = { claim, post, apply };

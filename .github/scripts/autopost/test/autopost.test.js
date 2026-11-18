/**
 * Uji auto-post tanpa internet: fetch diganti tiruan (mock).
 * Jalankan: node --test .github/scripts/autopost/test/
 */
const test   = require('node:test');
const assert = require('node:assert/strict');
const os     = require('os');
const fs     = require('fs');
const path   = require('path');

process.env.AUTOPOST_WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-'));
const C = require('../lib/common');
const { claim, post, apply } = require('../run');
const { chunkPlan } = require('../platforms/tiktok');

/* ── tiruan fetch ───────────────────────────────────────────────────── */
const calls = [];
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
function installFetch(overrides = {}) {
  calls.length = 0;
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    const method = opts.method || 'GET';
    calls.push({ method, url, headers: opts.headers || {}, body: opts.body });
    for (const [k, fn] of Object.entries(overrides)) if (url.includes(k)) return fn(url, opts);

    if (url.includes('drive.usercontent.google.com'))
      return new Response(Buffer.alloc(2048, 1), { headers: { 'content-type': 'video/mp4', 'content-length': '2048' } });
    // Instagram
    if (/\/IG1\/media$/.test(url)) return json({ id: 'C1', uri: 'https://rupload.facebook.com/ig-api-upload/v25.0/C1' });
    if (url.includes('ig-api-upload')) return json({ success: true });
    if (url.includes('/C1?fields=status_code')) return json({ status_code: 'FINISHED' });
    if (url.endsWith('/IG1/media_publish')) return json({ id: 'M1' });
    if (url.includes('/M1?fields=permalink')) return json({ permalink: 'https://www.instagram.com/reel/abc/' });
    // Facebook Reels
    if (url.endsWith('/PG1/video_reels')) {
      const b = JSON.parse(opts.body);
      return b.upload_phase === 'start'
        ? json({ video_id: 'V1', upload_url: 'https://rupload.facebook.com/video-upload/v25.0/V1' })
        : json({ success: true });
    }
    if (url.includes('video-upload')) return json({ success: true });
    if (url.includes('/V1?fields=permalink_url')) return json({ permalink_url: '/reel/V1' });
    // YouTube
    if (url.includes('oauth2.googleapis.com')) return json({ access_token: 'ya29.x' });
    if (url.includes('uploadType=resumable')) return json({}, 200, { location: 'https://upload.youtube/session1' });
    if (url === 'https://upload.youtube/session1') return json({ id: 'YT1', status: { privacyStatus: 'public' } });
    // TikTok
    if (url.endsWith('/oauth/token/')) return json({ access_token: 'act.x', refresh_token: 'rft.x' });
    if (url.includes('creator_info')) return json({ data: { creator_username: 'penjaga.harapan', privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'] }, error: { code: 'ok' } });
    if (url.includes('/video/init/')) return json({ data: { publish_id: 'P1', upload_url: 'https://open-upload.tiktokapis.com/u/1' }, error: { code: 'ok' } });
    if (url.includes('open-upload.tiktokapis.com')) return new Response('', { status: 201 });
    if (url.includes('status/fetch')) return json({ data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [7311] }, error: { code: 'ok' } });
    return json({ error: { message: `tidak ditiru: ${method} ${url}` } }, 404);
  };
}

const CREDS = {
  'penjaga-harapan': {
    instagram: { igUserId: 'IG1', accessToken: 'EAAG-secret-token-ig' },
    facebook:  { pageId: 'PG1', pageToken: 'EAAG-secret-token-fb' },
    youtube:   { clientId: 'cid', clientSecret: 'csecret-long-value', refreshToken: '1//refresh-long-value' },
    tiktok:    { clientKey: 'ck', clientSecret: 'tt-secret-long-value', refreshToken: 'rft.long-value-xyz' }
  }
};

function sample(over = {}) {
  return {
    id: 'k1', title: 'Petani Bisa Menggugat UU', status: 'ACC', format: 'Short',
    account: 'penjaga-harapan', publishDate: '2026-11-25', publishTime: '',
    platforms: ['instagram', 'facebook', 'youtube', 'tiktok', 'twitter'],
    caption: '=== INSTAGRAM ===\nCaption IG #PenjagaHarapan\n\n=== TIKTOK ===\nCaption TT #MK\n\n---\nKata kunci SEO: a, b',
    platformLinks: {},
    autoPost: { enabled: true, time: '19:00', mediaUrl: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view?usp=sharing', mediaType: 'video' },
    ...over
  };
}

/* ── unit ───────────────────────────────────────────────────────────── */
test('caption per platform + buang catatan SEO', () => {
  const raw = sample().caption;
  assert.equal(C.captionFor('instagram', raw), 'Caption IG #PenjagaHarapan');
  assert.equal(C.captionFor('tiktok', raw), 'Caption TT #MK');
  assert.equal(C.captionFor('facebook', raw), 'Caption IG #PenjagaHarapan');   // cadangan dari IG
  assert.equal(C.captionFor('youtube', raw), 'Caption IG #PenjagaHarapan');
  assert.equal(C.captionFor('instagram', 'Caption biasa'), 'Caption biasa');
});

test('jadwal dibaca sebagai WIB', () => {
  assert.equal(new Date(C.scheduledAtMs('2026-11-25', '19:00')).toISOString(), '2026-11-25T12:00:00.000Z');
  assert.equal(new Date(C.scheduledAtMs('2026-11-25', '')).toISOString(), '2026-11-24T17:00:00.000Z');
});

test('link Google Drive diubah ke unduhan langsung', () => {
  assert.match(C.directMediaUrl('https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view?usp=sharing').url, /download\?id=1AbCdEfGhIjKlMn/);
  assert.match(C.directMediaUrl('https://drive.google.com/open?id=1AbCdEfGhIjKlMn').url, /id=1AbCdEfGhIjKlMn/);
  assert.throws(() => C.directMediaUrl('https://drive.google.com/drive/folders/1WJyuOSfP'), /folder/);
  assert.throws(() => C.directMediaUrl(''), /belum diisi/);
});

test('pembagian chunk TikTok', () => {
  assert.deepEqual(chunkPlan(3e6), { chunkSize: 3e6, count: 1 });
  const p = chunkPlan(100 * 1024 * 1024);
  assert.equal(p.count, 10);
});

/* ── claim ──────────────────────────────────────────────────────────── */
test('claim: belum waktunya → tidak diambil', () => {
  const list = [sample()];
  const { claimed } = claim(list, Date.parse('2026-11-25T11:59:00Z'));
  assert.equal(claimed.length, 0);
});

test('claim: jatuh tempo → platform didukung saja, ditandai processing', () => {
  const list = [sample()];
  const { claimed } = claim(list, Date.parse('2026-11-25T12:01:00Z'));
  assert.deepEqual(claimed[0].platforms, ['instagram', 'facebook', 'youtube', 'tiktok']);
  assert.equal(list[0].autoPost.results.instagram.status, 'processing');
  assert.equal(list[0].autoPost.results.instagram.attempts, 1);
  // run kedua tidak mengambil ulang yang sedang processing
  assert.equal(claim(list, Date.parse('2026-11-25T12:20:00Z')).claimed.length, 0);
});

test('claim: status belum ACC/Done, atau auto-post mati → dilewati', () => {
  const t = Date.parse('2026-11-26T00:00:00Z');
  assert.equal(claim([sample({ status: 'Review' })], t).claimed.length, 0);
  assert.equal(claim([sample({ autoPost: { ...sample().autoPost, enabled: false } })], t).claimed.length, 0);
});

test('claim: processing macet > 2 jam → needs-check, tidak diposting ulang', () => {
  const c = sample();
  c.autoPost.results = { instagram: { status: 'processing', claimedAt: '2026-11-25T12:00:00Z', attempts: 1 } };
  c.platforms = ['instagram'];
  const { claimed, changed } = claim([c], Date.parse('2026-11-25T15:00:00Z'));
  assert.equal(claimed.length, 0);
  assert.ok(changed);
  assert.equal(c.autoPost.results.instagram.status, 'needs-check');
});

test('claim: lewat > 48 jam → skipped', () => {
  const c = sample({ platforms: ['instagram'] });
  claim([c], Date.parse('2026-11-28T12:01:00Z'));
  assert.equal(c.autoPost.results.instagram.status, 'skipped');
});

test('claim: gagal 3x → berhenti mencoba', () => {
  const c = sample({ platforms: ['instagram'] });
  c.autoPost.results = { instagram: { status: 'error', attempts: 3 } };
  assert.equal(claim([c], Date.parse('2026-11-25T13:00:00Z')).claimed.length, 0);
});

/* ── post + apply (alur lengkap dengan API tiruan) ──────────────────── */
test('alur lengkap: 4 platform berhasil → Published + link terisi', async () => {
  installFetch();
  const list = [sample()];
  const { claimed } = claim(list, Date.parse('2026-11-25T12:01:00Z'));
  const results = await post(list, claimed, CREDS);

  const byP = Object.fromEntries(results.map(r => [r.platform, r]));
  for (const p of ['instagram', 'facebook', 'youtube', 'tiktok']) assert.equal(byP[p].status, 'done', `${p}: ${byP[p].error}`);
  assert.equal(byP.instagram.url, 'https://www.instagram.com/reel/abc/');
  assert.equal(byP.facebook.url, 'https://www.facebook.com/reel/V1');
  assert.equal(byP.youtube.url, 'https://www.youtube.com/shorts/YT1');
  assert.equal(byP.tiktok.url, 'https://www.tiktok.com/@penjaga.harapan/video/7311');

  // caption yang dikirim sesuai platform
  const ttInit = calls.find(c => c.url.includes('/video/init/'));
  assert.equal(JSON.parse(ttInit.body).post_info.title, 'Caption TT #MK');
  const igCreate = calls.find(c => /\/IG1\/media$/.test(c.url));
  assert.equal(JSON.parse(igCreate.body).caption, 'Caption IG #PenjagaHarapan');
  // upload IG biner pakai header offset/file_size
  const igUp = calls.find(c => c.url.includes('ig-api-upload'));
  assert.equal(igUp.headers.file_size, '2048');

  const activity = [];
  apply(list, results, activity);
  assert.equal(list[0].status, 'Published');
  assert.equal(list[0].platformLinks.youtube, 'https://www.youtube.com/shorts/YT1');
  assert.equal(activity.length, 4);
});

test('gagal di satu platform: error tercatat, token tidak bocor, status tetap', async () => {
  installFetch({
    'creator_info': () => json({ data: {}, error: { code: 'unaudited_client_can_only_post_to_private_accounts', message: 'x' } })
  });
  const list = [sample({ platforms: ['instagram', 'tiktok'] })];
  const { claimed } = claim(list, Date.parse('2026-11-25T12:01:00Z'));
  const results = await post(list, claimed, CREDS);
  const tt = results.find(r => r.platform === 'tiktok');
  assert.equal(tt.status, 'error');
  assert.equal(tt.kind, 'config');
  assert.match(tt.error, /belum lolos audit/);

  apply(list, results, []);
  assert.equal(list[0].status, 'ACC');                       // belum semua tayang
  assert.equal(list[0].autoPost.results.instagram.status, 'done');
  assert.equal(list[0].autoPost.results.tiktok.attempts, C.MAX_ATTEMPTS); // error setting → tidak di-retry
});

test('kredensial kosong → error jelas', async () => {
  installFetch();
  const list = [sample({ account: '33-official', platforms: ['youtube'] })];
  const { claimed } = claim(list, Date.parse('2026-11-25T12:01:00Z'));
  const [r] = await post(list, claimed, CREDS);
  assert.equal(r.status, 'error');
  assert.match(r.error, /Kredensial YouTube/);
});

test('Drive mengembalikan halaman HTML → pesan akses link', async () => {
  installFetch({ 'drive.usercontent': () => new Response('<html>', { headers: { 'content-type': 'text/html' } }) });
  const list = [sample({ platforms: ['instagram'] })];
  const { claimed } = claim(list, Date.parse('2026-11-25T12:01:00Z'));
  const [r] = await post(list, claimed, CREDS);
  assert.match(r.error, /Siapa saja yang memiliki link/);
});

test('redact menyembunyikan token', () => {
  assert.equal(C.redact('gagal token EAAG-secret-token-ig x', ['EAAG-secret-token-ig']), 'gagal token *** x');
  assert.equal(C.redact('url?access_token=abc123&x=1'), 'url?access_token=***&x=1');
});

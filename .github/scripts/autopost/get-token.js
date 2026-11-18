#!/usr/bin/env node
/**
 * get-token.js — bantu ambil token untuk AUTOPOST_CREDENTIALS.
 * Jalankan DI LAPTOP SENDIRI (Node 18+), bukan di server.
 *
 *   node get-token.js meta    <APP_ID> <APP_SECRET> <USER_TOKEN_DARI_GRAPH_EXPLORER>
 *   node get-token.js youtube <CLIENT_ID> <CLIENT_SECRET>
 *   node get-token.js tiktok  <CLIENT_KEY> <CLIENT_SECRET> <REDIRECT_URI>
 *
 * Hasilnya: potongan JSON yang tinggal ditempel ke secret AUTOPOST_CREDENTIALS.
 * JANGAN simpan hasilnya di repo / chat / grup WA.
 */
const http = require('http');
const readline = require('readline');

const [, , which, a, b, c] = process.argv;
const ask = q => new Promise(r => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, x => { rl.close(); r(x.trim()); }); });
const die = m => { console.error('✗ ' + m); process.exit(1); };
async function j(url, opts) {
  const res = await fetch(url, opts);
  const t = await res.text();
  let d; try { d = JSON.parse(t); } catch { d = { raw: t }; }
  if (!res.ok) die(`${res.status}: ${d.error?.message || d.error_description || t.slice(0, 300)}`);
  return d;
}

/* ── META: page token permanen + ID Instagram ───────────────────────── */
async function meta(appId, appSecret, userToken) {
  if (!appId || !appSecret || !userToken) die('Pakai: node get-token.js meta <APP_ID> <APP_SECRET> <USER_TOKEN>');
  const V = 'v25.0';
  const ll = await j(`https://graph.facebook.com/${V}/oauth/access_token?` + new URLSearchParams({
    grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: userToken }));
  const pages = await j(`https://graph.facebook.com/${V}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&limit=100&access_token=${ll.access_token}`);
  if (!pages.data?.length) die('Tidak ada Page. Pastikan akun ini admin Page & izin pages_show_list diberikan.');
  console.log('\nTempel bagian yang sesuai ke AUTOPOST_CREDENTIALS (per akun CMS):\n');
  for (const p of pages.data) {
    const ig = p.instagram_business_account;
    console.log(`// Page: ${p.name}${ig ? `  |  IG: @${ig.username}` : '  |  (belum terhubung ke Instagram)'}`);
    console.log(JSON.stringify({
      facebook: { pageId: p.id, pageToken: p.access_token },
      ...(ig ? { instagram: { igUserId: ig.id, accessToken: p.access_token } } : {})
    }, null, 2) + '\n');
  }
}

/* ── YOUTUBE: refresh token via localhost ───────────────────────────── */
async function youtube(clientId, clientSecret) {
  if (!clientId || !clientSecret) die('Pakai: node get-token.js youtube <CLIENT_ID> <CLIENT_SECRET>');
  const redirect = 'http://localhost:8765';
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId, redirect_uri: redirect, response_type: 'code', access_type: 'offline', prompt: 'consent',
    scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly' });
  console.log('\n1) Buka link ini, login dengan akun pemilik/manajer channel, pilih channel yang benar:\n\n' + url + '\n');
  const code = await new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, redirect);
      const c = u.searchParams.get('code');
      res.end(c ? 'Berhasil. Silakan kembali ke terminal.' : 'Tidak ada kode.');
      if (c) { srv.close(); resolve(c); }
    }).listen(8765);
  });
  const t = await j('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' }) });
  if (!t.refresh_token) die('Refresh token tidak diberikan. Cabut akses aplikasi di myaccount.google.com/permissions lalu ulangi.');
  const ch = await j('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: `Bearer ${t.access_token}` } });
  console.log(`\nChannel: ${ch.items?.[0]?.snippet?.title || '(tidak terbaca)'}\n`);
  console.log(JSON.stringify({ youtube: { clientId, clientSecret, refreshToken: t.refresh_token, categoryId: '25', privacy: 'public' } }, null, 2));
}

/* ── TIKTOK: refresh token (salin URL redirect) ─────────────────────── */
async function tiktok(clientKey, clientSecret, redirectUri) {
  if (!clientKey || !clientSecret || !redirectUri) die('Pakai: node get-token.js tiktok <CLIENT_KEY> <CLIENT_SECRET> <REDIRECT_URI>');
  const url = 'https://www.tiktok.com/v2/auth/authorize/?' + new URLSearchParams({
    client_key: clientKey, response_type: 'code', scope: 'user.info.basic,video.publish',
    redirect_uri: redirectUri, state: Math.random().toString(36).slice(2) });
  console.log('\n1) Buka link ini & login dengan akun TikTok tujuan:\n\n' + url + '\n');
  const back = await ask('2) Setelah diarahkan, salin URL lengkap dari address bar lalu tempel di sini:\n> ');
  const code = new URL(back).searchParams.get('code');
  if (!code) die('Kode tidak ditemukan di URL tersebut');
  const t = await j('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, code: decodeURIComponent(code),
      grant_type: 'authorization_code', redirect_uri: redirectUri }) });
  if (!t.refresh_token) die('Gagal: ' + JSON.stringify(t));
  console.log(`\nRefresh token berlaku ±${Math.round((t.refresh_expires_in || 0) / 86400)} hari — perbarui sebelum habis.\n`);
  console.log(JSON.stringify({ tiktok: { clientKey, clientSecret, refreshToken: t.refresh_token, privacyLevel: 'PUBLIC_TO_EVERYONE' } }, null, 2));
}

({ meta, youtube, tiktok }[which] || (() => die('Pakai: node get-token.js meta|youtube|tiktok …')))(a, b, c)
  .catch(e => die(e.message));

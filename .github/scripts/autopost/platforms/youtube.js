/**
 * youtube.js — upload video via YouTube Data API v3 (resumable upload)
 * Butuh OAuth refresh token channel (lihat AUTOPOST.md).
 */
const fs = require('fs');
const { PostError, http, truncate } = require('../lib/common');

async function accessToken(cred) {
  const { json } = await http('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cred.clientId, client_secret: cred.clientSecret,
      refresh_token: cred.refreshToken, grant_type: 'refresh_token'
    })
  }, 'YouTube refresh token');
  if (!json.access_token) throw new PostError('YouTube: access token kosong', 'config');
  return json.access_token;
}

async function postYouTube({ cred, media, caption, content }) {
  if (!cred?.clientId || !cred?.clientSecret || !cred?.refreshToken)
    throw new PostError('Kredensial YouTube (clientId / clientSecret / refreshToken) belum diisi', 'config');
  if (media.kind !== 'video') throw new PostError('YouTube hanya menerima video', 'config');

  let tok;
  try { tok = await accessToken(cred); }
  catch (e) {
    if (/invalid_grant/i.test(e.message))
      throw new PostError('YouTube: refresh token kedaluwarsa/dicabut — buat ulang dengan get-token.js', 'config');
    throw e;
  }

  // Judul: < 100 karakter, tanpa < >
  const rawTitle = content.autoPost?.youtubeTitle || content.title || 'Video';
  const title = truncate(rawTitle.replace(/[<>]/g, ''), 100);
  const description = truncate(caption.replace(/[<>]/g, ''), 5000);
  const tags = [...new Set((caption.match(/#[\p{L}\p{N}_]+/gu) || []).map(t => t.slice(1)))].slice(0, 15);

  const meta = {
    snippet: { title, description, tags, categoryId: String(cred.categoryId || '25'), defaultLanguage: 'id' },
    status: { privacyStatus: cred.privacy || 'public', selfDeclaredMadeForKids: false, embeddable: true }
  };

  // 1) mulai sesi resumable
  const { res } = await http(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tok}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(media.size),
        'X-Upload-Content-Type': media.mime
      },
      body: JSON.stringify(meta)
    }, 'YouTube mulai upload');
  const location = res.headers.get('location');
  if (!location) throw new PostError('YouTube: tidak mendapat URL upload');

  // 2) kirim file
  const { json } = await http(location, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': media.mime },
    body: await fs.openAsBlob(media.path)
  }, 'YouTube upload video');

  const id = json.id;
  const isShort = /short|reels?/i.test(content.format || '');
  return {
    id,
    url: isShort ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`,
    note: json.status?.privacyStatus && json.status.privacyStatus !== (cred.privacy || 'public')
      ? `Video berstatus ${json.status.privacyStatus} (project API belum diaudit YouTube?)` : undefined
  };
}

module.exports = { postYouTube };

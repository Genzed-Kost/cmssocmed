/**
 * tiktok.js — Content Posting API (Direct Post, FILE_UPLOAD)
 * Catatan: sebelum aplikasi TikTok lolos audit, semua postingan
 * dipaksa privat (SELF_ONLY) dan akun harus berstatus privat.
 */
const { PostError, http, poll, truncate } = require('../lib/common');
const { readChunk } = require('../lib/media');

const API = 'https://open.tiktokapis.com/v2';
const MB  = 1024 * 1024;

async function accessToken(cred) {
  const { json } = await http(`${API}/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: cred.clientKey, client_secret: cred.clientSecret,
      grant_type: 'refresh_token', refresh_token: cred.refreshToken
    })
  }, 'TikTok refresh token');
  if (!json.access_token)
    throw new PostError(`TikTok: refresh token ditolak (${json.error_description || json.error || 'tanpa pesan'}) — buat ulang dengan get-token.js`, 'config');
  return json.access_token;
}

/** Hitung pembagian chunk sesuai aturan TikTok (5–64 MB, chunk terakhir boleh lebih besar) */
function chunkPlan(size) {
  if (size <= 64 * MB) return { chunkSize: size, count: 1 };
  const chunkSize = 10 * MB;
  return { chunkSize, count: Math.floor(size / chunkSize) };
}

async function tt(path, tok, body, label) {
  const { json } = await http(`${API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body || {})
  }, label);
  if (json.error && json.error.code && json.error.code !== 'ok') {
    const hint = {
      unaudited_client_can_only_post_to_private_accounts:
        'Aplikasi TikTok belum lolos audit: akun harus privat & privacyLevel "SELF_ONLY"',
      spam_risk_too_many_posts: 'Batas posting harian akun TikTok tercapai',
      reached_active_user_cap: 'Kuota pengguna harian aplikasi TikTok tercapai'
    }[json.error.code];
    throw new PostError(`${label}: ${hint || json.error.message || json.error.code}`,
      json.error.code.startsWith('unaudited') ? 'config' : 'api');
  }
  return json.data || {};
}

async function postTikTok({ cred, media, caption }) {
  if (!cred?.clientKey || !cred?.clientSecret || !cred?.refreshToken)
    throw new PostError('Kredensial TikTok (clientKey / clientSecret / refreshToken) belum diisi', 'config');
  if (media.kind !== 'video') throw new PostError('Posting foto ke TikTok belum didukung (perlu domain terverifikasi)', 'config');

  const tok = await accessToken(cred);

  const info = await tt('/post/publish/creator_info/query/', tok, {}, 'TikTok info kreator');
  const wanted = cred.privacyLevel || 'PUBLIC_TO_EVERYONE';
  const options = info.privacy_level_options || [];
  if (options.length && !options.includes(wanted))
    throw new PostError(`TikTok: privacy "${wanted}" tidak tersedia untuk akun ini (pilihan: ${options.join(', ')})`, 'config');

  const { chunkSize, count } = chunkPlan(media.size);
  const init = await tt('/post/publish/video/init/', tok, {
    post_info: {
      title: truncate(caption, 2200),
      privacy_level: wanted,
      disable_comment: !!info.comment_disabled,
      disable_duet: !!info.duet_disabled,
      disable_stitch: !!info.stitch_disabled
    },
    source_info: { source: 'FILE_UPLOAD', video_size: media.size, chunk_size: chunkSize, total_chunk_count: count }
  }, 'TikTok mulai upload');

  for (let i = 0; i < count; i++) {
    const start = i * chunkSize;
    const end   = i === count - 1 ? media.size - 1 : start + chunkSize - 1;
    const buf   = readChunk(media.path, start, end - start + 1);
    await http(init.upload_url, {
      method: 'PUT',
      headers: {
        'Content-Type': media.mime,
        'Content-Length': String(buf.length),
        'Content-Range': `bytes ${start}-${end}/${media.size}`
      },
      body: buf
    }, `TikTok upload bagian ${i + 1}/${count}`);
  }

  const done = await poll(async () => {
    const st = await tt('/post/publish/status/fetch/', tok, { publish_id: init.publish_id }, 'TikTok cek status');
    if (st.status === 'FAILED') throw new PostError(`TikTok gagal memproses: ${st.fail_reason || 'tanpa alasan'}`);
    return st.status === 'PUBLISH_COMPLETE' ? st : null;
  }, { intervalMs: 8000, timeoutMs: 15 * 60 * 1000, label: 'TikTok proses video' });

  const postId = (done.publicaly_available_post_id || done.publicly_available_post_id || [])[0];
  const user = info.creator_username;
  return {
    id: postId ? String(postId) : init.publish_id,
    url: postId && user ? `https://www.tiktok.com/@${user}/video/${postId}` : (user ? `https://www.tiktok.com/@${user}` : ''),
    note: wanted === 'SELF_ONLY' ? 'Diposting privat (SELF_ONLY)' : undefined
  };
}

module.exports = { postTikTok, chunkPlan };

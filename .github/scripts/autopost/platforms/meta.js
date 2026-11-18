/**
 * meta.js — Instagram (Reels / foto) dan Facebook Page (Reels / video / foto)
 * Memakai Graph API dengan Page Access Token (Facebook Login for Business).
 */
const fs = require('fs');
const { PostError, http, poll, truncate } = require('../lib/common');

const V      = process.env.META_GRAPH_VERSION || 'v25.0';
const GRAPH  = `https://graph.facebook.com/${V}`;
const RUPLOAD = 'https://rupload.facebook.com';

const isShortForm = fmt => /short|reels?/i.test(fmt || '');

/* ════════════════════════ INSTAGRAM ════════════════════════════════ */
async function postInstagram({ cred, media, caption }) {
  if (!cred?.igUserId || !cred?.accessToken)
    throw new PostError('Kredensial Instagram (igUserId / accessToken) belum diisi', 'config');
  const tok = cred.accessToken;
  const ig  = cred.igUserId;
  caption = truncate(caption, 2200);

  let containerId;
  if (media.kind === 'image') {
    // IG mengambil gambar dari URL publik (tidak ada upload biner untuk foto)
    const { json } = await http(`${GRAPH}/${ig}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ image_url: media.publicUrl, caption })
    }, 'Instagram buat container foto');
    containerId = json.id;
  } else {
    // 1) container resumable
    const { json } = await http(`${GRAPH}/${ig}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ media_type: 'REELS', upload_type: 'resumable', caption, share_to_feed: true })
    }, 'Instagram buat container Reels');
    containerId = json.id;
    const uploadUri = json.uri || `${RUPLOAD}/ig-api-upload/${V}/${containerId}`;

    // 2) upload biner
    await http(uploadUri, {
      method: 'POST',
      headers: { Authorization: `OAuth ${tok}`, offset: '0', file_size: String(media.size) },
      body: await fs.openAsBlob(media.path)
    }, 'Instagram upload video');
  }

  // 3) tunggu proses
  await poll(async () => {
    const { json } = await http(`${GRAPH}/${containerId}?fields=status_code,status`, {
      headers: { Authorization: `Bearer ${tok}` }
    }, 'Instagram cek status');
    if (json.status_code === 'ERROR' || json.status_code === 'EXPIRED')
      throw new PostError(`Instagram gagal memproses media: ${json.status || json.status_code}`);
    return json.status_code === 'FINISHED';
  }, { intervalMs: 8000, timeoutMs: 15 * 60 * 1000, label: 'Instagram proses video' });

  // 4) publish
  const { json: pub } = await http(`${GRAPH}/${ig}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ creation_id: containerId })
  }, 'Instagram publish');

  let url = '';
  try {
    const { json } = await http(`${GRAPH}/${pub.id}?fields=permalink`, {
      headers: { Authorization: `Bearer ${tok}` }
    }, 'Instagram ambil permalink');
    url = json.permalink || '';
  } catch { /* permalink opsional */ }
  return { id: pub.id, url };
}

/* ════════════════════════ FACEBOOK PAGE ════════════════════════════ */
async function postFacebook({ cred, media, caption, content }) {
  if (!cred?.pageId || !cred?.pageToken)
    throw new PostError('Kredensial Facebook (pageId / pageToken) belum diisi', 'config');
  const tok  = cred.pageToken;
  const page = cred.pageId;

  if (media.kind === 'image') {
    const fd = new FormData();
    fd.append('source', await fs.openAsBlob(media.path, { type: media.mime }), 'image');
    fd.append('caption', caption);
    fd.append('published', 'true');
    const { json } = await http(`${GRAPH}/${page}/photos`, {
      method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: fd
    }, 'Facebook upload foto');
    const postId = json.post_id || json.id;
    return { id: postId, url: `https://www.facebook.com/${postId}` };
  }

  let videoId;
  if (isShortForm(content.format) && cred.useReels !== false) {
    // Reels: start → upload → finish
    const { json: st } = await http(`${GRAPH}/${page}/video_reels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ upload_phase: 'start' })
    }, 'Facebook Reels mulai');
    videoId = st.video_id;
    await http(st.upload_url || `${RUPLOAD}/video-upload/${V}/${videoId}`, {
      method: 'POST',
      headers: { Authorization: `OAuth ${tok}`, offset: '0', file_size: String(media.size) },
      body: await fs.openAsBlob(media.path)
    }, 'Facebook Reels upload');
    await http(`${GRAPH}/${page}/video_reels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ upload_phase: 'finish', video_id: videoId, video_state: 'PUBLISHED', description: caption })
    }, 'Facebook Reels publish');
  } else {
    const fd = new FormData();
    fd.append('source', await fs.openAsBlob(media.path, { type: media.mime }), 'video.mp4');
    fd.append('description', caption);
    if (content.title) fd.append('title', truncate(content.title, 250));
    const { json } = await http(`https://graph-video.facebook.com/${V}/${page}/videos`, {
      method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: fd
    }, 'Facebook upload video');
    videoId = json.id;
  }

  let url = `https://www.facebook.com/${page}/videos/${videoId}`;
  try {
    const { json } = await http(`${GRAPH}/${videoId}?fields=permalink_url`, {
      headers: { Authorization: `Bearer ${tok}` }
    }, 'Facebook ambil permalink');
    if (json.permalink_url)
      url = json.permalink_url.startsWith('http') ? json.permalink_url : `https://www.facebook.com${json.permalink_url}`;
  } catch { /* opsional */ }
  return { id: videoId, url };
}

module.exports = { postInstagram, postFacebook };

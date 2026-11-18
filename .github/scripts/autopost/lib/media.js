/**
 * media.js — unduh file media final ke disk runner
 */
const fs   = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { PostError, directMediaUrl } = require('./common');

const MAX_BYTES = 1024 * 1024 * 1024; // 1 GB

const EXT_BY_TYPE = {
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp'
};

function guessKind(contentType, filename, hint) {
  if (hint === 'video' || hint === 'image') return hint;
  if (/^video\//.test(contentType)) return 'video';
  if (/^image\//.test(contentType)) return 'image';
  if (/\.(mp4|mov|m4v|webm)$/i.test(filename || '')) return 'video';
  if (/\.(jpe?g|png|webp)$/i.test(filename || '')) return 'image';
  return 'video';
}

function filenameFromDisposition(h) {
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(h || '');
  return m ? decodeURIComponent(m[1]) : '';
}

/**
 * @returns {{ path, size, mime, kind, publicUrl }}
 *   publicUrl = URL unduhan langsung (dipakai IG untuk gambar)
 */
async function downloadMedia(link, dir, kindHint) {
  const { url, source } = directMediaUrl(link);
  fs.mkdirSync(dir, { recursive: true });

  let res;
  try { res = await fetch(url, { redirect: 'follow' }); }
  catch (e) { throw new PostError(`Unduh media gagal: ${e.message}`); }
  if (!res.ok) {
    throw new PostError(
      res.status === 404 || res.status === 403
        ? `File media tidak bisa diakses (HTTP ${res.status}). Pastikan akses link: "Siapa saja yang memiliki link".`
        : `Unduh media gagal (HTTP ${res.status})`,
      res.status === 404 || res.status === 403 ? 'config' : 'api');
  }
  const ctype = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (ctype === 'text/html') {
    throw new PostError(
      source === 'gdrive'
        ? 'Google Drive mengembalikan halaman, bukan file. Pastikan akses link "Siapa saja yang memiliki link" dan link mengarah ke file (bukan folder).'
        : 'Link media mengarah ke halaman web, bukan file video/gambar langsung.',
      'config');
  }
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new PostError(`File terlalu besar (${(len / 1e6).toFixed(0)} MB, maks 1 GB)`, 'config');

  const fname = filenameFromDisposition(res.headers.get('content-disposition'));
  const kind  = guessKind(ctype, fname, kindHint);
  const ext   = EXT_BY_TYPE[ctype] || path.extname(fname) || (kind === 'image' ? '.jpg' : '.mp4');
  const file  = path.join(dir, `media_${Date.now()}${ext}`);

  let seen = 0;
  const limiter = async function* (src) {
    for await (const chunk of src) {
      seen += chunk.length;
      if (seen > MAX_BYTES) throw new PostError('File terlalu besar (maks 1 GB)', 'config');
      yield chunk;
    }
  };
  await pipeline(Readable.fromWeb(res.body), limiter, fs.createWriteStream(file));

  const size = fs.statSync(file).size;
  if (!size) throw new PostError('File media kosong (0 byte)', 'config');
  const mime = /^(video|image)\//.test(ctype) ? ctype : (kind === 'image' ? 'image/jpeg' : 'video/mp4');
  return { path: file, size, mime, kind, publicUrl: url };
}

/** Baca sebagian file (untuk upload per-chunk) */
function readChunk(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return n === length ? buf : buf.subarray(0, n);
  } finally { fs.closeSync(fd); }
}

module.exports = { downloadMedia, readChunk, guessKind };

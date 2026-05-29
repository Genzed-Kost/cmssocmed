/**
 * Cloudflare Pages Function — GitHub API Write Proxy
 *
 * PAT disimpan sebagai environment variable di Cloudflare (tidak pernah ke browser
 * atau ke repo publik). Semua request tulis dikirim lewat endpoint ini.
 *
 * Setup (Cloudflare Pages → project → Settings → Environment variables):
 *   GITHUB_TOKEN  — GitHub PAT dengan izin Contents: Read & Write
 *   GITHUB_OWNER  — (opsional) pemilik repo, default: Genzed-Kost
 *   GITHUB_REPO   — (opsional) nama repo,   default: cmssocmed
 */

const DEFAULT_OWNER = 'Genzed-Kost';
const DEFAULT_REPO  = 'cmssocmed';

/**
 * PUT /api/proxy?path=data/file.json
 * Tulis / update file di GitHub. Body: GitHub Contents API payload (JSON).
 */
export async function onRequestPut(context) {
  const { request, env } = context;

  const token = env.GITHUB_TOKEN;
  if (!token) {
    return jsonRes({ message: 'Server: GITHUB_TOKEN belum dikonfigurasi di Cloudflare' }, 500);
  }

  const url  = new URL(request.url);
  const path = url.searchParams.get('path');
  if (!path) return jsonRes({ message: 'Query param "path" diperlukan' }, 400);

  const owner  = env.GITHUB_OWNER || DEFAULT_OWNER;
  const repo   = env.GITHUB_REPO  || DEFAULT_REPO;
  const target = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

  const ghRes = await fetch(target, {
    method : 'PUT',
    headers: {
      'Authorization'       : `Bearer ${token}`,
      'Accept'              : 'application/vnd.github.v3+json',
      'Content-Type'        : 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent'          : 'CMS-PenjagaHarapan/1.0'
    },
    body: await request.text()
  });

  return new Response(await ghRes.text(), {
    status : ghRes.status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * GET /api/proxy
 * Cek koneksi: verifikasi GITHUB_TOKEN & akses repo.
 */
export async function onRequestGet(context) {
  const { env } = context;

  const token = env.GITHUB_TOKEN;
  if (!token) return jsonRes({ ok: false, error: 'GITHUB_TOKEN belum diset di Cloudflare' }, 500);

  const owner  = env.GITHUB_OWNER || DEFAULT_OWNER;
  const repo   = env.GITHUB_REPO  || DEFAULT_REPO;

  const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      'Authorization'       : `Bearer ${token}`,
      'Accept'              : 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent'          : 'CMS-PenjagaHarapan/1.0'
    }
  });

  const data = await ghRes.json().catch(() => ({}));
  return jsonRes({ ok: ghRes.ok, status: ghRes.status, repo: data.full_name });
}

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

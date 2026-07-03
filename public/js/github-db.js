/* ================================================================
   GitHubDB — GitHub REST API as a simple JSON database
   Uses: GET/PUT /repos/{owner}/{repo}/contents/{path}
   ================================================================ */

class GitHubDB {
  constructor() {
    this._ls = 'cmsph_github_v1';
    this._cfg = null;
    this._cache = {};  // in-memory cache for file SHAs
  }

  /* ── Config ──────────────────────────────────────────────────── */
  loadConfig() {
    if (this._cfg) return this._cfg;
    try { this._cfg = JSON.parse(localStorage.getItem(this._ls) || 'null'); }
    catch { this._cfg = null; }
    return this._cfg;
  }

  saveConfig(cfg) {
    this._cfg = cfg;
    localStorage.setItem(this._ls, JSON.stringify(cfg));
  }

  isConfigured() {
    const c = this.loadConfig();
    return !!(c && c.owner && c.repo);  // PAT tidak wajib untuk baca repo public
  }

  hasPAT() {
    const c = this.loadConfig();
    return !!(c && c.pat);
  }

  getConfig() { return this.loadConfig(); }

  /* ── HTTP helpers ────────────────────────────────────────────── */
  _headers() {
    const c = this.loadConfig();
    if (!c || !c.pat) throw new Error('GitHub PAT belum dikonfigurasi');
    return {
      'Authorization': `Bearer ${c.pat}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  _url(path) {
    const c = this.loadConfig();
    return `https://api.github.com/repos/${c.owner}/${c.repo}/contents/${path}`;
  }

  /* ── Core file operations ────────────────────────────────────── */

  /**
   * Read a file from GitHub. Returns { data: any, sha: string } or null.
   * Jika PAT tersimpan invalid (Bad credentials), otomatis retry tanpa auth
   * agar repo public tetap bisa dibaca meski cache PAT kadaluarsa.
   */
  async getFile(path) {
    const c = this.loadConfig();
    const branch = (c?.branch) || 'main';
    const url = this._url(path) + `?ref=${branch}&t=${Date.now()}`;

    const baseHeaders = {
      'Accept': 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };

    // PENTING: simpan pat sebagai string primitif (bukan referensi objek).
    // Jika banyak getFile() berjalan paralel (Promise.all) dan salah satu
    // menghapus cfg.pat, objek c yang di-share bisa kehilangan .pat SEBELUM
    // handler 401 di call lain sempat memeriksa c.pat.
    const patAtStart = c?.pat || '';
    const authHeaders = patAtStart
      ? { ...baseHeaders, 'Authorization': `Bearer ${patAtStart}` }
      : baseHeaders;

    let res = await fetch(url, { headers: authHeaders });

    // PAT invalid → hapus dari config & retry tanpa auth (repo public)
    if (res.status === 401 && patAtStart) {
      const cfg = this.loadConfig();
      if (cfg) { delete cfg.pat; this._cfg = cfg; localStorage.setItem(this._ls, JSON.stringify(cfg)); }
      localStorage.removeItem('cmsph_team_token_v1');
      res = await fetch(url, { headers: baseHeaders });
    }

    if (res.status === 404) return null;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }

    const json = await res.json();
    const content = decodeURIComponent(escape(atob(json.content.replace(/\s/g, ''))));
    let data;
    try { data = JSON.parse(content); }
    catch { data = content; }
    this._cache[path] = json.sha;
    return { data, sha: json.sha };
  }

  /**
   * Write (create or update) a file.
   * @param {string} path  - repo-relative path, e.g. "data/contents.json"
   * @param {any}    data  - JSON-serialisable value
   * @param {string} sha   - current file SHA (required for updates, omit for create)
   * @param {string} msg   - commit message
   */
  async putFile(path, data, sha, msg) {
    const c = this.loadConfig();
    const branch = c.branch || 'main';
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));

    const body = {
      message: msg || `Update ${path}`,
      content,
      branch
    };
    if (sha) body.sha = sha;

    const res = await fetch(this._url(path), {
      method: 'PUT',
      headers: this._headers(),
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }

    const json = await res.json();
    const newSha = json.content?.sha || sha;
    this._cache[path] = newSha;
    return newSha;
  }

  /* ── Collection-level helpers ────────────────────────────────── */

  async read(collection) {
    const filePath = `data/${collection}.json`;
    const result = await this.getFile(filePath);
    return result;   // { data, sha } or null
  }

  async write(collection, data, sha, msg) {
    const filePath = `data/${collection}.json`;
    return this.putFile(filePath, data, sha, msg || `CMS: update ${collection}`);
  }

  /* ── Convenience: read + write with auto-SHA ─────────────────── */

  async readData(collection) {
    const r = await this.read(collection);
    return r ? r.data : [];
  }

  /**
   * Overwrite entire collection atomically.
   * Fetches current SHA first if not cached.
   */
  async writeData(collection, data, msg) {
    const filePath = `data/${collection}.json`;
    let sha = this._cache[filePath];
    if (!sha) {
      const current = await this.getFile(filePath);
      sha = current ? current.sha : undefined;
    }
    return this.putFile(filePath, data, sha, msg);
  }

  /* ── Binary file upload ─────────────────────────────────────── */

  /** Upload file biner (base64) ke path GitHub. Digunakan untuk file budget. */
  async uploadFile(path, base64Content, msg) {
    const c = this.loadConfig();
    const branch = c.branch || 'main';
    // Cek apakah file sudah ada (untuk ambil SHA)
    let sha;
    try {
      const existing = await this.getFile(path);
      if (existing) sha = existing.sha;
    } catch { /* file baru, tidak perlu SHA */ }

    const body = { message: msg || `Upload ${path}`, content: base64Content, branch };
    if (sha) body.sha = sha;

    const res = await fetch(this._url(path), {
      method: 'PUT',
      headers: this._headers(),
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    const json = await res.json();
    this._cache[path] = json.content?.sha;
    return json.content?.download_url || null;
  }

  getRepo() {
    const c = this.loadConfig();
    return c ? `${c.owner}/${c.repo}` : '';
  }

  /* ── Append helpers ──────────────────────────────────────────── */

  async append(collection, item, msg) {
    const filePath = `data/${collection}.json`;
    const result = await this.getFile(filePath);
    const arr = result ? (Array.isArray(result.data) ? result.data : []) : [];
    arr.push(item);
    return this.putFile(filePath, arr, result?.sha, msg || `CMS: add to ${collection}`);
  }

  async updateItem(collection, id, updates, msg) {
    const filePath = `data/${collection}.json`;
    const result = await this.getFile(filePath);
    if (!result) throw new Error(`Collection ${collection} tidak ditemukan`);
    const arr = Array.isArray(result.data) ? result.data : [];
    const idx = arr.findIndex(x => x.id === id);
    if (idx === -1) throw new Error(`Item ${id} tidak ditemukan`);
    arr[idx] = { ...arr[idx], ...updates, updatedAt: new Date().toISOString() };
    return this.putFile(filePath, arr, result.sha, msg || `CMS: update item ${id}`);
  }

  async deleteItem(collection, id, msg) {
    const filePath = `data/${collection}.json`;
    const result = await this.getFile(filePath);
    if (!result) throw new Error(`Collection ${collection} tidak ditemukan`);
    const arr = Array.isArray(result.data) ? result.data : [];
    const filtered = arr.filter(x => x.id !== id);
    return this.putFile(filePath, filtered, result.sha, msg || `CMS: delete item ${id}`);
  }

  /* ── Create repository ───────────────────────────────────────── */

  /**
   * Create a new GitHub repository for the current user.
   * Uses the PAT from config.
   */
  async createRepo(name, description = '', isPrivate = true) {
    const c = this.loadConfig();
    if (!c || !c.pat) throw new Error('PAT belum dikonfigurasi');

    const res = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${c.pat}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({
        name,
        description,
        private: isPrivate,
        auto_init: true   // creates initial commit + README so branch exists
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);

    // Update config with confirmed owner and default branch
    const cfg = { ...c, owner: data.owner.login, repo: data.name, branch: data.default_branch || 'main' };
    this.saveConfig(cfg);
    this._cache = {};  // clear SHA cache for the new repo
    return data;
  }

  /* ── Test connection ─────────────────────────────────────────── */

  async testConnection() {
    const c = this.loadConfig();
    if (!c) throw new Error('Konfigurasi kosong');
    const url = `https://api.github.com/repos/${c.owner}/${c.repo}`;
    const res = await fetch(url, { headers: this._headers() });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    return await res.json();
  }

  /* ── Init data files ──────────────────────────────────────────── */

  async initDataFiles() {
    const defaults = {
      'contents.json':    [],
      'activity.json':    [],
      'todos.json':       [],
      'contentBank.json':    [],
      'assets.json':         [],
      'stockContents.json':  [],
      'settings.json': {
        kpi:   { 'penjaga-harapan': 5, '33-official': 2, 'jaga-asa': 1 },
        users: [],
        analyticsUrls: {}
      },
      'analytics.json': {
        'penjaga-harapan': {},
        '33-official':     {},
        'jaga-asa':        {}
      }
    };

    const results = [];
    for (const [file, defaultData] of Object.entries(defaults)) {
      const path = `data/${file}`;
      const existing = await this.getFile(path);
      if (!existing) {
        await this.putFile(path, defaultData, undefined, `CMS: init ${file}`);
        results.push({ file, action: 'created' });
      } else {
        results.push({ file, action: 'exists' });
      }
    }
    return results;
  }
}

// Global singleton
window.db = new GitHubDB();

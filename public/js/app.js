/* ================================================================
   CMS Penjaga Harapan — app.js v2
   GitHub-backed CMS · Role-based auth · Gemini AI
   ================================================================ */

'use strict';

/* ── Default repo config (public repo — PAT tidak diperlukan untuk baca) ──── */
/* Ubah sesuai repo data GitHub Anda. PAT tetap disimpan di localStorage. */
const DEFAULT_REPO = { owner: 'Genzed-Kost', repo: 'cmssocmed', branch: 'main' };

/* ── Constants ───────────────────────────────────────────────────────────── */
/* Gemini key disimpan di localStorage (bukan hardcode) — diisi admin di API Setup */
const GEMINI_LS_KEY = 'cmsph_gemini_v1';
function getGeminiKey()     { return localStorage.getItem(GEMINI_LS_KEY) || ''; }
function saveGeminiKey(key) { key ? localStorage.setItem(GEMINI_LS_KEY, key) : localStorage.removeItem(GEMINI_LS_KEY); }

const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-preview-04-17',
  'gemini-2.0-flash-lite',
  'gemini-1.5-pro-latest',
  'gemini-pro'
];
const NEWS_KEY       = 'cmsph_news_v1';
const NEWS_TTL       = 60 * 60 * 1000;
const DATA_CACHE_KEY = 'cmsph_data_v2';
const DATA_CACHE_TTL = 3 * 60 * 1000;   // 3 minutes — reduces GitHub API rate-limit hits
const PAGE_SIZE = 15;

/* ── Pantun data (login & logout per role) ─────────────────────────────── */
const PANTUN = {
  login: {
    admin: {
      icon: '👑',
      teks: 'Kapal berlayar ke pulau jauh,\nMembawa rempah penuh peti kayu.\nSelamat datang, Admin yang teguh,\nSemua sistem siap untukmu.'
    },
    creator: {
      icon: '🎨',
      teks: 'Bunga melati di pagi hari,\nHarum semerbak memenuhi taman.\nSelamat datang, Creator kami,\nKarya indahmu selalu dinantikan.'
    },
    director: {
      icon: '🦅',
      teks: 'Elang terbang tinggi di angkasa,\nMatanya tajam memandang bumi.\nSelamat datang, pemimpin perkasa,\nVisimu nyata memandu kami.'
    },
    supervisor: {
      icon: '🌳',
      teks: 'Pohon beringin di alun-alun,\nTeduh rindang melindungi rakyat.\nSelamat datang, sosok yang andal,\nBimbinganmu menjadi kekuatan.'
    },
    writer: {
      icon: '✍️',
      teks: 'Tinta mengalir di atas kertas,\nMenulis kisah penuh makna jiwa.\nSelamat datang, penulis cerdas,\nKata-katamu menyentuh semua.'
    },
    editor: {
      icon: '📝',
      teks: 'Intan permata digosok terang,\nKilauannya indah memukau mata.\nSelamat datang, Editor pilang,\nSentuhan terbaikmu sempurna kata.'
    },
    designer: {
      icon: '🎭',
      teks: 'Pelangi indah setelah hujan,\nWarnanya cerah menghias langit.\nSelamat datang, seniman andalan,\nDesainmu selalu memukau penikmat.'
    },
    default: {
      icon: '✨',
      teks: 'Pohon berbuah di tepi sungai,\nBuahnya ranum dan segar rasanya.\nSelamat datang, semangat tak lunai,\nMari kita berkarya bersama.'
    }
  },
  logout: {
    admin: {
      icon: '🌅',
      teks: 'Senja datang di tepi pantai,\nBurung camar pulang ke sarang.\nTerima kasih, Admin yang pandai,\nSampai jumpa di hari yang terang.'
    },
    creator: {
      icon: '🌟',
      teks: 'Angsa berenang di telaga bening,\nAirnya jernih berkilau cahaya.\nTerima kasih, Creator bersemangat,\nKaryamu terus jadi harapan jiwa.'
    },
    director: {
      icon: '🌙',
      teks: 'Bintang bersinar di langit malam,\nMenerangi bumi yang sunyi sepi.\nTerima kasih, pemimpin budiman,\nJasamu selalu kami kenang abadi.'
    },
    supervisor: {
      icon: '🍂',
      teks: 'Daun gugur di musim kemarau,\nTanda alam berganti rupa.\nTerima kasih, sudah bersemangat,\nSampai jumpa di kesempatan yang ada.'
    },
    default: {
      icon: '🌙',
      teks: 'Hari telah senja matahari pulang,\nBintang berkelip mengganti siang.\nTerima kasih telah bersemangat,\nSampai jumpa di lain waktu yang terang.'
    }
  }
};

/* ── Auth keys ───────────────────────────────────────────────────────────── */
const AUTH_KEY = 'cmsph_auth_v1';   // { adminName, adminHash } — persisted
const SESS_KEY = 'cmsph_sess_v1';   // { role, name }           — session only
const PUB_KEY  = 'cmsph_pub_v1';    // { users[] }              — cached public list

/* ── User helpers (supports both legacy string[] and new {name,role}[]) ──── */
function getUserName(u) { return typeof u === 'object' && u !== null ? (u.name || '') : (u || ''); }
function getUserRole(u) { return typeof u === 'object' && u !== null ? (u.role || 'Creator') : 'Creator'; }

/* ── Platform / account metadata ────────────────────────────────────────── */
const PLATFORM_META = {
  instagram: { name: 'Instagram',   color: '#e1306c' },
  tiktok:    { name: 'TikTok',      color: '#010101' },
  twitter:   { name: 'X (Twitter)', color: '#1da1f2' },
  facebook:  { name: 'Facebook',    color: '#1877f2' },
  youtube:   { name: 'YouTube',     color: '#ff0000' }
};

const STATUS_CLASS = {
  'Plan':      'badge-plan',
  'Review':    'badge-review',
  'Revisi':    'badge-revisi',
  'Preview':   'badge-preview',
  'ACC':       'badge-acc',
  'Done':      'badge-done',
  'Published': 'badge-published',
  'Drop':      'badge-drop',
  'Hold':      'badge-hold',
  // Backward-compat (data lama)
  'Ide':       'badge-plan',
  'Draft':     'badge-review',
  'Approved':  'badge-acc',
  'Scheduled': 'badge-preview'
};

const STATUSES  = ['Plan','Review','Revisi','Preview','ACC','Done','Published','Drop','Hold'];
const FORMATS   = ['Flayer','Meme','Karikatur','Komikstrip','Animasi','Video','Short','Monolog','Carousell','Podcast'];

const ACCOUNTS = [
  { id: 'penjaga-harapan', name: 'Penjaga Harapan', color: '#7c3aed' },
  { id: '33-official',     name: '33 Official',     color: '#16a34a' },
  { id: 'jaga-asa',        name: 'Jaga Asa',        color: '#ea580c' }
];

/* ── Role colour map (used in sidebar badge + user list) ─────────────────── */
const ROLE_COLORS = {
  Administrator: '#7c3aed',
  Ketua:         '#dc2626',
  Leader:        '#0284c7',
  Planner:       '#d97706',
  Creator:       '#16a34a'
};

const PAGE_TITLES = {
  dashboard:   'Dashboard',
  planner:     'Planner',
  bankkonten:  'Bank of Contents',
  activity:    'Activity Log',
  contents:    'New Contents',
  newpost:     'New Post',
  statistics:  'Statistik',
  apisetup:    'API Setup'
};

const chartInstances = {};   // canvasId → Chart instance
const DRAFT_KEY = 'cmsph_newpost_draft_v1'; // autosave draft

/* ── Platform rich-data field definitions ───────────────────────────────── */
const PLATFORM_FIELDS = {
  youtube: {
    label: 'YouTube', color: '#ff0000',
    followerKey: 'subsEOM', viewKey: 'totalViews',
    fields: [
      { key:'jmlVideo',         label:'Jml Video',        fmt:'num' },
      { key:'totalViews',       label:'Total Views',      fmt:'num' },
      { key:'uniqueViewers',    label:'Unique Viewers',   fmt:'num' },
      { key:'subsEOM',          label:'Subscribers (EOM)',fmt:'num' },
      { key:'subsGained',       label:'Subs Gained/Bulan',fmt:'num' },
      { key:'totalLikes',       label:'Total Likes',      fmt:'num' },
      { key:'totalComments',    label:'Total Comments',   fmt:'num' },
      { key:'totalEngagement',  label:'Total Eng.',       fmt:'num' },
      { key:'erPct',            label:'ER %',             fmt:'pct' },
      { key:'watchHours',       label:'Watch Hours',      fmt:'num' },
      { key:'impressions',      label:'Impressions',      fmt:'num' },
      { key:'adImpressions',    label:'Ad Impressions',   fmt:'num' },
      { key:'avgViewsPerVideo', label:'Avg Views/Vid',    fmt:'num' },
      { key:'peakViews',        label:'Peak Views',       fmt:'num' },
    ]
  },
  tiktok: {
    label: 'TikTok', color: '#010101',
    followerKey: 'followersEOM', viewKey: 'totalVideoViews',
    fields: [
      { key:'totalVideoViews',  label:'Total Vid Views',  fmt:'num' },
      { key:'profileViews',     label:'Profile Views',    fmt:'num' },
      { key:'followersEOM',     label:'Followers (EOM)',  fmt:'num' },
      { key:'followersGained',  label:'Followers Gained', fmt:'num' },
      { key:'totalViewers',     label:'Total Viewers',    fmt:'num' },
      { key:'newViewers',       label:'New Viewers',      fmt:'num' },
      { key:'returningViewers', label:'Returning Viewers',fmt:'num' },
      { key:'totalLikes',       label:'Total Likes',      fmt:'num' },
      { key:'totalComments',    label:'Total Comments',   fmt:'num' },
      { key:'totalShares',      label:'Total Shares',     fmt:'num' },
      { key:'totalEngagement',  label:'Total Eng.',       fmt:'num' },
      { key:'erPct',            label:'ER %',             fmt:'pct' },
    ]
  },
  facebook: {
    label: 'Facebook', color: '#1877f2',
    followerKey: 'pageFollowers', viewKey: 'totalViews',
    fields: [
      { key:'pageFollowers',    label:'Page Followers',   fmt:'num' },
      { key:'totalPost',        label:'Total Post',       fmt:'num' },
      { key:'totalViews',       label:'Total Views',      fmt:'num' },
      { key:'totalReach',       label:'Total Reach',      fmt:'num' },
      { key:'totalReactions',   label:'Total Reactions',  fmt:'num' },
      { key:'totalComments',    label:'Total Comments',   fmt:'num' },
      { key:'totalShares',      label:'Total Shares',     fmt:'num' },
      { key:'totalEngagement',  label:'Total Eng.',       fmt:'num' },
      { key:'avgViewsPerPost',  label:'Avg Views/Post',   fmt:'num' },
      { key:'avgEngPerPost',    label:'Avg Eng/Post',     fmt:'num' },
      { key:'maxViewsSingle',   label:'Max Views Single', fmt:'num' },
      { key:'erPct',            label:'ER %',             fmt:'pct' },
    ]
  },
  instagram: {
    label: 'Instagram', color: '#e1306c',
    followerKey: 'followersEOM', viewKey: 'totalViews',
    fields: [
      { key:'followersEOM',     label:'Followers (EOM)',  fmt:'num' },
      { key:'jmlPost',          label:'Jml Post',         fmt:'num' },
      { key:'totalViews',       label:'Total Views',      fmt:'num' },
      { key:'totalReach',       label:'Total Reach',      fmt:'num' },
      { key:'followersGained',  label:'Followers Gained', fmt:'num' },
      { key:'totalLikes',       label:'Total Likes',      fmt:'num' },
      { key:'totalComments',    label:'Total Comments',   fmt:'num' },
      { key:'totalShares',      label:'Total Shares',     fmt:'num' },
      { key:'totalSaves',       label:'Total Saves',      fmt:'num' },
      { key:'totalEngagement',  label:'Total Eng.',       fmt:'num' },
      { key:'erPct',            label:'ER %',             fmt:'pct' },
      { key:'avgViews',         label:'Avg Views',        fmt:'num' },
      { key:'peakViews',        label:'Peak Views',       fmt:'num' },
      { key:'avgEng',           label:'Avg Eng',          fmt:'num' },
      { key:'reelViews',        label:'Reel Views',       fmt:'num' },
      { key:'carouselViews',    label:'Carousel Views',   fmt:'num' },
      { key:'imageViews',       label:'Image Views',      fmt:'num' },
    ]
  },
  twitter: {
    label: 'X (Twitter)', color: '#1da1f2',
    followerKey: 'followers', viewKey: 'impressions',
    fields: [
      { key:'totalPost',        label:'Total Post',       fmt:'num' },
      { key:'impressions',      label:'Impressions',      fmt:'num' },
      { key:'totalEngagement',  label:'Total Eng.',       fmt:'num' },
      { key:'erPct',            label:'ER %',             fmt:'pct' },
      { key:'totalLikes',       label:'Total Likes',      fmt:'num' },
      { key:'totalRetweets',    label:'Total Retweets',   fmt:'num' },
      { key:'followers',        label:'Followers',        fmt:'num' },
    ]
  }
};

/* ── App state ───────────────────────────────────────────────────────────── */
let state = {
  contents:       [],
  activity:       [],
  todos:          [],
  bankKonten:     [],
  settings:       { kpi: {}, users: [], analyticsUrls: {} },
  analytics:      {},
  shas:           {},
  currentPage:    'dashboard',
  planPage:       1,
  actPage:        1,          // activity log pagination
  tempUrls:       {},
  urlActiveAcct:  'penjaga-harapan',
  statActiveAcct: 'penjaga-harapan',
  statActivePlat: 'youtube',
  top3Month:      null,         // selected month for Top 3 (null = latest)
  dashMonth:      null,       // null = current month (used only when no date range)
  dashDateFrom:   null,       // ISO date string or null
  dashDateTo:     null,       // ISO date string or null
  anlActiveAcct:  'penjaga-harapan',
  kpiPeriod:      'today'     // 'today' | 'week' | 'month_YYYY-MM'
};

/* ── DOM helpers ─────────────────────────────────────────────────────────── */
const $  = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);
const gv = id => { const el = $(id); return el ? el.value.trim() : ''; };
const sv = (id, v) => { const el = $(id); if (el) el.value = v ?? ''; };
/* setTxt: sets textContent of an element (for <div>/<span> stat cards etc.) */
const setTxt = (id, v) => { const el = $(id); if (el) el.textContent = v ?? ''; };

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}
function relTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'baru saja';
  if (m < 60) return `${m} mnt lalu`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} jam lalu`;
  return `${Math.floor(h / 24)} hari lalu`;
}
function getAcctName(id) {
  return ACCOUNTS.find(x => x.id === id)?.name || id;
}
function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ── Toast ───────────────────────────────────────────────────────────────── */
let toastTimer;
function toast(msg, type = '') {
  const el = $('toast');
  const icon = type === 'success' ? '✓ ' : type === 'error' ? '✕ ' : 'ℹ ';
  el.innerHTML = `<span class="toast-icon">${icon}</span>${msg}`;
  el.className = 'toast' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast hidden'; }, 3400);
}

/* ── Loading helpers ─────────────────────────────────────────────────────── */
function setLoading(btnId, loading, loadText, defaultText) {
  const btn = $(btnId);
  if (!btn) return;
  if (loading) {
    btn._defaultText = btn._defaultText || btn.innerHTML;
    btn.innerHTML = `<span class="btn-spinner"></span>${loadText || 'Menyimpan…'}`;
    btn.disabled  = true;
  } else {
    btn.innerHTML = defaultText || btn._defaultText || 'Simpan';
    btn.disabled  = false;
    delete btn._defaultText;
  }
}

function showPageLoader() {
  const el = $('pageLoader');
  if (el) el.classList.remove('hidden');
}
function hidePageLoader() {
  const el = $('pageLoader');
  if (el) el.classList.add('hidden');
}

/* ── Bendera Indonesia loader (brief visual when filter/status changes) ───── */
let _flagTimer;
function showFlagLoader(durationMs = 500) {
  const el = $('flagLoader');
  if (!el) return;
  clearTimeout(_flagTimer);
  el.classList.remove('hidden');
  el.classList.add('flag-visible');
  _flagTimer = setTimeout(() => {
    el.classList.remove('flag-visible');
    setTimeout(() => el.classList.add('hidden'), 250);
  }, durationMs);
}

/* ── AI call limit per content ───────────────────────────────────────────── */
const AI_LIMIT_KEY = 'cmsph_ai_limit_v1';
const AI_MAX       = 3;

function getAiLimits() {
  try { return JSON.parse(localStorage.getItem(AI_LIMIT_KEY) || '{}'); }
  catch { return {}; }
}
function getAiCount(contentKey, type) {
  return getAiLimits()?.[contentKey]?.[type] || 0;
}
function incAiCount(contentKey, type) {
  const data = getAiLimits();
  if (!data[contentKey]) data[contentKey] = {};
  data[contentKey][type] = (data[contentKey][type] || 0) + 1;
  localStorage.setItem(AI_LIMIT_KEY, JSON.stringify(data));
  return data[contentKey][type];
}
function getContentKey() {
  const id = gv('editPostId');
  return id || ('new_' + (gv('postTitle')||'draft').slice(0,20).replace(/\s+/g,'_'));
}

/* ══════════════════════════════════════════════════════════════════════════
   AUTH SYSTEM
   ══════════════════════════════════════════════════════════════════════════ */

async function hashPw(pw) {
  const buf = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(pw + ':cmsph:2024')
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

function getAuth()    { try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch { return null; } }
function saveAuth(a)  { localStorage.setItem(AUTH_KEY, JSON.stringify(a)); }
function getSess()    { try { return JSON.parse(sessionStorage.getItem(SESS_KEY) || 'null'); } catch { return null; } }
function setSess(s)   { sessionStorage.setItem(SESS_KEY, JSON.stringify(s)); }
function clearSess()  { sessionStorage.removeItem(SESS_KEY); }

function isFirstRun() { return !getAuth(); }
function isLoggedIn() { return !!getSess(); }
function isAdmin()    { return getSess()?.role === 'admin'; }
function currentUser(){ return getSess()?.name || 'Creator'; }

function getPubUsers() {
  try { return JSON.parse(localStorage.getItem(PUB_KEY) || '{}').users || []; }
  catch { return []; }
}
function setPubUsers(users) {
  // Preserve passwordHash so login can verify without a fresh GitHub fetch
  localStorage.setItem(PUB_KEY, JSON.stringify({
    users: (users || []).map(u => ({
      name: getUserName(u),
      role: getUserRole(u),
      phone: u?.phone || '',
      passwordHash: u?.passwordHash || ''
    }))
  }));
}

/* ── Apply auth state to UI ──────────────────────────────────────────────── */
function applyAuthState() {
  const sess  = getSess();
  const admin = sess?.role === 'admin';
  const name  = sess?.name || '—';

  // Topbar user
  if ($('userLabel')) $('userLabel').textContent = name;
  if ($('userAvatar')) {
    $('userAvatar').textContent = name.charAt(0).toUpperCase();
    $('userAvatar').style.background = admin ? '#eff6ff' : '#f0fdf4';
    $('userAvatar').style.color      = admin ? '#2563eb' : '#16a34a';
  }

  // Sidebar user
  if ($('sidebarAv')) {
    $('sidebarAv').textContent = name.charAt(0).toUpperCase();
    $('sidebarAv').className   = 'user-av-sm' + (admin ? '' : ' creator');
  }
  if ($('sidebarUname')) $('sidebarUname').textContent = name;
  const roleEl = $('sidebarRole');
  if (roleEl) {
    if (admin) {
      roleEl.textContent = 'Admin';
      roleEl.className   = 'role-badge admin';
      roleEl.removeAttribute('style');
    } else {
      // Show team role with correct colour from ROLE_COLORS
      const userObj   = (state.settings?.users || []).find(u => getUserName(u) === name);
      const teamRole  = getUserRole(userObj || null);
      const roleColor = ROLE_COLORS[teamRole] || '#16a34a';
      roleEl.textContent = teamRole;
      roleEl.className   = 'role-badge';
      roleEl.style.cssText = `background:${roleColor}18;color:${roleColor};border-color:${roleColor}30`;
    }
    roleEl.classList.remove('hidden');
  }

  // API Setup nav: only visible to admin
  const apiNav = document.querySelector('.nav-item[data-page="apisetup"]');
  if (apiNav) apiNav.style.display = admin ? '' : 'none';

  // GitHub sync button: only visible to admin
  if ($('btnGitSync')) $('btnGitSync').style.display = admin ? '' : 'none';

  // Statistics Input Data button: only visible to admin
  if ($('btnToggleStatInput')) $('btnToggleStatInput').style.display = admin ? '' : 'none';

  // Logout button
  if ($('btnLogout')) $('btnLogout').style.display = sess ? '' : 'none';
}

/* ── Custom confirm dialog (replaces native confirm()) ───────────────────── */
let _confirmCb = null;
function showConfirm(msg, onYes, { icon = '⚠️', yesLabel = 'Hapus', danger = true } = {}) {
  const modal = $('confirmModal');
  if (!modal) { if (confirm(msg)) onYes(); return; }
  setTxt('confirmMsg',  msg);
  setTxt('confirmIcon', icon);
  const yesBtn = $('confirmYes');
  if (yesBtn) {
    yesBtn.textContent = yesLabel;
    yesBtn.style.background    = danger ? 'var(--red)' : 'var(--blue)';
    yesBtn.style.borderColor   = danger ? 'var(--red)' : 'var(--blue)';
    yesBtn.style.color         = '#fff';
  }
  modal.classList.remove('hidden');
  _confirmCb = onYes;
}

/* ══════════════════════════════════════════════════════════════════════════
   FIRST-RUN WIZARD
   ══════════════════════════════════════════════════════════════════════════ */

function showWizard(mode) {
  $('wizardModal').classList.remove('hidden');
  if (mode === 'new') showWizardStep(1);
  else showWizardStep('Connect');
}

function showWizardStep(n) {
  $$('.wizard-step').forEach(s => s.classList.add('hidden'));
  $('ws' + n)?.classList.remove('hidden');

  const isConnect = n === 'Connect';
  const stepsWrap = $('wizardStepsWrap');
  if (stepsWrap) stepsWrap.classList.toggle('hidden', isConnect);

  if (!isConnect) {
    [1, 2, 3].forEach(i => {
      const dot  = $('sd' + i);
      const line = $('sl' + i);
      if (dot) {
        dot.classList.toggle('active', i === n);
        dot.classList.toggle('done',   i < n);
      }
      if (line) line.classList.toggle('done', i < n);
    });
  }
}

async function wizardStep1Next() {
  const name = gv('setupAdminName') || 'Admin';
  const pw   = gv('setupAdminPw');
  const pw2  = gv('setupAdminPw2');
  if (!pw)       { toast('Password harus diisi', 'error'); return; }
  if (pw !== pw2){ toast('Password tidak cocok', 'error'); return; }
  const btn = $('btnWs1Next');
  btn.textContent = 'Menyimpan…'; btn.disabled = true;
  try {
    const hash = await hashPw(pw);
    saveAuth({ adminName: name, adminHash: hash });
    showWizardStep(2);
  } finally {
    btn.textContent = 'Lanjut →'; btn.disabled = false;
  }
}

async function wizardCreateRepo() {
  const owner = gv('setupOwner');
  const repo  = gv('setupRepo');
  const pat   = gv('setupPat');
  const branch = gv('setupBranch') || 'main';
  if (!owner || !repo || !pat) { toast('Isi GitHub Username, Nama Repo, dan PAT', 'error'); return; }

  // Temporarily save config so db can use it
  window.db.saveConfig({ owner, repo, branch, pat });

  const btn = $('btnCreateRepo');
  btn.textContent = 'Membuat repo…'; btn.disabled = true;
  try {
    const info = await window.db.createRepo(repo, 'CMS Penjaga Harapan — data repository');
    // createRepo updates config with confirmed values
    sv('setupOwner',  info.owner.login);
    sv('setupRepo',   info.name);
    sv('setupBranch', info.default_branch || 'main');
    btn.textContent = '✓ Repo Dibuat!';
    toast(`Repo "${info.full_name}" berhasil dibuat 🎉`, 'success');
  } catch (e) {
    toast('Gagal buat repo: ' + e.message, 'error');
    btn.textContent = 'Buat Repo Otomatis'; btn.disabled = false;
  }
}

async function wizardStep2Finish() {
  const owner  = gv('setupOwner');
  const repo   = gv('setupRepo');
  const branch = gv('setupBranch') || 'main';
  const pat    = gv('setupPat');
  if (!owner || !repo || !pat) { toast('Isi semua field GitHub', 'error'); return; }

  window.db.saveConfig({ owner, repo, branch, pat });

  const btn = $('btnWizardFinish');
  btn.textContent = 'Menginisialisasi…'; btn.disabled = true;
  try {
    await window.db.testConnection();
    await window.db.initDataFiles();
    // Persist admin credentials to GitHub so other devices can connect
    const auth = getAuth();
    const existingSettings = await window.db.readData('settings') || { kpi:{}, users:[], analyticsUrls:{} };
    existingSettings.adminName = auth.adminName;
    existingSettings.adminHash = auth.adminHash;
    await window.db.writeData('settings', existingSettings, 'Init: persist admin credentials');
    // Auto-login as admin
    setSess({ role: 'admin', name: auth.adminName });
    showWizardStep(3);
    toast('GitHub terhubung!', 'success');
  } catch (e) {
    toast('Gagal: ' + e.message, 'error');
    btn.textContent = 'Simpan & Selesai'; btn.disabled = false;
  }
}

function wizardDone() {
  $('wizardModal').classList.add('hidden');
  applyAuthState();
  handleHash();
  setTimeout(loadAllData, 150);
}

/* ── Connect existing device (no re-setup needed on second/third device) ── */
async function connectExistingDevice() {
  const cfg = {
    owner:  gv('connectOwner').trim(),
    repo:   gv('connectRepo').trim(),
    branch: gv('connectBranch').trim() || 'main',
    pat:    gv('connectPat').trim()
  };
  if (!cfg.owner || !cfg.repo || !cfg.pat) { toast('Isi semua field GitHub', 'error'); return; }
  const btn = $('btnConnectDevice');
  btn.textContent = 'Menghubungkan…'; btn.disabled = true;
  window.db.saveConfig(cfg);
  try {
    await window.db.testConnection();
    const settings = await window.db.readData('settings');
    if (!settings?.adminHash) {
      toast('Instalasi belum menyimpan kredensial. Minta Admin membuka CMS & sync ulang terlebih dahulu.', 'warn');
      btn.textContent = 'Hubungkan →'; btn.disabled = false;
      return;
    }
    // Restore admin credentials from GitHub settings
    saveAuth({ adminName: settings.adminName || 'Admin', adminHash: settings.adminHash });
    // Cache public user list (with passwordHash for login verification)
    if (settings.users?.length) setPubUsers(settings.users);
    $('wizardModal').classList.add('hidden');
    showLogin();
    toast('Perangkat berhasil dihubungkan! Silakan login.', 'success');
  } catch (e) {
    toast('Gagal: ' + e.message, 'error');
    btn.textContent = 'Hubungkan →'; btn.disabled = false;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   LOGIN
   ══════════════════════════════════════════════════════════════════════════ */

/* ── Pantun display ──────────────────────────────────────────────────────── */
function showPantun(type, roleName, userName) {
  const key  = (roleName || '').toLowerCase();
  const pool = PANTUN[type] || PANTUN.login;
  const data = pool[key] || pool.default;

  const ov = $('pantunOverlay');
  if (!ov) return;
  $('pantunIcon').textContent      = data.icon;
  $('pantunRoleBadge').textContent = roleName || 'Tim';
  $('pantunText').textContent      = data.teks;
  $('pantunUser').textContent      = userName ? `— ${userName}` : '';

  // Role badge colour based on type
  const badge = $('pantunRoleBadge');
  if (type === 'logout') {
    badge.style.background = '#fef2f2'; badge.style.color = '#dc2626';
  } else {
    badge.style.background = ''; badge.style.color = '';
  }

  ov.classList.remove('hidden');
  // Auto-close after 4 s
  clearTimeout(ov._ptTimer);
  ov._ptTimer = setTimeout(closePantun, 4000);
}

function closePantun() {
  $('pantunOverlay')?.classList.add('hidden');
}

async function showLogin() {
  $('loginPage').classList.remove('hidden');
  populateLoginSelect();
  sv('loginPw', '');
  toggleLoginPw();
  // Refresh user list dari GitHub agar selalu up-to-date (background)
  if (window.db.isConfigured()) {
    try {
      const _s = await window.db.readData('settings');
      if (_s?.users?.length) {
        setPubUsers(_s.users);
        if (_s.adminHash && !getAuth()) {
          saveAuth({ adminName: _s.adminName || 'Admin', adminHash: _s.adminHash });
        }
        populateLoginSelect(); // re-render dengan data fresh
      }
    } catch {}
  }
}

function populateLoginSelect() {
  const sel   = $('loginUserSel');
  const auth  = getAuth();
  const users = getPubUsers(); // [{name,role}] or legacy string[]
  sel.innerHTML =
    `<option value="__admin__">${esc(auth?.adminName || 'Admin')} (Admin)</option>` +
    users.map(u => {
      const name = getUserName(u);
      const role = getUserRole(u);
      return `<option value="${esc(name)}">${esc(name)} (${esc(role)})</option>`;
    }).join('');
}

function toggleLoginPw() {
  // Password always required for all users
  $('loginPwWrap')?.classList.remove('hidden');
}

async function doLogin() {
  const sel   = $('loginUserSel');
  const isAdm = sel.value === '__admin__';
  const pw    = gv('loginPw');
  const btn   = $('btnDoLogin');
  if (!pw) { toast('Masukkan password', 'error'); return; }
  btn.textContent = 'Masuk…'; btn.disabled = true;
  try {
    if (isAdm) {
      const auth = getAuth();
      const hash = await hashPw(pw);
      if (hash !== auth.adminHash) { toast('Password salah', 'error'); return; }
      setSess({ role: 'admin', name: auth.adminName });
    } else {
      // Verify creator password from cached user list
      const users   = getPubUsers();
      const userObj = users.find(u => getUserName(u) === sel.value);
      if (!userObj) { toast('User tidak ditemukan', 'error'); return; }
      if (userObj.passwordHash) {
        const hash = await hashPw(pw);
        if (hash !== userObj.passwordHash) { toast('Password salah', 'error'); return; }
      }
      // No passwordHash = allow any password (backward compat, admin should set it)
      setSess({ role: 'creator', name: sel.value });
    }
    const loginName = isAdm ? getAuth().adminName : sel.value;
    $('loginPage').classList.add('hidden');
    sv('loginPw', '');
    applyAuthState();
    handleHash();
    setTimeout(async () => {
      await loadAllData();
      const loginRole = isAdm ? 'Admin' : (getUserRole((state.settings?.users||[]).find(u=>getUserName(u)===loginName)||null)||'Creator');
      logActivity(loginName, 'login', `masuk ke sistem sebagai ${loginRole}`);
      // Pantun selamat datang
      showPantun('login', loginRole, loginName);
    }, 200);
  } finally {
    btn.textContent = 'Masuk →'; btn.disabled = false;
  }
}

function doLogout() {
  const name = currentUser();
  const sess = getSess();
  const role = sess?.role === 'admin' ? 'Admin'
    : (getUserRole((state.settings?.users||[]).find(u=>getUserName(u)===name)||null)||'Creator');
  logActivity(name, 'logout', 'keluar dari sistem').catch(() => {});
  clearSess();
  // Clear page
  $$('.page').forEach(s => s.classList.remove('active'));
  showLogin();
  applyAuthState();
  // Pantun selamat tinggal (shown above login page)
  showPantun('logout', role, name);
}

/* ══════════════════════════════════════════════════════════════════════════
   DATA SYNC
   ══════════════════════════════════════════════════════════════════════════ */

function setSyncStatus(ok, label) {
  const dot = document.querySelector('.sync-dot');
  const lbl = $('syncLabel');
  if (dot) dot.className = 'sync-dot' + (ok === true ? ' ok' : ok === false ? ' err' : '');
  if (lbl) lbl.textContent = label || (ok ? 'Tersambung' : 'Error');
}

/* ── Data cache helpers (mengurangi GitHub API calls) ──────────────────── */
function saveDataCache() {
  try {
    localStorage.setItem(DATA_CACHE_KEY, JSON.stringify({
      ts:         Date.now(),
      contents:   state.contents,
      activity:   state.activity,
      todos:      state.todos,
      settings:   state.settings,
      analytics:  state.analytics,
      bankKonten: state.bankKonten
    }));
  } catch { /* storage full — ignore */ }
}

function clearDataCache() {
  try { localStorage.removeItem(DATA_CACHE_KEY); } catch {}
}

function _applyTopContentDefaults() {
  if (!state.settings.topContent) state.settings.topContent = {};
  ACCOUNTS.forEach(a => {
    if (!state.settings.topContent[a.id]) {
      state.settings.topContent[a.id] = {
        good: [{title:'',link:''},{title:'',link:''},{title:'',link:''}],
        bad:  [{title:'',link:''},{title:'',link:''},{title:'',link:''}]
      };
    }
  });
}

async function loadAllData(force = false) {
  if (!window.db.isConfigured()) { setSyncStatus(null, 'Belum terhubung'); return; }

  // ── Try localStorage cache first (skip API calls if data is fresh) ──
  if (!force) {
    try {
      const cached = JSON.parse(localStorage.getItem(DATA_CACHE_KEY) || 'null');
      if (cached && (Date.now() - cached.ts) < DATA_CACHE_TTL) {
        state.contents   = cached.contents   || [];
        state.activity   = cached.activity   || [];
        state.todos      = cached.todos      || [];
        state.settings   = cached.settings   || { kpi:{}, users:[], analyticsUrls:{} };
        state.analytics  = cached.analytics  || {};
        state.bankKonten = cached.bankKonten || [];
        // SHAs sengaja tidak di-cache — db.writeData() akan auto-fetch SHA saat write
        state.shas = {};
        _applyTopContentDefaults();
        checkBankKontenReminders();
        setPubUsers(state.settings.users || []);
        setSyncStatus(true, `Cache (${Math.round((Date.now() - cached.ts) / 1000)}s)`);
        renderCurrentPage();
        return;
      }
    } catch { /* corrupt cache — fall through to fetch */ }
  }

  // ── Fresh fetch from GitHub ─────────────────────────────────────────
  setSyncStatus(null, 'Memuat data…');
  const syncIcon = $('btnGitSync');
  if (syncIcon) syncIcon.classList.add('spinning');
  try {
    const [cR, aR, tR, sR, anlR, bkR] = await Promise.all([
      window.db.read('contents'),
      window.db.read('activity'),
      window.db.read('todos'),
      window.db.read('settings'),
      window.db.read('analytics'),
      window.db.read('contentBank')
    ]);
    state.contents   = cR?.data   || [];
    state.activity   = aR?.data   || [];
    state.todos      = tR?.data   || [];
    state.bankKonten = bkR?.data  || [];
    state.settings   = sR?.data   || { kpi: {}, users: [], analyticsUrls: {} };
    _applyTopContentDefaults();
    state.analytics = anlR?.data || {};
    state.shas = {
      contents:    cR?.sha,
      activity:    aR?.sha,
      todos:       tR?.sha,
      settings:    sR?.sha,
      analytics:   anlR?.sha,
      bankKonten:  bkR?.sha
    };
    // Check Bank Konten reminders after data loaded (jam 8 pagi on publish date)
    checkBankKontenReminders();
    // Cache public user list for login screen
    setPubUsers(state.settings.users || []);
    // Auto-migrate: push adminHash to GitHub settings if missing (for existing installs)
    const localAuth = getAuth();
    if (localAuth?.adminHash && !state.settings.adminHash) {
      state.settings.adminName = localAuth.adminName;
      state.settings.adminHash = localAuth.adminHash;
      window.db.writeData('settings', state.settings, 'Migrate: persist admin credentials')
        .then(sha => { state.shas.settings = sha; }).catch(() => {});
    }
    // Save to cache so next load is instant
    saveDataCache();
    setSyncStatus(true, `Sinkron ${new Date().toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})}`);
    renderCurrentPage();
  } catch (e) {
    setSyncStatus(false, 'Error sinkronisasi');
    toast('Gagal memuat data: ' + e.message, 'error');
  } finally {
    if (syncIcon) syncIcon.classList.remove('spinning');
  }
}

async function logActivity(user, action, target) {
  const auth = getAuth();
  const isAdminUser = user === (auth?.adminName || '');
  const userObj = isAdminUser ? null : (state.settings?.users || []).find(u => getUserName(u) === user);
  const role = isAdminUser ? 'Admin' : (getUserRole(userObj || null) || 'Creator');
  const item = { id: uid(), user, role, action, target, timestamp: new Date().toISOString() };
  state.activity.unshift(item);
  if (state.activity.length > 500) state.activity = state.activity.slice(0, 500);
  try {
    state.shas.activity = await window.db.writeData('activity', state.activity, `Aktivitas: ${action}`);
  } catch { /* non-critical */ }
}

/* ── WhatsApp Notification ──────────────────────────────────────────────── */
const WA_TOKEN_KEY = 'cmsph_wa_token';
function getWaToken() { return localStorage.getItem(WA_TOKEN_KEY) || ''; }
function saveWaToken(t) { if (t) localStorage.setItem(WA_TOKEN_KEY, t); else localStorage.removeItem(WA_TOKEN_KEY); }

/* Roles that receive script/naskah in the WA message */
const WA_SCRIPT_ROLES = ['Creator', 'Publisher'];

const WA_MSG_TEMPLATES = {
  Creator: (name, title, theme, date, acct, script, url) =>
    `Halo ${name}! 👋 Kamu ditugaskan sebagai *Creator* untuk konten:\n\n📌 *Judul:* ${title}\n🏷️ *Tema:* ${theme}\n📅 *Jadwal:* ${date}\n📱 *Akun:* ${acct}${script ? `\n\n📝 *Script/Naskah:*\n${script}` : ''}\n\nSilakan mulai membuat konten. Semangat! 🎉\n\n🔗 CMS: ${url}\n_- Penjaga Harapan CMS_`,
  Publisher: (name, title, theme, date, acct, script, url) =>
    `Halo ${name}! 👋 Kamu ditugaskan sebagai *Publisher* untuk konten:\n\n📌 *Judul:* ${title}\n🏷️ *Tema:* ${theme}\n📅 *Jadwal:* ${date}\n📱 *Akun:* ${acct}${script ? `\n\n📝 *Script/Naskah:*\n${script}` : ''}\n\nSilakan publish konten sesuai jadwal. 🚀\n\n🔗 CMS: ${url}\n_- Penjaga Harapan CMS_`,
  Leader: (name, title, theme, date, acct, script, url) =>
    `Halo ${name}! 👋 Kamu ditugaskan sebagai *Leader* untuk konten:\n\n📌 *Judul:* ${title}\n🏷️ *Tema:* ${theme}\n📅 *Jadwal:* ${date}\n\nMohon supervisi dan pastikan konten berjalan sesuai rencana.\n\n🔗 CMS: ${url}\n_- Penjaga Harapan CMS_`,
  Planner: (name, title, theme, date, acct, script, url) =>
    `Halo ${name}! 👋 Kamu ditugaskan sebagai *Planner* untuk konten:\n\n📌 *Judul:* ${title}\n🏷️ *Tema:* ${theme}\n📅 *Jadwal:* ${date}\n\nMohon pastikan brief, jadwal, dan resources sudah disiapkan.\n\n🔗 CMS: ${url}\n_- Penjaga Harapan CMS_`,
  Ketua: (name, title, theme, date, acct, script, url) =>
    `Halo ${name}! 👋 Terdapat konten baru yang perlu perhatian Anda:\n\n📌 *Judul:* ${title}\n🏷️ *Tema:* ${theme}\n📅 *Jadwal:* ${date}\n\nSilakan berikan arahan atau persetujuan jika diperlukan.\n\n🔗 CMS: ${url}\n_- Penjaga Harapan CMS_`,
  Administrator: (name, title, theme, date, acct, script, url) =>
    `Halo ${name}! 👋 Anda mendapat tugas baru untuk melakukan budgeting pada agenda:\n\n📌 *Judul:* ${title}\n🏷️ *Tema:* ${theme}\n📅 *Tanggal:* ${date}\n\nMohon segera lakukan pengelolaan budget dan administrasi untuk konten ini.\n\n🔗 CMS: ${url}\n_- Penjaga Harapan CMS_`,
};

/* Generic fallback for roles not in the template list */
function waGenericMsg(role, name, title, theme, date, acct, url) {
  return `Halo ${name}! 👋 Kamu ditugaskan sebagai *${role}* untuk konten:\n\n📌 *Judul:* ${title}\n🏷️ *Tema:* ${theme}\n📅 *Jadwal:* ${date}\n📱 *Akun:* ${acct}\n\nSilakan tindak lanjuti sesuai peranmu sebagai ${role}.\n\n🔗 CMS: ${url}\n_- Penjaga Harapan CMS_`;
}

async function sendWaNotif(phone, message) {
  const token = getWaToken();
  if (!token || !phone) return;
  const clean = String(phone).replace(/\D/g, '');
  const target = clean.startsWith('0') ? '62' + clean.slice(1) : clean;
  try {
    const fd = new FormData();
    fd.append('target', target);
    fd.append('message', message);
    const r = await fetch('https://api.fonnte.com/send', {
      method: 'POST', headers: { Authorization: token }, body: fd
    });
    const res = await r.json();
    if (!res.status) console.warn('WA notif failed:', res);
    else console.log('WA sent to', target);
  } catch (e) { console.warn('WA notif error:', e.message); }
}

async function notifyCreatorAssigned(content, oldCreator) {
  if (!content.creator || content.creator === oldCreator) return;
  if (!getWaToken()) return;
  const users   = state.settings?.users || [];
  const userObj = users.find(u => getUserName(u) === content.creator);
  if (!userObj?.phone) return;
  const role     = getUserRole(userObj) || 'Creator';
  const acctObj  = ACCOUNTS.find(a => a.id === content.account);
  const acctName = acctObj?.name || content.account || '—';
  const dateStr  = fmtDate(content.publishDate) || '—';
  const script   = (content.script || '').trim();
  const cmsUrl   = window.location.origin;
  const addScript = WA_SCRIPT_ROLES.includes(role) ? script : '';
  const msg = WA_MSG_TEMPLATES[role]
    ? WA_MSG_TEMPLATES[role](content.creator, content.title||'—', content.theme||'—', dateStr, acctName, addScript, cmsUrl)
    : waGenericMsg(role, content.creator, content.title||'—', content.theme||'—', dateStr, acctName, cmsUrl);
  await sendWaNotif(userObj.phone, msg);
}

/* ── Dashboard Ticker Reminder ──────────────────────────────────────────── */
function renderDashTicker() {
  const ticker = $('dashTicker');
  const inner  = $('dashTickerInner');
  if (!ticker || !inner) return;

  const todayStr = new Date().toISOString().slice(0, 10);
  const items    = [];

  // 1. Bank of Contents: semua item yang belum lewat atau hari ini
  (state.bankKonten || []).forEach(b => {
    if (!b.publishDate || b.publishDate < todayStr) return;
    const acctLabel = BK_ACCOUNTS.find(a => a.id === b.account)?.name || b.account || '';
    const daysLeft  = Math.round((new Date(b.publishDate) - new Date(todayStr)) / 86400000);
    const when      = daysLeft === 0 ? 'Hari ini' : daysLeft === 1 ? 'Besok' : fmtDate(b.publishDate);
    items.push(`📋 <strong>${esc(b.title || 'Bank Konten')}</strong>${b.creator ? ` · ${esc(b.creator)}` : ''}${acctLabel ? ` · ${esc(acctLabel)}` : ''} — ${when}`);
  });

  // 2. Planner: format Liputan, Podcast, Monolog yang belum selesai
  const tickerFormats = ['Liputan', 'Podcast', 'Monolog', 'Short'];
  const doneStatus    = ['Published', 'Done', 'Drop'];
  (state.contents || []).forEach(c => {
    if (!c.publishDate || c.publishDate < todayStr) return;
    if (doneStatus.includes(c.status)) return;
    if (!tickerFormats.includes(c.format)) return;
    const daysLeft = Math.round((new Date(c.publishDate) - new Date(todayStr)) / 86400000);
    const when     = daysLeft === 0 ? 'Hari ini' : daysLeft === 1 ? 'Besok' : fmtDate(c.publishDate);
    const icon     = c.format === 'Podcast' ? '🎙' : c.format === 'Monolog' ? '🎤' : c.format === 'Liputan' ? '📰' : '📱';
    items.push(`${icon} <strong>${esc(c.title || 'Konten')}</strong>${c.creator ? ` · ${esc(c.creator)}` : ''} [${esc(c.format)}] — ${when}`);
  });

  if (!items.length) {
    ticker.classList.add('hidden');
    return;
  }

  // Sort by date (closest first) — crude but effective
  const separator = '&nbsp;&nbsp;&nbsp;·&nbsp;&nbsp;&nbsp;';
  inner.innerHTML = items.join(separator) + separator + items.join(separator);
  inner.style.animationDuration = `${Math.max(18, items.length * 7)}s`;
  ticker.classList.remove('hidden');
}

/* ══════════════════════════════════════════════════════════════════════════
   BANK KONTEN
   ══════════════════════════════════════════════════════════════════════════ */

const BK_ACCOUNTS = [
  { id: 'penjaga-harapan', name: 'Penjaga Harapan' },
  { id: '33officialid',    name: '33 Official'      },
  { id: 'jaga-asa',        name: 'Jaga Asa'         }
];

const WA_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></svg>`;

function renderBankKonten() {
  const users  = state.settings?.users || [];
  const items  = state.bankKonten || [];
  const body   = $('bkBody');
  if (!body) return;

  setTxt('bkCount', items.length);
  setTxt('bkCountFoot', items.length ? `${items.length} konten tersimpan` : '');

  if (items.length === 0) {
    body.innerHTML = '<tr><td colspan="8" class="empty-cell">Belum ada data. Klik "+ Tambah Konten" untuk memulai.</td></tr>';
    return;
  }

  const userOpts = (selected = '') =>
    ['', ...users.map(u => getUserName(u))].map(n =>
      `<option value="${esc(n)}" ${n === selected ? 'selected' : ''}>${n ? esc(n) : '— Pilih Creator —'}</option>`
    ).join('');

  const acctOpts = (selected = '') =>
    BK_ACCOUNTS.map(a =>
      `<option value="${a.id}" ${a.id === selected ? 'selected' : ''}>${a.name}</option>`
    ).join('');

  const todayStr = new Date().toISOString().slice(0, 10);

  body.innerHTML = items.map((item, i) => {
    const creatorObj = users.find(u => getUserName(u) === item.creator);
    const canWa  = !!(item.creator && creatorObj?.phone);
    const isToday = item.publishDate === todayStr;
    return `<tr class="bk-row${isToday ? ' bk-row-today' : ''}" data-id="${item.id}">
      <td class="bk-no">${i + 1}</td>
      <td>
        <select class="bk-sel bk-acct-sel" data-id="${item.id}" data-field="account">
          <option value="">— Pilih Akun —</option>
          ${acctOpts(item.account || '')}
        </select>
      </td>
      <td>
        <input type="text" class="bk-inp" data-id="${item.id}" data-field="title"
          value="${esc(item.title || '')}" placeholder="Judul konten…" />
      </td>
      <td>
        <input type="text" class="bk-inp" data-id="${item.id}" data-field="reference"
          value="${esc(item.reference || '')}" placeholder="https://referensi…" />
      </td>
      <td>
        <input type="text" class="bk-inp" data-id="${item.id}" data-field="linkDrive"
          value="${esc(item.linkDrive || '')}" placeholder="https://drive.google.com/…" />
      </td>
      <td>
        <div class="bk-creator-wrap">
          <select class="bk-sel" data-id="${item.id}" data-field="creator">
            ${userOpts(item.creator || '')}
          </select>
          <button type="button" class="bk-wa-btn${canWa ? '' : ' bk-wa-btn--disabled'}"
            data-id="${item.id}" title="${canWa ? `Kirim WA ke ${esc(item.creator)}` : 'Pilih creator yang punya no. WA'}">
            ${WA_SVG}
          </button>
        </div>
      </td>
      <td>
        <input type="date" class="bk-inp" data-id="${item.id}" data-field="publishDate"
          value="${esc(item.publishDate || '')}" />
      </td>
      <td class="bk-actions">
        <button type="button" class="icon-btn bk-del-btn" data-id="${item.id}" title="Hapus baris">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
            <path d="M10 11v6M14 11v6M9 6V4h6v2"/>
          </svg>
        </button>
      </td>
    </tr>`;
  }).join('');

  _updateBkReminderBanner();
}

function _updateBkReminderBanner() {
  const banner = $('bkReminderBanner');
  if (!banner) return;
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayItems = (state.bankKonten || []).filter(x => x.publishDate === todayStr && x.creator);
  if (!todayItems.length) { banner.classList.add('hidden'); return; }
  const names = todayItems.slice(0, 3).map(x => `<strong>${esc(x.title || 'tanpa judul')}</strong>`).join(', ');
  const more  = todayItems.length > 3 ? ` +${todayItems.length - 3} lainnya` : '';
  banner.innerHTML = `⏰ <span>Konten tayang <strong>hari ini</strong>: ${names}${more}. Pastikan creator sudah siap!</span>`;
  banner.classList.remove('hidden');
}

async function addBankKontenRow() {
  const sess = getSess();
  const newItem = {
    id:           'bk_' + uid(),
    account:      '',
    title:        '',
    reference:    '',
    linkDrive:    '',
    creator:      (sess?.role !== 'admin' && sess?.name) ? sess.name : '',
    publishDate:  '',
    remindedDate: null,
    createdBy:    currentUser(),
    createdAt:    new Date().toISOString(),
    updatedAt:    new Date().toISOString()
  };
  state.bankKonten.push(newItem);
  renderBankKonten();

  try {
    state.shas.bankKonten = await window.db.writeData('contentBank', state.bankKonten, 'Bank Konten: tambah baris baru');
    saveDataCache();
    await logActivity(currentUser(), 'Tambah Bank Konten', 'baris baru');
    // Focus title input of the new row
    setTimeout(() => {
      $('bkBody')?.querySelector(`tr[data-id="${newItem.id}"] .bk-inp`)?.focus();
    }, 60);
  } catch (e) {
    state.bankKonten.pop();
    renderBankKonten();
    toast('Gagal tambah baris: ' + e.message, 'error');
  }
}

const _bkSaveTimers = {};
function debouncedSaveBkItem(id, field, value) {
  const item = state.bankKonten.find(x => x.id === id);
  if (!item) return;
  const oldVal = item[field];
  if (oldVal === value) return;   // tidak ada perubahan
  item[field]    = value;
  item.updatedAt = new Date().toISOString();

  // Langsung update tombol WA saat creator berubah
  if (field === 'creator') {
    const tr = $('bkBody')?.querySelector(`tr[data-id="${id}"]`);
    const waBtn = tr?.querySelector('.bk-wa-btn');
    if (waBtn) {
      const co  = (state.settings?.users || []).find(u => getUserName(u) === value);
      const ok  = !!(value && co?.phone);
      waBtn.classList.toggle('bk-wa-btn--disabled', !ok);
      waBtn.title = ok ? `Kirim WA ke ${value}` : 'Pilih creator yang punya no. WA';
    }
  }

  clearTimeout(_bkSaveTimers[id]);
  _bkSaveTimers[id] = setTimeout(async () => {
    try {
      state.shas.bankKonten = await window.db.writeData('contentBank', state.bankKonten, `Bank Konten: edit ${field}`);
      saveDataCache();
      await logActivity(currentUser(), 'Edit Bank Konten', `"${item.title || 'tanpa judul'}" — ${field}`);
    } catch (e) {
      toast('Gagal simpan: ' + e.message, 'error');
      item[field] = oldVal;   // revert on error
    }
  }, 800);
}

async function sendBankKontenWa(id) {
  const item = state.bankKonten.find(x => x.id === id);
  if (!item || !item.creator) { toast('Pilih creator terlebih dahulu', 'error'); return; }

  const users      = state.settings?.users || [];
  const creatorObj = users.find(u => getUserName(u) === item.creator);
  if (!creatorObj?.phone) { toast('Creator tidak memiliki nomor WhatsApp', 'error'); return; }

  const dateStr = item.publishDate ? fmtDate(item.publishDate) : 'belum ditentukan';
  const refLine = item.reference ? `\n🔗 *Referensi:* ${item.reference}` : '';
  const msg = `Halo ${item.creator}! 📢\n\nKonten *${item.title || '(belum ada judul)'}* dijadwalkan tayang *${dateStr}*.${refLine}\n\nYuk segera siapkan kontennya! 💪\n\n_- Penjaga Harapan CMS_`;

  if (getWaToken()) {
    await sendWaNotif(creatorObj.phone, msg);
    toast(`Pesan terkirim ke ${item.creator} ✓`, 'success');
  } else {
    const clean = creatorObj.phone.replace(/\D/g, '');
    const num   = clean.startsWith('0') ? '62' + clean.slice(1) : clean;
    window.open(`https://wa.me/${num}?text=${encodeURIComponent(msg)}`, '_blank');
  }
  await logActivity(currentUser(), 'Kirim WA Bank Konten', `ke ${item.creator} — "${item.title || 'tanpa judul'}"`);
}

async function checkBankKontenReminders() {
  if (!state.bankKonten?.length) return;
  const now      = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  if (now.getHours() < 8) return;   // belum jam 8 pagi

  const toRemind = state.bankKonten.filter(item =>
    item.publishDate === todayStr &&
    item.remindedDate !== todayStr &&
    item.creator
  );
  if (!toRemind.length) return;

  // Update banner di halaman Bank Konten (jika sedang dibuka)
  _updateBkReminderBanner();

  if (!getWaToken()) {
    // Tidak ada token → hanya tampilkan toast info
    const names = toRemind.slice(0, 2).map(x => x.title || 'tanpa judul').join(', ');
    const extra = toRemind.length > 2 ? ` +${toRemind.length - 2} lagi` : '';
    toast(`⏰ ${toRemind.length} konten tayang hari ini: ${names}${extra}`, '');
    return;
  }

  // Ada Fonnte token → kirim WA otomatis
  const users = state.settings?.users || [];
  for (const item of toRemind) {
    const co = users.find(u => getUserName(u) === item.creator);
    if (co?.phone) {
      const refLine = item.reference ? `\n🔗 *Referensi:* ${item.reference}` : '';
      const msg = `Halo ${item.creator}! ⏰ *Jadwal Tayang Hari Ini*\n\nKonten *${item.title || '(tanpa judul)'}* dijadwalkan tayang ${fmtDate(item.publishDate)}.${refLine}\n\nSegera siapkan kontennya! 🚀\n\n_- Penjaga Harapan CMS_`;
      await sendWaNotif(co.phone, msg);
    }
    item.remindedDate = todayStr;
  }

  // Simpan remindedDate ke GitHub (agar tidak kirim ulang)
  try {
    state.shas.bankKonten = await window.db.writeData('contentBank', state.bankKonten, 'Bank Konten: catat reminder terkirim');
  } catch { /* non-critical */ }

  toast(`✓ Reminder WA terkirim ke ${toRemind.length} creator`, 'success');
}

/* ══════════════════════════════════════════════════════════════════════════
   ROUTING
   ══════════════════════════════════════════════════════════════════════════ */

function handleHash() {
  const h = location.hash.replace('#', '') || 'dashboard';
  navigate(h);
}

function navigate(page) {
  if (!PAGE_TITLES[page]) page = 'dashboard';

  // Guard: API Setup — admin only
  if (page === 'apisetup' && !isAdmin()) {
    toast('Hanya admin yang dapat mengakses halaman ini', 'error');
    page = 'dashboard';
    history.replaceState(null, '', '#dashboard');
  }

  state.currentPage = page;
  $$('.page').forEach(s => s.classList.remove('active'));
  $('page-' + page)?.classList.add('active');
  $$('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  $('topbarTitle').textContent = PAGE_TITLES[page];
  renderCurrentPage();
}

function renderCurrentPage() {
  switch (state.currentPage) {
    case 'dashboard':   renderDashboard();    break;
    case 'planner':     renderPlanner();      break;
    case 'bankkonten':  renderBankKonten();   break;
    case 'activity':    renderActivity();     break;
    case 'contents':    renderContents();     break;
    case 'newpost':     renderNewPostForm();  break;
    case 'statistics':  renderStatistics();   break;
    case 'apisetup':    renderApiSetup();     break;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   DASHBOARD
   ══════════════════════════════════════════════════════════════════════════ */

/* ── Dashboard period filter: "Bulan Ini" button + optional date range ─────── */
function initDashFilter() {
  // Set default month (current month)
  if (!state.dashMonth) {
    const n = new Date();
    state.dashMonth = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}`;
  }

  const btnBulanIni = $('btnDashBulanIni');
  const fromInp     = $('dashDateFrom');
  const toInp       = $('dashDateTo');
  const clearBtn    = $('btnClearDashDate');

  if (!btnBulanIni || btnBulanIni._dashFilterInit) return;
  btnBulanIni._dashFilterInit = true;

  function applyRange() {
    state.dashDateFrom = fromInp?.value || null;
    state.dashDateTo   = toInp?.value   || null;
    const hasRange = !!(state.dashDateFrom || state.dashDateTo);
    if (btnBulanIni) btnBulanIni.classList.toggle('active', !hasRange);
    if (clearBtn)    clearBtn.style.display = hasRange ? '' : 'none';
    showFlagLoader(350);
    renderDashboard();
  }

  btnBulanIni.addEventListener('click', () => {
    if (fromInp) fromInp.value = '';
    if (toInp)   toInp.value   = '';
    state.dashDateFrom = null;
    state.dashDateTo   = null;
    if (btnBulanIni) btnBulanIni.classList.add('active');
    if (clearBtn)    clearBtn.style.display = 'none';
    showFlagLoader(350);
    renderDashboard();
  });

  fromInp?.addEventListener('change', applyRange);
  toInp?.addEventListener('change',   applyRange);
  clearBtn?.addEventListener('click', () => {
    if (fromInp) fromInp.value = '';
    if (toInp)   toInp.value   = '';
    state.dashDateFrom = null;
    state.dashDateTo   = null;
    if (btnBulanIni) btnBulanIni.classList.add('active');
    if (clearBtn)    clearBtn.style.display = 'none';
    showFlagLoader(350);
    renderDashboard();
  });
}

function buildKpiPeriodSel() {
  const sel = $('kpiPeriodSel');
  if (!sel || sel.options.length) return;
  const opts = [
    { val: 'today', lbl: '📅 Hari Ini' },
    { val: 'week',  lbl: '📆 Minggu Ini' }
  ];
  sel.innerHTML = opts.map(o => `<option value="${o.val}">${o.lbl}</option>`).join('');
  sel.value = 'today';
  state.kpiPeriod = 'today';
  sel.addEventListener('change', () => {
    state.kpiPeriod = sel.value;  // 'today' or 'week'
    showFlagLoader(350);
    refreshKpiList();
  });
}


function renderDashboard() {
  // Init month selector on first render
  initDashFilter();
  if (!$('kpiPeriodSel')?.options.length) buildKpiPeriodSel();

  // Determine filter: date range takes priority, otherwise current month
  const monthContents = state.contents.filter(c => {
    const d = new Date(c.publishDate || c.createdAt || '');
    if (state.dashDateFrom || state.dashDateTo) {
      const from = state.dashDateFrom ? new Date(state.dashDateFrom) : new Date(0);
      const to   = state.dashDateTo   ? new Date(state.dashDateTo + 'T23:59:59') : new Date('9999');
      return d >= from && d <= to;
    }
    // Default: Bulan Ini
    const now = new Date();
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });

  const totalKpi  = Object.values(state.settings?.kpi || {}).reduce((a,b) => a + (+b||0), 0);
  const selesai   = monthContents.filter(c => ['Published','Done'].includes(c.status)).length;
  const progress  = monthContents.filter(c => ['Review','Revisi','Preview','ACC'].includes(c.status)).length;
  const teamCount = (state.settings?.users || []).length;

  setTxt('dStatKonten',   monthContents.length);
  setTxt('dStatTarget',   totalKpi || '?');
  setTxt('dStatSelesai',  selesai);
  setTxt('dStatProgress', progress);
  setTxt('dStatTeam',     teamCount);

  refreshKpiList();  // KPI Harian has its own period filter
  renderTodoList();
  renderDashNearContent();
  renderAnalyticsCompact();
  renderDashTicker();
}

function renderKpiList(monthContents) {
  const kpi  = state.settings?.kpi || {};
  const list = $('kpiList');
  if (!list) return;
  const rows = ACCOUNTS.map(acct => {
    const target = +(kpi[acct.id] || 0);
    const actual = monthContents.filter(c => c.account === acct.id && c.status === 'Published').length;
    const pct    = target ? Math.min(100, Math.round(actual / target * 100)) : 0;
    const cls    = pct >= 100 ? 'green' : pct >= 50 ? '' : 'yellow';
    return `<div class="kpi-item">
      <span class="kpi-acct" title="${esc(acct.name)}">${esc(acct.name)}</span>
      <div class="kpi-bar-wrap"><div class="kpi-bar ${cls}" style="width:${pct}%"></div></div>
      <span class="kpi-fraction">${actual}/${target}</span>
    </div>`;
  }).join('');
  list.innerHTML = rows || '<div class="kpi-skeleton">Atur target di API Setup</div>';
}

/* ── KPI Harian period filter ────────────────────────────────────────────── */
function setKpiPeriod(period) {
  // Called externally if needed; sync the dropdown too
  state.kpiPeriod = period;
  const sel = $('kpiPeriodSel');
  if (sel) sel.value = period.startsWith('month_') ? period.slice(6) : period;
  showFlagLoader(350);
  refreshKpiList();
}

function refreshKpiList() {
  const period = state.kpiPeriod || 'today';
  const now    = new Date(); now.setHours(0,0,0,0);
  let filtered, label;

  if (period === 'today') {
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    filtered = state.contents.filter(c => {
      const d = new Date(c.publishDate || '');
      return d >= now && d < tomorrow;
    });
    label = 'Hari Ini — ' + now.toLocaleDateString('id-ID', { day:'numeric', month:'long' });

  } else if (period === 'week') {
    // Week: Monday–Sunday
    const day = now.getDay();
    const mon = new Date(now); mon.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
    const sun = new Date(mon); sun.setDate(mon.getDate() + 7);
    filtered = state.contents.filter(c => {
      const d = new Date(c.publishDate || '');
      return d >= mon && d < sun;
    });
    const fmt = d => d.toLocaleDateString('id-ID', { day:'numeric', month:'short' });
    label = `Minggu Ini (${fmt(mon)} – ${fmt(new Date(sun.getTime()-1))})`;

  } else {
    // period = 'month_YYYY-MM'
    const ym = period.startsWith('month_') ? period.slice(6) : (() => {
      const n = new Date();
      return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}`;
    })();
    const [sy, sm] = ym.split('-').map(Number);
    filtered = state.contents.filter(c => {
      const d = new Date(c.publishDate || c.createdAt || '');
      return d.getMonth() + 1 === sm && d.getFullYear() === sy;
    });
    label = new Date(sy, sm - 1, 1).toLocaleDateString('id-ID', { month:'long', year:'numeric' });
  }

  // Update dropdown title to show label (period info now lives in tooltip/title)
  const kpiSel = $('kpiPeriodSel');
  if (kpiSel) kpiSel.title = label;
  renderKpiList(filtered);
}

function renderDashNearContent() {
  const el = $('dashNearList');
  if (!el) return;
  const now = new Date(); now.setHours(0,0,0,0);

  function inPeriod(c) {
    const d = c.publishDate ? new Date(c.publishDate) : null;
    if (state.dashDateFrom || state.dashDateTo) {
      if (!d) return false;
      const from = state.dashDateFrom ? new Date(state.dashDateFrom) : new Date(0);
      const to   = state.dashDateTo   ? new Date(state.dashDateTo + 'T23:59:59') : new Date('9999');
      return d >= from && d <= to;
    }
    return !d || d >= now;
  }

  const upcoming = state.contents
    .filter(c => c.status !== 'Published' && inPeriod(c))
    .sort((a,b) => {
      const da = a.publishDate ? new Date(a.publishDate) : new Date('9999');
      const db = b.publishDate ? new Date(b.publishDate) : new Date('9999');
      return da - db;
    })
    .slice(0, 3);

  const published = state.contents
    .filter(c => {
      if (c.status !== 'Published') return false;
      const d = new Date(c.publishDate || c.createdAt || '');
      if (state.dashDateFrom || state.dashDateTo) {
        const from = state.dashDateFrom ? new Date(state.dashDateFrom) : new Date(0);
        const to   = state.dashDateTo   ? new Date(state.dashDateTo + 'T23:59:59') : new Date('9999');
        return d >= from && d <= to;
      }
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    })
    .sort((a,b) => new Date(b.publishDate||b.createdAt||0) - new Date(a.publishDate||a.createdAt||0))
    .slice(0, 3);

  el.innerHTML = `
    <div class="near-split">
      <div class="near-split-col">
        <div class="dash-section-head" style="margin-bottom:10px">
          <span class="dash-section-title">Upcoming Content</span>
          <a href="#planner" class="link-sm">LIHAT SEMUA</a>
        </div>
        <div class="dash-content-grid">
          ${upcoming.length ? upcoming.map(c => dashContentCard(c)).join('') : '<div class="dash-empty">Belum ada konten mendatang</div>'}
        </div>
      </div>
      <div class="near-split-col">
        <div class="dash-section-head" style="margin-bottom:10px">
          <span class="dash-section-title">Published Content</span>
          <a href="#planner" class="link-sm">LIHAT SEMUA</a>
        </div>
        <div class="dash-content-grid">
          ${published.length ? published.map(c => dashContentCard(c)).join('') : '<div class="dash-empty">Belum ada konten terpublish</div>'}
        </div>
      </div>
    </div>`;
}

/* stubs — HTML containers removed, kept for safety */
function renderDashUpcoming() {}
function renderDashPublished() {}

function renderAnalyticsCompact() { renderAnalyticsPanel(); }

/* Draw a mini SVG sparkline from an array of numbers */
function drawSparkline(vals, color, w=80, h=28, labels=[]) {
  if (!vals || vals.length < 2) {
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><line x1="0" y1="${h/2}" x2="${w}" y2="${h/2}" stroke="#e2e8f0" stroke-width="1.5" stroke-dasharray="3,3"/></svg>`;
  }
  const nums = vals.map(v => +v || 0);
  const min  = Math.min(...nums), max = Math.max(...nums);
  const range = max - min || 1;
  const pad   = 3;
  const coords = nums.map((v, i) => ({
    x: pad + (i / (nums.length - 1)) * (w - pad * 2),
    y: pad + ((1 - (v - min) / range) * (h - pad * 2)),
    v, lbl: labels[i] || ''
  }));
  const pts = coords.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const last = coords[coords.length - 1];

  // Interactive hit circles for tooltip
  const hitCircles = coords.map((p, i) => {
    const tipLabel = p.lbl ? fmtMonth(p.lbl) : `#${i+1}`;
    const tipVal   = fmtNum(p.v);
    return `<circle class="spark-pt" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5"
      fill="${color}" opacity="${i === coords.length-1 ? '0.85' : '0'}"
      data-tip="${tipLabel}: ${tipVal}"/>`;
  }).join('');

  return `<svg class="spark-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="overflow:visible">
    <defs>
      <linearGradient id="sg_${color.replace('#','')}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity=".18"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <polyline points="${pts} ${(w-pad).toFixed(1)},${h} ${pad},${h}" fill="url(#sg_${color.replace('#','')})" stroke="none"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="2.5" fill="${color}"/>
    ${hitCircles}
  </svg>`;
}

function buildAnlAcctSel() {
  const sel = $('anlpAcctSel');
  if (!sel || sel.options.length) return;
  const abbr = { 'penjaga-harapan':'AKUN PH', '33-official':'AKUN 33', 'jaga-asa':'AKUN JA' };
  ACCOUNTS.forEach(a => {
    const opt = document.createElement('option');
    opt.value = a.id; opt.textContent = abbr[a.id] || a.name;
    if (a.id === state.anlActiveAcct) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', () => {
    state.anlActiveAcct = sel.value;
    renderAnalyticsPanel();
  });
}

function renderAnalyticsPanel() {
  buildAnlAcctSel();
  const acctId  = state.anlActiveAcct || 'penjaga-harapan';
  const grid    = $('anlpGrid');
  if (!grid) return;
  const urls    = state.settings?.analyticsUrls?.[acctId] || {};
  const anlData = state.analytics?.[acctId] || {};

  const platIconMap = {
    instagram:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="5"/><circle cx="17.5" cy="6.5" r="1.5" fill="currentColor" stroke="none"/></svg>`,
    tiktok:  `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.32 6.32 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.8a8.18 8.18 0 004.78 1.52V6.9a4.85 4.85 0 01-1.01-.21z"/></svg>`,
    twitter: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
    facebook:`<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>`,
    youtube: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M23.495 6.205a3.007 3.007 0 00-2.088-2.088c-1.87-.501-9.396-.501-9.396-.501s-7.507-.01-9.396.501A3.007 3.007 0 00.527 6.205a31.247 31.247 0 00-.522 5.805 31.247 31.247 0 00.522 5.783 3.007 3.007 0 002.088 2.088c1.868.502 9.396.502 9.396.502s7.506 0 9.396-.502a3.007 3.007 0 002.088-2.088 31.247 31.247 0 00.5-5.783 31.247 31.247 0 00-.5-5.805zM9.609 15.601V8.408l6.264 3.602z"/></svg>`
  };

  grid.innerHTML = Object.entries(PLATFORM_FIELDS).map(([platId, platM]) => {
    const rows    = (anlData[platId] || []).sort((a,b) => a.month.localeCompare(b.month));
    const last6   = rows.slice(-6);
    const latest  = rows[rows.length - 1];
    const follVal = latest?.[platM.followerKey];
    const viewVal = latest?.[platM.viewKey];
    const url     = urls[platId];
    const monthLbl = latest ? fmtMonth(latest.month) : '—';

    // Sparkline data
    const follSpark  = last6.map(r => r[platM.followerKey] || 0);
    const viewSpark  = last6.map(r => r[platM.viewKey]     || 0);
    const sparkMonths = last6.map(r => r.month);
    const hasData    = last6.length >= 2;

    return `<div class="anlp-card">
      <div class="anlp-card-head">
        <span class="anlp-card-icon" style="color:${platM.color}">${platIconMap[platId]||''}</span>
        <span class="anlp-card-name">${platM.label.toUpperCase()}</span>
        ${url ? `<a href="${esc(url)}" target="_blank" class="anlp-card-link" title="Buka">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </a>` : ''}
      </div>
      <div class="anlp-card-vals">
        <div class="anlp-val-col">
          <div class="anlp-val-label">FOLLOWERS</div>
          <div class="anlp-val-num">${follVal !== undefined && follVal !== null ? fmtNum(follVal) : '<span class="anlp-no-data">—</span>'}</div>
          ${hasData ? `<div class="anlp-spark">${drawSparkline(follSpark, platM.color, 80, 28, sparkMonths)}</div>` : ''}
        </div>
        <div class="anlp-val-col">
          <div class="anlp-val-label">VIEWS <span style="font-weight:400;opacity:.7">(${monthLbl})</span></div>
          <div class="anlp-val-num">${viewVal !== undefined && viewVal !== null ? fmtNum(viewVal) : '<span class="anlp-no-data">—</span>'}</div>
          ${hasData ? `<div class="anlp-spark">${drawSparkline(viewSpark, platM.color, 80, 28, sparkMonths)}</div>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

/* ── Dashboard Planner Sections ─────────────────────────────────────────── */

function dashContentCard(c) {
  const platIconMap = {
    instagram: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="5"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>`,
    tiktok:    `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.32 6.32 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.8a8.18 8.18 0 004.78 1.52V6.9a4.85 4.85 0 01-1.01-.21z"/></svg>`,
    twitter:   `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
    facebook:  `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>`,
    youtube:   `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M23.495 6.205a3.007 3.007 0 00-2.088-2.088c-1.87-.501-9.396-.501-9.396-.501s-7.507-.01-9.396.501A3.007 3.007 0 00.527 6.205a31.247 31.247 0 00-.522 5.805 31.247 31.247 0 00.522 5.783 3.007 3.007 0 002.088 2.088c1.868.502 9.396.502 9.396.502s7.506 0 9.396-.502a3.007 3.007 0 002.088-2.088 31.247 31.247 0 00.5-5.783 31.247 31.247 0 00-.5-5.805zM9.609 15.601V8.408l6.264 3.602z"/></svg>`
  };
  const plats = (c.platforms||[]).map(p => {
    const meta = PLATFORM_META[p];
    if (!meta) return '';
    return `<span class="dcc-plat-icon" style="color:${meta.color}" title="${meta.name}">${platIconMap[p]||p}</span>`;
  }).join('');

  const acct     = ACCOUNTS.find(a => a.id === c.account);
  const users    = (state.settings?.users || []);
  const statuses = STATUSES;

  return `<div class="dash-content-card">
    <div class="dcc-top">
      <select class="dcc-status-sel ${STATUS_CLASS[c.status]||'badge-ide'}"
        onchange="updateContentField('${c.id}','status',this.value)" title="Ubah status">
        ${statuses.map(s=>`<option value="${s}" ${s===c.status?'selected':''}>${s}</option>`).join('')}
      </select>
      <span class="dcc-date">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
        ${fmtDate(c.publishDate)}
      </span>
    </div>
    ${acct ? `<div class="dcc-owner-tag" style="background:${acct.color}18;color:${acct.color};border-color:${acct.color}30">${acct.name}</div>` : ''}
    <div class="dcc-title">${esc(c.title||'—')}</div>
    <div class="dcc-meta-row">
      <span class="dcc-label">TEMA</span>
      <span class="dcc-val">${esc(c.theme||'—')}</span>
    </div>
    <div class="dcc-meta-row">
      <span class="dcc-label">CREATOR</span>
      <select class="dcc-creator-sel" onchange="updateContentField('${c.id}','creator',this.value)" title="Ubah creator">
        <option value="">— pilih —</option>
        ${users.map(u=>{const n=getUserName(u);return `<option value="${esc(n)}" ${n===c.creator?'selected':''}>${esc(n)}</option>`;}).join('')}
      </select>
    </div>
    <div class="dcc-meta-row">
      <span class="dcc-label">PLATFORM</span>
      <div style="display:flex;gap:6px;align-items:center">${plats||'<span class="dcc-val">—</span>'}</div>
    </div>
  </div>`;
}

async function updateContentField(id, field, value) {
  const c = state.contents.find(x => x.id === id);
  if (!c || c[field] === value) return;
  // Block status/creator edits on Published content
  if (c.status === 'Published' && (field === 'status' || field === 'creator')) {
    toast('Konten sudah dipublish — status & creator tidak dapat diubah', 'warn');
    return;
  }
  showFlagLoader(600);
  const oldVal = c[field];
  c[field] = value;
  c.updatedAt = new Date().toISOString();
  try {
    state.shas.contents = await window.db.writeData('contents', state.contents, `Update ${field}: ${c.title}`);
    // Detailed log per field type
    if (field === 'creator') {
      await logActivity(currentUser(), 'ubah creator', `"${c.title}" dari ${oldVal||'(kosong)'} menjadi ${value||'(kosong)'}`);
      await notifyCreatorAssigned(c, oldVal);
    } else if (field === 'status') {
      await logActivity(currentUser(), 'ubah status', `"${c.title}" menjadi ${value}`);
    } else {
      await logActivity(currentUser(), `ubah ${field}`, `"${c.title}"`);
    }
    if (state.currentPage === 'dashboard') renderDashboard();
    toast(`${field === 'status' ? 'Status' : 'Creator'} diperbarui ✓`, 'success');
  } catch (e) { toast('Gagal: ' + e.message, 'error'); }
}

function renderDashUpcoming() {
  const el = $('dashUpcomingGrid');
  if (!el) return;
  const now = new Date(); now.setHours(0,0,0,0);

  // Helper: apply same period filter as stat cards
  function inPeriod(c) {
    const d = c.publishDate ? new Date(c.publishDate) : null;
    if (state.dashDateFrom || state.dashDateTo) {
      if (!d) return false;
      const from = state.dashDateFrom ? new Date(state.dashDateFrom) : new Date(0);
      const to   = state.dashDateTo   ? new Date(state.dashDateTo + 'T23:59:59') : new Date('9999');
      return d >= from && d <= to;
    }
    // Default (Bulan Ini): show all future + this-month unpublished
    return !d || d >= now;
  }

  const upcoming = state.contents
    .filter(c => c.status !== 'Published' && inPeriod(c))
    .sort((a,b) => {
      const da = a.publishDate ? new Date(a.publishDate) : new Date('9999');
      const db = b.publishDate ? new Date(b.publishDate) : new Date('9999');
      return da - db;
    })
    .slice(0, 6);

  if (!upcoming.length) {
    el.innerHTML = `<div class="dash-empty">Belum ada konten mendatang${state.dashDateFrom || state.dashDateTo ? ' dalam periode ini' : ''}</div>`;
    return;
  }
  el.innerHTML = upcoming.map(c => dashContentCard(c)).join('');
}

function renderDashPublished() {
  const el = $('dashPublishedGrid');
  if (!el) return;

  // Apply same period filter as stat cards
  const published = state.contents
    .filter(c => {
      if (c.status !== 'Published') return false;
      const d = new Date(c.publishDate || c.createdAt || '');
      if (state.dashDateFrom || state.dashDateTo) {
        const from = state.dashDateFrom ? new Date(state.dashDateFrom) : new Date(0);
        const to   = state.dashDateTo   ? new Date(state.dashDateTo + 'T23:59:59') : new Date('9999');
        return d >= from && d <= to;
      }
      const now = new Date();
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    })
    .sort((a,b) => new Date(b.publishDate||b.createdAt||0) - new Date(a.publishDate||a.createdAt||0))
    .slice(0, 3);

  if (!published.length) {
    el.innerHTML = `<div class="dash-empty">Belum ada konten terpublish${state.dashDateFrom || state.dashDateTo ? ' dalam periode ini' : ''}</div>`;
    return;
  }
  el.innerHTML = published.map(c => dashContentCard(c)).join('');
}

/* ── To-Do ───────────────────────────────────────────────────────────────── */
function renderTodoList() {
  const list = $('todoList');
  if (!list) return;

  const me    = currentUser();
  const admin = isAdmin();

  // Admin sees all; each user sees only their own assigned todos
  const myTodos = admin
    ? state.todos
    : state.todos.filter(t => t.assignedTo === me);

  const label = $('todoUserLabel');
  if (label) label.textContent = admin ? '' : `(${me})`;

  // Populate the assign dropdown
  const assignSel = $('todoAssign');
  if (assignSel) {
    const users = state.settings?.users || [];
    if (admin) {
      const auth = getAuth();
      const adminName = auth?.adminName || 'Admin';
      assignSel.innerHTML =
        `<option value="${esc(adminName)}">${esc(adminName)} (saya)</option>` +
        users.map(u => {
          const n = getUserName(u);
          return `<option value="${esc(n)}">${esc(n)}</option>`;
        }).join('');
      assignSel.style.display = '';
    } else {
      assignSel.innerHTML = `<option value="${esc(me)}">${esc(me)}</option>`;
      assignSel.style.display = 'none';
    }
  }

  if (!myTodos.length) {
    list.innerHTML = '<li class="todo-empty">Belum ada tugas' + (admin ? '' : ' untuk Anda') + '</li>';
    return;
  }
  list.innerHTML = myTodos.map(t => `
    <li class="todo-item" id="todo-li-${t.id}">
      <input type="checkbox" class="todo-check" ${t.done?'checked':''}
        onchange="toggleTodo('${t.id}',this.checked)" />
      <span class="todo-text ${t.done?'done':''}" ondblclick="startEditTodo('${t.id}')">${esc(t.text)}</span>
      ${t.assignedTo && admin ? `<span class="todo-assign">${esc(t.assignedTo)}</span>` : ''}
      <button class="todo-edit" onclick="startEditTodo('${t.id}')" title="Edit">✏</button>
      <button class="todo-del"  onclick="deleteTodo('${t.id}')" title="Hapus">×</button>
    </li>`).join('');
}

async function toggleTodo(id, done) {
  const t = state.todos.find(x => x.id === id);
  if (!t) return;
  t.done = done;
  try { state.shas.todos = await window.db.writeData('todos', state.todos, 'Todo: toggle'); }
  catch (e) { toast('Gagal simpan: ' + e.message, 'error'); }
}

async function deleteTodo(id) {
  state.todos = state.todos.filter(x => x.id !== id);
  renderTodoList();
  try { state.shas.todos = await window.db.writeData('todos', state.todos, 'Todo: hapus'); toast('Tugas dihapus'); }
  catch (e) { toast('Gagal: ' + e.message, 'error'); }
}

function startEditTodo(id) {
  const t  = state.todos.find(x => x.id === id);
  const li = document.getElementById(`todo-li-${id}`);
  if (!t || !li) return;
  const span = li.querySelector('.todo-text');
  if (!span) return;

  const inp = document.createElement('input');
  inp.type      = 'text';
  inp.className = 'inp-sm todo-edit-inp';
  inp.value     = t.text;
  inp.style.cssText = 'flex:1;min-width:0;font-size:.82rem';
  span.replaceWith(inp);
  // Hide edit/del while editing to avoid double-click
  li.querySelectorAll('.todo-edit,.todo-del').forEach(b => b.style.display='none');
  inp.focus(); inp.select();

  const save = async () => {
    const newText = inp.value.trim();
    if (newText && newText !== t.text) {
      t.text = newText;
      try { state.shas.todos = await window.db.writeData('todos', state.todos, 'Todo: edit'); toast('Tugas diperbarui ✓', 'success'); }
      catch(e) { toast('Gagal: ' + e.message, 'error'); }
    }
    renderTodoList();
  };
  inp.addEventListener('blur',    save);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); inp.removeEventListener('blur', save); save(); }
    if (e.key === 'Escape') { renderTodoList(); }
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   PLANNER
   ══════════════════════════════════════════════════════════════════════════ */

function renderPlanner(page) {
  if (page !== undefined) state.planPage = page;

  const search    = gv('planSearch').toLowerCase();
  const creator   = gv('planFilterCreator');
  const status    = gv('planFilterStatus');
  const time      = gv('planFilterTime');
  const dateFrom  = gv('planDateFrom');
  const dateTo    = gv('planDateTo');

  let rows = state.contents.filter(c => {
    if (search  && !c.title?.toLowerCase().includes(search)) return false;
    if (creator && c.creator !== creator) return false;
    if (status  && c.status  !== status)  return false;
    if (time === 'week') {
      const d    = new Date(c.publishDate||'');
      const now2 = new Date(); now2.setHours(0,0,0,0);
      const day  = now2.getDay();
      const mon  = new Date(now2); mon.setDate(now2.getDate() - (day === 0 ? 6 : day - 1));
      const sun  = new Date(mon);  sun.setDate(mon.getDate() + 7);
      if (d < mon || d >= sun) return false;
    }
    if (time === 'month') {
      const d = new Date(c.publishDate||''), now = new Date();
      if (d.getMonth() !== now.getMonth() || d.getFullYear() !== now.getFullYear()) return false;
    }
    if (dateFrom) {
      const d = new Date(c.publishDate||'');
      if (d < new Date(dateFrom)) return false;
    }
    if (dateTo) {
      const d = new Date(c.publishDate||'');
      if (d > new Date(dateTo + 'T23:59:59')) return false;
    }
    return true;
  });

  rows.sort((a, b) => new Date(a.publishDate||'9999') - new Date(b.publishDate||'9999'));
  $('planCount').textContent = `${rows.length} konten`;

  const total = Math.ceil(rows.length / PAGE_SIZE) || 1;
  state.planPage = Math.min(state.planPage, total);
  const slice = rows.slice((state.planPage - 1) * PAGE_SIZE, state.planPage * PAGE_SIZE);
  const admin  = isAdmin();

  const tbody = $('planBody');
  tbody.innerHTML = slice.length ? slice.map(c => {
    const plats = (c.platforms||[]).map(p => `<span class="plat-pill plat-${p}">${p.charAt(0).toUpperCase()}</span>`).join('');
    const acct  = ACCOUNTS.find(a => a.id === c.account);
    return `<tr>
      <td><span class="badge ${STATUS_CLASS[c.status]||'badge-ide'}">${esc(c.status)}</span></td>
      <td>${fmtDate(c.publishDate)}</td>
      <td>
        <div style="font-weight:600">${esc(c.title)}</div>
        ${acct ? `<div style="font-size:.7rem;color:${acct.color};margin-top:2px">${acct.name}</div>` : ''}
      </td>
      <td>${esc(c.theme||'—')}</td>
      <td><div class="plat-pills">${plats||'—'}</div></td>
      <td>${esc(c.creator||'—')}</td>
      <td><div style="display:flex;gap:5px">
        <button class="btn-xs" onclick="editContent('${c.id}')">Edit</button>
        ${admin ? `<button class="btn-xs" style="border-color:#fca5a5;color:var(--red)" onclick="deleteContent('${c.id}')">Hapus</button>` : ''}
      </div></td>
    </tr>`;
  }).join('') : '<tr><td colspan="7" class="empty-cell">Belum ada konten</td></tr>';

  $('planPagination').innerHTML = Array.from({length:total},(_,i) =>
    `<button class="page-btn ${i+1===state.planPage?'active':''}" onclick="renderPlanner(${i+1})">${i+1}</button>`
  ).join('');

  populateCreatorFilter('planFilterCreator');
}

function populateCreatorFilter(selectId) {
  const sel = $(selectId);
  if (!sel) return;
  const users = state.settings?.users || [];
  const cur   = sel.value;
  sel.innerHTML = '<option value="">Semua Creator</option>' +
    users.map(u => {
      const n = getUserName(u);
      return `<option value="${esc(n)}" ${n===cur?'selected':''}>${esc(n)}</option>`;
    }).join('');
}

/* ══════════════════════════════════════════════════════════════════════════
   ACTIVITY LOG
   ══════════════════════════════════════════════════════════════════════════ */

const ACT_PAGE_SIZE = 20;

function renderActivity(page) {
  if (page !== undefined) state.actPage = page;
  const search   = gv('actSearch').toLowerCase();
  const dateFrom = gv('actDateFrom');
  const dateTo   = gv('actDateTo');
  const list     = $('activityList');
  if (!list) return;

  const filtered = state.activity.filter(a => {
    if (search && !((a.user||'').toLowerCase().includes(search) ||
                    (a.action||'').toLowerCase().includes(search) ||
                    (a.target||'').toLowerCase().includes(search))) return false;
    if (dateFrom) { const d = new Date(a.timestamp||''); if (d < new Date(dateFrom)) return false; }
    if (dateTo)   { const d = new Date(a.timestamp||''); if (d > new Date(dateTo + 'T23:59:59')) return false; }
    return true;
  });

  const total = Math.ceil(filtered.length / ACT_PAGE_SIZE) || 1;
  if (state.actPage > total) state.actPage = total;
  const slice = filtered.slice((state.actPage - 1) * ACT_PAGE_SIZE, state.actPage * ACT_PAGE_SIZE);

  const icons = { tambah:'➕', edit:'✏️', hapus:'🗑️', publish:'🚀', login:'🔑', logout:'🚪', unduh:'📥', statistik:'📊', default:'📋' };

  if (!slice.length) {
    list.innerHTML = '<li class="act-empty" style="padding:20px 0">Belum ada aktivitas</li>';
  } else {
    list.innerHTML = slice.map(a => {
      const iconType = Object.keys(icons).find(k => (a.action||'').toLowerCase().includes(k)) || 'default';
      const roleColor = ROLE_COLORS[a.role] || (a.role === 'Admin' ? '#7c3aed' : '#16a34a');
      const roleBadge = a.role
        ? ` <span style="font-size:.6rem;padding:1px 5px;border-radius:3px;background:${roleColor}18;color:${roleColor};border:1px solid ${roleColor}30;vertical-align:middle">${esc(a.role)}</span>`
        : '';
      return `<li class="activity-item">
        <div class="act-icon-lg">${icons[iconType]}</div>
        <div class="act-body-lg">
          <span class="act-user">${esc(a.user||'—')}</span>${roleBadge}
          <div class="act-desc">${esc(a.action)} ${a.target?`<strong>${esc(a.target)}</strong>`:''}</div>
          <div class="act-ts">${fmtDate(a.timestamp)} · ${relTime(a.timestamp)}</div>
        </div>
      </li>`;
    }).join('');
  }

  // Count + pagination
  setTxt('actCount', `${filtered.length} aktivitas`);
  const pagEl = $('actPagination');
  if (pagEl) {
    pagEl.innerHTML = total <= 1 ? '' : Array.from({length: total}, (_, i) =>
      `<button class="page-btn ${i+1===state.actPage?'active':''}" onclick="renderActivity(${i+1})">${i+1}</button>`
    ).join('');
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   CONTENTS
   ══════════════════════════════════════════════════════════════════════════ */

function renderContents() {
  const search = gv('cntSearch').toLowerCase();
  const status = gv('cntFilterStatus');
  const acct   = gv('cntFilterAcct');
  const grid   = $('contentGrid');
  if (!grid) return;

  const filtered = state.contents.filter(c => {
    if (search && !c.title?.toLowerCase().includes(search)) return false;
    if (status && c.status  !== status) return false;
    if (acct   && c.account !== acct)   return false;
    return true;
  });

  if (!filtered.length) {
    grid.innerHTML = '<div class="cnt-empty">Belum ada konten. Klik "+ New Post" untuk membuat.</div>';
    return;
  }

  grid.innerHTML = filtered.map(c => {
    const plats = (c.platforms||[]).map(p =>
      `<span class="plat-pill plat-${p}">${(PLATFORM_META[p]?.name||p).split(' ')[0]}</span>`
    ).join('');
    return `<div class="cnt-card">
      <div class="cnt-card-top">
        <span class="cnt-title">${esc(c.title)}</span>
        <span class="badge ${STATUS_CLASS[c.status]||'badge-ide'}">${esc(c.status)}</span>
      </div>
      <div class="cnt-meta">
        <div class="cnt-row"><span>${fmtDate(c.publishDate)}</span><span>·</span><span>${esc(getAcctName(c.account))}</span></div>
        <div class="cnt-row">${plats||'<span style="color:var(--muted)">—</span>'}</div>
        ${c.creator?`<div class="cnt-row">👤 ${esc(c.creator)}</div>`:''}
      </div>
      <div class="cnt-actions">
        <button class="btn-xs" onclick="editContent('${c.id}')">Edit</button>
        ${c.outputLink?`<a href="${esc(c.outputLink)}" target="_blank" class="btn-xs">Link ↗</a>`:''}
        <button class="btn-xs" style="margin-left:auto;border-color:#fca5a5;color:var(--red)" onclick="deleteContent('${c.id}')">Hapus</button>
      </div>
    </div>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════════════════════════
   NEW POST
   ══════════════════════════════════════════════════════════════════════════ */

/* ── New Post autosave (localStorage) ───────────────────────────────────── */
let _draftTimer;
function saveNewPostDraft() {
  if (gv('editPostId')) return; // don't autosave when editing existing post
  const draft = {
    postDate: gv('postDate'), postCreator: gv('postCreator'), postAccount: gv('postAccount'),
    postStatus: gv('postStatus'), postTitle: gv('postTitle'), postTheme: gv('postTheme'),
    postFormat: gv('postFormat'), postScript: gv('postScript'), postCaption: gv('postCaption'),
    postOutputLink: gv('postOutputLink'), postNotes: gv('postNotes'),
    platforms: Array.from($$('#platformChecks input:checked')).map(cb => cb.value),
    savedAt: new Date().toISOString()
  };
  if (!draft.postTitle && !draft.postScript && !draft.postCaption) return; // nothing to save
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  const ind = $('draftSaveInd');
  if (ind) { ind.textContent = '💾 Draft disimpan lokal'; clearTimeout(_draftTimer); _draftTimer = setTimeout(() => ind.textContent='', 2500); }
}

function clearNewPostDraft() { localStorage.removeItem(DRAFT_KEY); }

function restoreDraftToForm(d) {
  sv('postDate',       d.postDate       || '');
  sv('postCreator',    d.postCreator    || '');
  sv('postAccount',    d.postAccount    || '');
  sv('postStatus',     d.postStatus     || 'Ide');
  sv('postTitle',      d.postTitle      || '');
  sv('postTheme',      d.postTheme      || '');
  sv('postFormat',     d.postFormat     || 'Flayer');
  sv('postScript',     d.postScript     || '');
  sv('postCaption',    d.postCaption    || '');
  sv('postOutputLink', d.postOutputLink || '');
  sv('postNotes',      d.postNotes      || '');
  $$('#platformChecks input').forEach(cb => { cb.checked = (d.platforms||[]).includes(cb.value); });
}

function updateAiLimitDisplay() {
  const key = getContentKey();
  const draftLeft   = AI_MAX - getAiCount(key, 'draft');
  const captionLeft = AI_MAX - getAiCount(key, 'caption');
  const draftBtn    = $('btnGenerateDraft');
  const captBtn     = $('btnGenerateCaption');
  if (draftBtn) {
    draftBtn.title = `Generate naskah (${draftLeft}/${AI_MAX} sisa)`;
    draftBtn.classList.toggle('btn-limit-warn', draftLeft === 0);
    if (draftLeft === 0) draftBtn.setAttribute('data-limit', '0');
    else draftBtn.removeAttribute('data-limit');
  }
  if (captBtn) {
    captBtn.title = `Generate caption (${captionLeft}/${AI_MAX} sisa)`;
    captBtn.classList.toggle('btn-limit-warn', captionLeft === 0);
    if (captionLeft === 0) captBtn.setAttribute('data-limit', '0');
    else captBtn.removeAttribute('data-limit');
  }
}

function renderNewPostForm(content) {
  const creatorSel = $('postCreator');
  if (creatorSel) {
    const users = state.settings?.users || [];
    const cur   = creatorSel.value;
    creatorSel.innerHTML = '<option value="">— Pilih Creator —</option>' +
      users.map(u => {
        const n = getUserName(u);
        return `<option value="${esc(n)}" ${n===cur?'selected':''}>${esc(n)}</option>`;
      }).join('');
  }

  if (content) {
    sv('editPostId',     content.id);
    sv('postDate',       content.publishDate || '');
    sv('postCreator',    content.creator     || '');
    sv('postAccount',    content.account     || '');
    sv('postStatus',     content.status      || 'Ide');
    sv('postTitle',      content.title       || '');
    sv('postTheme',      content.theme       || '');
    sv('postFormat',     content.format      || 'Reels');
    sv('postScript',     content.script      || '');
    sv('postCaption',    content.caption     || '');
    sv('postOutputLink', content.outputLink  || '');
    sv('postNotes',      content.notes       || '');
    $$('#platformChecks input').forEach(cb => {
      cb.checked = (content.platforms||[]).includes(cb.value);
    });
    // Lock status & creator when Published
    const isPublished = content.status === 'Published';
    ['postStatus','postCreator'].forEach(fid => {
      const el = $(fid); if (el) el.disabled = isPublished;
    });
    const lockBanner = $('publishedLockBanner');
    if (lockBanner) lockBanner.classList.toggle('hidden', !isPublished);
  } else {
    // New post: unlock fields and check for saved draft
    ['postStatus','postCreator'].forEach(fid => { const el = $(fid); if (el) el.disabled = false; });
    $('publishedLockBanner')?.classList.add('hidden');
    ['editPostId','postDate','postTitle','postTheme','postScript','postCaption','postOutputLink','postNotes'].forEach(id => sv(id,''));
    sv('postStatus','Plan'); sv('postCreator',''); sv('postAccount',''); sv('postFormat','Flayer');
    $$('#platformChecks input').forEach(cb => { cb.checked = false; });

    try {
      const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      if (saved?.postTitle || saved?.postScript) {
        const ind = $('draftSaveInd');
        if (ind) {
          const ts = saved.savedAt ? new Date(saved.savedAt).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'}) : '';
          ind.innerHTML = `📋 Draft tersimpan (${ts}) — <button class="link-btn" id="btnRestoreDraft">Pulihkan</button> · <button class="link-btn" id="btnDiscardDraft">Abaikan</button>`;
          $('btnRestoreDraft')?.addEventListener('click', () => {
            restoreDraftToForm(saved);
            ind.textContent = '✓ Draft dipulihkan';
            setTimeout(() => ind.textContent='', 2500);
          });
          $('btnDiscardDraft')?.addEventListener('click', () => {
            clearNewPostDraft();
            ind.textContent = '';
          });
        }
      }
    } catch { /* ignore */ }
  }
  updateAiLimitDisplay();
}

function editContent(id) {
  const c = state.contents.find(x => x.id === id);
  if (!c) return;
  navigate('newpost');
  renderNewPostForm(c);
}

async function deleteContent(id) {
  const title = state.contents.find(x => x.id === id)?.title || 'konten ini';
  showConfirm(`Hapus konten "${title}"? Tindakan ini tidak dapat dibatalkan.`, async () => {
    state.contents = state.contents.filter(x => x.id !== id);
    if (state.currentPage === 'planner')   renderPlanner();
    if (state.currentPage === 'contents')  renderContents();
    if (state.currentPage === 'dashboard') renderDashboard();
    try {
      state.shas.contents = await window.db.writeData('contents', state.contents, `Hapus: ${title}`);
      saveDataCache();
      await logActivity(currentUser(), 'hapus konten', title);
      toast('Konten dihapus');
    } catch (e) { toast('Gagal: ' + e.message, 'error'); }
  });
}

async function savePost() {
  const id = gv('editPostId');

  // Validate required fields
  const required = [
    { id: 'postDate',    label: 'Tanggal Tayang' },
    { id: 'postCreator', label: 'Creator' },
    { id: 'postAccount', label: 'Akun Target' },
    { id: 'postTitle',   label: 'Judul Konten' },
    { id: 'postTheme',   label: 'Tema' }
  ];
  for (const f of required) {
    if (!gv(f.id)) {
      toast(`${f.label} wajib diisi (*)`, 'error');
      $(f.id)?.focus();
      $(f.id)?.classList.add('inp-error');
      setTimeout(() => $(f.id)?.classList.remove('inp-error'), 2000);
      return;
    }
  }
  const platforms = Array.from($$('#platformChecks input:checked')).map(cb => cb.value);
  if (!platforms.length) {
    toast('Pilih minimal 1 Platform Distribusi (*)', 'error');
    return;
  }

  const title   = gv('postTitle');
  const theme   = gv('postTheme');
  const acctId  = gv('postAccount');
  const creator = gv('postCreator');
  const acctName = ACCOUNTS.find(a => a.id === acctId)?.name || acctId || '—';
  const data = {
    title, platforms,
    publishDate: gv('postDate'),
    creator,
    account:     acctId,
    status:      gv('postStatus'),
    theme,
    format:      gv('postFormat'),
    script:      gv('postScript'),
    caption:     gv('postCaption'),
    outputLink:  gv('postOutputLink'),
    notes:       gv('postNotes')
  };

  // Capture old creator before updating (for WA notification)
  const oldCreator = id ? (state.contents.find(x => x.id === id)?.creator || null) : null;

  if (id) {
    const idx = state.contents.findIndex(x => x.id === id);
    if (idx !== -1) state.contents[idx] = { ...state.contents[idx], ...data, updatedAt: new Date().toISOString() };
  } else {
    state.contents.unshift({ id: uid(), ...data, createdAt: new Date().toISOString() });
  }

  try {
    state.shas.contents = await window.db.writeData('contents', state.contents, `${id?'Edit':'Tambah'}: ${title}`);
    saveDataCache();
    // Detailed activity log
    const logDetail = id
      ? `"${title}"`
      : `berjudul "${title}" (tema: ${theme}) untuk akun ${acctName} dijadwalkan ${fmtDate(gv('postDate'))}`;
    await logActivity(currentUser(), id ? 'edit konten' : 'tambah konten', logDetail);
    // WA notification if creator was assigned/changed
    const savedContent = state.contents.find(x => x.title === title && x.creator === creator) || { ...data };
    await notifyCreatorAssigned(savedContent, oldCreator);
    clearNewPostDraft();
    toast(`Konten berhasil ${id ? 'diperbarui' : 'disimpan'}`, 'success');
    navigate('planner');
  } catch (e) { toast('Gagal simpan: ' + e.message, 'error'); }
}

/* ══════════════════════════════════════════════════════════════════════════
   API SETUP (admin only)
   ══════════════════════════════════════════════════════════════════════════ */

function renderApiSetup() {
  const cfg = window.db.getConfig() || {};
  sv('cfgOwner',  cfg.owner  || '');
  sv('cfgRepo',   cfg.repo   || '');
  sv('cfgBranch', cfg.branch || 'main');
  sv('cfgPat',    cfg.pat    || '');

  const connected = window.db.isConfigured();
  const el = $('githubConnStatus');
  if (el) { el.textContent = connected ? 'Tersambung' : 'Belum tersambung'; el.className = 'badge-status' + (connected ? ' ok' : ''); }

  const kpi = state.settings?.kpi || {};
  sv('kpiPH', kpi['penjaga-harapan'] || '');
  sv('kpi33', kpi['33-official']     || '');
  sv('kpiJA', kpi['jaga-asa']        || '');

  // Gemini key
  sv('cfgGeminiKey', getGeminiKey());
  updateGeminiStatus();

  // WhatsApp API token
  sv('cfgWaToken', getWaToken());
  updateWaStatus();

  renderUserList();
  renderUrlAcctBar();
  renderPlatformUrls(state.urlActiveAcct);
}

/* Gemini key */
function updateGeminiStatus() {
  const el  = $('geminiKeyStatus');
  const has = !!getGeminiKey();
  if (el) { el.textContent = has ? 'Terkonfigurasi' : 'Belum diisi'; el.className = 'badge-status' + (has ? ' ok' : ''); }
}

/* WhatsApp token */
function updateWaStatus() {
  const el  = $('waTokenStatus');
  const has = !!getWaToken();
  if (el) { el.textContent = has ? 'Aktif' : 'Belum diisi'; el.className = 'badge-status' + (has ? ' ok' : ''); }
}
function saveWaTokenFromForm() {
  const t = gv('cfgWaToken').trim();
  saveWaToken(t);
  updateWaStatus();
  toast(t ? 'Token WA disimpan ✓' : 'Token WA dihapus', t ? 'success' : 'warn');
}

/* ── Generate shareable access link for team members ─────────────────── */
function generateShareLink() {
  const cfg = window.db.getConfig();
  if (!cfg?.owner || !cfg?.repo || !cfg?.pat) {
    toast('Konfigurasi GitHub belum lengkap', 'error'); return;
  }
  const encoded = btoa(JSON.stringify({ owner: cfg.owner, repo: cfg.repo, branch: cfg.branch || 'main', pat: cfg.pat }));
  const url = `${window.location.origin}${window.location.pathname}?access=${encoded}`;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url)
      .then(() => toast('✅ Link akses tim disalin! Bagikan ke anggota.', 'success'))
      .catch(() => prompt('Salin link ini dan bagikan ke anggota tim:', url));
  } else {
    prompt('Salin link ini dan bagikan ke anggota tim:', url);
  }
}

/* GitHub config */
async function testGithub() {
  const cfg = { owner: gv('cfgOwner'), repo: gv('cfgRepo'), branch: gv('cfgBranch')||'main', pat: gv('cfgPat') };
  if (!cfg.owner || !cfg.repo || !cfg.pat) { toast('Isi semua field GitHub', 'error'); return; }
  window.db.saveConfig(cfg);
  toast('Menguji koneksi…');
  try {
    const info = await window.db.testConnection();
    toast(`Terhubung ke ${info.full_name} ✓`, 'success');
    $('githubConnStatus').textContent = 'Tersambung'; $('githubConnStatus').className = 'badge-status ok';
    setSyncStatus(true, 'Tersambung');
  } catch (e) {
    toast('Gagal: ' + e.message, 'error');
    $('githubConnStatus').textContent = 'Error'; $('githubConnStatus').className = 'badge-status err';
  }
}

async function saveAndInitGithub() {
  const cfg = { owner: gv('cfgOwner'), repo: gv('cfgRepo'), branch: gv('cfgBranch')||'main', pat: gv('cfgPat') };
  if (!cfg.owner || !cfg.repo || !cfg.pat) { toast('Isi semua field GitHub', 'error'); return; }
  window.db.saveConfig(cfg);
  setSyncStatus(null, 'Menginisialisasi…');
  try {
    await window.db.testConnection();
    await window.db.initDataFiles();
    toast('GitHub tersambung. File data dibuat.', 'success');
    $('githubConnStatus').textContent = 'Tersambung'; $('githubConnStatus').className = 'badge-status ok';
    setSyncStatus(true);
    await loadAllData();
  } catch (e) { toast('Gagal: ' + e.message, 'error'); setSyncStatus(false, 'Error'); }
}

/* Platform URLs */
function renderUrlAcctBar() {
  const bar = $('urlAcctBar');
  if (!bar) return;
  bar.innerHTML = ACCOUNTS.map(acct =>
    `<button class="url-acct-tab ${acct.id===state.urlActiveAcct?'active':''}"
       onclick="selectUrlAcct('${acct.id}')">${acct.name}</button>`
  ).join('');
}

function renderPlatformUrls(acctId) {
  const list = $('platformUrlList');
  if (!list) return;
  const urls     = state.settings?.analyticsUrls || {};
  const acctUrls = { ...(urls[acctId]||{}), ...(state.tempUrls[acctId]||{}) };
  list.innerHTML = `<div class="platform-url-list">` +
    Object.entries(PLATFORM_META).map(([k, m]) => `
      <div class="platform-url-row">
        <span class="platform-url-dot" style="background:${m.color}"></span>
        <span class="platform-url-name">${m.name}</span>
        <input class="platform-url-inp" id="purl_${k}" placeholder="${k}.com/namaakun"
          value="${esc(acctUrls[k]||'')}" />
      </div>`).join('') + `</div>`;
}

function selectUrlAcct(acctId) {
  saveTempUrls(state.urlActiveAcct);
  state.urlActiveAcct = acctId;
  renderUrlAcctBar();
  renderPlatformUrls(acctId);
}

function saveTempUrls(acctId) {
  const obj = {};
  Object.keys(PLATFORM_META).forEach(k => { const el = $(`purl_${k}`); if (el) obj[k] = el.value.trim(); });
  state.tempUrls[acctId] = obj;
}

async function saveUrls() {
  saveTempUrls(state.urlActiveAcct);
  const settings = state.settings || { kpi:{}, users:[], analyticsUrls:{} };
  settings.analyticsUrls = settings.analyticsUrls || {};
  Object.assign(settings.analyticsUrls, state.tempUrls);
  state.settings = settings; state.tempUrls = {};
  try {
    state.shas.settings = await window.db.writeData('settings', settings, 'Update platform URLs');
    toast('URL platform disimpan', 'success');
    renderAnalyticsCompact();
  } catch (e) { toast('Gagal: ' + e.message, 'error'); }
}

/* User management */
function renderUserList() {
  const list  = $('userList');
  const users = state.settings?.users || [];
  if (!list) return;
  if (!users.length) { list.innerHTML = '<li class="user-empty">Belum ada anggota. Tambahkan creator tim.</li>'; return; }
  list.innerHTML = users.map(u => {
    const name  = getUserName(u);
    const role  = getUserRole(u);
    const phone = u.phone || '';
    const color = ROLE_COLORS[role] || '#16a34a';
    const hasPw = !!u.passwordHash;
    return `<li class="user-item">
      <div class="user-av">${name.charAt(0).toUpperCase()}</div>
      <div class="user-info">
        <span class="user-name">${esc(name)}</span>
        ${phone ? `<span class="user-phone">📱 ${esc(phone)}</span>` : '<span class="user-phone muted">— no WA —</span>'}
      </div>
      <span title="${hasPw ? 'Password diatur' : 'Belum ada password'}" style="font-size:.75rem;cursor:default">${hasPw ? '🔒' : '🔓'}</span>
      <span class="user-role-tag" style="background:${color}18;color:${color};border:1px solid ${color}30">${esc(role)}</span>
      <button class="user-edit" onclick="editUser('${esc(name)}')" title="Edit">✏</button>
      <button class="user-del"  onclick="deleteUser('${esc(name)}')" title="Hapus">×</button>
    </li>`;
  }).join('');
}

async function addUser() {
  const name     = gv('userNameInput').trim();
  const role     = gv('userRoleInput').trim() || 'Creator';
  const phone    = gv('userPhoneInput').trim();
  const password = gv('userPasswordInput').trim();
  if (!name) { toast('Nama tidak boleh kosong', 'error'); return; }
  const settings = state.settings || { kpi:{}, users:[], analyticsUrls:{} };
  if (!settings.users) settings.users = [];
  if (settings.users.some(u => getUserName(u) === name)) { toast('Nama sudah ada', 'error'); return; }
  const passwordHash = password ? await hashPw(password) : '';
  settings.users.push({ name, role, phone, passwordHash });
  state.settings = settings;
  setPubUsers(settings.users);
  renderUserList();
  sv('userNameInput', ''); sv('userRoleInput', 'Creator'); sv('userPhoneInput', ''); sv('userPasswordInput', '');
  $('addUserForm').classList.add('hidden');
  try {
    state.shas.settings = await window.db.writeData('settings', settings, `Tambah user: ${name} (${role})`);
    saveDataCache();
    await logActivity(currentUser(), 'tambah anggota', `${name} (${role})`);
    toast(`${name} (${role}) ditambahkan`, 'success');
  } catch (e) { toast('Gagal: ' + e.message, 'error'); }
}

async function deleteUser(name) {
  showConfirm(`Hapus "${name}" dari tim? Tindakan ini tidak dapat dibatalkan.`, async () => {
    const settings = state.settings;
    settings.users = (settings.users||[]).filter(u => getUserName(u) !== name);
    state.settings = settings;
    setPubUsers(settings.users);
    renderUserList();
    try {
      state.shas.settings = await window.db.writeData('settings', settings, `Hapus user: ${name}`);
      saveDataCache();
      await logActivity(currentUser(), 'hapus anggota', `${name}`);
      toast(`${name} dihapus`);
    } catch (e) { toast('Gagal: ' + e.message, 'error'); }
  });
}

/* ── Edit User ───────────────────────────────────────────────────────────── */
function editUser(oldName) {
  const users = state.settings?.users || [];
  const u = users.find(x => getUserName(x) === oldName);
  if (!u) return;
  sv('editUserOldName',      oldName);
  sv('editUserName',         getUserName(u));
  sv('editUserRole',         getUserRole(u));
  sv('editUserPhone',        u.phone || '');
  sv('editUserNewPassword',  '');
  $('editUserModal')?.classList.remove('hidden');
  $('editUserName')?.focus();
}

async function saveEditUser() {
  const oldName = gv('editUserOldName');
  const newName = gv('editUserName').trim();
  const newRole = gv('editUserRole').trim() || 'Creator';
  if (!newName) { toast('Nama tidak boleh kosong', 'error'); return; }

  const settings = state.settings;
  const idx = (settings.users||[]).findIndex(u => getUserName(u) === oldName);
  if (idx === -1) return;

  // Check duplicate (allow if same name)
  if (newName !== oldName && settings.users.some(u => getUserName(u) === newName)) {
    toast('Nama sudah digunakan', 'error'); return;
  }

  const newPhone = gv('editUserPhone').trim();
  const newPw    = gv('editUserNewPassword').trim();
  const u        = settings.users[idx];
  const passwordHash = newPw ? await hashPw(newPw) : (u?.passwordHash || '');
  settings.users[idx] = { name: newName, role: newRole, phone: newPhone, passwordHash };

  // Propagate name change to todos & contents
  if (newName !== oldName) {
    state.todos    = state.todos.map(t => t.assignedTo === oldName ? {...t, assignedTo: newName} : t);
    state.contents = state.contents.map(c => c.creator  === oldName ? {...c, creator: newName}   : c);
  }

  state.settings = settings;
  setPubUsers(settings.users);
  renderUserList();
  $('editUserModal')?.classList.add('hidden');

  try {
    state.shas.settings = await window.db.writeData('settings', settings, `Edit user: ${oldName} → ${newName} (${newRole})`);
    if (newName !== oldName) {
      state.shas.todos    = await window.db.writeData('todos',    state.todos,    `Update assignee: ${oldName}→${newName}`);
      state.shas.contents = await window.db.writeData('contents', state.contents, `Update creator: ${oldName}→${newName}`);
    }
    toast(`${newName} (${newRole}) diperbarui ✓`, 'success');
    await logActivity(currentUser(), 'edit user', `${oldName} → ${newName} (${newRole})`);
  } catch (e) { toast('Gagal: ' + e.message, 'error'); }
}

/* KPI */
async function saveKpi() {
  const settings = state.settings || { kpi:{}, users:[], analyticsUrls:{} };
  settings.kpi = {
    'penjaga-harapan': +gv('kpiPH') || 0,
    '33-official':     +gv('kpi33') || 0,
    'jaga-asa':        +gv('kpiJA') || 0
  };
  state.settings = settings;
  try {
    state.shas.settings = await window.db.writeData('settings', settings, 'Update KPI targets');
    toast('Target KPI disimpan', 'success');
    if (state.currentPage === 'dashboard') renderDashboard();
  } catch (e) { toast('Gagal: ' + e.message, 'error'); }
}

/* ══════════════════════════════════════════════════════════════════════════
   STATISTICS
   ══════════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════
   STATISTICS — rich platform data tables
   ══════════════════════════════════════════════════════════════════════════ */

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function fmtNum(n) {
  if (n === null || n === undefined || n === '') return '—';
  n = +n;
  if (isNaN(n)) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toLocaleString('id-ID');
}

function getLast6Months() {
  const out = [], d = new Date();
  for (let i = 5; i >= 0; i--) {
    const dt = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

function fmtMonth(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  const names = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agt','Sep','Okt','Nov','Des'];
  return `${names[+m - 1]} ${y}`;
}

/* ── Render ──────────────────────────────────────────────────────────────── */
function fmtStatVal(val, fmt) {
  if (val === null || val === undefined || val === '') return '<span style="color:var(--muted-lt)">—</span>';
  if (fmt === 'pct') return `${(+val).toFixed(2)}%`;
  return fmtNum(+val);
}

function getCurrentYM() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

function renderStatistics() {
  renderStatAcctBar();
  renderStatPlatBar();
  renderStatChart();
  renderStatGoodBad(state.statActiveAcct);
  initStatDownloadMonth();
}

function renderStatAcctBar() {
  const bar = $('statAcctBar');
  if (!bar) return;
  bar.innerHTML = ACCOUNTS.map(a =>
    `<button class="stat-acct-tab ${a.id === state.statActiveAcct ? 'active' : ''}"
       onclick="switchStatAcct('${a.id}')">${a.name}</button>`
  ).join('');
}

function renderStatPlatBar() {
  const bar = $('statPlatBar');
  if (!bar) return;
  const ap = state.statActivePlat || 'youtube';
  bar.innerHTML = Object.entries(PLATFORM_FIELDS).map(([id, m]) =>
    `<button class="stat-plat-tab ${id===ap?'active':''}"
       style="${id===ap?`--plat-color:${m.color};border-color:${m.color};color:${m.color};background:${m.color}18`:''}"
       onclick="switchStatPlat('${id}')">${m.label}</button>`
  ).join('');
}

function switchStatAcct(acctId) {
  state.statActiveAcct = acctId;
  renderStatAcctBar();
  renderStatChart();
  renderStatGoodBad(acctId);
  $('statInputCard')?.classList.add('hidden');
}

function switchStatPlat(platId) {
  state.statActivePlat = platId;
  renderStatPlatBar();
  renderStatChart();
  renderStatGoodBad(state.statActiveAcct);
  $('statInputCard')?.classList.add('hidden');
}

/* ── alias so existing references to renderStatTable still work ─────────── */
function renderStatTable() { renderStatChart(); }

function renderStatChart() {
  const acctId = state.statActiveAcct;
  const platId = state.statActivePlat || 'youtube';
  const platM  = PLATFORM_FIELDS[platId];
  if (!platM) return;

  // Update input form title
  const title = $('statInputTitle');
  if (title) title.textContent = `📊 Input ${platM.label} — ${getAcctName(acctId)}`;

  const rows = ((state.analytics?.[acctId]?.[platId]) || [])
    .slice().sort((a,b) => a.month.localeCompare(b.month));

  const summaryWrap = $('statSummaryWrap');
  const chartWrap   = $('statChartWrap');

  /* ── No data state ──────────────────────────────────────────────── */
  if (!rows.length) {
    if (summaryWrap) summaryWrap.innerHTML = '';
    if (chartWrap)   chartWrap.innerHTML = `<div class="stat-no-data">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--muted-lt)"><rect x="18" y="3" width="4" height="18" rx="1"/><rect x="10" y="8" width="4" height="13" rx="1"/><rect x="2" y="13" width="4" height="8" rx="1"/></svg>
      <p>Belum ada data <strong>${platM.label}</strong> untuk <strong>${getAcctName(acctId)}</strong></p>
      <button class="btn-sm blue" onclick="document.getElementById('btnToggleStatInput').click()">+ Input Data Pertama</button>
    </div>`;
    if (window._statChart) { window._statChart.destroy(); window._statChart = null; }
    const dt = $('statDataTable'); if (dt) dt.innerHTML = '';
    return;
  }

  /* ── Summary cards (total kumulatif seluruh data) ───────────────── */
  const keyFields = platM.fields.slice(0, 4);
  // Hitung total kumulatif (SUM semua bulan)
  const totals = {};
  keyFields.forEach(f => {
    totals[f.key] = rows.reduce((s, r) => s + (+r[f.key] || 0), 0);
  });
  if (summaryWrap) summaryWrap.innerHTML = `<div class="stat-summary-row">
    ${keyFields.map(f => `
      <div class="stat-summary-card">
        <div class="stat-sum-label">${f.label}</div>
        <div class="stat-sum-val" style="color:${platM.color}">${fmtStatVal(totals[f.key], f.fmt)}</div>
        <div class="stat-sum-period">Total ${rows.length} bulan</div>
      </div>`).join('')}
  </div>`;

  /* ── Bar chart: last 12 months, followers (bars) + views (line) ─ */
  if (chartWrap && !chartWrap.querySelector('canvas')) {
    chartWrap.innerHTML = '<canvas id="statBarChart"></canvas>';
  } else if (!chartWrap) return;

  const displayRows = rows.slice(-12);
  const labels     = displayRows.map(r => fmtMonth(r.month));
  const follData   = displayRows.map(r => +(r[platM.followerKey] || 0));
  const viewData   = displayRows.map(r => +(r[platM.viewKey]     || 0));
  const acctObj    = ACCOUNTS.find(a => a.id === acctId);
  const barColor   = platM.color;

  if (window._statChart) { window._statChart.destroy(); window._statChart = null; }

  const canvas = $('statBarChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  window._statChart = new Chart(ctx, {
    data: {
      labels,
      datasets: [
        {
          type: 'bar',
          label: 'Followers',
          data: follData,
          backgroundColor: barColor + '33',
          borderColor: barColor,
          borderWidth: 1.5,
          borderRadius: 5,
          yAxisID: 'yFoll',
          order: 2
        },
        {
          type: 'line',
          label: 'Views',
          data: viewData,
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99,102,241,.08)',
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          tension: 0.35,
          fill: true,
          yAxisID: 'yView',
          order: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'top',
          labels: { boxWidth: 12, font: { size: 11 } }
        },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${fmtNum(ctx.parsed.y)}`
          }
        }
      },
      scales: {
        yFoll: {
          type: 'linear', position: 'left',
          title: { display: true, text: 'Followers', font: { size: 10 } },
          ticks: { callback: v => fmtNum(v), font: { size: 10 } },
          grid: { color: 'rgba(0,0,0,.06)' }
        },
        yView: {
          type: 'linear', position: 'right',
          title: { display: true, text: 'Views', font: { size: 10 } },
          ticks: { callback: v => fmtNum(v), font: { size: 10 } },
          grid: { drawOnChartArea: false }
        },
        x: { ticks: { font: { size: 10 } } }
      }
    }
  });

  // Render admin-only data table below chart
  renderStatDataTable(acctId, platId, rows);
}

/* ── Admin-only monthly data table ─────────────────────────────────────── */
function renderStatDataTable(acctId, platId, rows) {
  const wrap  = $('statDataTable');
  if (!wrap) return;

  if (!isAdmin() || !rows.length) { wrap.innerHTML = ''; return; }

  const platM = PLATFORM_FIELDS[platId];
  if (!platM) { wrap.innerHTML = ''; return; }

  const sorted = [...rows].sort((a, b) => b.month.localeCompare(a.month)); // terbaru di atas

  const headerCells = platM.fields.map(f => `<th>${f.label}</th>`).join('');
  const bodyRows = sorted.map(r => {
    const cells = platM.fields.map(f =>
      `<td style="text-align:right">${fmtStatVal(r[f.key], f.fmt)}</td>`
    ).join('');
    return `<tr><td style="white-space:nowrap;font-weight:500">${fmtMonth(r.month)}</td>${cells}</tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="card" style="margin-top:16px">
      <div class="card-head">
        <span class="card-title">📋 Data Bulanan — ${platM.label} · ${getAcctName(acctId)}</span>
        <span class="badge-status ok" style="font-size:.68rem">Admin Only</span>
      </div>
      <div style="overflow-x:auto">
        <table class="data-table" style="font-size:.78rem">
          <thead>
            <tr>
              <th style="white-space:nowrap">BULAN</th>
              ${headerCells}
            </tr>
          </thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
    </div>`;
}

/* ── Download helpers ───────────────────────────────────────────────────── */
function initStatDownloadMonth() {
  const inp = $('statDlMonth');
  if (inp && !inp.value) inp.value = getCurrentYM();
}

function downloadStatJpg() {
  const canvas = $('statBarChart');
  if (!canvas) { toast('Tidak ada grafik untuk didownload', 'error'); return; }
  const acctId = state.statActiveAcct;
  const platId = state.statActivePlat || 'youtube';
  const month  = $('statDlMonth')?.value || getCurrentYM();

  // Create a white-background version
  const offCanvas = document.createElement('canvas');
  offCanvas.width  = canvas.width;
  offCanvas.height = canvas.height;
  const offCtx = offCanvas.getContext('2d');
  offCtx.fillStyle = '#ffffff';
  offCtx.fillRect(0, 0, offCanvas.width, offCanvas.height);
  offCtx.drawImage(canvas, 0, 0);

  const link = document.createElement('a');
  link.download = `grafik-${acctId}-${platId}-${month}.jpg`;
  link.href = offCanvas.toDataURL('image/jpeg', 0.92);
  link.click();
  toast('Grafik berhasil didownload ✓', 'success');
}

function downloadStatTable() {
  const acctId = state.statActiveAcct;
  const platId = state.statActivePlat || 'youtube';
  const platM  = PLATFORM_FIELDS[platId];
  if (!platM) return;

  const rows = ((state.analytics?.[acctId]?.[platId]) || [])
    .slice().sort((a,b) => a.month.localeCompare(b.month));
  if (!rows.length) { toast('Belum ada data untuk didownload', 'error'); return; }

  const month = $('statDlMonth')?.value || getCurrentYM();

  // 4 key columns: follower, views, total engagement, ER
  const follF = platM.fields.find(f => f.key === platM.followerKey) || platM.fields[0];
  const viewF = platM.fields.find(f => f.key === platM.viewKey)     || platM.fields[1];
  const engF  = platM.fields.find(f => f.key.toLowerCase().includes('totalengagement') || f.label.toLowerCase().includes('engagement'));
  const erF   = platM.fields.find(f => f.fmt === 'pct' || f.label.toLowerCase().includes('er %'));
  const cols  = [follF, viewF, engF, erF].filter(Boolean);

  const acctObj = ACCOUNTS.find(a => a.id === acctId);
  const headerRow = `<tr style="background:${platM.color};color:#fff"><th>Bulan</th>${cols.map(f=>`<th>${f.label}</th>`).join('')}</tr>`;
  const dataRows  = rows.map(r => {
    const isSelected = r.month === month;
    const style = isSelected ? `style="background:${platM.color}18;font-weight:600"` : '';
    return `<tr ${style}><td>${fmtMonth(r.month)}</td>${cols.map(f=>`<td>${fmtStatVal(r[f.key],f.fmt)}</td>`).join('')}</tr>`;
  }).join('');

  const html = `<html><head><meta charset="UTF-8">
    <style>
      body { font-family: Arial, sans-serif; padding: 24px; color: #0f172a; }
      h2   { margin-bottom: 4px; font-size: 16px; }
      p    { color: #64748b; font-size: 12px; margin-bottom: 16px; }
      table { border-collapse: collapse; width: 100%; font-size: 12px; }
      th, td { padding: 8px 12px; border: 1px solid #e2e8f0; text-align: right; }
      th:first-child, td:first-child { text-align: left; }
      th { font-size: 11px; letter-spacing: .04em; }
    </style></head><body>
    <h2>${platM.label} — ${acctObj?.name || acctId}</h2>
    <p>Diekspor: ${new Date().toLocaleDateString('id-ID',{day:'2-digit',month:'long',year:'numeric'})} · ${rows.length} bulan data</p>
    <table><thead>${headerRow}</thead><tbody>${dataRows}</tbody></table>
  </body></html>`;

  html2pdf().set({
    margin: 10,
    filename: `tabel-${acctId}-${platId}-${month}.pdf`,
    jsPDF: { unit:'mm', format:'a4', orientation:'landscape' }
  }).from(html).save();
  toast('Tabel sedang didownload ✓', 'success');
}

/* ── Top 3 per-bulan — semua user bisa edit ─────────────────────────────── */

function _getTop3MonthOptions(acctId) {
  // Kumpulkan semua bulan dari semua platform untuk akun ini
  const platRows = Object.values(state.analytics?.[acctId] || {}).flat();
  const months = [...new Set(platRows.map(r => r.month))].sort().reverse();
  if (!months.includes(getCurrentYM())) months.unshift(getCurrentYM());
  return months;
}

function _ensureTop3(acctId, month) {
  const empty3 = () => [{title:'',link:''},{title:'',link:''},{title:'',link:''}];
  if (!state.settings.topContent) state.settings.topContent = {};
  if (!state.settings.topContent[acctId]) state.settings.topContent[acctId] = {};
  const acctData = state.settings.topContent[acctId];

  // Migrasi format lama ({ good, bad }) → per-bulan
  if (acctData.good && !acctData[month]) {
    const refMonth = Object.keys(acctData).find(k => acctData[k]?.good) || month;
    if (!acctData[refMonth]?.good) {
      const oldGood = acctData.good;
      const oldBad  = acctData.bad;
      // Hapus key lama, simpan ke bulan saat ini
      delete state.settings.topContent[acctId].good;
      delete state.settings.topContent[acctId].bad;
      state.settings.topContent[acctId][getCurrentYM()] = { good: oldGood, bad: oldBad };
    }
  }

  if (!acctData[month]) {
    acctData[month] = { good: empty3(), bad: empty3() };
  }
  if (!acctData[month].good) acctData[month].good = empty3();
  if (!acctData[month].bad)  acctData[month].bad  = empty3();
  return acctData[month];
}

function renderStatGoodBad(acctId) {
  const wrap = $('statGoodBadWrap');
  if (!wrap) return;
  const acct = ACCOUNTS.find(a => a.id === acctId);

  // Resolve bulan aktif
  const months  = _getTop3MonthOptions(acctId);
  const selMonth = state.top3Month && months.includes(state.top3Month)
    ? state.top3Month
    : months[0] || getCurrentYM();
  state.top3Month = selMonth;

  const topData = _ensureTop3(acctId, selMonth);

  // Month selector HTML
  const monthSelHtml = `
    <div class="top3-month-bar">
      <span style="font-size:.75rem;color:var(--muted);font-weight:500">📅 Bulan:</span>
      <select class="inp-sm" id="top3MonthSel" onchange="switchTop3Month(this.value)" style="min-width:120px">
        ${months.map(m => `<option value="${m}" ${m === selMonth ? 'selected' : ''}>${fmtMonth(m)}</option>`).join('')}
      </select>
    </div>`;

  function sectionHtml(type, items, label, icon, headCls) {
    const acctColor = acct?.color || '#6366f1';
    const head = `<div class="sgb-section-head ${headCls}">
      <span class="sgb-icon">${icon}</span>
      <span>${label}</span>
      <span class="sgb-acct" style="color:${acctColor}">${acct?.name||''} · ${fmtMonth(selMonth)}</span>
    </div>`;

    // Semua user bisa edit
    const inputRows = items.map((item, i) => `
      <div class="sgb-input-row">
        <input type="text" class="inp-sm" placeholder="Judul konten…"
          value="${esc(item.title||'')}" style="flex:1;min-width:0"
          oninput="updateTopSlot('${esc(acctId)}','${type}',${i},'title',this.value,'${selMonth}')" />
        <input type="url" class="inp-sm" placeholder="https://link-konten…"
          value="${esc(item.link||'')}" style="flex:2;min-width:0"
          oninput="updateTopSlot('${esc(acctId)}','${type}',${i},'link',this.value,'${selMonth}')" />
      </div>`).join('');

    // Preview cards (untuk semua user — tampilkan hasil simpan)
    const valid = items.filter(it => it.link);
    const cards = valid.length
      ? valid.map(it => `<a href="${esc(it.link)}" target="_blank" class="sgb-card sgb-${type}">
          <div class="sgb-card-title">${esc(it.title || '(Tanpa Judul)')}</div>
          <div class="sgb-card-actions">
            <span class="btn-xs blue">🔗 Buka</span>
            <button type="button" class="btn-xs" onclick="event.preventDefault();previewContent('${esc(it.link)}','${esc(it.title||'')}')">👁 Preview</button>
          </div>
        </a>`).join('')
      : '';

    return `<div class="sgb-col">
      ${head}
      <div class="sgb-admin-form">${inputRows}
        <button class="btn-xs blue" style="margin-top:6px"
          onclick="saveTopContent('${esc(acctId)}','${selMonth}')">💾 Simpan Top Content</button>
      </div>
      ${cards ? `<div class="sgb-list" style="margin-top:8px">${cards}</div>` : ''}
    </div>`;
  }

  wrap.innerHTML = `
    ${monthSelHtml}
    <div class="sgb-row">
      ${sectionHtml('good', topData.good, 'Top 3 Good Content',     '🏆', 'good')}
      ${sectionHtml('bad',  topData.bad,  'Top 3 Perlu Perhatian',  '⚠️', 'bad')}
    </div>`;
}

function switchTop3Month(month) {
  state.top3Month = month;
  renderStatGoodBad(state.statActiveAcct);
}

function updateTopSlot(acctId, type, idx, field, val, month) {
  const m = month || state.top3Month || getCurrentYM();
  _ensureTop3(acctId, m);
  state.settings.topContent[acctId][m][type][idx][field] = val;
}

async function saveTopContent(acctId, month) {
  if (!state.settings) return;
  const m = month || state.top3Month || getCurrentYM();
  _ensureTop3(acctId, m);
  showFlagLoader(600);
  try {
    state.shas.settings = await window.db.writeData('settings', state.settings, `Top Content: ${acctId} ${m}`);
    await logActivity(currentUser(), 'Update Top Content', `${getAcctName(acctId)} — ${fmtMonth(m)}`);
    toast(`Top Content ${fmtMonth(m)} disimpan ✓`, 'success');
    renderStatGoodBad(acctId);   // re-render agar preview terbaru muncul
  } catch(e) { toast('Gagal menyimpan: ' + e.message, 'error'); }
}

function previewContent(url, title) {
  const modal = $('cntPreviewModal');
  const frame = $('cntPreviewFrame');
  const linkEl = $('cntPreviewLink');
  const titleEl = $('cntPreviewTitle');
  if (!modal || !frame) return;

  if (titleEl) titleEl.textContent = title || 'Preview Konten';
  if (linkEl) { linkEl.href = url; }

  // Build embed URL
  let embedUrl = url;
  const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (ytMatch) {
    embedUrl = `https://www.youtube.com/embed/${ytMatch[1]}?autoplay=0&rel=0`;
  } else if (url.includes('tiktok.com')) {
    // TikTok can't iframe-embed easily — open in new tab
    window.open(url, '_blank');
    return;
  } else if (url.includes('instagram.com')) {
    window.open(url, '_blank');
    return;
  }

  frame.src = embedUrl;
  modal.classList.remove('hidden');
}
function closeCntPreview() {
  const modal = $('cntPreviewModal');
  const frame = $('cntPreviewFrame');
  if (modal) modal.classList.add('hidden');
  if (frame) frame.src = '';   // stop video
}

function openStatEdit(month) {
  const platId = state.statActivePlat || 'youtube';
  const acctId = state.statActiveAcct;
  const platM  = PLATFORM_FIELDS[platId];
  const existing = (state.analytics?.[acctId]?.[platId] || []).find(r => r.month === month);

  sv('statMonth', month);
  const title = $('statInputTitle');
  if (title) title.textContent = `✏️ Edit ${platM?.label} — ${fmtMonth(month)}`;

  renderStatInputFields(acctId, platId, existing);
  $('statInputCard')?.classList.remove('hidden');
  $('statInputCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderStatInputFields(acctId, platIdOverride, prefill) {
  const container = $('statInputFields');
  if (!container) return;
  const platId = platIdOverride || state.statActivePlat || 'youtube';
  const platM  = PLATFORM_FIELDS[platId];
  if (!platM) return;

  // Auto-prefill from last record if not editing
  const existing = prefill || (() => {
    const rows = (state.analytics?.[acctId]?.[platId] || [])
      .slice().sort((a,b)=>a.month.localeCompare(b.month));
    return rows[rows.length-1] || null;
  })();

  // Group fields into columns of 3 for readability
  container.innerHTML = `<div class="stat-inp-grid">
    ${platM.fields.map(f => `
      <div class="stat-inp-field">
        <label class="form-label" style="font-size:.7rem">${f.label}</label>
        <input type="number" id="sif_${f.key}" class="inp-sm" style="width:100%"
          placeholder="0" step="${f.fmt==='pct'?'0.01':'1'}" min="0"
          value="${existing?.[f.key] ?? ''}" />
      </div>`).join('')}
  </div>`;
}

async function saveAnalyticsEntry() {
  const month  = gv('statMonth');
  const acctId = state.statActiveAcct;
  const platId = state.statActivePlat || 'youtube';
  const platM  = PLATFORM_FIELDS[platId];
  if (!month) { toast('Pilih bulan terlebih dahulu', 'error'); return; }

  const analytics = state.analytics || {};
  if (!analytics[acctId]) analytics[acctId] = {};
  if (!analytics[acctId][platId]) analytics[acctId][platId] = [];

  // Build entry from inputs
  const entry = { month };
  let hasAny = false;
  platM.fields.forEach(f => {
    const raw = gv(`sif_${f.key}`);
    if (raw !== '') {
      entry[f.key] = f.fmt === 'pct' ? parseFloat(raw) : parseInt(raw, 10);
      hasAny = true;
    }
  });
  if (!hasAny) { toast('Isi minimal satu field', 'error'); return; }

  // Replace or add
  analytics[acctId][platId] = analytics[acctId][platId].filter(r => r.month !== month);
  analytics[acctId][platId].push(entry);
  analytics[acctId][platId].sort((a,b) => a.month.localeCompare(b.month));
  if (analytics[acctId][platId].length > 36)
    analytics[acctId][platId] = analytics[acctId][platId].slice(-36);

  state.analytics = analytics;
  setLoading('btnSaveStats', true, 'Menyimpan…');
  try {
    state.shas.analytics = await window.db.writeData(
      'analytics', analytics,
      `Statistik: ${getAcctName(acctId)} ${platM.label} ${fmtMonth(month)}`
    );
    await logActivity(currentUser(), 'update statistik', `${getAcctName(acctId)} ${platM.label} — ${fmtMonth(month)}`);
    toast(`Data ${platM.label} ${fmtMonth(month)} disimpan ✓`, 'success');
    const lbl = $('statLastSaved');
    if (lbl) lbl.textContent = `Tersimpan: ${fmtMonth(month)}`;
    renderStatTable();
    $('statInputCard')?.classList.add('hidden');
  } catch (e) {
    toast('Gagal simpan: ' + e.message, 'error');
  } finally {
    setLoading('btnSaveStats', false, 'Simpan ke GitHub');
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   GEMINI AI
   ══════════════════════════════════════════════════════════════════════════ */

function geminiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${getGeminiKey()}`;
}

async function callGemini(prompt) {
  const key = getGeminiKey();
  if (!key) throw new Error('Gemini API Key belum diisi. Masuk ke API Setup → Gemini AI dan isi key-nya.');
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.8, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } }
  });
  let lastErr = 'Semua model gagal';
  for (const model of GEMINI_MODELS) {
    try {
      const res  = await fetch(geminiUrl(model), { method:'POST', headers:{'Content-Type':'application/json'}, body });
      const data = await res.json();
      if (data.error) { lastErr = data.error.message; continue; }
      const text = data.candidates?.[0]?.content?.parts?.find(p => p.text)?.text;
      if (!text) { lastErr = 'Respons kosong'; continue; }
      return text;
    } catch (e) { lastErr = e.message; }
  }
  throw new Error(lastErr);
}

function showAiLoad(msg) { $('aiLoadMsg').textContent = msg; $('aiLoadOverlay').classList.remove('hidden'); }
function hideAiLoad()     { $('aiLoadOverlay').classList.add('hidden'); }

async function generateDraft() {
  const title = gv('postTitle'), theme = gv('postTheme'), format = gv('postFormat');
  const acct  = gv('postAccount') ? getAcctName(gv('postAccount')) : 'akun';
  if (!title) { toast('Isi judul konten terlebih dahulu', 'error'); return; }

  // 3x limit check
  const key   = getContentKey();
  const count = getAiCount(key, 'draft');
  if (count >= AI_MAX) {
    toast(`Batas generate naskah tercapai (${AI_MAX}× per konten) untuk mengurangi biaya API`, 'error');
    return;
  }

  showAiLoad(`Generating draft naskah… (${count + 1}/${AI_MAX})`);
  try {
    const isDialog = ['Podcast','Monolog','Video','Short'].includes(format);
    const text = await callGemini(
      `Kamu adalah content writer profesional untuk media sosial Indonesia, khususnya untuk akun "${acct}".\n\nBuatkan naskah/script konten lengkap:\n- Judul: ${title}\n- Tema: ${theme || 'umum'}\n- Format: ${format}\n- Akun: ${acct}\n\n${isDialog ? 'Sertakan dialog/percakapan jika diperlukan, tulis dengan format:\nHOST: [teks]\nNARASI: [teks]\nPERTANYAAN: [teks]\nJAWABAN: [teks]\n\n' : ''}Tulis naskah lengkap dan detail yang siap digunakan. Langsung mulai naskahnya.`
    );
    sv('postScript', text);
    incAiCount(key, 'draft');
    const remaining = AI_MAX - (count + 1);
    toast(`Draft berhasil digenerate ✨ (sisa ${remaining}× lagi)`, 'success');
    updateAiLimitDisplay();
  } catch (e) { toast('Gagal generate: ' + e.message, 'error'); }
  finally { hideAiLoad(); }
}

async function generateCaption() {
  const title  = gv('postTitle'), script = gv('postScript');
  const plats  = Array.from($$('#platformChecks input:checked')).map(cb => cb.value);
  const acctId = gv('postAccount');
  const acct   = acctId ? getAcctName(acctId) : 'Penjaga Harapan';
  if (!title && !script) { toast('Isi judul atau naskah terlebih dahulu', 'error'); return; }

  // 3x limit check
  const key   = getContentKey();
  const count = getAiCount(key, 'caption');
  if (count >= AI_MAX) {
    toast(`Batas generate caption tercapai (${AI_MAX}× per konten) untuk mengurangi biaya API`, 'error');
    return;
  }

  showAiLoad(`Generating caption… (${count + 1}/${AI_MAX})`);
  try {
    const hasDialog = script && /host:|narasi:|pertanyaan:|jawaban:/i.test(script);
    const scriptExcerpt = script ? script.slice(0, 600) : '';
    const platformStr   = plats.length ? plats.join(', ') : 'Instagram, TikTok';

    const prompt = `Kamu adalah copywriter profesional media sosial untuk akun "${acct}" di Indonesia.

Buatkan caption media sosial yang PANJANG, menarik, dan engaging untuk platform: ${platformStr}.

Detail konten:
- Judul: ${title}
- Akun: ${acct}
${scriptExcerpt ? `- Naskah/ringkasan:\n${scriptExcerpt}` : ''}
${hasDialog ? '\n- Konten ini memiliki format dialog/percakapan. Sertakan cuplikan percakapan menarik dalam caption.' : ''}

Panduan penulisan caption:
1. Buka dengan hook yang kuat (pertanyaan atau pernyataan mengejutkan)
2. Jelaskan konten dengan detail dan informatif (minimal 3-4 paragraf)
${hasDialog ? '3. Sertakan 1-2 baris dialog/percakapan menarik sebagai teaser\n4.' : '3.'} Tutup dengan call-to-action yang kuat
${hasDialog ? '5.' : '4.'} Wajib cantumkan hashtag #PenjagaHarapan sebagai hashtag PERTAMA
${hasDialog ? '6.' : '5.'} Tambahkan 10-15 hashtag relevan lainnya di akhir
${hasDialog ? '7.' : '6.'} Gunakan emoji yang sesuai di setiap paragraf
${hasDialog ? '8.' : '7.'} Bahasa Indonesia yang natural, semangat, dan menginspirasi

Langsung tulis caption-nya sekarang.`;

    const text = await callGemini(prompt);
    sv('postCaption', text);
    incAiCount(key, 'caption');
    const remaining = AI_MAX - (count + 1);
    toast(`Caption berhasil digenerate ✨ (sisa ${remaining}× lagi)`, 'success');
    updateAiLimitDisplay();
  } catch (e) { toast('Gagal generate: ' + e.message, 'error'); }
  finally { hideAiLoad(); }
}

/* ══════════════════════════════════════════════════════════════════════════
   INFO PRESIDEN AI (News Panel)
   ══════════════════════════════════════════════════════════════════════════ */

function openNewsPanel() {
  $('newsPanel').classList.add('open');
  $('newsOverlay').classList.add('active');
  const cache = getCachedNews();
  if (cache) renderNewsContent(cache.text, cache.ts);
  else fetchNews();
}
function closeNewsPanel() {
  $('newsPanel').classList.remove('open');
  $('newsOverlay').classList.remove('active');
}
function getCachedNews() {
  try { const o = JSON.parse(localStorage.getItem(NEWS_KEY)||'null'); return (o && Date.now()-o.ts < NEWS_TTL) ? o : null; }
  catch { return null; }
}
function setCachedNews(text) { localStorage.setItem(NEWS_KEY, JSON.stringify({ text, ts: Date.now() })); }

async function fetchNews() {
  $('newsContent').innerHTML = `<div class="news-loading"><div class="spinner"></div><span>Mengambil info terkini dari AI…</span></div>`;
  $('newsTimestamp').textContent = '';
  const prompt = `Berikan tepat 5 berita atau informasi terbaru mengenai Presiden Republik Indonesia Prabowo Subianto dan kebijakan pemerintahan saat ini. Gunakan format persis seperti ini untuk setiap item (wajib diikuti):

ITEM_1
JUDUL: [tulis judul berita di sini]
ISI: [deskripsikan 2-3 kalimat dalam bahasa Indonesia yang jelas dan informatif]

ITEM_2
JUDUL: [tulis judul berita di sini]
ISI: [deskripsikan 2-3 kalimat dalam bahasa Indonesia yang jelas dan informatif]

ITEM_3
JUDUL: [tulis judul berita di sini]
ISI: [deskripsikan 2-3 kalimat dalam bahasa Indonesia yang jelas dan informatif]

ITEM_4
JUDUL: [tulis judul berita di sini]
ISI: [deskripsikan 2-3 kalimat dalam bahasa Indonesia yang jelas dan informatif]

ITEM_5
JUDUL: [tulis judul berita di sini]
ISI: [deskripsikan 2-3 kalimat dalam bahasa Indonesia yang jelas dan informatif]

Langsung mulai dari ITEM_1 tanpa pengantar.`;
  try {
    const text = await callGemini(prompt);
    setCachedNews(text);
    renderNewsContent(text, Date.now());
  } catch (e) {
    $('newsContent').innerHTML = `<div style="color:var(--red);font-size:.82rem;padding:12px 0">Gagal memuat: ${esc(e.message)}</div>`;
  }
}

function renderNewsContent(text, ts) {
  // Parse ITEM_N / JUDUL: / ISI: format
  const items = [];
  const blocks = text.split(/ITEM_\d+/i).filter(b => b.trim());
  blocks.forEach((block, i) => {
    const judulM = block.match(/JUDUL:\s*(.+)/i);
    const isiM   = block.match(/ISI:\s*([\s\S]+?)(?=\n*$)/i);
    if (judulM) {
      items.push({
        num:   i + 1,
        title: judulM[1].trim(),
        body:  isiM ? isiM[1].trim().replace(/\n+/g,' ') : ''
      });
    }
  });

  // Fallback: original markdown parse
  if (!items.length) {
    const lines = text.split('\n'); let cur = null;
    lines.forEach(line => {
      const m = line.match(/^[🔹🔸▪▸➤•*\-]\s*\*{0,2}(.+?)\*{0,2}$/);
      if (m && line.length < 120) { if (cur) items.push(cur); cur = { num: items.length+1, title: m[1], body: '' }; }
      else if (cur && line.trim()) cur.body += (cur.body?' ':'')+line.replace(/\*\*/g,'').trim();
    });
    if (cur) items.push(cur);
  }

  $('newsContent').innerHTML = items.length
    ? items.map(it => `
      <div class="news-item">
        <div class="news-item-num">${it.num}</div>
        <div class="news-item-content">
          <div class="news-item-title">${esc(it.title)}</div>
          ${it.body ? `<div class="news-item-body">${esc(it.body)}</div>` : ''}
        </div>
      </div>`).join('')
    : `<div class="news-item"><div class="news-item-content"><div class="news-item-body">${esc(text)}</div></div></div>`;

  if (ts) {
    const d = new Date(ts);
    $('newsTimestamp').textContent = `Update: ${d.toLocaleString('id-ID',{hour:'2-digit',minute:'2-digit',day:'2-digit',month:'short'})}`;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   PDF EXPORT
   ══════════════════════════════════════════════════════════════════════════ */

/* ── Planner PDF: uses current active filters, includes downloader info ─────── */
function downloadPlannerPdf() {
  const search   = gv('planSearch').toLowerCase();
  const creator  = gv('planFilterCreator');
  const status   = gv('planFilterStatus');
  const time     = gv('planFilterTime');
  const dateFrom = gv('planDateFrom');
  const dateTo   = gv('planDateTo');

  const now = new Date(); now.setHours(0,0,0,0);

  let filtered = state.contents.filter(c => {
    if (search  && !c.title?.toLowerCase().includes(search)) return false;
    if (creator && c.creator !== creator) return false;
    if (status  && c.status  !== status)  return false;
    if (time === 'week') {
      const d   = new Date(c.publishDate||'');
      const day = now.getDay();
      const mon = new Date(now); mon.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
      const sun = new Date(mon); sun.setDate(mon.getDate() + 7);
      if (d < mon || d >= sun) return false;
    }
    if (time === 'month') {
      const d = new Date(c.publishDate||'');
      if (d.getMonth() !== now.getMonth() || d.getFullYear() !== now.getFullYear()) return false;
    }
    if (dateFrom && new Date(c.publishDate||'') < new Date(dateFrom)) return false;
    if (dateTo   && new Date(c.publishDate||'') > new Date(dateTo + 'T23:59:59')) return false;
    return true;
  });

  filtered.sort((a,b) => new Date(a.publishDate||'9999') - new Date(b.publishDate||'9999'));

  // Build filter summary for header
  const filterParts = [];
  if (search)   filterParts.push(`Judul: "${search}"`);
  if (creator)  filterParts.push(`Creator: ${creator}`);
  if (status)   filterParts.push(`Status: ${status}`);
  if (time === 'week')  filterParts.push('Minggu Ini');
  if (time === 'month') filterParts.push('Bulan Ini');
  if (dateFrom || dateTo) filterParts.push(`${dateFrom || '...'} s/d ${dateTo || '...'}`);
  const filterDesc  = filterParts.length ? filterParts.join(' · ') : 'Semua Konten';
  const downloader  = currentUser();
  const exportDate  = new Date().toLocaleDateString('id-ID', { day:'2-digit', month:'long', year:'numeric' });
  const exportTime  = new Date().toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit' });

  const statusBg = { Published:'#dcfce7', Approved:'#dbeafe', Review:'#fef9c3',
    Scheduled:'#ede9fe', Draft:'#f1f5f9', Ide:'#fff7ed' };

  const html = `<div style="font-family:Arial,sans-serif;padding:24px;color:#0f172a">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;border-bottom:2px solid #e2e8f0;padding-bottom:12px">
      <div>
        <div style="font-size:20px;font-weight:800;color:#1e293b">Laporan Planner Konten</div>
        <div style="font-size:12px;color:#64748b;margin-top:3px">Penjaga Harapan CMS</div>
      </div>
      <div style="text-align:right;font-size:11px;color:#64748b;line-height:1.7">
        <div>Diekspor oleh: <strong>${esc(downloader)}</strong></div>
        <div>${exportDate}, ${exportTime}</div>
        <div>Filter: <em>${esc(filterDesc)}</em></div>
        <div>${filtered.length} konten</div>
      </div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:11px">
      <thead><tr style="background:#1e293b;color:#fff">
        <th style="padding:8px 10px;text-align:left;border:1px solid #334155">No</th>
        <th style="padding:8px 10px;text-align:left;border:1px solid #334155">Tanggal</th>
        <th style="padding:8px 10px;text-align:left;border:1px solid #334155">Judul Konten</th>
        <th style="padding:8px 10px;text-align:left;border:1px solid #334155">Status</th>
        <th style="padding:8px 10px;text-align:left;border:1px solid #334155">Akun</th>
        <th style="padding:8px 10px;text-align:left;border:1px solid #334155">Creator</th>
        <th style="padding:8px 10px;text-align:left;border:1px solid #334155">Platform</th>
      </tr></thead>
      <tbody>${filtered.map((c,i)=>`<tr style="background:${i%2===0?'#fff':'#f8fafc'}">
        <td style="padding:7px 10px;border:1px solid #e2e8f0;color:#94a3b8">${i+1}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0">${fmtDate(c.publishDate)}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;font-weight:600">${esc(c.title)}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0">
          <span style="background:${statusBg[c.status]||'#f1f5f9'};border-radius:4px;padding:2px 7px;font-size:10px;font-weight:700">${esc(c.status)}</span>
        </td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0">${esc(getAcctName(c.account))}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0">${esc(c.creator||'—')}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;font-size:10px">${(c.platforms||[]).join(', ')||'—'}</td>
      </tr>`).join('')}</tbody>
    </table>
    ${filtered.length===0 ? '<p style="text-align:center;color:#94a3b8;padding:24px 0">Tidak ada konten sesuai filter</p>' : ''}
  </div>`;

  if (window.html2pdf) {
    const div = document.createElement('div');
    div.innerHTML = html;
    html2pdf().from(div).set({
      margin: 8,
      filename: `planner-${downloader.replace(/\s+/g,'-')}-${new Date().toISOString().slice(0,10)}.pdf`,
      image: { type:'jpeg', quality:.95 },
      html2canvas: { scale: 2 },
      jsPDF: { unit:'mm', format:'a4', orientation:'landscape' }
    }).save();
  } else {
    const w = window.open('', '_blank');
    w.document.write(`<html><head><meta charset="UTF-8"></head><body>${html}</body></html>`);
    w.document.close(); w.print();
  }
  toast(`PDF ${filtered.length} konten sedang diunduh…`, 'success');
  logActivity(currentUser(), 'unduh PDF planner', `${filtered.length} konten · filter: ${filterDesc}`);
}

/* legacy alias — kept so any leftover references don't break */
function openPdfModal()  { downloadPlannerPdf(); }
function closePdfModal() { $('pdfModal')?.classList.add('hidden'); }
function downloadPdf()   { downloadPlannerPdf(); }

/* ══════════════════════════════════════════════════════════════════════════
   EVENT LISTENERS & INIT
   ══════════════════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', async () => {

  /* ── Sidebar toggle ─────────────────────────────────────────── */
  $('sidebarToggle')?.addEventListener('click', () => $('sidebar').classList.toggle('collapsed'));
  $('menuBtn')?.addEventListener('click', () => {
    const s = $('sidebar');
    window.innerWidth <= 680 ? s.classList.toggle('mobile-open') : s.classList.toggle('collapsed');
  });

  /* ── Hash routing ───────────────────────────────────────────── */
  window.addEventListener('hashchange', handleHash);
  $$('.nav-item').forEach(a => a.addEventListener('click', () => {
    if (window.innerWidth <= 680) $('sidebar').classList.remove('mobile-open');
  }));

  /* ── Wizard ─────────────────────────────────────────────────── */
  $('btnWs1Next')?.addEventListener('click', wizardStep1Next);
  $('setupAdminPw2')?.addEventListener('keydown', e => { if (e.key==='Enter') wizardStep1Next(); });
  $('btnWs2Back')?.addEventListener('click', () => showWizardStep(1));
  $('btnCreateRepo')?.addEventListener('click', wizardCreateRepo);
  $('btnWizardFinish')?.addEventListener('click', wizardStep2Finish);
  $('btnWizardDone')?.addEventListener('click', wizardDone);
  $('btnToggleSetupPat')?.addEventListener('click', () => { const i=$('setupPat'); i.type=i.type==='password'?'text':'password'; });
  // Connect existing device
  $('btnShowConnectDevice')?.addEventListener('click', () => showWizardStep('Connect'));
  $('btnBackToWs1')?.addEventListener('click', () => showWizardStep(1));
  $('btnConnectDevice')?.addEventListener('click', connectExistingDevice);
  $('btnToggleConnectPat')?.addEventListener('click', () => { const i=$('connectPat'); i.type=i.type==='password'?'text':'password'; });

  /* ── Login ──────────────────────────────────────────────────── */
  $('loginUserSel')?.addEventListener('change', toggleLoginPw);
  $('btnDoLogin')?.addEventListener('click', doLogin);
  $('loginPw')?.addEventListener('keydown', e => { if (e.key==='Enter') doLogin(); });
  $('btnToggleLoginPw')?.addEventListener('click', () => { const i=$('loginPw'); i.type=i.type==='password'?'text':'password'; });
  $('btnLogout')?.addEventListener('click', doLogout);

  /* ── GitHub (API Setup) ─────────────────────────────────────── */
  $('btnTestGithub')?.addEventListener('click', testGithub);
  $('btnSaveGithub')?.addEventListener('click', saveAndInitGithub);
  $('btnTogglePat')?.addEventListener('click', () => { const i=$('cfgPat'); i.type=i.type==='password'?'text':'password'; });
  $('btnSaveGeminiKey')?.addEventListener('click', () => {
    const key = gv('cfgGeminiKey');
    saveGeminiKey(key);
    updateGeminiStatus();
    toast(key ? 'Gemini API Key disimpan ✓' : 'Gemini API Key dihapus', key ? 'success' : '');
  });
  $('btnToggleGeminiKey')?.addEventListener('click', () => { const i=$('cfgGeminiKey'); i.type=i.type==='password'?'text':'password'; });
  $('btnSaveWaToken')?.addEventListener('click', saveWaTokenFromForm);
  $('btnToggleWaToken')?.addEventListener('click', () => { const i=$('cfgWaToken'); i.type=i.type==='password'?'text':'password'; });
  $('btnSaveUrls')?.addEventListener('click', saveUrls);
  $('btnSaveKpi')?.addEventListener('click', saveKpi);

  /* ── User management ────────────────────────────────────────── */
  $('btnAddUser')?.addEventListener('click', () => { $('addUserForm').classList.toggle('hidden'); $('userNameInput')?.focus(); });
  $('btnSaveUser')?.addEventListener('click', addUser);
  $('btnCancelUser')?.addEventListener('click', () => { $('addUserForm').classList.add('hidden'); sv('userNameInput',''); });
  $('userNameInput')?.addEventListener('keydown', e => { if (e.key==='Enter') addUser(); });

  /* ── To-Do ──────────────────────────────────────────────────── */
  $('btnAddTodo')?.addEventListener('click', () => { $('addTodoForm').classList.toggle('hidden'); $('todoInput')?.focus(); });
  $('btnCancelTodo')?.addEventListener('click', () => { $('addTodoForm').classList.add('hidden'); sv('todoInput',''); });
  $('btnSaveTodo')?.addEventListener('click', async () => {
    const text = gv('todoInput'), assign = gv('todoAssign');
    if (!text) return;
    const item = { id: uid(), text, done: false, assignedTo: assign, createdAt: new Date().toISOString() };
    state.todos.push(item);
    renderTodoList();
    sv('todoInput', ''); $('addTodoForm').classList.add('hidden');
    try { state.shas.todos = await window.db.writeData('todos', state.todos, 'Todo: tambah'); toast('Tugas ditambahkan','success'); }
    catch (e) { toast('Gagal: '+e.message,'error'); }
  });
  $('todoInput')?.addEventListener('keydown', e => { if (e.key==='Enter') $('btnSaveTodo').click(); });

  /* ── New Post ───────────────────────────────────────────────── */
  $('btnSavePost')?.addEventListener('click', savePost);
  $('btnCancelPost')?.addEventListener('click', () => { clearNewPostDraft(); navigate('planner'); });
  $('btnPlanNew')?.addEventListener('click', () => { navigate('newpost'); renderNewPostForm(); });

  /* ── New Post autosave — save draft every 30s + on each change ── */
  const draftFields = ['postDate','postCreator','postAccount','postStatus','postTitle','postTheme','postFormat','postScript','postCaption','postOutputLink','postNotes'];
  draftFields.forEach(id => {
    $(id)?.addEventListener('input',  saveNewPostDraft);
    $(id)?.addEventListener('change', saveNewPostDraft);
  });
  $$('#platformChecks input').forEach(cb => cb.addEventListener('change', saveNewPostDraft));
  setInterval(saveNewPostDraft, 30_000);
  $('btnGenerateDraft')?.addEventListener('click', generateDraft);
  $('btnGenerateCaption')?.addEventListener('click', generateCaption);

  /* ── Planner filters ────────────────────────────────────────── */
  ['planSearch','planFilterCreator','planFilterStatus','planFilterTime','planDateFrom','planDateTo'].forEach(id => {
    $(id)?.addEventListener('input',  () => renderPlanner(1));
    $(id)?.addEventListener('change', () => renderPlanner(1));
  });
  $('btnClearDateRange')?.addEventListener('click', () => {
    // Reset ALL planner filters at once
    sv('planSearch',        '');
    sv('planFilterCreator', '');
    sv('planFilterStatus',  '');
    sv('planFilterTime',    '');
    sv('planDateFrom',      '');
    sv('planDateTo',        '');
    renderPlanner(1);
    toast('Filter planner direset ✓');
  });
  /* ── Analytics panel sync ──────────────────────────────────── */
  // btnAnlpSync removed — data syncs automatically on load

  /* ── Sparkline tooltip (platform analytics) ──────────────────── */
  const _sparkTip = $('sparkTooltip');
  document.addEventListener('mousemove', e => {
    const pt = e.target.closest('.spark-pt');
    if (pt && _sparkTip) {
      _sparkTip.textContent = pt.dataset.tip || '';
      _sparkTip.classList.remove('hidden');
      _sparkTip.style.left = `${e.clientX + 12}px`;
      _sparkTip.style.top  = `${e.clientY - 28}px`;
    } else if (_sparkTip) {
      _sparkTip.classList.add('hidden');
    }
  });

  /* ── KPI Harian period selector is wired in buildKpiPeriodSel() ── */

  /* ── Contents filters ───────────────────────────────────────── */
  ['cntSearch','cntFilterStatus','cntFilterAcct'].forEach(id => {
    $(id)?.addEventListener('input',  renderContents);
    $(id)?.addEventListener('change', renderContents);
  });

  /* ── Confirm modal ──────────────────────────────────────────── */
  $('confirmYes')?.addEventListener('click', () => { $('confirmModal').classList.add('hidden'); _confirmCb?.(); _confirmCb = null; });
  $('confirmNo')?.addEventListener('click',  () => { $('confirmModal').classList.add('hidden'); _confirmCb = null; });

  /* ── Edit User modal ─────────────────────────────────────────── */
  $('closeEditUser')?.addEventListener('click',  () => $('editUserModal').classList.add('hidden'));
  $('cancelEditUser')?.addEventListener('click', () => $('editUserModal').classList.add('hidden'));
  $('saveEditUser')?.addEventListener('click',   saveEditUser);
  $('editUserName')?.addEventListener('keydown', e => { if (e.key==='Enter') saveEditUser(); });

  /* ── Activity search + date filter ──────────────────────────── */
  $('actSearch')?.addEventListener('input',  () => renderActivity(1));
  ['actDateFrom','actDateTo'].forEach(id => $(id)?.addEventListener('change', () => renderActivity(1)));
  $('btnClearActFilter')?.addEventListener('click', () => {
    sv('actSearch',''); sv('actDateFrom',''); sv('actDateTo',''); renderActivity(1);
  });

  /* ── Planner PDF (uses active filters, no modal) ───────────── */
  $('btnPlanPdf')?.addEventListener('click', downloadPlannerPdf);
  // Legacy modal buttons (kept for safety)
  $('closePdfModal')?.addEventListener('click', closePdfModal);
  $('cancelPdfModal')?.addEventListener('click', closePdfModal);
  $('confirmPdfDownload')?.addEventListener('click', downloadPdf);

  /* ── News panel ─────────────────────────────────────────────── */
  $('badgeInfoPresiden')?.addEventListener('click', openNewsPanel);
  $('closeNewsPanel')?.addEventListener('click', closeNewsPanel);
  $('newsOverlay')?.addEventListener('click', closeNewsPanel);
  $('btnRefreshNews')?.addEventListener('click', () => { localStorage.removeItem(NEWS_KEY); fetchNews(); });

  /* ── Statistics download ──────────────────────────────────── */
  $('btnDlJpg')?.addEventListener('click', downloadStatJpg);
  $('btnDlTable')?.addEventListener('click', downloadStatTable);

  /* ── Statistics ─────────────────────────────────────────────── */
  $('btnToggleStatInput')?.addEventListener('click', () => {
    const card = $('statInputCard');
    if (!card) return;
    const wasHidden = card.classList.contains('hidden');
    card.classList.toggle('hidden');
    if (wasHidden) {
      const d = new Date();
      if (!$('statMonth')?.value) sv('statMonth', `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
      renderStatInputFields(state.statActiveAcct);
      const title = $('statInputTitle');
      if (title) {
        const platM = PLATFORM_FIELDS[state.statActivePlat || 'youtube'];
        title.textContent = `📊 Input ${platM?.label||''} — ${getAcctName(state.statActiveAcct)}`;
      }
      $('statMonth')?.focus();
    }
  });
  $('btnCloseStatInput')?.addEventListener('click', () => $('statInputCard')?.classList.add('hidden'));
  $('btnSaveStats')?.addEventListener('click', saveAnalyticsEntry);
  // statMetric removed — platform tabs handle switching now

  /* ── Bank Konten ─────────────────────────────────────────────── */
  $('btnAddBkRow')?.addEventListener('click', addBankKontenRow);

  // Inline edit: save on change (debounced 800ms)
  $('bkBody')?.addEventListener('change', e => {
    const inp = e.target.closest('[data-id][data-field]');
    if (!inp) return;
    debouncedSaveBkItem(inp.dataset.id, inp.dataset.field, inp.value);
  });

  // Clicks: WA button + delete button
  $('bkBody')?.addEventListener('click', e => {
    // WA send
    const waBtn = e.target.closest('.bk-wa-btn:not(.bk-wa-btn--disabled)');
    if (waBtn) { sendBankKontenWa(waBtn.dataset.id); return; }

    // Delete row
    const delBtn = e.target.closest('.bk-del-btn');
    if (delBtn) {
      const id   = delBtn.dataset.id;
      const item = state.bankKonten.find(x => x.id === id);
      if (!item) return;
      showConfirm(
        `Hapus konten "${item.title || 'tanpa judul'}" dari Bank Konten?`,
        async () => {
          state.bankKonten = state.bankKonten.filter(x => x.id !== id);
          try {
            state.shas.bankKonten = await window.db.writeData('contentBank', state.bankKonten, `Bank Konten: hapus "${item.title}"`);
            await logActivity(currentUser(), 'Hapus Bank Konten', `"${item.title || 'tanpa judul'}"`);
            renderBankKonten();
            toast('Konten dihapus ✓', 'success');
          } catch (err) {
            toast('Gagal hapus: ' + err.message, 'error');
            // Re-add item on failure
            state.bankKonten.splice(state.bankKonten.length, 0, item);
            renderBankKonten();
          }
        }
      );
    }
  });

  // Page visibility: cek reminder saat tab aktif kembali
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.bankKonten?.length) checkBankKontenReminders();
  });

  /* ── GitHub sync ────────────────────────────────────────────── */
  $('btnGitSync')?.addEventListener('click', () => { clearDataCache(); loadAllData(true); });

  /* ── Expose globals for inline onclick ─────────────────────── */
  window.closePantun    = closePantun;
  window.toggleTodo     = toggleTodo;
  window.deleteTodo     = deleteTodo;
  window.editContent    = editContent;
  window.deleteContent  = deleteContent;
  window.selectUrlAcct  = selectUrlAcct;
  window.renderPlanner  = renderPlanner;
  window.deleteUser     = deleteUser;
  window.switchStatAcct     = switchStatAcct;
  window.switchStatPlat     = switchStatPlat;
  window.openStatEdit       = openStatEdit;
  window.navigate           = navigate;
  window.renderNewPostForm  = renderNewPostForm;
  window.updateContentField = updateContentField;
  window.setKpiPeriod       = setKpiPeriod;
  window.previewContent     = previewContent;
  window.closeCntPreview    = closeCntPreview;
  window.renderActivity       = renderActivity;
  window.editUser             = editUser;
  window.saveEditUser         = saveEditUser;
  window.startEditTodo        = startEditTodo;
  window.saveWaTokenFromForm  = saveWaTokenFromForm;
  window.updateTopSlot        = updateTopSlot;
  window.saveTopContent       = saveTopContent;
  window.switchTop3Month      = switchTop3Month;
  window.generateShareLink    = generateShareLink;

  /* ── INIT: Check for ?access= shared link from admin ───────── */
  const _urlParams = new URLSearchParams(window.location.search);
  const _accessB64 = _urlParams.get('access');
  if (_accessB64) {
    try {
      const _cfg = JSON.parse(atob(_accessB64));
      if (_cfg.owner && _cfg.repo && _cfg.pat) {
        window.db.saveConfig(_cfg);
        // Remove ?access= from URL bar (no reload)
        history.replaceState(null, '', window.location.pathname + window.location.hash);
      }
    } catch {}
  }

  /* ── INIT: Pre-configure dengan default repo jika belum ada config ── */
  if (!window.db.isConfigured()) {
    window.db.saveConfig(DEFAULT_REPO);  // tanpa PAT — hanya untuk baca repo public
  }

  /* ── INIT: Auth flow ────────────────────────────────────────── */
  if (isFirstRun()) {
    // Coba ambil admin hash dari GitHub settings (berhasil jika repo public)
    try {
      const _s = await window.db.readData('settings');
      if (_s?.adminHash) {
        saveAuth({ adminName: _s.adminName || 'Admin', adminHash: _s.adminHash });
        setPubUsers(_s.users || []);
        showLogin();
      } else {
        // Repo ada tapi belum ada admin — instalasi pertama
        showWizard('new');
      }
    } catch {
      // Tidak bisa baca settings (rate limit / private repo) — tetap tampilkan login
      showLogin();
    }
  } else if (!isLoggedIn()) {
    // Returning visit, no active session — show login
    showLogin();
  } else {
    // Active session — enter app normally
    applyAuthState();
    handleHash();
    if (window.db.isConfigured()) setTimeout(loadAllData, 100);
  }

  /* ── Topbar "Setup GitHub" — klik untuk buka connect form ─── */
  $('topbarUser')?.addEventListener('click', () => {
    if (!isLoggedIn()) showWizard();
  });
});

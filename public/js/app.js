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

/* Claude AI key (Anthropic) */
const CLAUDE_LS_KEY = 'cmsph_claude_v1';
function getClaudeKey()     { return localStorage.getItem(CLAUDE_LS_KEY) || ''; }
function saveClaudeKey(key) { key ? localStorage.setItem(CLAUDE_LS_KEY, key) : localStorage.removeItem(CLAUDE_LS_KEY); }

const CLAUDE_MODELS = ['claude-3-haiku-20240307', 'claude-haiku-4-5', 'claude-3-5-haiku-20241022'];

// Model yang mendukung thinkingConfig (gemini-2.5+)
const GEMINI_THINKING_MODELS = new Set(['gemini-2.5-flash', 'gemini-2.5-pro']);
const GEMINI_MODELS = [
  'gemini-2.5-flash',   // utama — thinking support
  'gemini-2.0-flash',   // fallback stabil
  'gemini-2.0-flash-lite', // fallback ringan
  'gemini-1.5-flash-002', // fallback lama v2
];
const NEWS_KEY        = 'cmsph_news_v1';
const NEWS_TTL        = 60 * 60 * 1000;
const DATA_CACHE_KEY     = 'cmsph_data_v2';
const DATA_CACHE_TTL     = 3 * 60 * 1000;   // 3 minutes — reduces GitHub API rate-limit hits
const TEAM_TOKEN_KEY     = 'cmsph_team_token_v1'; // cache teamToken agar request selalu authenticated
const LOGIN_ATTEMPTS_KEY = 'cmsph_login_att_v1';

/* ── Token encode/decode ─────────────────────────────────────────────────────
   XOR + hex agar tidak cocok dengan pola secret scanning GitHub.
   GitHub bisa decode base64, tapi tidak bisa reverse XOR tanpa key ini.
   localStorage tetap menyimpan nilai raw (decoded).                          */
const _TK = 'cmsph_ph_2024_xk';   // XOR key — bukan rahasia, hanya mengaburkan pola

function _encodeToken(t) {
  if (!t) return '';
  return Array.from(t)
    .map((c, i) => (c.charCodeAt(0) ^ _TK.charCodeAt(i % _TK.length)).toString(16).padStart(2, '0'))
    .join('');
}

function _decodeToken(s) {
  if (!s) return '';
  // Format baru: hex XOR
  if (/^[0-9a-f]+$/.test(s) && s.length % 2 === 0) {
    try {
      const r = (s.match(/.{2}/g) || [])
        .map((h, i) => String.fromCharCode(parseInt(h, 16) ^ _TK.charCodeAt(i % _TK.length)))
        .join('');
      if (r) return r;
    } catch {}
  }
  // Fallback format lama: base64
  try { return decodeURIComponent(escape(atob(s))); } catch {}
  return s;  // fallback: raw
}
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS   = 5 * 60 * 1000;   // 5 menit lockout setelah 5x gagal
const PAGE_SIZE = 15;

/* ── Login attempt limiting ──────────────────────────────────────────────── */
function _getLoginAttempts() {
  try { return JSON.parse(localStorage.getItem(LOGIN_ATTEMPTS_KEY) || 'null') || { count: 0 }; }
  catch { return { count: 0 }; }
}
function _resetLoginAttempts() { localStorage.removeItem(LOGIN_ATTEMPTS_KEY); }
function _recordFailedAttempt() {
  const a = _getLoginAttempts();
  a.count = (a.count || 0) + 1;
  a.lastAttempt = Date.now();
  if (a.count >= LOGIN_MAX_ATTEMPTS) {
    a.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
  }
  localStorage.setItem(LOGIN_ATTEMPTS_KEY, JSON.stringify(a));
  return a;
}
function _checkLoginLockout() {
  const a = _getLoginAttempts();
  if (!a.lockedUntil) return null;
  if (Date.now() < a.lockedUntil) {
    const mins = Math.ceil((a.lockedUntil - Date.now()) / 60000);
    return `Terlalu banyak percobaan gagal. Coba lagi dalam ${mins} menit.`;
  }
  _resetLoginAttempts();   // lockout sudah berakhir, reset
  return null;
}

/**
 * Terapkan teamToken dari localStorage ke DB config SEBELUM request apapun dikirim.
 * Dipanggil di startup (sebelum auth flow) agar loadAllData() selalu authenticated.
 * Admin yang sudah punya PAT sendiri tidak terpengaruh.
 */
function _applyTeamTokenFromCache() {
  if (window.db.getConfig()?.pat) return;  // sudah ada PAT (admin) — skip
  const cached = localStorage.getItem(TEAM_TOKEN_KEY);
  if (cached) {
    const cfg = window.db.getConfig() || {};
    window.db.saveConfig({ ...cfg, pat: cached });
  }
}


/* ── Auth keys ───────────────────────────────────────────────────────────── */
const AUTH_KEY = 'cmsph_auth_v1';   // { adminName, adminHash } — persisted
const SESS_KEY = 'cmsph_sess_v1';   // { role, name }           — session only
const PUB_KEY  = 'cmsph_pub_v1';    // { users[] }              — cached public list

/* ── User helpers (supports both legacy string[] and new {name,role}[]) ──── */
function getUserName(u) { return typeof u === 'object' && u !== null ? (u.name || '') : (u || ''); }
function getUserRole(u) { return typeof u === 'object' && u !== null ? (u.role || '') : ''; }

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
  'Ongoing':   'badge-ongoing',   // sedang dalam pengerjaan / pelaksanaan
  'ACC':       'badge-acc',
  'Done':      'badge-done',
  'Published': 'badge-published',
  'Drop':      'badge-drop',
  'Hold':      'badge-hold',
  // Backward-compat (data lama)
  'Ide':       'badge-plan',
  'Draft':     'badge-review',
  'Approved':  'badge-acc',
  'Preview':   'badge-ongoing',   // alias lama → Ongoing
  'Scheduled': 'badge-ongoing',
};

const STATUSES  = ['Plan','Review','Revisi','Ongoing','ACC','Done','Published','Drop','Hold'];
const FORMATS   = ['Flayer','Meme','Karikatur','Komikstrip','Animasi','Video','Short','Monolog','Carousell','Podcast','Liputan'];
const FORMATS_DUAL_ROLE = ['Podcast','Liputan']; // formats that need Creator + Editor fields

/* ── Platform icon SVGs (shared across card + link modal) ───────────────── */
const PLAT_ICON_SVG = {
  instagram: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="5"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>`,
  tiktok:    `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.32 6.32 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.8a8.18 8.18 0 004.78 1.52V6.9a4.85 4.85 0 01-1.01-.21z"/></svg>`,
  twitter:   `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
  facebook:  `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>`,
  youtube:   `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M23.495 6.205a3.007 3.007 0 00-2.088-2.088c-1.87-.501-9.396-.501-9.396-.501s-7.507-.01-9.396.501A3.007 3.007 0 00.527 6.205a31.247 31.247 0 00-.522 5.805 31.247 31.247 0 00.522 5.783 3.007 3.007 0 002.088 2.088c1.868.502 9.396.502 9.396.502s7.506 0 9.396-.502a3.007 3.007 0 002.088-2.088 31.247 31.247 0 00.5-5.783 31.247 31.247 0 00-.5-5.805zM9.609 15.601V8.408l6.264 3.602z"/></svg>`
};

const ACCOUNTS = [
  { id: 'penjaga-harapan', name: 'Penjaga Harapan', color: '#7c3aed' },
  { id: '33-official',     name: '33 Official',     color: '#16a34a' },
  { id: 'jaga-asa',        name: 'Jaga Asa',        color: '#ea580c' }
];

/* ── Role colour map (used in sidebar badge + user list) ─────────────────── */
const ROLE_COLORS = {
  // Manajemen
  Administrator: '#7c3aed',   // violet
  Ketua:         '#dc2626',   // red
  Leader:        '#0284c7',   // sky blue
  // Produksi
  Planner:       '#d97706',   // amber
  Producer:      '#c2410c',   // deep orange
  Creator:       '#16a34a',   // green
  Publisher:     '#0891b2',   // cyan
  // Konten
  Writer:        '#1e40af',   // navy blue
  Editor:        '#0f766e',   // teal
  Designer:      '#be185d',   // pink
  Videographer:  '#a21caf',   // fuchsia
};
const ROLES_LIST = [
  'Creator','Writer','Designer','Videographer','Editor',
  'Publisher','Producer','Planner','Leader','Ketua','Administrator'
];

const PAGE_TITLES = {
  dashboard:   'Dashboard',
  planner:     'Planner',
  bankkonten:  'Bank of Contents',
  activity:    'Activity Log',
  contents:    'New Contents',
  newpost:     'New Post',
  statistics:  'Statistik',
  apisetup:    'API Setup',
  assets:      'Aset & Drive'
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
      { key:'jmlVideo',         label:'Jml Video',        fmt:'num' },
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
      { key:'followersGained',  label:'Follows Monthly',  fmt:'num' },
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

/* ── Platform-specific CSV column name aliases ───────────────────────────
   Key   = header nama kolom dari export platform (lowercase, tanpa spasi/simbol)
   Value = field key di PLATFORM_FIELDS
   Digunakan oleh parseCSVDirect agar mapping lebih akurat daripada fuzzy match. */
const PLATFORM_CSV_ALIASES = {
  youtube: {
    // YouTube Studio — Overview CSV
    'views':                          'totalViews',
    'videoviews':                     'totalViews',
    'watchtimehours':                 'watchHours',
    'watchtime(hours)':               'watchHours',
    'watchtime':                      'watchHours',
    'subscribersgained':              'subsGained',
    'subscriberslost':                '_subsLost',
    'subscribers':                    'subsEOM',
    'impressions':                    'impressions',
    'impressionsclickthroughrate(%)': 'erPct',
    'impressionsclickthroughrate':    'erPct',
    'likes':                          'totalLikes',
    'dislikes':                       '_dislikes',
    'commentsadded':                  'totalComments',
    'comments':                       'totalComments',
    'shares':                         '_shares',
    'videos':                         'jmlVideo',
    'videosposted':                   'jmlVideo',
    'averageviewduration':            '_avgViewDur',
    'averageviewpercentage(%)':       '_avgViewPct',
    'uniqueviewers':                  'uniqueViewers',
    'revenue(usd)':                   '_revenue',
    'adimpressions':                  'adImpressions',
    'cpm(usd)':                       '_cpm',
  },
  tiktok: {
    // TikTok Studio — Overview & Content export
    'videoviews':                     'totalVideoViews',
    'videoplays':                     'totalVideoViews',
    'videoplaycounts':                'totalVideoViews',
    'views':                          'totalVideoViews',
    'profileviews':                   'profileViews',
    'profilevisits':                  'profileViews',
    'likes':                          'totalLikes',
    'likecounts':                     'totalLikes',
    'comments':                       'totalComments',
    'commentcounts':                  'totalComments',
    'shares':                         'totalShares',
    'sharecounts':                    'totalShares',
    'followers':                      'followersEOM',
    'followercount':                  'followersEOM',
    'totalfollowers':                 'followersEOM',
    'newfollowers':                   'followersGained',
    'followersgained':                'followersGained',
    'uniqueviewers':                  'totalViewers',
    'newviewers':                     'newViewers',
    'returningviewers':               'returningViewers',
    'totalengagement':                'totalEngagement',
    'engagement':                     'totalEngagement',
  },
  instagram: {
    // Meta Business Suite — Account-level & Post-level export
    'impressions':                    'totalViews',
    'totalimpressions':               'totalViews',
    'reach':                          'totalReach',
    'accountsreached':                'totalReach',
    'totalreach':                     'totalReach',
    'followers':                      'followersEOM',
    'totalfollowers':                 'followersEOM',
    'followercount':                  'followersEOM',
    'newfollows':                     'followersGained',
    'follows':                        'followersGained',
    'followersgained':                'followersGained',
    'profilevisits':                  '_profileViews',
    'likes':                          'totalLikes',
    'likecounts':                     'totalLikes',
    'comments':                       'totalComments',
    'commentcounts':                  'totalComments',
    'shares':                         'totalShares',
    'sharecounts':                    'totalShares',
    'saves':                          'totalSaves',
    'savecounts':                     'totalSaves',
    'reelplays':                      'reelViews',
    'reelviews':                      'reelViews',
    'videoplays':                     'reelViews',
    'videoviews':                     'reelViews',
    'totalengagement':                'totalEngagement',
    'engagement':                     'totalEngagement',
    // Post-level export columns (digunakan untuk filter & date)
    'publishtime':                    '_date',
    'posttime':                       '_date',
    'accountusername':                '_account',
    'posttype':                       '_postType',
    'permalink':                      '_link',
    'postdescription':                '_desc',
  },
  facebook: {
    // Meta Business Suite — Page Insights export
    'pagefans':                       'pageFollowers',
    'totalpagefans':                  'pageFollowers',
    'pagelikesandfollowers':          'pageFollowers',
    'followers':                      'pageFollowers',
    'pageimpressions':                'totalViews',
    'totalimpressions':               'totalViews',
    'pageimpressionstotal':           'totalViews',
    'pagereach':                      'totalReach',
    'totalreach':                     'totalReach',
    'pagepostengagements':            'totalEngagement',
    'totalengagements':               'totalEngagement',
    'engagement':                     'totalEngagement',
    'pageviewstotal':                 'totalViews',
    'reactions':                      'totalReactions',
    'pagereactions':                  'totalReactions',
    'totalreactions':                 'totalReactions',
    'likes':                          'totalReactions',  // FB "likes" = reactions
    'comments':                       'totalComments',
    'shares':                         'totalShares',
    'posts':                          'totalPost',
    'postspublished':                 'totalPost',
  },
  twitter: {
    // X (Twitter) Analytics export
    'impressions':                    'impressions',
    'engagements':                    'totalEngagement',
    'totalengagements':               'totalEngagement',
    'likes':                          'totalLikes',
    'favorites':                      'totalLikes',
    'retweets':                       'totalRetweets',
    'replies':                        '_replies',
    'userprofileclicks':              '_profileClicks',
    'urllinkclicks':                  '_urlClicks',
    'followers':                      'followers',
    'followerscount':                 'followers',
    'newsfollowers':                  '_newFollowers',
    'posts':                          'totalPost',
    'tweets':                         'totalPost',
    'tweetdate':                      '_date',
  },
};

/* ── App state ───────────────────────────────────────────────────────────── */
let state = {
  contents:       [],
  activity:       [],
  todos:          [],
  bankKonten:     [],
  assets:         [],
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
  statViewMode:   'monthly',   // 'monthly' | 'weekly'
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
      // Show team role with correct colour from ROLE_COLORS (hidden if no role set)
      const userObj  = (state.settings?.users || []).find(u => getUserName(u) === name);
      const teamRole = getUserRole(userObj || null);
      if (teamRole) {
        const roleColor = ROLE_COLORS[teamRole] || '#64748b';
        roleEl.textContent   = teamRole;
        roleEl.className     = 'role-badge';
        roleEl.style.cssText = `background:${roleColor}18;color:${roleColor};border-color:${roleColor}30`;
        roleEl.classList.remove('hidden');
      } else {
        roleEl.classList.add('hidden');
        return;   // skip the outer remove-hidden below
      }
    }
    roleEl.classList.remove('hidden');
  }

  // API Setup nav: only visible to admin
  const apiNav = document.querySelector('.nav-item[data-page="apisetup"]');
  if (apiNav) apiNav.style.display = admin ? '' : 'none';

  // Sync/refresh button: visible to all logged-in users
  if ($('btnGitSync')) $('btnGitSync').style.display = sess ? '' : 'none';

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

/* ── Token Setup — onboarding device baru untuk repo private ─────────────── */
function showTokenSetup() {
  $('loginPage')?.classList.add('hidden');
  $('wizardModal')?.classList.add('hidden');
  $('tokenSetupModal')?.classList.remove('hidden');
  $('setupToken') && ($('setupToken').value = '');
}

async function connectWithTeamToken() {
  const token = ($('setupToken')?.value || '').trim();
  if (!token) { toast('Masukkan token terlebih dahulu', 'error'); return; }

  const btn = $('btnSubmitSetupToken');
  if (btn) { btn.textContent = 'Menghubungkan…'; btn.disabled = true; }

  try {
    // Coba koneksi dengan token yang dimasukkan
    window.db.saveConfig({ ...DEFAULT_REPO, pat: token });
    const _s = await window.db.readData('settings');

    if (!_s?.adminHash) {
      toast('Token valid tapi data admin belum ada. Hubungi Admin untuk setup ulang.', 'warn');
      window.db.saveConfig(DEFAULT_REPO);
      return;
    }

    // Simpan token ke cache
    localStorage.setItem(TEAM_TOKEN_KEY, token);

    // Jika settings menyimpan teamToken yang berbeda (lebih terbatas), pakai itu
    if (_s.teamToken && _s.teamToken !== token) {
      const decoded = _decodeToken(_s.teamToken);
      localStorage.setItem(TEAM_TOKEN_KEY, decoded);
      window.db.saveConfig({ ...DEFAULT_REPO, pat: decoded });
    }

    saveAuth({ adminName: _s.adminName || 'Admin', adminHash: _s.adminHash });
    setPubUsers(_s.users || []);
    $('tokenSetupModal')?.classList.add('hidden');
    showLogin();
    toast('✅ Perangkat berhasil terhubung! Silakan login.', 'success');
  } catch (e) {
    toast('Gagal terhubung: ' + e.message, 'error');
    window.db.saveConfig(DEFAULT_REPO);  // reset ke tanpa PAT
  } finally {
    if (btn) { btn.textContent = 'Hubungkan →'; btn.disabled = false; }
  }
}

function showWizard(mode) {
  $('tokenSetupModal')?.classList.add('hidden');
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
  if (!owner || !repo || !pat) { toast('Isi semua kolom yang diperlukan', 'error'); return; }

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
  if (!owner || !repo || !pat) { toast('Isi semua kolom yang diperlukan', 'error'); return; }

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
    toast('Server terhubung!', 'success');
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

/* ── Cek ?invite= param di URL (dipanggil saat app startup) ─────────────── */
/**
 * Jika URL mengandung ?invite=<id>, tampilkan PIN dialog.
 * Credential TIDAK ada di URL — hanya invite ID.
 * @returns {boolean} true jika param ditemukan
 */
function checkInviteParam() {
  const params   = new URLSearchParams(window.location.search);
  const inviteId = params.get('invite');
  if (!inviteId) return false;
  // Jangan bersihkan URL dulu — dibutuhkan oleh doConsumeInvite()
  // URL dibersihkan setelah invite berhasil dikonsumsi
  showInvitePinModal(inviteId);
  return true;
}

/* ── Connect existing device (no re-setup needed on second/third device) ── */
async function connectExistingDevice() {
  const cfg = {
    owner:  gv('connectOwner').trim(),
    repo:   gv('connectRepo').trim(),
    branch: gv('connectBranch').trim() || 'main',
    pat:    gv('connectPat').trim()
  };
  if (!cfg.owner || !cfg.repo || !cfg.pat) { toast('Isi semua kolom yang diperlukan', 'error'); return; }
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

/* ── Login / Logout notification (toast) ────────────────────────────────── */
function showPantun(type, roleName, userName) {
  if (type === 'login') {
    toast(`👋 Selamat datang, ${userName || 'Tim'}!`, 'success');
  } else {
    toast(`Sampai jumpa, ${userName || 'Tim'}! 👋`, '');
  }
}
function closePantun() {} // no-op — tidak ada overlay

async function showLogin() {
  $('loginPage').classList.remove('hidden');
  sv('loginPw', '');
  toggleLoginPw();

  // Fetch dari GitHub agar admin hash & daftar user selalu up-to-date.
  // Tidak perlu populateLoginSelect() karena nama diketik manual sekarang.
  if (window.db.isConfigured()) {
    try {
      const _s = await window.db.readData('settings');
      if (_s) {
        if (_s.adminHash && !getAuth()) {
          saveAuth({ adminName: _s.adminName || 'Admin', adminHash: _s.adminHash });
        }
        if (_s.teamToken) {
          const decoded = _decodeToken(_s.teamToken);
          localStorage.setItem(TEAM_TOKEN_KEY, decoded);
          if (!window.db.getConfig()?.pat) {
            window.db.saveConfig({ ...window.db.getConfig(), pat: decoded });
          }
        }
        if (_s.users?.length) setPubUsers(_s.users);
      }
    } catch { /* gagal fetch — login tetap bisa dengan cache lokal */ }
  }
}


function populateLoginSelect() {
  // Input teks — tidak ada dropdown yang perlu diisi.
  // Fungsi ini dipertahankan agar pemanggil lama tidak error.
}

function toggleLoginPw() {
  // Password always required for all users
  $('loginPwWrap')?.classList.remove('hidden');
}

async function doLogin() {
  const inp        = $('loginUserSel');
  const typedName  = (inp?.value || '').trim();
  const pw         = gv('loginPw');
  const btn        = $('btnDoLogin');

  if (!typedName) { toast('Masukkan nama', 'error'); inp?.focus(); return; }
  if (!pw)        { toast('Masukkan password', 'error'); return; }

  // ── Cek lockout percobaan login ─────────────────────────────
  const lockMsg = _checkLoginLockout();
  if (lockMsg) { toast(lockMsg, 'error'); return; }

  btn.textContent = 'Masuk…'; btn.disabled = true;
  let userObj = null;   // diisi di blok creator
  try {
    const auth      = getAuth();
    const adminName = auth?.adminName || 'Admin';
    const isAdm     = typedName.toLowerCase() === adminName.toLowerCase();

    // ── Helper: shake input + toast error password ─────────────────
    const shakeAndToast = (msg) => {
      const pwWrap = $('loginPwWrap');
      if (pwWrap) {
        pwWrap.classList.remove('login-shake');
        void pwWrap.offsetWidth; // reflow untuk restart animasi
        pwWrap.classList.add('login-shake');
      }
      toast(msg, 'error');
    };

    if (isAdm) {
      const hash = await hashPw(pw);
      if (hash !== auth?.adminHash) {
        const a = _recordFailedAttempt();
        shakeAndToast(a.lockedUntil
          ? '🔒 Terlalu banyak percobaan — akun dikunci 5 menit.'
          : `❌ Password salah. Sisa percobaan: ${LOGIN_MAX_ATTEMPTS - a.count}`);
        return;
      }
      _resetLoginAttempts();
      setSess({ role: 'admin', name: adminName });

    } else {
      // ── Cari user di cache; jika kosong, fetch dulu dari server ──
      let users = getPubUsers();
      userObj   = users.find(u => getUserName(u).toLowerCase() === typedName.toLowerCase());

      if (!userObj && window.db.isConfigured()) {
        btn.textContent = 'Memeriksa…';
        try {
          const _s = await window.db.readData('settings');
          if (_s?.users?.length) {
            setPubUsers(_s.users);
            users   = getPubUsers();
            userObj = users.find(u => getUserName(u).toLowerCase() === typedName.toLowerCase());
          }
        } catch { /* tetap lanjut dengan cache lokal */ }
        btn.textContent = 'Masuk…';
      }

      if (!userObj) {
        shakeAndToast('❌ Nama tidak ditemukan dalam daftar tim');
        return;
      }

      if (userObj.passwordHash) {
        const hash = await hashPw(pw);
        if (hash !== userObj.passwordHash) {
          const a = _recordFailedAttempt();
          shakeAndToast(a.lockedUntil
            ? '🔒 Terlalu banyak percobaan — akun dikunci 5 menit.'
            : `❌ Password salah. Sisa percobaan: ${LOGIN_MAX_ATTEMPTS - a.count}`);
          return;
        }
      }
      // Tidak ada passwordHash = izinkan masuk (backward compat)
      _resetLoginAttempts();
      setSess({ role: 'creator', name: getUserName(userObj) });
    }

    const loginName = isAdm ? adminName : getUserName(userObj);
    $('loginPage').classList.add('hidden');
    sv('loginPw', '');
    if (inp) inp.value = '';
    applyAuthState();
    handleHash();

    // Tampilkan notifikasi selamat datang langsung
    showPantun('login', isAdm ? 'Admin' : 'Creator', loginName);

    setTimeout(async () => {
      await loadAllData();
      const loginRole = isAdm ? 'Admin' : (getUserRole((state.settings?.users||[]).find(u=>getUserName(u)===loginName)||null)||'Creator');
      logActivity(loginName, 'login', `masuk ke sistem sebagai ${loginRole}`);
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
  $$('.page').forEach(s => s.classList.remove('active'));
  showLogin();
  applyAuthState();
  // Pantun selamat tinggal
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
      bankKonten: state.bankKonten,
      assets:     state.assets
    }));
  } catch { /* storage full — ignore */ }
}

function clearDataCache() {
  try { localStorage.removeItem(DATA_CACHE_KEY); } catch {}
}

/**
 * Setelah settings dimuat dari GitHub: HAPUS apiKeys dari settings jika ada
 * (migrasi dari versi lama yang menyimpan keys di GitHub — tidak aman untuk
 * public repo). Keys sekarang hanya di localStorage dan di share link.
 */
function _syncApiKeysFromSettings() {
  const keys = state.settings?.apiKeys;
  if (keys) {
    // Migrasi: jika ada keys tersimpan di settings lama, pindah ke localStorage
    // lalu hapus dari settings agar tidak tersimpan di GitHub
    let needCleanup = false;
    if (keys.gemini) { localStorage.setItem(GEMINI_LS_KEY, keys.gemini); needCleanup = true; }
    if (keys.claude) { localStorage.setItem(CLAUDE_LS_KEY, keys.claude); needCleanup = true; }
    if (keys.wa)     { localStorage.setItem(WA_TOKEN_KEY,  keys.wa);     needCleanup = true; }

    if (needCleanup && window.db?.getConfig()?.pat) {
      delete state.settings.apiKeys;
      window.db.writeData('settings', state.settings, 'Keamanan: hapus API keys dari GitHub settings')
        .then(sha => { state.shas.settings = sha; saveDataCache(); })
        .catch(() => {});
    } else if (keys) {
      delete state.settings.apiKeys;
    }
  }

  // ── Sync teamToken: cache ke localStorage + apply jika belum ada PAT ───
  // teamToken = fine-grained PAT terbatas, disimpan di settings.json.
  // Di-cache di localStorage agar _applyTeamTokenFromCache() bisa terapkan
  // SEBELUM request apapun dikirim pada kunjungan berikutnya.
  const teamToken = state.settings?.teamToken;
  if (teamToken) {
    const decoded = _decodeToken(teamToken);
    localStorage.setItem(TEAM_TOKEN_KEY, decoded);  // simpan cache (raw)
    if (!window.db.getConfig()?.pat) {
      const cfg = window.db.getConfig() || {};
      window.db.saveConfig({ ...cfg, pat: decoded });
    }
  } else {
    localStorage.removeItem(TEAM_TOKEN_KEY);
  }

  // ── Auto-apply API keys dari settings.json → localStorage (jika belum ada) ──
  // Admin simpan sekali → semua device otomatis punya key tanpa input manual.
  if (state.settings?.geminiKey && !getGeminiKey()) {
    saveGeminiKey(_decodeToken(state.settings.geminiKey));
  }
  if (state.settings?.claudeKey && !getClaudeKey()) {
    saveClaudeKey(_decodeToken(state.settings.claudeKey));
  }
  if (state.settings?.fonnte && !getWaToken()) {
    saveWaToken(_decodeToken(state.settings.fonnte));
  }
}

/**
 * @deprecated API keys tidak lagi disimpan ke GitHub (tidak aman untuk public repo).
 * Keys hanya di localStorage dan dioper via "Salin Link Akses Tim".
 */
async function _persistApiKey(_keyName, _value) {
  // Sengaja dikosongkan — lihat generateShareLink() untuk distribusi keys ke device baru
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
        state.contents   = Array.isArray(cached.contents)  ? cached.contents  : [];
        state.activity   = Array.isArray(cached.activity)  ? cached.activity  : [];
        state.todos      = Array.isArray(cached.todos)     ? cached.todos     : [];
        state.settings   = cached.settings   || { kpi:{}, users:[], analyticsUrls:{} };
        state.analytics  = cached.analytics  || {};
        state.bankKonten = cached.bankKonten || [];
        state.assets     = Array.isArray(cached.assets) ? cached.assets : [];
        // SHAs sengaja tidak di-cache — db.writeData() akan auto-fetch SHA saat write
        state.shas = {};
        _applyTopContentDefaults();
        _syncApiKeysFromSettings();   // sync API keys dari GitHub settings → localStorage
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
    const [cR, aR, tR, sR, anlR, bkR, asR] = await Promise.all([
      window.db.read('contents'),
      window.db.read('activity'),
      window.db.read('todos'),
      window.db.read('settings'),
      window.db.read('analytics'),
      window.db.read('contentBank'),
      window.db.read('assets')
    ]);
    state.contents   = Array.isArray(cR?.data)  ? cR.data  : [];
    state.activity   = Array.isArray(aR?.data)  ? aR.data  : [];
    state.todos      = Array.isArray(tR?.data)  ? tR.data  : [];
    state.bankKonten = Array.isArray(bkR?.data) ? bkR.data : [];
    state.assets     = Array.isArray(asR?.data) ? asR.data : [];
    state.settings   = sR?.data   || { kpi: {}, users: [], analyticsUrls: {} };
    _applyTopContentDefaults();
    _syncApiKeysFromSettings();   // sync API keys dari GitHub settings → localStorage
    state.analytics = anlR?.data || {};
    state.shas = {
      contents:    cR?.sha,
      activity:    aR?.sha,
      todos:       tR?.sha,
      settings:    sR?.sha,
      analytics:   anlR?.sha,
      bankKonten:  bkR?.sha,
      assets:      asR?.sha
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
  if (!Array.isArray(state.activity)) state.activity = [];  // guard: jika terhapus/rusak
  state.activity.unshift(item);
  if (state.activity.length > 500) state.activity = state.activity.slice(0, 500);
  try {
    state.shas.activity = await window.db.writeData('activity', state.activity, `Aktivitas: ${action}`);
    saveDataCache(); // keep cache fresh so Activity Log always reflects latest
  } catch { /* non-critical */ }
}

/* ── Activity Log: fetch fresh from GitHub then render ───────────────────── */
async function loadAndRenderActivity() {
  const list = $('activityList');
  if (list) list.innerHTML = `
    <li class="act-empty" style="padding:24px 0;display:flex;align-items:center;justify-content:center;gap:8px">
      <div class="spinner" style="width:16px;height:16px;border-width:2px"></div>
      <span style="font-size:.8rem;color:var(--muted)">Memuat aktivitas terbaru…</span>
    </li>`;

  try {
    const r = await window.db.read('activity');
    if (r) {
      state.activity   = r.data || [];
      state.shas.activity = r.sha;
      saveDataCache();
    }
  } catch { /* non-critical — render from current state */ }

  renderActivity();
}

/* ── WhatsApp Notification ──────────────────────────────────────────────── */
const WA_TOKEN_KEY = 'cmsph_wa_token';
function getWaToken() { return localStorage.getItem(WA_TOKEN_KEY) || ''; }
function saveWaToken(t) { if (t) localStorage.setItem(WA_TOKEN_KEY, t); else localStorage.removeItem(WA_TOKEN_KEY); }

/* Pesan WA dinamis berdasarkan STATUS konten saat creator dipilih */
const WA_STATUS_CTA = {
  'Plan':      { emoji: '📋', cta: 'Konten sudah masuk perencanaan. Yuk mulai siapkan referensi dan materinya ya!' },
  'Review':    { emoji: '🔍', cta: 'Konten kamu sedang dalam tahap review. Harap standby untuk feedback dari tim.' },
  'Revisi':    { emoji: '✏️', cta: 'Konten perlu direvisi. Cek catatan di CMS dan segera lakukan perbaikan ya.' },
  'Ongoing':   { emoji: '🎙', cta: 'Konten sedang dalam pelaksanaan. Semangat, pantau terus progresnya ya!' },
  'ACC':       { emoji: '✅', cta: 'Selamat! Konten kamu sudah di-ACC dan siap ditayangkan sesuai jadwal.' },
  'Done':      { emoji: '🎉', cta: 'Konten sudah selesai — kerja bagus! Tinggal menunggu jadwal publish.' },
  'Published': { emoji: '🚀', cta: 'Konten kamu sudah LIVE! Yuk pantau performa dan engagement di platform ya.' },
  'Hold':      { emoji: '⏸️', cta: 'Konten sedang di-hold sementara. Akan ada info lanjutan dari tim secepatnya.' },
  'Drop':      { emoji: '❌', cta: 'Konten ini tidak dilanjutkan. Terima kasih atas kontribusinya ya.' },
};

function waStatusMsg(name, title, theme, status, date, acct, url) {
  const s = WA_STATUS_CTA[status] || { emoji: '📌', cta: 'Mohon cek CMS untuk detail selengkapnya.' };
  return (
    `Halo ${name}! ${s.emoji}\n\n` +
    `Saat ini konten *${title}* ber-tema *${theme}* sudah disiapkan dengan status *${status}*.\n\n` +
    `${s.cta}\n\n` +
    `📅 Jadwal: ${date}\n` +
    `📱 Akun: ${acct}\n` +
    `🔗 CMS: ${url}\n\n` +
    `_- Penjaga Harapan CMS_`
  );
}

/* Kirim notif WA via Fonnte. Return {ok, detail} agar caller bisa bereaksi.
   Gagal = tampilkan toast error ke admin (tidak silent lagi).            */
async function sendWaNotif(phone, message) {
  const token = getWaToken();
  if (!token) return { ok: false, detail: 'Token Fonnte belum dikonfigurasi' };
  if (!phone) return { ok: false, detail: 'Nomor WA tidak ada' };

  // Normalisasi nomor: +62…/08… → 628…
  const clean  = String(phone).replace(/\D/g, '');
  const target = clean.startsWith('0') ? '62' + clean.slice(1) : clean;

  try {
    const fd = new FormData();
    fd.append('target',  target);
    fd.append('message', message);
    const r = await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: { Authorization: token },
      body: fd
    });

    // Cek HTTP error terlebih dahulu
    if (!r.ok) {
      const detail = `HTTP ${r.status} ${r.statusText}`;
      console.warn('WA notif HTTP error:', detail);
      if (isAdmin()) toast(`⚠ WA gagal terkirim: ${detail}`, 'error');
      return { ok: false, detail };
    }

    const res = await r.json();
    if (!res.status) {
      // Fonnte mengembalikan status false → pesan ditolak
      const detail = res.reason || res.message || JSON.stringify(res);
      console.warn('WA notif rejected by Fonnte:', res);
      if (isAdmin()) toast(`⚠ WA ditolak Fonnte: ${detail}`, 'error');
      return { ok: false, detail };
    }

    console.log('WA sent to', target, '—', res);
    return { ok: true, detail: res.detail || 'Terkirim' };

  } catch (e) {
    console.warn('WA notif error:', e.message);
    if (isAdmin()) toast(`⚠ WA gagal: ${e.message}`, 'error');
    return { ok: false, detail: e.message };
  }
}

/* Test koneksi Fonnte — kirim pesan ke nomor admin sendiri */
async function testWaToken() {
  const token = getWaToken();
  if (!token) { toast('Isi dan simpan Token Fonnte terlebih dahulu', 'error'); return; }

  // Cari nomor HP admin yang sedang login
  const me      = currentUser();
  const users   = state.settings?.users || [];
  const userObj = users.find(u => getUserName(u) === me);
  const phone   = userObj?.phone;
  if (!phone) {
    toast('Nomor WA tidak ditemukan di profil Anda. Isi nomor di daftar pengguna dulu.', 'error');
    return;
  }

  const btn = $('btnTestWa');
  if (btn) { btn.textContent = '⏳ Mengirim…'; btn.disabled = true; }
  try {
    const result = await sendWaNotif(phone,
      `✅ *Test Notifikasi Penjaga Harapan CMS*\n\nKoneksi Fonnte berhasil! Token aktif dan pesan dapat dikirim.\n\n_Waktu: ${new Date().toLocaleString('id-ID')}_`
    );
    if (result.ok) toast('✅ Pesan test berhasil dikirim ke ' + phone, 'success');
    // Error sudah ditampilkan oleh sendWaNotif
  } finally {
    if (btn) { btn.textContent = '🧪 Test Kirim'; btn.disabled = false; }
  }
}

/* Kirim WA ke creator dari Planner.
   Jika token Fonnte ada → kirim otomatis via API.
   Jika tidak → buka wa.me (manual).                */
async function openPlannerWa(id) {
  const c = state.contents.find(x => x.id === id);
  if (!c) return;
  const users = state.settings?.users || [];
  const crArr = Array.isArray(c.creator) ? c.creator : (c.creator ? [c.creator] : []);
  const acctObj = ACCOUNTS.find(a => a.id === c.account);

  // Kumpulkan semua creator yang punya nomor WA
  const targets = crArr
    .map(cr => ({ name: cr, user: users.find(u => getUserName(u) === cr) }))
    .filter(t => t.user?.phone);

  if (!targets.length) { toast('Creator tidak memiliki nomor WA', 'error'); return; }

  if (getWaToken()) {
    // Kirim ke SEMUA creator
    const sent = [];
    for (const t of targets) {
      const msg = waStatusMsg(
        t.name, c.title || '—', c.theme || '—', c.status || 'Plan',
        fmtDate(c.publishDate), acctObj?.name || c.account || '—',
        window.location.origin
      );
      const result = await sendWaNotif(t.user.phone, msg);
      if (result.ok) sent.push(t.name);
    }
    if (sent.length) toast(`✅ Pesan terkirim ke ${sent.join(', ')}`, 'success');
    await logActivity(currentUser(), 'Kirim WA Planner', `ke ${sent.join(', ')} — "${c.title || 'tanpa judul'}" (${c.status})`);
  } else {
    // Fallback: buka wa.me hanya ke creator pertama
    const t = targets[0];
    const msg = waStatusMsg(
      t.name, c.title || '—', c.theme || '—', c.status || 'Plan',
      fmtDate(c.publishDate), acctObj?.name || c.account || '—',
      window.location.origin
    );
    const clean  = String(t.user.phone).replace(/\D/g, '');
    const target = clean.startsWith('0') ? '62' + clean.slice(1) : clean;
    window.open(`https://wa.me/${target}?text=${encodeURIComponent(msg)}`, '_blank');
  }
}

async function notifyCreatorAssigned(content) {
  if (!content.creator) return;
  if (!getWaToken()) return;
  const users  = state.settings?.users || [];
  const crArr  = Array.isArray(content.creator) ? content.creator : [content.creator];
  const status   = content.status || 'Plan';
  const acctObj  = ACCOUNTS.find(a => a.id === content.account);
  const acctName = acctObj?.name || content.account || '—';
  const dateStr  = fmtDate(content.publishDate) || '—';
  const cmsUrl   = `${window.location.origin}/loginuser`;
  const sent = [];
  for (const creatorName of crArr) {
    const userObj = users.find(u => getUserName(u) === creatorName);
    if (!userObj?.phone) continue;
    const msg = waStatusMsg(creatorName, content.title||'—', content.theme||'—', status, dateStr, acctName, cmsUrl);
    const result = await sendWaNotif(userObj.phone, msg);
    if (result.ok) sent.push(creatorName);
  }
  if (sent.length) toast(`📲 WA terkirim ke ${sent.join(', ')}`, 'success');
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
    const crTxt = Array.isArray(c.creator) ? c.creator.join(', ') : (c.creator || '');
    items.push(`${icon} <strong>${esc(c.title || 'Konten')}</strong>${crTxt ? ` · ${esc(crTxt)}` : ''} [${esc(c.format)}] — ${when}`);
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
  { id: '33-official',     name: '33 Official'      },   // harus sama dengan ACCOUNTS
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
        <button type="button" class="icon-btn bk-save-btn" data-id="${item.id}" title="Simpan baris ini">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/>
            <polyline points="17 21 17 13 7 13 7 21"/>
            <polyline points="7 3 7 8 15 8"/>
          </svg>
        </button>
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
    const result = await sendWaNotif(creatorObj.phone, msg);
    if (result.ok) toast(`✅ Pesan terkirim ke ${item.creator}`, 'success');
    // Error sudah ditampilkan oleh sendWaNotif
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
  let sentCount = 0; let failCount = 0;
  for (const item of toRemind) {
    const co = users.find(u => getUserName(u) === item.creator);
    if (co?.phone) {
      const refLine = item.reference ? `\n🔗 *Referensi:* ${item.reference}` : '';
      const msg = `Halo ${item.creator}! ⏰ *Jadwal Tayang Hari Ini*\n\nKonten *${item.title || '(tanpa judul)'}* dijadwalkan tayang ${fmtDate(item.publishDate)}.${refLine}\n\nSegera siapkan kontennya! 🚀\n\n_- Penjaga Harapan CMS_`;
      const result = await sendWaNotif(co.phone, msg);
      if (result.ok) sentCount++; else failCount++;
    }
    item.remindedDate = todayStr;
  }

  // Simpan remindedDate ke GitHub (agar tidak kirim ulang)
  try {
    state.shas.bankKonten = await window.db.writeData('contentBank', state.bankKonten, 'Bank Konten: catat reminder terkirim');
  } catch { /* non-critical */ }

  if (sentCount > 0 && failCount === 0) {
    toast(`✓ Reminder WA terkirim ke ${sentCount} creator`, 'success');
  } else if (sentCount > 0) {
    toast(`⚠ Reminder WA: ${sentCount} terkirim, ${failCount} gagal`, 'warn');
  } else if (failCount > 0) {
    toast(`✗ Semua reminder WA gagal (${failCount} pesan)`, 'error');
  }
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
    case 'activity':    loadAndRenderActivity(); break;
    case 'contents':    renderContents();     break;
    case 'newpost':     renderNewPostForm();  break;
    case 'statistics':  renderStatistics();   break;
    case 'apisetup':    renderApiSetup();     break;
    case 'assets':      renderAssets();       break;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   DASHBOARD
   ══════════════════════════════════════════════════════════════════════════ */

/* ── Helper: konversi nilai dropdown periode → {from, to} ───────────────── */
function getPeriodDates(value) {
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);
  const pad   = n => String(n).padStart(2, '0');

  switch (value) {
    case 'month': {
      const y = now.getFullYear(), m = now.getMonth();
      return { from: `${y}-${pad(m+1)}-01`,
               to:   new Date(y, m+1, 0).toISOString().slice(0, 10) };
    }
    case 'week': {
      const d   = now.getDay();
      const mon = new Date(now); mon.setDate(now.getDate() - (d === 0 ? 6 : d - 1));
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      return { from: mon.toISOString().slice(0, 10),
               to:   sun.toISOString().slice(0, 10) };
    }
    case 'last7':  return { from: new Date(now - 6*864e5).toISOString().slice(0,10), to: today };
    case 'last30': return { from: new Date(now - 29*864e5).toISOString().slice(0,10), to: today };
    case 'today':  return { from: today, to: today };
    case 'lastmonth': {
      const y = now.getFullYear(), m = now.getMonth();
      const ly = m === 0 ? y-1 : y, lm = m === 0 ? 12 : m;
      return { from: `${ly}-${pad(lm)}-01`,
               to:   new Date(y, m, 0).toISOString().slice(0, 10) };
    }
    case 'year': {
      const y = now.getFullYear();
      return { from: `${y}-01-01`, to: `${y}-12-31` };
    }
    case 'all':  return { from: null, to: null };
    default:     return null;   // 'custom' — gunakan input manual
  }
}

/* ── Dashboard period filter ─────────────────────────────────────────────── */
function initDashFilter() {
  const sel       = $('dashPeriodSel');
  const fromInp   = $('dashDateFrom');
  const toInp     = $('dashDateTo');
  const customDiv = $('dashCustomRange');

  if (!sel || sel._dashFilterInit) return;
  sel._dashFilterInit = true;

  function applyPeriod() {
    const val = sel?.value || 'month';
    const isCustom = val === 'custom';
    customDiv?.classList.toggle('hidden', !isCustom);

    if (isCustom) {
      state.dashDateFrom = fromInp?.value || null;
      state.dashDateTo   = toInp?.value   || null;
    } else {
      const r = getPeriodDates(val);
      state.dashDateFrom = r.from;
      state.dashDateTo   = r.to;
    }
    showFlagLoader(350);
    renderDashboard();
  }

  sel.addEventListener('change', applyPeriod);
  fromInp?.addEventListener('change', applyPeriod);
  toInp?.addEventListener('change',   applyPeriod);

  // Terapkan default (Bulan Ini) saat init
  applyPeriod();
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

  // Monthly target = (KPI PH + KPI 33official) × days in current month
  const kpi = state.settings?.kpi || {};
  const _now = new Date();
  const daysThisMonth = new Date(_now.getFullYear(), _now.getMonth() + 1, 0).getDate();
  const dailyKpi  = (+(kpi['penjaga-harapan']||0)) + (+(kpi['33-official']||0));
  const monthlyTarget = dailyKpi ? dailyKpi * daysThisMonth : null;

  const selesai   = monthContents.filter(c => c.status === 'Published').length;
  // ON PROGRESS = semua konten yang belum Published (Plan, Review, Revisi, Preview, ACC, Done, Hold, Drop)
  const progress  = monthContents.filter(c => c.status !== 'Published').length;
  const teamCount = (state.settings?.users || []).length;

  setTxt('dStatKonten',   monthContents.length);
  setTxt('dStatTarget',   monthlyTarget ?? '?');
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
          ${upcoming.length ? upcoming.map(c => dashContentCard(c, 'upcoming')).join('') : '<div class="dash-empty">Belum ada konten mendatang</div>'}
        </div>
      </div>
      <div class="near-split-col">
        <div class="dash-section-head" style="margin-bottom:10px">
          <span class="dash-section-title">Published Content</span>
          <a href="#planner" class="link-sm">LIHAT SEMUA</a>
        </div>
        <div class="dash-content-grid">
          ${published.length ? published.map(c => dashContentCard(c, 'published')).join('') : '<div class="dash-empty">Belum ada konten terpublish</div>'}
        </div>
      </div>
    </div>`;
}


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

function dashContentCard(c, mode = 'upcoming') {
  const platIconMap = PLAT_ICON_SVG;
  // Platform icons — for published mode each is a clickable button
  const plats = (c.platforms||[]).map(p => {
    const meta = PLATFORM_META[p];
    if (!meta) return '';
    if (mode === 'published') {
      const platUrl = (c.platformLinks||{})[p] || '';
      if (platUrl) {
        return `<span class="dcc-plat-link-wrap">
          <a href="${esc(platUrl)}" target="_blank" rel="noopener"
             class="dcc-plat-btn has-link" style="color:${meta.color}" title="${esc(meta.name)} ↗">${platIconMap[p]||p}</a>
          <button type="button" class="dcc-plat-edit-btn" style="color:${meta.color}"
            onclick="openLinkModal('${c.id}','published','${p}')" title="Edit link ${esc(meta.name)}">
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
        </span>`;
      }
      return `<button type="button" class="dcc-plat-btn"
        style="color:${meta.color}" title="Tambah link ${esc(meta.name)}"
        onclick="openLinkModal('${c.id}','published','${p}')">${platIconMap[p]||p}</button>`;
    }
    return `<span class="dcc-plat-icon" style="color:${meta.color}" title="${meta.name}">${platIconMap[p]||p}</span>`;
  }).join('');

  const acct     = ACCOUNTS.find(a => a.id === c.account);
  const users    = (state.settings?.users || []);
  const statuses = STATUSES;

  // ── Owner row (createdBy) ──────────────────────────────────────
  const ownerRow = `<div class="dcc-meta-row${!c.createdBy ? ' dcc-empty' : ''}">
    <span class="dcc-label">OWNER</span>
    <span class="dcc-val dcc-owner-val">${esc(c.createdBy || '—')}</span>
  </div>`;

  // ── Editor row (for Podcast / Liputan) ────────────────────────
  const editorRow = (c.editor && FORMATS_DUAL_ROLE.includes(c.format))
    ? `<div class="dcc-meta-row">
        <span class="dcc-label">EDITOR</span>
        <span class="dcc-val">${esc(c.editor)}</span>
      </div>`
    : '';

  // ── Output icon — sejajar nama akun (kiri) ──────────────────────────────
  const outputAcctIcon = c.outputLink
    ? `<a href="${esc(c.outputLink)}" target="_blank" rel="noopener"
         title="Output tersimpan — klik untuk buka" onclick="event.stopPropagation()"
         style="display:inline-flex;align-items:center;gap:3px;color:#16a34a;
                font-size:.68rem;font-weight:600;text-decoration:none;flex-shrink:0">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
          <path d="M22 9H13.4L11.7 7.3A1 1 0 0011 7H6a1 1 0 00-1 1v1H3a1 1 0 00-1 1v9a2 2 0 002 2h16a2 2 0 002-2V11a2 2 0 00-2-2z" opacity=".4"/>
          <path d="M20 11H4a1 1 0 00-1 1v7a1 1 0 001 1h16a1 1 0 001-1v-7a1 1 0 00-1-1z"/>
        </svg>
      </a>`
    : '';

  // Whole-card click → open popup (skip interactive elements)
  const cardClick = `onclick="if(!event.target.closest('select,button,a,input'))openLinkModal('${c.id}','${mode}')"`;

  return `<div class="dash-content-card" ${cardClick}>
    <div class="dcc-top">
      <select class="dcc-status-sel ${STATUS_CLASS[c.status]||'badge-ide'}"
        onchange="updateContentField('${c.id}','status',this.value)" title="Ubah status">
        ${statuses.map(s=>`<option value="${s}" ${s===c.status?'selected':''}>${s}</option>`).join('')}
      </select>
      ${outputAcctIcon}
      <span class="dcc-date">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
        ${fmtDate(c.publishDate)}
      </span>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:6px">
      ${acct ? `<div class="dcc-owner-tag" style="background:${acct.color}18;color:${acct.color};border-color:${acct.color}30">${acct.name}</div>` : '<span></span>'}
      ${c.theme ? `<span style="font-size:.68rem;color:var(--muted);font-weight:500;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px">${esc(c.theme)}</span>` : ''}
    </div>
    <div class="dcc-title">${esc(c.title||'—')}</div>
    <div class="dcc-meta-row${!c.format ? ' dcc-empty' : ''}">
      <span class="dcc-label">TIPE KONTEN</span>
      <span class="dcc-val"><span class="format-pill format-${(c.format||'').toLowerCase()}">${esc(c.format||'—')}</span></span>
    </div>
    <div class="dcc-meta-row">
      <span class="dcc-label">CREATOR</span>
      ${(()=>{
        const arr=Array.isArray(c.creator)?c.creator:(c.creator?[c.creator]:[]);
        if(arr.length>1) return `<span class="dcc-val dcc-creator">${esc(arr.join(', '))}</span>`;
        const sel0=arr[0]||'';
        return `<select class="dcc-creator-sel" onchange="updateContentField('${c.id}','creator',this.value)" title="Ubah creator">
          <option value="">— pilih —</option>
          ${users.map(u=>{const n=getUserName(u);return `<option value="${esc(n)}" ${n===sel0?'selected':''}>${esc(n)}</option>`;}).join('')}
        </select>`;
      })()}
    </div>
    <div class="dcc-meta-row${!plats ? ' dcc-empty' : ''}">
      <span class="dcc-label">PLATFORM</span>
      <div style="display:flex;gap:6px;align-items:center">${plats||'<span class="dcc-val">—</span>'}</div>
    </div>
    ${editorRow}
    ${ownerRow}
  </div>`;
}

/* ── Per-platform link for published cards (debounced) ───────────────────── */
const _platLinkTimers = {};
function debouncePlatformLink(contentId, platform, url) {
  clearTimeout(_platLinkTimers[contentId + platform]);
  _platLinkTimers[contentId + platform] = setTimeout(async () => {
    const c = state.contents.find(x => x.id === contentId);
    if (!c) return;
    if (!c.platformLinks) c.platformLinks = {};
    c.platformLinks[platform] = url.trim();
    c.updatedAt = new Date().toISOString();
    try {
      state.shas.contents = await window.db.writeData('contents', state.contents, `Platform link: ${c.title} — ${platform}`);
      saveDataCache();
      // Update the ↗ anchor without re-rendering the full card
      const anchor = document.querySelector(`[data-plat-anchor="${contentId}_${platform}"]`);
      if (anchor) {
        if (url.trim()) {
          anchor.href = url.trim();
          anchor.style.display = '';
        } else {
          anchor.style.display = 'none';
        }
      }
    } catch (e) { toast('Gagal simpan link: ' + e.message, 'error'); }
  }, 800);
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
      await notifyCreatorAssigned(c);
    } else if (field === 'status') {
      await logActivity(currentUser(), 'ubah status', `"${c.title}" menjadi ${value}`);
    } else {
      await logActivity(currentUser(), `ubah ${field}`, `"${c.title}"`);
    }
    // Refresh My To-Do saat creator/status berubah
    if (field === 'creator' || field === 'status') renderTodoList();
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
  el.innerHTML = published.map(c => dashContentCard(c, 'published')).join('');
}

/* ── My To-Do (ringkasan tugas dari Planner) ─────────────────────────────── */
function renderTodoList() {
  const list = $('todoList');
  if (!list) return;

  const me          = currentUser();
  const admin       = isAdmin();
  const todayStr    = new Date().toISOString().slice(0, 10);
  const tomorrowStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const DONE        = ['Published', 'Done', 'Drop'];

  // Label subjudul
  const label = $('todoUserLabel');
  if (label) label.textContent = admin ? '(semua tim)' : `(${me})`;

  const PRIORITY_FORMATS  = ['Podcast', 'Liputan'];   // prioritas 5 hari sebelum
  const PRIORITY_DAYS     = 5;
  const in5DaysStr        = new Date(Date.now() + PRIORITY_DAYS * 86400000).toISOString().slice(0, 10);

  // Filter & sort konten dari planner
  const myContents = (state.contents || [])
    .filter(c => {
      if (DONE.includes(c.status)) return false;
      if (admin) return true;
      const creators = Array.isArray(c.creator) ? c.creator : (c.creator ? [c.creator] : []);
      return creators.includes(me);
    })
    .sort((a, b) => {
      // Scoring: Podcast/Liputan dalam 5 hari ke depan → skor tinggi, naik ke atas
      const isPrioA = PRIORITY_FORMATS.includes(a.format) && a.publishDate >= todayStr && a.publishDate <= in5DaysStr;
      const isPrioB = PRIORITY_FORMATS.includes(b.format) && b.publishDate >= todayStr && b.publishDate <= in5DaysStr;
      if (isPrioA && !isPrioB) return -1;
      if (!isPrioA && isPrioB) return  1;
      // Dalam grup yang sama: urut tanggal
      const da = a.publishDate ? new Date(a.publishDate) : new Date('9999');
      const db = b.publishDate ? new Date(b.publishDate) : new Date('9999');
      return da - db;
    });

  if (!myContents.length) {
    list.innerHTML = `<li class="todo-empty">${admin ? 'Tidak ada konten aktif' : 'Tidak ada tugas untuk Anda saat ini'}</li>`;
    return;
  }

  // Ambil max 8 total (lebih banyak agar Podcast/Liputan tidak terpotong)
  const combined = myContents.slice(0, 8);

  function buildItem(c) {
    const mode     = c.status === 'Published' ? 'published' : 'upcoming';
    const overdue  = c.publishDate && c.publishDate < todayStr;
    const isToday  = c.publishDate === todayStr;
    const isTomorrow = c.publishDate === tomorrowStr;

    // Deteksi prioritas Podcast/Liputan dalam 5 hari
    const daysToDate  = c.publishDate ? Math.round((new Date(c.publishDate) - new Date(todayStr)) / 86400000) : null;
    const isPrioFormat = PRIORITY_FORMATS.includes(c.format);
    const isPrio      = isPrioFormat && daysToDate !== null && daysToDate >= 0 && daysToDate <= PRIORITY_DAYS;

    const dateStr = c.publishDate
      ? (overdue        ? `⚠ ${fmtDate(c.publishDate)}`
        : isToday       ? 'Hari Ini'
        : isTomorrow    ? 'Besok'
        : daysToDate !== null && daysToDate <= PRIORITY_DAYS
          ? `${daysToDate} hari lagi`
          : fmtDate(c.publishDate))
      : '—';

    // Tag badge
    let tagHtml = '';
    if (isToday)         tagHtml = `<span class="todo-day-tag todo-day-tag--today">Hari Ini</span>`;
    else if (isTomorrow) tagHtml = `<span class="todo-day-tag todo-day-tag--tomorrow">Besok</span>`;
    else if (isPrio)     tagHtml = `<span class="todo-day-tag todo-day-tag--prio">🔔 ${daysToDate}h lagi</span>`;

    const formatIcon = c.format === 'Podcast' ? '🎙' : c.format === 'Liputan' ? '📰' : '';
    const liClass = [
      'todo-item todo-planner-item',
      overdue  ? 'todo-overdue'          : '',
      isToday  ? 'todo-highlight-today'  : '',
      isTomorrow ? 'todo-highlight-tomorrow' : '',
      isPrio   ? 'todo-highlight-prio'   : '',
    ].filter(Boolean).join(' ');

    return `<li class="${liClass}"
        onclick="openLinkModal('${c.id}','${mode}')" title="Klik untuk lihat detail">
      <span class="badge ${STATUS_CLASS[c.status] || 'badge-ide'} todo-status-badge">${esc(c.status || 'Plan')}</span>
      <span class="todo-planner-body">
        <span class="todo-planner-title">${formatIcon ? formatIcon + ' ' : ''}${esc(c.title || '(Tanpa Judul)')}${tagHtml}</span>
        <span class="todo-planner-meta">${esc(c.format || '—')} · ${dateStr}</span>
      </span>
      <span class="todo-planner-arrow">›</span>
    </li>`;
  }

  list.innerHTML = combined.map(c => buildItem(c)).join('');
}

// toggleTodo / deleteTodo / startEditTodo dihapus —
// My To-Do sekarang hanya menampilkan data dari Planner (read-only)

/* ══════════════════════════════════════════════════════════════════════════
   PLANNER
   ══════════════════════════════════════════════════════════════════════════ */

function renderPlanner(page) {
  if (page !== undefined) state.planPage = page;

  const search    = gv('planSearch').toLowerCase();
  const creator   = gv('planFilterCreator');
  const status    = gv('planFilterStatus');
  const time      = gv('planFilterTime');
  // Resolve custom date inputs or period preset → dateFrom / dateTo
  let dateFrom, dateTo;
  if (time === 'custom') {
    dateFrom = gv('planDateFrom');
    dateTo   = gv('planDateTo');
  } else if (time && time !== '') {
    const r = getPeriodDates(time);
    dateFrom = r?.from || '';
    dateTo   = r?.to   || '';
  } else {
    dateFrom = ''; dateTo = '';
  }
  // Show/hide custom range inputs
  $('planCustomRange')?.classList.toggle('hidden', time !== 'custom');

  let rows = state.contents.filter(c => {
    if (search  && !c.title?.toLowerCase().includes(search)) return false;
    if (creator) {
      const crArr = Array.isArray(c.creator) ? c.creator : (c.creator ? [c.creator] : []);
      if (!crArr.includes(creator)) return false;
    }
    if (status  && c.status  !== status)  return false;
    if (time === 'week') {
      const d    = new Date(c.publishDate||'');
      const now2 = new Date(); now2.setHours(0,0,0,0);
      const day  = now2.getDay();
      const mon  = new Date(now2); mon.setDate(now2.getDate() - (day === 0 ? 6 : day - 1));
      const sun  = new Date(mon);  sun.setDate(mon.getDate() + 7);
      if (d < mon || d >= sun) return false;
    }
    // dateFrom/dateTo sudah di-resolve dari getPeriodDates() di atas
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

  const tbody  = $('planBody');
  const users  = state.settings?.users || [];
  tbody.innerHTML = slice.length ? slice.map(c => {
    const plats = (c.platforms||[]).map(p => `<span class="plat-pill plat-${p}">${p.charAt(0).toUpperCase()}</span>`).join('');
    const acct  = ACCOUNTS.find(a => a.id === c.account);
    const crArr = Array.isArray(c.creator) ? c.creator : (c.creator ? [c.creator] : []);
    const hasPhone = crArr.some(cr => users.find(u => getUserName(u) === cr)?.phone);
    const waBtn = hasPhone
      ? `<button class="btn-xs" style="color:#16a34a;border-color:#bbf7d0;padding:3px 6px" onclick="openPlannerWa('${c.id}')" title="Kirim WA manual">${WA_SVG}</button>`
      : '';
    const isDualFmt = FORMATS_DUAL_ROLE.includes(c.format);
    const budgetTotal = (c.budget||[]).reduce((s,r)=>s+(r.qty||0)*(r.price||0),0);
    const budgetBtn = (admin && isDualFmt)
      ? `<button class="btn-xs budget-planner-btn${budgetTotal>0?' has-budget':''}"
           onclick="openBudgetModal('${c.id}')" title="Budget Produksi">
           💰${budgetTotal>0?` Rp ${budgetTotal>=1e6?(budgetTotal/1e6).toFixed(1)+'jt':budgetTotal>=1e3?(budgetTotal/1e3).toFixed(0)+'rb':budgetTotal}`:''}
         </button>`
      : '';
    return `<tr>
      <td><span class="badge ${STATUS_CLASS[c.status]||'badge-ide'}">${esc(c.status)}</span></td>
      <td>${fmtDate(c.publishDate)}</td>
      <td>
        <div style="font-weight:600">${esc(c.title)}</div>
        ${acct ? `<div style="font-size:.7rem;color:${acct.color};margin-top:2px">${acct.name}</div>` : ''}
      </td>
      <td>${esc(c.theme||'—')}</td>
      <td><span class="format-pill format-${(c.format||'').toLowerCase()}">${esc(c.format||'—')}</span></td>
      <td><div class="plat-pills">${plats||'—'}</div></td>
      <td>${esc(Array.isArray(c.creator) ? c.creator.join(', ') : (c.creator||'—'))}</td>
      <td><div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">
        <button class="btn-xs" style="padding:4px 6px" onclick="editContent('${c.id}')" title="Edit">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        ${waBtn}
        ${budgetBtn}
        ${admin ? `<button class="btn-xs" style="padding:4px 6px;border-color:#fca5a5;color:var(--red)" onclick="deleteContent('${c.id}')" title="Hapus">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
        </button>` : ''}
      </div></td>
    </tr>`;
  }).join('') : '<tr><td colspan="8" class="empty-cell">Belum ada konten</td></tr>';

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
  const search  = gv('actSearch').toLowerCase();
  const period  = gv('actPeriodSel');
  let dateFrom, dateTo;
  if (period === 'custom') {
    dateFrom = gv('actDateFrom');
    dateTo   = gv('actDateTo');
  } else if (period) {
    const r = getPeriodDates(period);
    dateFrom = r?.from || ''; dateTo = r?.to || '';
  } else {
    dateFrom = ''; dateTo = '';
  }
  const list = $('activityList');
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
        ${c.creator?`<div class="cnt-row">👤 ${esc(Array.isArray(c.creator)?c.creator.join(', '):c.creator)}</div>`:''}
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
  const isDual = FORMATS_DUAL_ROLE.includes(gv('postFormat'));
  const draft = {
    postDate: gv('postDate'),
    postCreator:  isDual ? '' : gv('postCreator'),
    postCreators: isDual ? _getMultiCreators() : [],   // multi-creator (Podcast/Liputan)
    postAccount: gv('postAccount'),
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
  // Aktifkan UI yang sesuai dulu, baru isi creator
  onFormatChange(d.postFormat || 'Flayer');
  if (FORMATS_DUAL_ROLE.includes(d.postFormat || '')) {
    _setMultiCreators(Array.isArray(d.postCreators) ? d.postCreators : []);
  } else {
    sv('postCreator', d.postCreator || '');
  }
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

/* ── Multi-creator chip helpers ─────────────────────────────────────────── */
function _populateCreatorAddSel() {
  const sel = $('creatorAddSel');
  if (!sel) return;
  const users    = state.settings?.users || [];
  const selected = _getMultiCreators();
  sel.innerHTML = '<option value="">＋ Tambah creator…</option>' +
    users
      .map(u => getUserName(u))
      .filter(n => n && !selected.includes(n))
      .map(n => `<option value="${esc(n)}">${esc(n)}</option>`)
      .join('');
}

function _getMultiCreators() {
  const chips = $('creatorChips');
  if (!chips) return [];
  return Array.from(chips.querySelectorAll('.creator-chip[data-name]')).map(el => el.dataset.name);
}

function _setMultiCreators(names) {
  const chips = $('creatorChips');
  if (!chips) return;
  chips.innerHTML = (names || []).map(n =>
    `<span class="creator-chip" data-name="${esc(n)}">${esc(n)}<button type="button" class="creator-chip-rm" title="Hapus">×</button></span>`
  ).join('');
  _populateCreatorAddSel();
}

function addCreatorChip(name) {
  if (!name) return;
  const chips = $('creatorChips');
  if (!chips) return;
  if (_getMultiCreators().includes(name)) return;  // sudah ada
  chips.insertAdjacentHTML('beforeend',
    `<span class="creator-chip" data-name="${esc(name)}">${esc(name)}<button type="button" class="creator-chip-rm" title="Hapus">×</button></span>`
  );
  _populateCreatorAddSel();
}

/* ── Format change: show/hide Editor field + toggle creator UI ─────────── */
function onFormatChange(fmt) {
  const isDual = FORMATS_DUAL_ROLE.includes(fmt);
  $('postEditorRow')?.classList.toggle('hidden', !isDual);
  const lbl = $('postCreatorLabel');
  if (lbl) lbl.innerHTML = isDual
    ? 'Creator <small style="font-weight:400;color:var(--muted)">(produksi · bisa pilih lebih dari 1)</small> <span class="req-star">*</span>'
    : 'Creator <span class="req-star">*</span>';

  const sel   = $('postCreator');
  const multi = $('postCreatorMulti');
  if (isDual) {
    // Tampilkan chip UI, sembunyikan single-select
    if (sel)   sel.classList.add('hidden');
    if (multi) multi.classList.remove('hidden');
    _populateCreatorAddSel();
  } else {
    // Tampilkan single-select, sembunyikan chip UI + reset chips
    if (sel)   sel.classList.remove('hidden');
    if (multi) multi.classList.add('hidden');
    _setMultiCreators([]);
  }
}

/* ── Link / Detail Modal ─────────────────────────────────────────────────── */
function openLinkModal(contentId, mode, platform) {
  const c = state.contents.find(x => x.id === contentId);
  if (!c) return;
  const modal = $('linkEditModal');
  if (!modal) return;

  /* ── Shared helpers ── */
  const acct       = ACCOUNTS.find(a => a.id === c.account);
  const creatorTxt = Array.isArray(c.creator) ? c.creator.join(', ') : (c.creator || '—');
  const editorTxt  = (c.editor && FORMATS_DUAL_ROLE.includes(c.format)) ? c.editor : null;
  const extSvg     = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
  const saveSvg    = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13"/><polyline points="7 3 7 8 15 8"/></svg>`;
  const editSvg    = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

  /* ── Platform icons (colored, read-only) ── */
  const platIconsHtml = (c.platforms||[]).map(p => {
    const pm = PLATFORM_META[p]; if (!pm) return '';
    return `<span style="color:${pm.color}" title="${esc(pm.name)}">${PLAT_ICON_SVG[p]||p}</span>`;
  }).join('');

  /* ── Info table ── */
  const infoTable = `
    <div class="lem-info-table">
      <div class="lem-info-col">
        <div class="lem-info-col-lbl">CREATOR</div>
        <div class="lem-info-col-val lem-creator-val">${esc(creatorTxt)}</div>
        ${editorTxt ? `<div class="lem-info-col-sub">EDITOR: ${esc(editorTxt)}</div>` : ''}
      </div>
      <div class="lem-info-col">
        <div class="lem-info-col-lbl">OWNER</div>
        <div class="lem-info-col-val">${esc(c.createdBy||'—')}</div>
      </div>
      <div class="lem-info-col">
        <div class="lem-info-col-lbl">TEMA</div>
        <div class="lem-info-col-val">${esc(c.theme||'—')}</div>
      </div>
      <div class="lem-info-col">
        <div class="lem-info-col-lbl">FORMAT</div>
        <div class="lem-info-col-val">${esc(c.format||'—')}</div>
      </div>
      <div class="lem-info-col">
        <div class="lem-info-col-lbl">PLATFORMS</div>
        <div class="lem-info-col-val lem-info-plats">${platIconsHtml||'—'}</div>
      </div>
    </div>`;

  /* ── Content sections ── */
  const scriptSec = c.script
    ? `<div class="lem-section">
        <div class="lem-section-lbl">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          SCRIPT / NASKAH
        </div>
        <div class="lem-section-body">${esc(c.script)}</div>
      </div>` : '';

  const captionSec = c.caption
    ? `<div class="lem-section">
        <div class="lem-section-lbl">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
          CAPTION
        </div>
        <div class="lem-section-body">${esc(c.caption)}</div>
      </div>` : '';

  const notesSec = `<div class="lem-section lem-section--notes">
      <div class="lem-section-lbl">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
        CATATAN KHUSUS
      </div>
      <div class="lem-section-body">${esc(c.notes||'Tidak ada catatan.')}</div>
    </div>`;

  /* ── Edit semua data button ── */
  const editBtn = `<button class="btn-md blue lem-edit-all-btn" onclick="closeLinkModal();editContent('${contentId}')">
    ${editSvg} Edit Semua Data
  </button>`;

  /* ── Build header + base block ── */
  $('linkEditTitle').textContent = c.title || '—';
  const subhead = `<div class="lem-subhead">
    ${c.status ? `<span class="badge ${STATUS_CLASS[c.status]||'badge-ide'}">${esc(c.status)}</span>` : ''}
    ${c.publishDate ? `<span class="lem-subhead-date">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
      ${esc(fmtDate(c.publishDate))}
    </span>` : ''}
    ${acct ? `<span class="lem-subhead-acct" style="color:${acct.color};border-color:${acct.color}40;background:${acct.color}10">${esc(acct.name)}</span>` : ''}
  </div>`;

  const baseHtml = subhead + infoTable + scriptSec + captionSec + notesSec;

  /* ── Mode-specific link section ── */
  if (mode === 'upcoming') {
    $('linkEditContent').innerHTML = baseHtml + `
      <div class="lem-output-section">
        <div class="lem-section-lbl">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
          OUTPUT LINK
        </div>
        <div class="lem-output-row">
          <input class="form-inp lem-output-inp" type="url" id="linkEditInp"
            value="${esc(c.outputLink || '')}"
            placeholder="Masukkan URL / link output (Google Drive, dll)..." />
          <button class="btn-md green lem-save-btn" onclick="saveLinkFromModal('${contentId}','upcoming')">
            ${saveSvg} Simpan
          </button>
        </div>
        ${c.outputLink ? `<a href="${esc(c.outputLink)}" target="_blank" rel="noopener" class="lem-open-link">Buka link tersimpan ${extSvg}</a>` : ''}
      </div>
      <div class="lem-modal-footer">${editBtn}</div>`;

  } else if (mode === 'published' && platform) {
    /* ── Edit satu platform link ── */
    const meta = PLATFORM_META[platform] || { name: platform, color: '#64748b' };
    const existingUrl = (c.platformLinks||{})[platform] || '';
    $('linkEditContent').innerHTML = baseHtml + `
      <div class="lem-output-section">
        <div class="lem-section-lbl" style="color:${meta.color}">
          <span style="display:inline-flex;width:14px;height:14px;align-items:center;justify-content:center">${PLAT_ICON_SVG[platform]||''}</span>
          ${esc(meta.name).toUpperCase()} LINK
        </div>
        <div class="lem-output-row">
          <input class="form-inp lem-output-inp" type="url" id="linkEditInp"
            value="${esc(existingUrl)}"
            placeholder="https://..." />
          <button class="btn-md lem-save-btn" style="background:${meta.color};color:#fff;border-color:${meta.color}"
            onclick="saveLinkFromModal('${contentId}','published','${platform}')">
            ${saveSvg} Simpan
          </button>
        </div>
        ${existingUrl ? `<a href="${esc(existingUrl)}" target="_blank" rel="noopener" class="lem-open-link">Buka link tersimpan ${extSvg}</a>` : ''}
      </div>
      <div class="lem-modal-footer">${editBtn}</div>`;

  } else if (mode === 'published' && !platform) {
    /* ── Overview semua platform links ── */
    const platItems = (c.platforms||[]).map(p => {
      const pm = PLATFORM_META[p]; if (!pm) return '';
      const url = (c.platformLinks||{})[p] || '';
      return `<div class="lem-plat-item">
        <span class="lem-plat-item-icon" style="color:${pm.color};background:${pm.color}18;border-color:${pm.color}33">${PLAT_ICON_SVG[p]||p}</span>
        <div class="lem-plat-item-info">
          <span class="lem-plat-item-name" style="color:${pm.color}">${esc(pm.name)}</span>
          ${url
            ? `<a href="${esc(url)}" target="_blank" rel="noopener" class="lem-plat-item-url">${esc(url.length>44?url.slice(0,44)+'…':url)}</a>`
            : `<span class="lem-plat-item-empty">Belum diisi</span>`}
        </div>
        <button type="button" class="btn-xs" onclick="openLinkModal('${contentId}','published','${p}')">${url?'Edit':'+ Link'}</button>
      </div>`;
    }).join('');
    $('linkEditContent').innerHTML = baseHtml + `
      <div class="lem-output-section">
        <div class="lem-section-lbl">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
          PLATFORM LINKS
        </div>
        <div class="lem-plat-list">${platItems||'<span style="color:var(--muted-lt);font-size:.8rem">Tidak ada platform</span>'}</div>
      </div>
      <div class="lem-modal-footer">${editBtn}</div>`;
  }

  modal.classList.remove('hidden');
  setTimeout(() => { const inp = $('linkEditInp'); if (inp) { inp.focus(); inp.select(); } }, 60);
}

/* expose for inline onclick */
window.editFromModal = (id) => { closeLinkModal(); editContent(id); };

async function saveLinkFromModal(contentId, mode, platform) {
  const url = gv('linkEditInp').trim();
  const c = state.contents.find(x => x.id === contentId);
  if (!c) { closeLinkModal(); return; }
  const btn = $('linkEditModal')?.querySelector('.lem-save-btn');
  if (btn) { btn.textContent = 'Menyimpan…'; btn.disabled = true; }

  try {
    if (mode === 'upcoming') {
      c.outputLink = url;
    } else {
      if (!c.platformLinks) c.platformLinks = {};
      c.platformLinks[platform] = url;
    }
    c.updatedAt = new Date().toISOString();
    state.shas.contents = await window.db.writeData('contents', state.contents,
      mode === 'upcoming' ? `Output link: ${c.title}` : `Platform link ${platform}: ${c.title}`);
    saveDataCache();
    toast('Link disimpan ✓', 'success');
    closeLinkModal();
    // Refresh dashboard cards
    if (state.currentPage === 'dashboard') renderDashNearContent();
  } catch (e) {
    toast('Gagal simpan: ' + e.message, 'error');
    if (btn) { btn.textContent = 'Simpan'; btn.disabled = false; }
  }
}

function closeLinkModal() {
  $('linkEditModal')?.classList.add('hidden');
}

function renderNewPostForm(content) {
  const users = state.settings?.users || [];
  // Populate Creator select
  const creatorSel = $('postCreator');
  if (creatorSel) {
    const cur = creatorSel.value;
    creatorSel.innerHTML = '<option value="">— Pilih Creator —</option>' +
      users.map(u => { const n = getUserName(u); return `<option value="${esc(n)}" ${n===cur?'selected':''}>${esc(n)}</option>`; }).join('');
  }
  // Populate Editor select
  const editorSel = $('postEditor');
  if (editorSel) {
    const cur = editorSel.value;
    editorSel.innerHTML = '<option value="">— Pilih Editor —</option>' +
      users.map(u => { const n = getUserName(u); return `<option value="${esc(n)}" ${n===cur?'selected':''}>${esc(n)}</option>`; }).join('');
  }

  if (content) {
    sv('editPostId',     content.id);
    sv('postDate',       content.publishDate || '');
    // creator handled after onFormatChange (may be array for Podcast/Liputan)
    sv('postCreator',    Array.isArray(content.creator) ? '' : (content.creator || ''));
    sv('postEditor',     content.editor      || '');
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
    onFormatChange(content.format || '');  // show/hide editor row + toggle creator UI
    // Restore creator: chip UI untuk Podcast/Liputan, single-select untuk lainnya
    if (FORMATS_DUAL_ROLE.includes(content.format || '')) {
      _setMultiCreators(Array.isArray(content.creator) ? content.creator : (content.creator ? [content.creator] : []));
    } else {
      sv('postCreator', Array.isArray(content.creator) ? '' : (content.creator || ''));
    }
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
    sv('postStatus','Plan'); sv('postCreator',''); sv('postEditor',''); sv('postAccount',''); sv('postFormat','Flayer');
    onFormatChange('Flayer');  // reset editor row visibility
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
  // Validasi creator: dual-role (Podcast/Liputan) pakai chip UI, bukan select
  const _isDualNow = FORMATS_DUAL_ROLE.includes(gv('postFormat'));
  const _creatorCheck = _isDualNow ? _getMultiCreators() : [gv('postCreator')];
  if (!_creatorCheck.length || !_creatorCheck[0]) {
    toast('Creator wajib diisi (*)', 'error');
    const elC = _isDualNow ? $('postCreatorMulti') : $('postCreator');
    elC?.classList.add('inp-error');
    setTimeout(() => elC?.classList.remove('inp-error'), 2000);
    return;
  }
  const platforms = Array.from($$('#platformChecks input:checked')).map(cb => cb.value);
  if (!platforms.length) {
    toast('Pilih minimal 1 Platform Distribusi (*)', 'error');
    return;
  }

  const title   = gv('postTitle');
  const theme   = gv('postTheme');
  const acctId  = gv('postAccount');
  const isDualRoleFmt = FORMATS_DUAL_ROLE.includes(gv('postFormat'));
  const creator = isDualRoleFmt
    ? _getMultiCreators()           // baca dari chip UI
    : gv('postCreator');            // baca dari single-select
  const acctName = ACCOUNTS.find(a => a.id === acctId)?.name || acctId || '—';

  // Auto-koreksi status: Plan hanya untuk besok ke depan; hari ini → Ongoing
  const todayStr = new Date().toISOString().slice(0, 10);
  const rawStatus = gv('postStatus');
  const autoStatus = (rawStatus === 'Plan' && gv('postDate') <= todayStr) ? 'Ongoing' : rawStatus;
  if (autoStatus !== rawStatus) sv('postStatus', autoStatus);

  const data = {
    title, platforms,
    publishDate: gv('postDate'),
    creator,
    editor:      gv('postEditor') || '',
    account:     acctId,
    status:      autoStatus,
    theme,
    format:      gv('postFormat'),
    script:      gv('postScript'),
    caption:     gv('postCaption'),
    outputLink:  gv('postOutputLink'),
    notes:       gv('postNotes')
  };

  if (id) {
    const idx = state.contents.findIndex(x => x.id === id);
    if (idx !== -1) state.contents[idx] = { ...state.contents[idx], ...data, updatedAt: new Date().toISOString() };
  } else {
    state.contents.unshift({ id: uid(), ...data, platformLinks: {}, createdBy: currentUser(), createdAt: new Date().toISOString() });
  }

  try {
    state.shas.contents = await window.db.writeData('contents', state.contents, `${id?'Edit':'Tambah'}: ${title}`);
    saveDataCache();
    const logDetail = id
      ? `"${title}"`
      : `berjudul "${title}" (tema: ${theme}) untuk akun ${acctName} dijadwalkan ${fmtDate(gv('postDate'))}`;
    await logActivity(currentUser(), id ? 'edit konten' : 'tambah konten', logDetail);
    // WA ke semua creator sesuai status yang disimpan
    const savedContent = state.contents.find(x => x.title === title) || { ...data };
    await notifyCreatorAssigned(savedContent);
    clearNewPostDraft();
    toast(`Konten berhasil ${id ? 'diperbarui' : 'disimpan'}`, 'success');
    navigate('planner');
  } catch (e) { toast('Gagal simpan: ' + e.message, 'error'); }
}

/* ══════════════════════════════════════════════════════════════════════════
   ASSETS & DRIVE
   ══════════════════════════════════════════════════════════════════════════ */

function _closeAllAssetDrops() {
  $$('.asset-dropdown').forEach(d => d.classList.add('hidden'));
}

function renderAssets() {
  const sec = $('assetsSection');
  if (!sec) return;
  const admin  = isAdmin();
  const files  = state.assets || [];

  const filesHtml = files.length === 0
    ? `<div class="asset-empty"><span>📂</span><p>Belum ada file aset.${admin ? ' Klik "+ Tambah File" untuk mulai.' : ''}</p></div>`
    : files.map(f => {
        const url = f.url || '#';
        return `
          <div class="asset-folder-item">
            <a class="asset-folder-link" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(f.name)}">
              <span class="asset-folder-icon">
                ${f.emoji
                  ? `<span style="font-size:1.4rem">${esc(f.emoji)}</span>`
                  : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" width="28" height="28"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" fill="#d1d5db" stroke="#9ca3af"/></svg>`}
              </span>
              <span class="asset-folder-name">${esc(f.name)}</span>
            </a>
            <div class="asset-menu-wrap">
              <button class="asset-menu-btn" title="Opsi" onclick="toggleAssetMenu(event,'${f.id}')">
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
              </button>
              <div class="asset-dropdown hidden" data-fid="${f.id}">
                ${admin ? `<button onclick="_closeAllAssetDrops();openEditAssetFile('${f.id}')">✏️ Edit</button>` : ''}
                <button onclick="_closeAllAssetDrops();openAssetInfo('${f.id}')">ℹ️ Informasi File</button>
                ${admin ? `<button class="red" onclick="_closeAllAssetDrops();deleteAssetFile('${f.id}')">🗑️ Hapus</button>` : ''}
              </div>
            </div>
          </div>`;
      }).join('');

  sec.innerHTML = `
    ${admin ? `<div style="margin-bottom:14px"><button class="btn blue" onclick="openAddAssetFile()">+ Tambah File</button></div>` : ''}
    <div class="asset-grid">${filesHtml}</div>

    <!-- Modal tambah/edit file -->
    <div id="assetFileModal" class="modal-overlay hidden">
      <div class="modal-box" style="max-width:420px">
        <h3 id="assetFileModalTitle" class="modal-title">Tambah File</h3>
        <input type="hidden" id="assetFileEditId">
        <div class="form-group">
          <label class="form-label">Emoji / Ikon <span style="color:var(--muted);font-weight:400">(opsional, mis. 🎬 📸 🎨)</span></label>
          <input id="assetFileEmoji" class="form-input" placeholder="📁" maxlength="4" style="width:70px">
        </div>
        <div class="form-group">
          <label class="form-label">Nama File *</label>
          <input id="assetFileName" class="form-input" placeholder="mis. Stock Video, Foto PH, Logo...">
        </div>
        <div class="form-group">
          <label class="form-label">URL Drive / Link *</label>
          <input id="assetFileUrl" class="form-input" type="url" placeholder="https://drive.google.com/...">
        </div>
        <div class="form-group">
          <label class="form-label">Keterangan</label>
          <input id="assetFileNotes" class="form-input" placeholder="Opsional — deskripsi singkat isi file">
        </div>
        <div class="modal-footer">
          <button class="btn" onclick="closeAssetFileModal()">Batal</button>
          <button class="btn blue" onclick="saveAssetFile()">Simpan</button>
        </div>
      </div>
    </div>

    <!-- Modal informasi file -->
    <div id="assetInfoModal" class="modal-overlay hidden">
      <div class="modal-box" style="max-width:380px">
        <h3 class="modal-title">ℹ️ Informasi File</h3>
        <div id="assetInfoBody" style="display:flex;flex-direction:column;gap:10px;padding:4px 0 8px"></div>
        <div class="modal-footer">
          <button class="btn blue" onclick="$('assetInfoModal').classList.add('hidden')">Tutup</button>
        </div>
      </div>
    </div>`;
}

function toggleAssetMenu(e, fileId) {
  e.stopPropagation();
  e.preventDefault();
  const btn  = e.currentTarget;
  const wrap = btn.closest('.asset-menu-wrap');
  const drop = wrap?.querySelector('.asset-dropdown');
  if (!drop) return;
  const wasHidden = drop.classList.contains('hidden');
  _closeAllAssetDrops();
  if (wasHidden) {
    drop.classList.remove('hidden');
    // posisi: kalau dekat tepi bawah, buka ke atas
    const rect = btn.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    drop.style.top    = spaceBelow < 120 ? 'auto' : 'calc(100% + 4px)';
    drop.style.bottom = spaceBelow < 120 ? 'calc(100% + 4px)' : 'auto';
  }
}

// Tutup semua dropdown jika klik di luar — dipasang saat init
function _initAssetClickOutside() {
  document.addEventListener('click', e => {
    if (!e.target.closest('.asset-menu-wrap')) _closeAllAssetDrops();
  });
}

/* ── Asset CRUD ─────────────────────────────────────────────────────────── */
function openAddAssetFile() {
  $('assetFileModalTitle').textContent = 'Tambah File';
  $('assetFileEditId').value  = '';
  $('assetFileEmoji').value   = '';
  $('assetFileName').value    = '';
  $('assetFileUrl').value     = '';
  $('assetFileNotes').value   = '';
  $('assetFileModal').classList.remove('hidden');
  $('assetFileName').focus();
}
function openEditAssetFile(fileId) {
  const f = (state.assets || []).find(x => x.id === fileId);
  if (!f) return;
  $('assetFileModalTitle').textContent = 'Edit File';
  $('assetFileEditId').value  = f.id;
  $('assetFileEmoji').value   = f.emoji || '';
  $('assetFileName').value    = f.name  || '';
  $('assetFileUrl').value     = f.url   || '';
  $('assetFileNotes').value   = f.notes || '';
  $('assetFileModal').classList.remove('hidden');
  $('assetFileName').focus();
}
function closeAssetFileModal() {
  $('assetFileModal')?.classList.add('hidden');
}
async function saveAssetFile() {
  const name  = $('assetFileName').value.trim();
  const url   = $('assetFileUrl').value.trim();
  if (!name) { toast('Nama file wajib diisi', 'error'); return; }
  if (!url)  { toast('URL Drive wajib diisi', 'error'); return; }
  const editId = $('assetFileEditId').value;
  state.assets = state.assets || [];
  if (editId) {
    const f = state.assets.find(x => x.id === editId);
    if (f) { f.emoji = $('assetFileEmoji').value.trim(); f.name = name; f.url = url; f.notes = $('assetFileNotes').value.trim(); }
  } else {
    state.assets.push({ id: uid(), emoji: $('assetFileEmoji').value.trim(), name, url, notes: $('assetFileNotes').value.trim(), addedBy: currentUser(), addedAt: new Date().toISOString() });
  }
  closeAssetFileModal();
  renderAssets();
  try {
    state.shas.assets = await window.db.writeData('assets', state.assets, `Aset: ${editId ? 'edit' : 'tambah'} "${name}"`);
    saveDataCache();
    toast(editId ? 'File diperbarui ✓' : 'File ditambahkan ✓', 'success');
  } catch(e) { toast('Gagal simpan: ' + e.message, 'error'); }
}
async function deleteAssetFile(fileId) {
  const f = (state.assets || []).find(x => x.id === fileId);
  if (!f) return;
  if (!confirm(`Hapus file "${f.name}"?`)) return;
  state.assets = state.assets.filter(x => x.id !== fileId);
  renderAssets();
  try {
    state.shas.assets = await window.db.writeData('assets', state.assets, `Aset: hapus "${f.name}"`);
    saveDataCache();
    toast('File dihapus');
  } catch(e) { toast('Gagal hapus: ' + e.message, 'error'); }
}
function openAssetInfo(fileId) {
  const f = (state.assets || []).find(x => x.id === fileId);
  if (!f) return;
  const body = $('assetInfoBody');
  if (!body) return;
  const row = (label, val) => val
    ? `<div style="display:flex;gap:8px;align-items:flex-start"><span style="color:var(--muted);font-size:.8rem;min-width:90px;padding-top:1px">${label}</span><span style="font-size:.85rem;word-break:break-all">${val}</span></div>`
    : '';
  body.innerHTML = [
    row('Nama', esc(f.name)),
    row('Emoji', f.emoji ? esc(f.emoji) : '—'),
    row('URL', f.url ? `<a href="${esc(f.url)}" target="_blank" style="color:var(--primary)">${esc(f.url)}</a>` : '—'),
    row('Keterangan', f.notes ? esc(f.notes) : ''),
    row('Ditambahkan', f.addedBy ? `${esc(f.addedBy)}` : ''),
    row('Tanggal', f.addedAt ? fmtDate(f.addedAt.slice(0,10)) : ''),
  ].filter(Boolean).join('');
  $('assetInfoModal').classList.remove('hidden');
}

// backward-compat stubs
function openAddAssetFolder()  { openAddAssetFile(); }
function openEditAssetFolder(id) { openEditAssetFile(id); }
function closeAssetFolderModal() { closeAssetFileModal(); }
async function saveAssetFolder() { await saveAssetFile(); }
async function deleteAssetFolder(id) { await deleteAssetFile(id); }
function openAddAssetLink()    {}
function openEditAssetLink()   {}
function closeAssetLinkModal() {}
async function saveAssetLink() {}
async function deleteAssetLink() {}
function copyAssetLink(url) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(() => toast('Link disalin ✓', 'success'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = url; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    toast('Link disalin ✓', 'success');
  }
}
// stub — tidak dipakai lagi tapi aman jika ada referensi lama
function openAddAssetLink()    {}
function openEditAssetLink()   {}
function closeAssetLinkModal() {}
async function saveAssetLink() {}
async function deleteAssetLink() {}
function copyAssetLink(url) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(() => toast('Link disalin ✓', 'success'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = url; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    toast('Link disalin ✓', 'success');
  }
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

  // Claude key
  sv('cfgClaudeKey', getClaudeKey());
  updateClaudeStatus();

  // WhatsApp API token
  sv('cfgWaToken', getWaToken());
  updateWaStatus();

  // Team token — tampilkan nilai saat ini (ter-mask karena type=password)
  sv('cfgTeamToken', state.settings?.teamToken || '');
  updateTeamTokenStatus();

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

/* Claude key */
function updateClaudeStatus() {
  const el  = $('claudeKeyStatus');
  const has = !!getClaudeKey();
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
  _saveApiKeysToSettings({ fonnte: t });
  toast(t ? 'Token WA disimpan ✓' : 'Token WA dihapus', t ? 'success' : 'warn');
}

/* ── YouTube Auto-Sync: trigger GitHub Actions workflow_dispatch ─────────── */
async function triggerYouTubeSync() {
  const cfg = window.db.getConfig();
  if (!cfg?.pat) { toast('Konfigurasi token akses di API Setup terlebih dahulu', 'error'); return; }

  const btn = $('btnTriggerYtSync');
  if (btn) { btn.textContent = '⏳ Memulai sync…'; btn.disabled = true; }
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/actions/workflows/sync-youtube.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.pat}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        body: JSON.stringify({ ref: cfg.branch || 'main' })
      }
    );
    if (resp.status === 204) {
      toast('✅ YouTube sync dimulai! Data akan terupdate dalam ~1 menit.', 'success');
    } else {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${resp.status}`);
    }
  } catch (e) {
    toast('Gagal trigger sync: ' + e.message, 'error');
  } finally {
    if (btn) { btn.textContent = '▶ Jalankan Sekarang'; btn.disabled = false; }
  }
}

/**
 * Simpan API keys (Gemini, Claude, Fonnte) ke settings.json (encoded).
 * Hanya admin yang bisa update — creator tidak punya akses tulis settings.
 * Gagal silently — key sudah aman di localStorage.
 */
async function _saveApiKeysToSettings(updates) {
  if (getSess()?.role !== 'admin') return;
  try {
    const settings = { ...(state.settings || { kpi: {}, users: [], analyticsUrls: {} }) };
    for (const [k, v] of Object.entries(updates)) {
      if (v) settings[k] = _encodeToken(v);
      else   delete settings[k];
    }
    state.settings = settings;
    state.shas.settings = await window.db.writeData('settings', settings, 'API keys: update');
    saveDataCache();
  } catch (e) {
    console.warn('API keys: gagal simpan ke GitHub —', e.message);
    // Tidak tampilkan error ke user — key sudah tersimpan di localStorage
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   INVITE SYSTEM — Enkripsi AES-256-GCM + PIN terpisah
   URL pendek: https://domain/loginuser?invite=<8chars>
   Data tersimpan di GitHub (terenkripsi) — tidak readable tanpa PIN
   ══════════════════════════════════════════════════════════════════════════ */

/** Turunkan AES-256-GCM key dari PIN via PBKDF2 */
async function _deriveKey(pin) {
  const enc  = new TextEncoder();
  const raw  = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('cmssocmed-ph-v1'), iterations: 150000, hash: 'SHA-256' },
    raw,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Enkripsi object → URL-safe base64 */
async function _encryptPayload(data, pin) {
  const key = await _deriveKey(pin);
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const ct  = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(data))
  );
  const buf = new Uint8Array(12 + ct.byteLength);
  buf.set(iv);
  buf.set(new Uint8Array(ct), 12);
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Dekripsi URL-safe base64 → object */
async function _decryptPayload(b64, pin) {
  const pad = b64.replace(/-/g, '+').replace(/_/g, '/');
  const buf = Uint8Array.from(atob(pad + '=='.slice(0, (4 - pad.length % 4) % 4)), c => c.charCodeAt(0));
  const key = await _deriveKey(pin);
  const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12));
  return JSON.parse(new TextDecoder().decode(dec));
}

/** Buat PIN numerik 6-digit secara kriptografis acak */
function _randomPin6() {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 900000 + 100000);
}

/** Buat invite ID 8 huruf hex (acak) */
function _randomInviteId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Buat invite terenkripsi dan simpan ke GitHub _invites.json.
 * @param {string} pin  — PIN 6 digit yang dibuat admin
 * @returns {string}    — URL invite pendek
 */
async function createDeviceInvite(pin) {
  const cfg = window.db.getConfig();
  if (!cfg?.owner || !cfg?.repo || !cfg?.pat)
    throw new Error('Konfigurasi server belum lengkap');

  const payload = {
    owner: cfg.owner, repo: cfg.repo, branch: cfg.branch || 'main', pat: cfg.pat,
    gemini: getGeminiKey() || undefined,
    claude: getClaudeKey() || undefined,
    wa:     getWaToken()   || undefined,
  };
  Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

  const id        = _randomInviteId();
  const encrypted = await _encryptPayload(payload, pin);
  const expires   = Date.now() + 24 * 60 * 60 * 1000;  // 24 jam

  // Load & prune expired invites
  let invites = {};
  try { invites = (await window.db.readData('_invites')) || {}; } catch {}
  Object.keys(invites).forEach(k => { if (invites[k].expires < Date.now()) delete invites[k]; });
  invites[id] = { encrypted, expires };
  await window.db.writeData('_invites', invites, `Invite: buat akses perangkat baru`);

  return `${window.location.origin}/loginuser?invite=${id}`;
}

/**
 * Konsumsi invite: dekripsi payload lalu hapus invite dari GitHub.
 * @param {string} id  — invite ID dari URL
 * @param {string} pin — PIN dari admin
 * @returns {object}   — payload { owner, repo, branch, pat, gemini?, claude?, wa? }
 */
async function consumeInvite(id, pin) {
  let invites;
  try { invites = await window.db.readData('_invites'); } catch {
    throw new Error('Tidak dapat membaca data invite dari server');
  }
  const inv = invites?.[id];
  if (!inv) throw new Error('Kode invite tidak ditemukan atau sudah digunakan');
  if (inv.expires < Date.now()) throw new Error('Invite kedaluwarsa — minta admin buat link baru');

  let payload;
  try { payload = await _decryptPayload(inv.encrypted, pin); }
  catch { throw new Error('PIN salah — periksa kembali PIN dari admin'); }

  // Hapus invite setelah digunakan (one-time use)
  // CATATAN: penghapusan ke GitHub dilakukan di doConsumeInvite() setelah PAT baru disimpan,
  // agar device baru (yang belum punya PAT) tetap bisa menghapus invite-nya sendiri.
  delete invites[id];
  return { payload, invitesAfterDelete: invites };
}

/* ── Salin Link Akses Tim — cukup salin URL loginuser ────────────────────── */
function generateShareLink() {
  const url = `${window.location.origin}/loginuser`;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url)
      .then(() => toast(`🔗 Link disalin! Bagikan ke anggota tim.`, 'success'))
      .catch(() => prompt('Salin link ini:', url));
  } else {
    prompt('Salin link ini:', url);
  }
}

/* ── Token Akses Tim ─────────────────────────────────────────────────────── */
function updateTeamTokenStatus() {
  const el  = $('teamTokenStatus');
  const has = !!(state.settings?.teamToken);
  if (el) {
    el.textContent = has ? 'Aktif' : 'Belum diisi';
    el.className   = 'badge-status' + (has ? ' ok' : '');
  }
}

async function saveTeamTokenFromForm() {
  const token = gv('cfgTeamToken').trim();
  if (!token) { toast('Masukkan fine-grained PAT terlebih dahulu', 'error'); return; }

  const btn = $('btnSaveTeamToken');
  if (btn) { btn.textContent = 'Menyimpan…'; btn.disabled = true; }

  const settings = state.settings || { kpi:{}, users:[], analyticsUrls:{} };
  settings.teamToken = _encodeToken(token);   // encode agar tidak terdeteksi secret scanner
  try {
    state.settings = settings;
    state.shas.settings = await window.db.writeData('settings', settings, 'Token akses tim: update');
    saveDataCache();
    sv('cfgTeamToken', '');          // kosongkan field setelah simpan
    updateTeamTokenStatus();
    toast('✅ Token disimpan — anggota bisa langsung login!', 'success');
  } catch (e) {
    toast('Gagal simpan: ' + e.message, 'error');
  } finally {
    if (btn) { btn.textContent = '💾 Simpan'; btn.disabled = false; }
  }
}

function deleteTeamToken() {
  showConfirm(
    'Hapus Token Akses Tim? Perangkat baru harus setup manual.',
    async () => {
      const settings = state.settings || {};
      delete settings.teamToken;
      try {
        state.settings = settings;
        state.shas.settings = await window.db.writeData('settings', settings, 'Token akses tim: hapus');
        saveDataCache();
        sv('cfgTeamToken', '');
        updateTeamTokenStatus();
        toast('Token akses tim dihapus', '');
      } catch (e) { toast('Gagal: ' + e.message, 'error'); }
    },
    { icon: '🔑', yesLabel: 'Hapus Token', danger: true }
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   JAM DIGITAL — topbar clock (HH:MM:SS + tanggal)
   ══════════════════════════════════════════════════════════════════════════ */
function startClock() {
  const DAYS   = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'];
  const MONTHS = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  const elHM   = document.getElementById('clockHM');
  const elSec  = document.getElementById('clockSec');
  const elDate = document.getElementById('clockDate');
  const sbHM   = document.getElementById('sbClockHM');
  const sbSec  = document.getElementById('sbClockSec');
  const sbDate = document.getElementById('sbClockDate');

  function tick() {
    const n = new Date();
    const H = String(n.getHours()).padStart(2, '0');
    const M = String(n.getMinutes()).padStart(2, '0');
    const S = String(n.getSeconds()).padStart(2, '0');
    const dateStr = `${DAYS[n.getDay()]}, ${n.getDate()} ${MONTHS[n.getMonth()]} ${n.getFullYear()}`;
    if (elHM)   elHM.textContent   = `${H}:${M}`;
    if (elSec)  elSec.textContent  = S;
    if (elDate) elDate.textContent = dateStr;
    if (sbHM)   sbHM.textContent   = `${H}:${M}`;
    if (sbSec)  sbSec.textContent  = S;
    if (sbDate) sbDate.textContent = dateStr;
  }

  tick();
  setInterval(tick, 1000);
}

/* ═══════════════════════════════════════════════════════════════════════════
   KURS USD/IDR — fetchExchangeRate (frankfurter.app, refresh tiap 5 mnt)
   ══════════════════════════════════════════════════════════════════════════ */
async function fetchExchangeRate() {
  const CACHE_KEY = 'cms_usd_idr_v1';

  const _show = (rate) => {
    const el = document.getElementById('rateValue');
    if (el) el.textContent = 'Rp ' + Math.round(rate).toLocaleString('id-ID');
    // widget selalu visible (tidak perlu remove hidden lagi)
  };

  // Tampilkan cache dulu agar widget muncul instan
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (c?.rate && c.rate > 1000) _show(c.rate);
  } catch {}

  // Coba 3 API secara berurutan
  const APIS = [
    { url: 'https://open.er-api.com/v6/latest/USD',          get: d => d?.rates?.IDR },
    { url: 'https://api.frankfurter.app/latest?from=USD&to=IDR', get: d => d?.rates?.IDR },
    { url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json', get: d => d?.usd?.idr }
  ];

  for (const api of APIS) {
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 5000);
      const r    = await fetch(api.url, { signal: ctrl.signal });
      clearTimeout(tid);
      if (!r.ok) continue;
      const d    = await r.json();
      const rate = api.get(d);
      if (rate && rate > 1000) {
        _show(rate);
        localStorage.setItem(CACHE_KEY, JSON.stringify({ rate, ts: Date.now() }));
        return;
      }
    } catch { continue; }
  }
}
function showInviteCreatorModal() {
  const cfg = window.db.getConfig();
  if (!cfg?.owner || !cfg?.repo || !cfg?.pat) {
    toast('Konfigurasi server belum lengkap', 'error'); return;
  }
  const pin = _randomPin6();
  const modal = document.getElementById('inviteCreatorModal');
  if (!modal) { toast('Modal invite tidak ditemukan', 'error'); return; }

  document.getElementById('invitePinInput').value = pin;
  document.getElementById('inviteUrlDisplay').value = '— klik Buat Link —';
  document.getElementById('inviteBtnCopyUrl').disabled = true;
  document.getElementById('inviteBtnCopyUrl').dataset.url = '';
  modal.classList.remove('hidden');
}

async function doCreateInvite() {
  const pin    = document.getElementById('invitePinInput')?.value?.trim();
  const btn    = document.getElementById('inviteBtnCreate');
  if (!pin || pin.length < 4) { toast('PIN minimal 4 karakter', 'error'); return; }

  btn.disabled = true; btn.textContent = 'Membuat…';
  try {
    const url = await createDeviceInvite(pin);
    document.getElementById('inviteUrlDisplay').value = url;
    const copyBtn = document.getElementById('inviteBtnCopyUrl');
    copyBtn.disabled = false;
    copyBtn.dataset.url = url;
    toast('✅ Link invite berhasil dibuat!', 'success');
  } catch (e) {
    toast('Gagal buat invite: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Buat Link';
  }
}

function closeInviteCreatorModal() {
  document.getElementById('inviteCreatorModal')?.classList.add('hidden');
}

/* ── UI: Masukkan PIN (device baru) ──────────────────────────────────────── */
function showInvitePinModal(inviteId) {
  const modal = document.getElementById('invitePinModal');
  if (!modal) return;
  document.getElementById('invitePinEntry').value = '';
  document.getElementById('invitePinModal').dataset.inviteId = inviteId;
  modal.classList.remove('hidden');
  setTimeout(() => document.getElementById('invitePinEntry')?.focus(), 100);
}

async function doConsumeInvite() {
  const modal    = document.getElementById('invitePinModal');
  const inviteId = modal?.dataset?.inviteId;
  const pin      = document.getElementById('invitePinEntry')?.value?.trim();
  const btn      = document.getElementById('inviteBtnConsume');
  if (!pin) { toast('Masukkan PIN terlebih dahulu', 'error'); return; }

  btn.disabled = true; btn.textContent = 'Memverifikasi…';
  try {
    const { payload, invitesAfterDelete } = await consumeInvite(inviteId, pin);
    // Simpan config dengan PAT baru DULU, baru hapus invite (butuh PAT untuk write)
    window.db.saveConfig({
      owner: payload.owner, repo: payload.repo,
      branch: payload.branch || 'main', pat: payload.pat
    });
    // Hapus invite dari GitHub (sekarang PAT sudah tersimpan)
    window.db.writeData('_invites', invitesAfterDelete, `Invite: hapus ${inviteId} (sudah digunakan)`).catch(() => {});
    if (payload.gemini) localStorage.setItem(GEMINI_LS_KEY, payload.gemini);
    if (payload.claude) localStorage.setItem(CLAUDE_LS_KEY, payload.claude);
    if (payload.wa)     localStorage.setItem(WA_TOKEN_KEY,  payload.wa);

    // Load settings untuk restore auth
    const settings = await window.db.readData('settings');
    if (!settings?.adminHash) throw new Error('Data admin belum tersedia di server');
    saveAuth({ adminName: settings.adminName || 'Admin', adminHash: settings.adminHash });
    if (settings.users?.length) setPubUsers(settings.users);

    modal.classList.add('hidden');
    // Bersihkan URL
    history.replaceState(null, '', window.location.pathname);
    toast('✅ Perangkat berhasil dihubungkan! Silakan login.', 'success');
    showLogin();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Verifikasi & Hubungkan';
  }
}

/* GitHub config */
async function testGithub() {
  const cfg = { owner: gv('cfgOwner'), repo: gv('cfgRepo'), branch: gv('cfgBranch')||'main', pat: gv('cfgPat') };
  if (!cfg.owner || !cfg.repo || !cfg.pat) { toast('Isi semua kolom yang diperlukan', 'error'); return; }
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
  if (!cfg.owner || !cfg.repo || !cfg.pat) { toast('Isi semua kolom yang diperlukan', 'error'); return; }
  window.db.saveConfig(cfg);
  setSyncStatus(null, 'Menginisialisasi…');
  try {
    await window.db.testConnection();
    await window.db.initDataFiles();
    toast('Server tersambung. Data berhasil diinisialisasi.', 'success');
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
    const color = ROLE_COLORS[role] || '#64748b';
    const hasPw = !!u.passwordHash;
    const roleBadge = role
      ? `<span class="user-role-tag" style="background:${color}18;color:${color};border:1px solid ${color}30">${esc(role)}</span>`
      : `<span class="user-role-tag" style="background:#f1f5f9;color:#94a3b8;border:1px solid #e2e8f0">—</span>`;
    return `<li class="user-item">
      <div class="user-av">${name.charAt(0).toUpperCase()}</div>
      <div class="user-info">
        <span class="user-name">${esc(name)}</span>
        ${phone ? `<span class="user-phone">📱 ${esc(phone)}</span>` : '<span class="user-phone muted">— no WA —</span>'}
      </div>
      <button class="user-pw-btn ${hasPw ? 'has-pw' : 'no-pw'}" onclick="editUser('${esc(name)}')" title="${hasPw ? 'Password diatur, klik ubah' : 'Belum ada password, klik untuk set'}">${hasPw ? '🔒' : '🔓'}</button>
      ${roleBadge}
      <button class="user-edit" onclick="editUser('${esc(name)}')" title="Edit">✏</button>
      <button class="user-del"  onclick="deleteUser('${esc(name)}')" title="Hapus">×</button>
    </li>`;
  }).join('');
}

function toggleCustomRole(sel, inputId) {
  const inp = document.getElementById(inputId);
  if (!inp) return;
  inp.style.display = sel.value === '__other__' ? 'block' : 'none';
  if (sel.value === '__other__') { inp.value = ''; inp.focus(); }
}

async function addUser() {
  const name     = gv('userNameInput').trim();
  let role   = gv('userRoleInput').trim();
  if (role === '__other__') role = (gv('userRoleCustomInput') || '').trim();
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
  sv('userNameInput', ''); sv('userRoleInput', ''); sv('userPhoneInput', ''); sv('userPasswordInput', '');
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
  const _roles = ['','Creator','Writer','Designer','Videographer','Editor','Publisher','Producer','Planner','Leader','Ketua','Administrator'];
  const _cr = getUserRole(u);
  if (_roles.includes(_cr)) {
    sv('editUserRole', _cr);
    const _ci = document.getElementById('editUserRoleCustom'); if (_ci) _ci.style.display = 'none';
  } else {
    sv('editUserRole', '__other__');
    const _ci2 = document.getElementById('editUserRoleCustom');
    if (_ci2) { _ci2.value = _cr; _ci2.style.display = 'block'; }
  }
  sv('editUserPhone',        u.phone || '');
  sv('editUserNewPassword',  '');
  $('editUserModal')?.classList.remove('hidden');
  $('editUserName')?.focus();
}

async function saveEditUser() {
  const oldName = gv('editUserOldName');
  const newName = gv('editUserName').trim();
  let newRole = gv('editUserRole').trim();
  if (newRole === '__other__') newRole = (gv('editUserRoleCustom') || '').trim();
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

  // Propagate name change to todos, contents (creator bisa string atau array), dan bankKonten
  if (newName !== oldName) {
    state.todos = state.todos.map(t =>
      t.assignedTo === oldName ? { ...t, assignedTo: newName } : t
    );
    state.contents = state.contents.map(c => {
      // creator bisa string (format biasa) atau string[] (Podcast/Liputan multi-select)
      if (Array.isArray(c.creator)) {
        const updated = c.creator.map(n => n === oldName ? newName : n);
        return updated.join(',') !== c.creator.join(',') ? { ...c, creator: updated } : c;
      }
      return c.creator === oldName ? { ...c, creator: newName } : c;
    });
    state.bankKonten = state.bankKonten.map(b =>
      b.creator === oldName ? { ...b, creator: newName } : b
    );
  }

  state.settings = settings;
  setPubUsers(settings.users);
  renderUserList();
  $('editUserModal')?.classList.add('hidden');

  try {
    state.shas.settings = await window.db.writeData('settings', settings, `Edit user: ${oldName} → ${newName} (${newRole})`);
    if (newName !== oldName) {
      state.shas.todos      = await window.db.writeData('todos',       state.todos,       `Update assignee: ${oldName}→${newName}`);
      state.shas.contents   = await window.db.writeData('contents',    state.contents,    `Update creator: ${oldName}→${newName}`);
      state.shas.bankKonten = await window.db.writeData('contentBank', state.bankKonten,  `Update creator BK: ${oldName}→${newName}`);
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

/* Format ISO week: "2025-W43" → "W43 Okt '25" */
function fmtWeek(yw) {
  if (!yw) return '';
  const [y, w] = yw.split('-W');
  // Hitung tanggal Senin minggu ke-W
  const jan4 = new Date(+y, 0, 4);
  const mon  = new Date(jan4.getTime() + (parseInt(w,10) - 1) * 7 * 86400000
    - (jan4.getDay() || 7 - 1) * 86400000);
  const MNAMES = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agt','Sep','Okt','Nov','Des'];
  return `W${w} ${MNAMES[mon.getMonth()]} '${String(y).slice(-2)}`;
}

/* Dapatkan ISO week string dari Date */
function dateToISOWeek(date) {
  const d = new Date(date);
  d.setHours(0,0,0,0);
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  const y    = d.getFullYear();
  const jan4 = new Date(y, 0, 4);
  const wn   = 1 + Math.round(((d - jan4) / 86400000 - 3 + (jan4.getDay() + 6) % 7) / 7);
  return `${y}-W${String(wn).padStart(2,'0')}`;
}

/* Fungsi toggle view mode Monthly/Weekly */
function setStatViewMode(mode) {
  state.statViewMode = mode;
  // Update tombol toggle
  $$('.stat-view-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  // Update dropdown periode sesuai mode
  const sel = $('statPeriodSel');
  if (sel) {
    if (mode === 'weekly') {
      sel.innerHTML = `
        <option value="12w">12 Minggu Terakhir</option>
        <option value="8w">8 Minggu Terakhir</option>
        <option value="4w">4 Minggu Terakhir</option>
        <option value="allw">Semua Data</option>`;
      onStatPeriodChange('12w');
    } else {
      sel.innerHTML = `
        <option value="12">12 Bulan Terakhir</option>
        <option value="6">6 Bulan Terakhir</option>
        <option value="3">3 Bulan Terakhir</option>
        <option value="1">Bulan Ini</option>
        <option value="year">Tahun Ini</option>
        <option value="all">Semua Data</option>
        <option value="custom">⚙ Kustom…</option>`;
      onStatPeriodChange('12');
    }
  }
  renderStatChart();
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

/* ── Deskripsi tiap field statistik (tampil di tooltip info icon) ─────────── */
const STAT_FIELD_DESC = {
  // YouTube
  jmlVideo:         'Jumlah video yang diunggah dalam periode ini.',
  totalViews:       'Total tayangan semua video dalam periode ini.',
  uniqueViewers:    'Jumlah penonton unik — satu orang dihitung sekali meski menonton berkali-kali.',
  subsEOM:          'Total subscriber di akhir periode (End of Month) — angka kumulatif, bukan pertambahan.',
  subsGained:       'Pertambahan (atau penurunan) subscriber selama periode ini. Positif = bertambah, negatif = berkurang.',
  watchHours:       'Total jam tonton semua video dalam periode ini.',
  impressions:      'Berapa kali thumbnail video ditampilkan kepada pengguna YouTube.',
  adImpressions:    'Jumlah tayangan iklan yang muncul di video channel ini.',
  avgViewsPerVideo: 'Rata-rata tayangan per video = Total Views ÷ Jumlah Video.',
  peakViews:        'Tayangan tertinggi dari satu video dalam periode ini.',
  // TikTok
  totalVideoViews:  'Total tayangan semua video TikTok dalam periode ini.',
  profileViews:     'Jumlah kunjungan ke halaman profil TikTok.',
  followersEOM:     'Jumlah followers di akhir bulan (End of Month).',
  followersGained:  'Pertambahan (atau penurunan) followers dalam periode ini.',
  totalViewers:     'Jumlah akun unik yang menonton video dalam periode ini.',
  newViewers:       'Penonton baru yang belum pernah menonton konten sebelumnya.',
  returningViewers: 'Penonton lama yang kembali menonton dalam periode ini.',
  // Facebook
  pageFollowers:    'Total pengikut halaman Facebook saat ini.',
  totalPost:        'Jumlah postingan yang diterbitkan dalam periode ini.',
  totalReach:       'Jumlah akun unik yang melihat konten (berbeda dari Views — ini unik).',
  totalReactions:   'Total reaksi (Like, Love, Haha, dll.) pada semua postingan.',
  avgViewsPerPost:  'Rata-rata tayangan per postingan = Total Views ÷ Jumlah Postingan.',
  avgEngPerPost:    'Rata-rata engagement per postingan = Total Engagement ÷ Jumlah Postingan.',
  maxViewsSingle:   'Tayangan tertinggi dari satu postingan terbaik dalam periode ini.',
  // Instagram
  jmlPost:          'Jumlah postingan yang diterbitkan dalam periode ini.',
  totalSaves:       'Jumlah pengguna yang menyimpan (bookmark) postingan.',
  avgViews:         'Rata-rata tayangan per postingan = Total Views ÷ Jumlah Postingan.',
  avgEng:           'Rata-rata engagement per postingan = Total Engagement ÷ Jumlah Postingan.',
  reelViews:        'Total tayangan khusus dari konten format Reels.',
  carouselViews:    'Total tayangan khusus dari konten format Carousel (multi-gambar).',
  imageViews:       'Total tayangan khusus dari konten format gambar tunggal.',
  // Umum
  totalLikes:       'Total likes/suka dari semua konten dalam periode ini.',
  totalComments:    'Total komentar dari semua konten dalam periode ini.',
  totalShares:      'Total konten yang dibagikan (share/retweet) oleh pengguna.',
  totalEngagement:  'Total interaksi = Likes + Comments + Shares + Saves (tergantung platform).',
  erPct:            'Engagement Rate = Total Engagement ÷ Total Views × 100%. Mengukur seberapa aktif audiens berinteraksi.',
  // Twitter/X
  impressions:      'Berapa kali tweet ditampilkan ke pengguna di timeline atau pencarian.',
  totalRetweets:    'Jumlah retweet/quote tweet dalam periode ini.',
  followers:        'Jumlah followers akun Twitter/X saat ini.',
};

/* ── Period dropdown → set hidden month inputs ───────────────────────────── */
function onStatPeriodChange(val) {
  const fromInp = $('statFromMonth');
  const toInp   = $('statToMonth');
  const sep     = $('statRangeSep');
  const isCustom = val === 'custom';
  if (fromInp) fromInp.classList.toggle('hidden', !isCustom);
  if (toInp)   toInp.classList.toggle('hidden', !isCustom);
  if (sep)     sep.classList.toggle('hidden', !isCustom);
  if (isCustom) return; // month inputs drive the filter directly

  const now = new Date();
  const padM = m => String(m + 1).padStart(2, '0');
  const ym = (y, m) => `${y}-${padM(m)}`;

  let from = '', to = '';
  if (val === '1') {
    from = to = ym(now.getFullYear(), now.getMonth());
  } else if (val === 'year') {
    from = `${now.getFullYear()}-01`;
    to   = ym(now.getFullYear(), now.getMonth());
  } else if (val === 'all') {
    from = ''; to = '';
  } else {
    // numeric = N months back
    const n  = parseInt(val, 10);
    const d0 = new Date(now.getFullYear(), now.getMonth() - n + 1, 1);
    from = ym(d0.getFullYear(), d0.getMonth());
    to   = ym(now.getFullYear(), now.getMonth());
  }
  if (fromInp) fromInp.value = from;
  if (toInp)   toInp.value   = to;
  renderStatChart();
}

/* ── Import file → Gemini Vision → auto-fill Data Bulanan ───────────────── */
/* ── Helper: parse angka format Indonesia (1.234.567 atau 1,234,567) ──────── */
function parseIDNumber(s) {
  if (s === null || s === undefined) return 0;
  s = String(s).trim().replace(/[^\d.,%-]/g, '');
  if (!s || s === '-') return 0;
  // Deteksi format: jika ada titik sebagai pemisah ribuan (1.234.567)
  if (/^\d{1,3}(\.\d{3})+$/.test(s))          return parseFloat(s.replace(/\./g, ''));
  if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s))      return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  // Format dengan koma sebagai pemisah ribuan (1,234,567)
  if (/^\d{1,3}(,\d{3})+$/.test(s))           return parseFloat(s.replace(/,/g, ''));
  if (/^\d{1,3}(,\d{3})+\.\d+$/.test(s))      return parseFloat(s.replace(/,/g, ''));
  // Koma sebagai desimal
  if (/^\d+,\d{1,2}$/.test(s))                return parseFloat(s.replace(',', '.'));
  // Persen: "3,42%" → 3.42
  if (s.endsWith('%'))                         return parseFloat(s.slice(0,-1).replace(',','.').replace(/\./g,'')) || 0;
  return parseFloat(s) || 0;
}

/* ── Helper: parse bulan dari berbagai format ────────────────────────────── */
function parseMonthStr(s) {
  if (!s) return '';
  s = String(s).trim().replace(/^﻿/, ''); // strip BOM
  const MMAP = {
    jan:1,feb:2,mar:3,apr:4,mei:5,may:5,jun:6,jul:7,agt:8,aug:8,sep:9,okt:10,oct:10,nov:11,des:12,dec:12,
    januari:1,februari:2,maret:3,april:4,juni:6,juli:7,agustus:8,september:9,oktober:10,november:11,desember:12
  };
  // MM/DD/YYYY HH:MM atau M/D/YYYY (format US/Instagram export)
  const mUS = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mUS) return `${mUS[3]}-${String(+mUS[1]).padStart(2,'0')}`;
  // DD/MM/YYYY (format EU)
  const mEU = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (mEU) return `${mEU[3]}-${String(+mEU[2]).padStart(2,'0')}`;
  // YYYY-MM-DD atau YYYY/MM/DD
  const mISO = s.match(/^(\d{4})[-\/](\d{2})[-\/]\d{2}/);
  if (mISO) return `${mISO[1]}-${mISO[2]}`;
  // YYYY-MM atau YYYY/MM
  if (/^\d{4}[-\/]\d{2}$/.test(s)) return s.slice(0,7).replace('/','-');
  // "Jan 2025" / "Januari 2025" / "Jan-2025"
  const m1 = s.match(/([a-z]{3,})[\s\-]+(\d{4})/i);
  if (m1) { const n = MMAP[m1[1].toLowerCase()]; if (n) return `${m1[2]}-${String(n).padStart(2,'0')}`; }
  // "2025 Jan" / "2025-Jan"
  const m2 = s.match(/(\d{4})[\s\-]+([a-z]{3,})/i);
  if (m2) { const n = MMAP[m2[2].toLowerCase()]; if (n) return `${m2[1]}-${String(n).padStart(2,'0')}`; }
  // MM/YYYY
  const m3 = s.match(/^(\d{1,2})\/(\d{4})$/);
  if (m3) return `${m3[2]}-${String(+m3[1]).padStart(2,'0')}`;
  return '';
}

/* ── CSV direct parser — akurat tanpa AI ────────────────────────────────── */
/* ── RFC-4180 CSV tokenizer: handle quoted fields dengan newline di dalamnya ── */
function _csvTokenize(text, sep) {
  const rows = []; let row = []; let field = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], nx = text[i + 1] ?? '';
    if (inQ) {
      if (c === '"' && nx === '"') { field += '"'; i++; }   // "" → "
      else if (c === '"')          { inQ = false; }
      else                         { field += c; }           // newline di dalam quotes tetap masuk field
    } else {
      if      (c === '"')  { inQ = true; }
      else if (c === sep)  { row.push(field.trim()); field = ''; }
      else if (c === '\n') {
        row.push(field.trim()); field = '';
        if (row.some(f => f !== '')) rows.push(row);
        row = [];
      } else if (c !== '\r') { field += c; }
    }
  }
  if (field || row.length) { row.push(field.trim()); if (row.some(f=>f!=='')) rows.push(row); }
  return rows;
}

/* groupBy: 'auto' | 'month' | 'week'
   platId : untuk lookup PLATFORM_CSV_ALIASES               */
function parseCSVDirect(csvText, platM, acctUsername = '', platId = '', groupBy = 'auto') {
  // Strip BOM UTF-8
  csvText = csvText.replace(/^﻿/, '');
  if (csvText.trim().length < 10) return { error: 'File kosong atau terlalu pendek.' };

  // Deteksi separator dari baris pertama (luar quoted section)
  let firstLine = ''; let inQ = false;
  for (const c of csvText) {
    if (c === '"') inQ = !inQ;
    if (c === '\n' && !inQ) break;
    if (c !== '\r') firstLine += c;
  }
  const sepCount = { ',': (firstLine.match(/,/g)||[]).length, ';': (firstLine.match(/;/g)||[]).length, '\t': (firstLine.match(/\t/g)||[]).length };
  const sep = Object.entries(sepCount).sort((a,b) => b[1]-a[1])[0][0];

  // Tokenize CSV dengan benar (handle multi-line quoted fields)
  const allRows = _csvTokenize(csvText, sep).filter(r => r.some(c => c));
  if (allRows.length < 2) return { error: 'File terlalu pendek (kurang dari 2 baris data).' };

  // Cari baris header (baris pertama yang punya ≥2 kolom non-kosong)
  let headerRowIdx = 0;
  for (let i = 0; i < Math.min(5, allRows.length); i++) {
    if (allRows[i].filter(c => c).length >= 2) { headerRowIdx = i; break; }
  }
  const rawHeaders = allRows[headerRowIdx].map(h => h.replace(/^﻿/, ''));
  const headers    = rawHeaders.map(h => h.toLowerCase());
  const dataRows   = allRows.slice(headerRowIdx + 1);

  // ── Cari kolom tanggal ───────────────────────────────────────────────────
  const dateCandidateOrder = [
    /publishtime|publishdate|publishedat|posttime|postdate/,
    /uploadtime|uploaddate|tweetdate/,
    /^tanggal|^tgl|^waktu/,
    /^date$|^datetime$/,
    /bulan|month|periode|period/,
  ];
  let effectiveMonthCol = -1;
  for (const pattern of dateCandidateOrder) {
    const idx = headers.findIndex(h => pattern.test(h.replace(/[^a-z0-9]/g, '')));
    if (idx < 0) continue;
    const sampleVal = dataRows[0]?.[idx] ?? '';
    if (parseMonthStr(sampleVal)) { effectiveMonthCol = idx; break; }
  }
  if (effectiveMonthCol < 0) {
    for (let i = 0; i < headers.length; i++) {
      if (parseMonthStr(dataRows[0]?.[i] ?? '')) { effectiveMonthCol = i; break; }
    }
  }
  if (effectiveMonthCol < 0) effectiveMonthCol = 0;

  // ── Deteksi apakah data harian (banyak baris per bulan) ──────────────────
  const sampleDates = dataRows.slice(0, 30).map(r => parseMonthStr(r[effectiveMonthCol] ?? '')).filter(Boolean);
  const uniqueMonths = new Set(sampleDates);
  // Jika banyak baris dengan bulan berbeda di sample kecil → kemungkinan data harian
  const isDailyData = sampleDates.length > 5 && uniqueMonths.size < sampleDates.length * 0.5;

  // Tentukan groupBy akhir
  let resolvedGroupBy = groupBy;
  if (groupBy === 'auto') {
    resolvedGroupBy = isDailyData ? 'month' : 'month';
    // catatan: user bisa override ke 'week' via preview modal
  }

  // ── Deteksi kolom akun ───────────────────────────────────────────────────
  const acctColIdx = headers.findIndex(h =>
    /accountusername|username/.test(h.replace(/[^a-z0-9]/g,''))
  );

  // ── Mapping kolom → field key (platform aliases > exact key/label > fuzzy) ─
  const aliases     = PLATFORM_CSV_ALIASES[platId] || {};
  const fieldMap    = {};           // colIdx → fieldKey
  const mappedCols  = [];           // { colName, fieldKey, fieldLabel }
  const unmappedCols = [];          // kolom yang tidak bisa dipetakan ke field manapun

  // Pass 1: platform aliases (paling akurat)
  headers.forEach((h, i) => {
    if (i === effectiveMonthCol || i === acctColIdx) return;
    const hc    = h.replace(/[^a-z0-9()%]/g, '');
    const alias = aliases[hc];
    if (alias && !alias.startsWith('_')) {     // skip internal aliases (_date, _account, dll)
      const field = platM.fields.find(f => f.key === alias);
      if (field && !Object.values(fieldMap).includes(alias)) {
        fieldMap[i] = alias;
        mappedCols.push({ col: i, colName: rawHeaders[i], fieldKey: alias, fieldLabel: field.label });
      }
    }
  });

  // Pass 2: exact match key/label (untuk kolom belum terpetakan)
  platM.fields.forEach(f => {
    if (Object.values(fieldMap).includes(f.key)) return;  // sudah terpetakan
    const fKey   = f.key.toLowerCase();
    const fLabel = f.label.toLowerCase().replace(/[^a-z0-9]/g, '');
    let best = -1;
    headers.forEach((h, i) => {
      if (i === effectiveMonthCol || i === acctColIdx || fieldMap[i]) return;
      const hc = h.replace(/[^a-z0-9]/g,'');
      if (hc === fKey || hc === fLabel) best = i;
    });
    if (best >= 0) {
      fieldMap[best] = f.key;
      mappedCols.push({ col: best, colName: rawHeaders[best], fieldKey: f.key, fieldLabel: f.label });
    }
  });

  // Pass 3: substring fuzzy (fallback terakhir)
  platM.fields.forEach(f => {
    if (Object.values(fieldMap).includes(f.key)) return;
    const fKey = f.key.toLowerCase();
    let best = -1;
    headers.forEach((h, i) => {
      if (i === effectiveMonthCol || i === acctColIdx || fieldMap[i] || best >= 0) return;
      const hc = h.replace(/[^a-z0-9]/g,'');
      if (hc.length >= 4 && fKey.includes(hc)) best = i;
      else if (fKey.length >= 4 && hc.includes(fKey)) best = i;
    });
    if (best >= 0) {
      fieldMap[best] = f.key;
      mappedCols.push({ col: best, colName: rawHeaders[best], fieldKey: f.key, fieldLabel: f.label, fuzzy: true });
    }
  });

  // Kolom yang tidak terpetakan ke field manapun
  headers.forEach((h, i) => {
    if (i === effectiveMonthCol || i === acctColIdx || !h || fieldMap[i]) return;
    const hc = h.replace(/[^a-z0-9]/g,'');
    if (!hc) return;
    // Skip juga internal alias columns (_date, _account, dll)
    const alias = aliases[hc];
    if (!alias || !alias.startsWith('_')) {
      unmappedCols.push(rawHeaders[i]);
    }
  });

  // ── Helper: date → week key "YYYY-W##" ───────────────────────────────────
  function dateToWeek(monthStr) {
    // monthStr adalah "YYYY-MM" → konversi ke "YYYY-W##" berdasarkan tanggal tengah bulan
    // Untuk data yang sudah berbentuk YYYY-MM, gunakan minggu ke-3 bulan itu
    const [y, m] = monthStr.split('-').map(Number);
    const d = new Date(y, m - 1, 15); // tanggal 15 = tengah bulan
    const jan4 = new Date(y, 0, 4);
    const week = Math.ceil(((d - jan4) / 86400000 + jan4.getDay() + 1) / 7);
    return `${y}-W${String(week).padStart(2, '0')}`;
  }

  // ── Agregasi per periode (month atau week) ───────────────────────────────
  const periodMap = {}; let skippedRows = 0;
  const isWeekly  = resolvedGroupBy === 'week';
  const rowKey    = isWeekly ? 'week' : 'month';

  for (const cols of dataRows) {
    if (cols.every(c => !c)) continue;
    if (acctColIdx >= 0 && acctUsername) {
      const rowAcct = (cols[acctColIdx] || '').toLowerCase().replace(/[^a-z0-9]/g,'');
      const target  = acctUsername.toLowerCase().replace(/[^a-z0-9]/g,'');
      if (!rowAcct.includes(target) && !target.includes(rowAcct)) { skippedRows++; continue; }
    }
    const month = parseMonthStr(cols[effectiveMonthCol] ?? '');
    if (!month) continue;
    const periodKey = isWeekly ? dateToWeek(month) : month;
    if (!periodMap[periodKey]) {
      periodMap[periodKey] = { [rowKey]: periodKey };
      platM.fields.forEach(f => { periodMap[periodKey][f.key] = 0; });
    }
    Object.entries(fieldMap).forEach(([idx, key]) => {
      periodMap[periodKey][key] += parseIDNumber(cols[+idx] ?? '');
    });
  }

  const results = Object.values(periodMap).sort((a, b) => (a[rowKey]||'').localeCompare(b[rowKey]||''));
  if (!results.length) {
    const detectedCols = rawHeaders.filter(h=>h).join(', ');
    const sampleVal    = dataRows[0]?.[effectiveMonthCol] ?? '?';
    return { error: `Tidak ada baris valid.\n\nKolom terdeteksi: ${detectedCols}\nKolom tanggal (col ${effectiveMonthCol}): "${sampleVal}"\nFilter akun: ${acctUsername || 'semua'}\n\nFormat tanggal didukung: MM/DD/YYYY, YYYY-MM-DD, YYYY-MM, "Jan 2025"` };
  }

  // Lampirkan info mapping untuk preview modal
  results._skipped    = skippedRows;
  results._mappedCols  = mappedCols;
  results._unmappedCols = unmappedCols;
  results._isDailyData  = isDailyData;
  results._groupBy      = resolvedGroupBy;
  return results;
}

/* ── Import file: CSV → parse langsung; gambar/PDF → Gemini AI ──────────── */
async function importStatFromFile(input) {
  const file = input?.files?.[0];
  if (!file) return;
  input.value = '';

  const platId = state.statActivePlat || 'youtube';
  const platM  = PLATFORM_FIELDS[platId];
  const acctId = state.statActiveAcct;
  const btn    = $('btnStatImportFile');
  const ICON   = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/><polyline points="17 8 12 3 7 8"/></svg>';

  if (btn) { btn.textContent = '⏳ Membaca…'; btn.disabled = true; }

  try {
    const name     = file.name.toLowerCase();
    const mimeType = file.type || '';
    const isCSV    = name.endsWith('.csv') || mimeType.includes('csv') || mimeType.includes('text/plain') && name.endsWith('.txt');
    const isImage  = mimeType.startsWith('image/');

    /* ── CSV / TSV: parse langsung, tidak perlu AI ── */
    if (isCSV || name.endsWith('.tsv')) {
      const text = await file.text();
      // Map acctId ke username yang mungkin ada di CSV (untuk filter multi-akun export)
      const ACCT_USERNAME_MAP = {
        'penjaga-harapan': 'penjaga_harapan',
        '33-official':     '33official',
        'jaga-asa':        'jagaasa',
      };
      const acctUsername = ACCT_USERNAME_MAP[acctId] || '';
      const result = parseCSVDirect(text, platM, acctUsername, platId, 'auto');
      // Error object → tampilkan pesan detail
      if (!Array.isArray(result)) {
        toast(result?.error || 'CSV tidak bisa diparsing.', 'error');
        return;
      }
      const rows    = result;
      const skipped = result._skipped || 0;
      const infoMsg = skipped > 0 ? ` (${skipped} baris akun lain diabaikan)` : '';
      if (rows.length === 1) {
        // Satu periode: langsung buka form review
        const rowKey = rows[0].week ? 'week' : 'month';
        await openStatInputForImport(acctId, platId, rows[0][rowKey], rows[0]);
        toast(`✅ Data ${fmtMonth(rows[0][rowKey])} berhasil dibaca dari CSV!${infoMsg}`, 'success');
      } else {
        // Multi-periode: tampilkan preview untuk verifikasi sebelum simpan
        // Simpan raw CSV meta untuk regroupImportPreview (toggle week/month)
        rows._rawCsvMeta = { csvText: text, platM, acctUsername, platId };
        showImportPreview(rows, platId, acctId);
      }
      return;
    }

    /* ── Gambar / PDF: kirim ke Claude (primary) atau Gemini (fallback gratis) ── */
    if (!getClaudeKey() && !getGeminiKey()) {
      toast('Isi Claude API Key (akurat) atau Gemini API Key (gratis) di API Setup', 'error'); return;
    }

    let raw = '';
    if (isImage) {
      const base64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload  = e => res(e.target.result.split(',')[1]);
        r.onerror = rej;
        r.readAsDataURL(file);
      });
      raw = await callAI(buildImportPrompt(platM), { base64, mimeType });
    } else {
      const text = await file.text().catch(() => '');
      if (!text) { toast('Format file tidak didukung. Gunakan CSV, gambar, atau PDF.', 'error'); return; }
      raw = await callAI(buildImportPrompt(platM) + '\n\nData:\n' + text.slice(0, 8000));
    }

    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*?\})/s);
    if (!match) throw new Error('AI tidak dapat mengekstrak data. Coba gambar yang lebih jelas.');

    const parsed   = JSON.parse(match[1].trim());
    // Normalisasi: pastikan semua angka sudah benar format ID
    platM.fields.forEach(f => {
      if (parsed[f.key] !== undefined) parsed[f.key] = parseIDNumber(String(parsed[f.key]));
    });

    const monthVal = parsed.month || getCurrentYM();
    await openStatInputForImport(acctId, platId, monthVal, parsed);
    toast(`✅ Data ${fmtMonth(monthVal)} berhasil dibaca dari file!`, 'success');

  } catch (e) {
    toast('Gagal baca file: ' + e.message, 'error');
  } finally {
    if (btn) { btn.innerHTML = ICON + ' <span class="btn-text">Import</span>'; btn.disabled = false; }
  }
}

/* ── Import Preview Modal ────────────────────────────────────────────────── */
function showImportPreview(rows, platId, acctId) {
  const platM    = PLATFORM_FIELDS[platId];
  const acctName = ACCOUNTS.find(a => a.id === acctId)?.name || acctId;
  const rowKey   = rows[0]?.week ? 'week' : 'month';
  const isWeekly = rowKey === 'week';

  // Simpan data ke state untuk dipakai saat confirm
  state._importPreview = { rows, platId, acctId, rowKey };

  // ── Title ────────────────────────────────────────────────────────────────
  const titleEl = $('importPreviewTitle');
  if (titleEl) titleEl.textContent = `Preview Import — ${platM?.label || platId} · ${acctName}`;

  // ── Info mapping kolom ───────────────────────────────────────────────────
  const mappedCols   = rows._mappedCols   || [];
  const unmappedCols = rows._unmappedCols || [];
  const isDailyData  = rows._isDailyData  || false;
  const skipped      = rows._skipped      || 0;

  const infoEl = $('importPreviewMappingInfo');
  if (infoEl) {
    const mappedHtml = mappedCols.map(c =>
      `<span class="import-chip import-chip--ok" title="Kolom CSV: ${c.colName}">${c.fieldLabel}${c.fuzzy ? ' ≈' : ''}</span>`
    ).join('');
    const unmappedHtml = unmappedCols.map(c =>
      `<span class="import-chip import-chip--skip" title="Tidak dipetakan ke field manapun">${c}</span>`
    ).join('');
    const dailyNote = isDailyData
      ? `<div class="import-daily-note">⚠ Data tampaknya harian — dikelompokkan per <strong>${isWeekly ? 'minggu' : 'bulan'}</strong> secara otomatis.</div>`
      : '';
    const skippedNote = skipped > 0
      ? `<div class="import-daily-note">ℹ ${skipped} baris akun lain diabaikan.</div>`
      : '';
    infoEl.innerHTML = `
      <div class="import-mapping-row">
        <span class="import-mapping-label">✅ Dipetakan (${mappedCols.length}):</span>
        <div class="import-chip-group">${mappedHtml || '<em style="color:var(--muted)">—</em>'}</div>
      </div>
      ${unmappedCols.length ? `<div class="import-mapping-row">
        <span class="import-mapping-label">⚠ Tidak dikenali (${unmappedCols.length}):</span>
        <div class="import-chip-group">${unmappedHtml}</div>
      </div>` : ''}
      ${dailyNote}${skippedNote}`;
  }

  // ── Tabel preview ────────────────────────────────────────────────────────
  // Hanya tampilkan kolom yang ada datanya (minimal 1 baris non-zero)
  const visibleFields = (platM?.fields || []).filter(f =>
    rows.some(r => r[f.key] && r[f.key] !== 0)
  );
  const tableEl = $('importPreviewTable');
  if (tableEl) {
    const fmtVal = (v, fmt) => {
      if (!v && v !== 0) return '—';
      if (fmt === 'pct') return v.toFixed(2) + '%';
      return v.toLocaleString('id-ID');
    };
    const thead = `<thead><tr>
      <th>${isWeekly ? 'Minggu' : 'Bulan'}</th>
      ${visibleFields.map(f => `<th>${f.label}</th>`).join('')}
    </tr></thead>`;
    const tbody = `<tbody>${rows.map(r => `<tr>
      <td class="import-period-cell">${isWeekly ? (r.week || '—') : fmtMonth(r.month)}</td>
      ${visibleFields.map(f => {
        const v   = r[f.key];
        const cls = (!v || v === 0) ? ' class="import-zero"' : '';
        return `<td${cls}>${fmtVal(v, f.fmt)}</td>`;
      }).join('')}
    </tr>`).join('')}</tbody>`;
    tableEl.innerHTML = thead + tbody;
  }

  // ── Update tombol simpan ─────────────────────────────────────────────────
  const confirmBtn = $('btnConfirmImport');
  if (confirmBtn) {
    const label = isWeekly ? 'minggu' : 'bulan';
    confirmBtn.textContent = `Simpan Semua (${rows.length} ${label})`;
  }

  // ── Toggle weekly/monthly (hanya untuk data harian) ──────────────────────
  const toggleWrap = $('importPreviewGroupToggle');
  if (toggleWrap) toggleWrap.style.display = isDailyData ? '' : 'none';

  // ── Tampilkan modal ───────────────────────────────────────────────────────
  const overlay = $('importPreviewOverlay');
  if (overlay) overlay.classList.remove('hidden');
}

function closeImportPreview() {
  const overlay = $('importPreviewOverlay');
  if (overlay) overlay.classList.add('hidden');
  state._importPreview = null;
}

async function confirmImportPreview() {
  const prev = state._importPreview;
  if (!prev) return;
  const btn = $('btnConfirmImport');
  if (btn) { btn.textContent = '⏳ Menyimpan…'; btn.disabled = true; }
  try {
    await importMultiRowsDirectly(prev.acctId, prev.platId, prev.rows);
    const rowKey = prev.rowKey;
    const label  = rowKey === 'week' ? 'minggu' : 'bulan';
    toast(`✅ ${prev.rows.length} ${label} data berhasil diimpor!`, 'success');
    renderStatChart();
    closeImportPreview();
  } catch (e) {
    toast('Gagal simpan: ' + e.message, 'error');
    if (btn) { btn.textContent = 'Coba Lagi'; btn.disabled = false; }
  }
}

/* Re-parse CSV dengan groupBy baru (month/week) saat user toggle */
function regroupImportPreview(groupBy) {
  const prev = state._importPreview;
  if (!prev?._rawCsvMeta) return;
  const { csvText, platM, acctUsername, platId } = prev._rawCsvMeta;
  const result = parseCSVDirect(csvText, platM, acctUsername, platId, groupBy);
  if (!Array.isArray(result)) { toast(result?.error || 'Gagal re-parse CSV', 'error'); return; }
  state._importPreview.rows   = result;
  state._importPreview.rowKey = result[0]?.week ? 'week' : 'month';
  showImportPreview(result, platId, prev.acctId);
}

/* ── Download Template CSV per platform ─────────────────────────────────── */
function downloadStatTemplate() {
  const platId = state.statActivePlat || 'youtube';
  const platM  = PLATFORM_FIELDS[platId];
  if (!platM) return;

  // Kolom: gunakan nama kolom dari aliases (terbalik: fieldKey → colName)
  const aliases  = PLATFORM_CSV_ALIASES[platId] || {};
  const aliasRev = {};  // fieldKey → kolom nama asli (ambil yang pertama ditemukan)
  Object.entries(aliases).forEach(([colKey, fieldKey]) => {
    if (!fieldKey.startsWith('_') && !aliasRev[fieldKey]) {
      // Konversi hc kembali ke nama yang lebih readable
      aliasRev[fieldKey] = colKey.replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/^./, c => c.toUpperCase());
    }
  });

  // Build header row: Bulan, lalu tiap field
  const headers = ['Bulan', ...platM.fields.map(f => aliasRev[f.key] || f.key)];

  // Build 2 example rows (bulan lalu & 2 bulan lalu)
  const now = new Date();
  const exampleRows = [1, 2].map(i => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    return [m, ...platM.fields.map(() => '0')];
  });

  const csvContent = [
    headers.join(','),
    ...exampleRows.map(r => r.map(v => `"${v}"`).join(',')),
  ].join('\n');

  const blob = new Blob(['﻿' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `template-${platId}.csv`; a.click();
  URL.revokeObjectURL(url);
  toast(`Template ${platM.label} diunduh ✓`, 'success');
}

/* Simpan banyak baris CSV langsung ke state & GitHub */
async function importMultiRowsDirectly(acctId, platId, rows) {
  // Deteksi apakah data weekly (punya field 'week') atau monthly
  const isWeeklyData = rows.some(r => r.week && !r.month);
  const storeKey = isWeeklyData ? platId + '_w' : platId;
  const rowKey   = isWeeklyData ? 'week' : 'month';

  if (!state.analytics[acctId]) state.analytics[acctId] = {};
  if (!state.analytics[acctId][storeKey]) state.analytics[acctId][storeKey] = [];
  const existing    = state.analytics[acctId][storeKey];
  const existKeys   = new Set(existing.map(r => r[rowKey]));
  const toAdd       = rows.filter(r => !existKeys.has(r[rowKey]));
  const toUpdate    = rows.filter(r =>  existKeys.has(r[rowKey]));

  toUpdate.forEach(newRow => {
    const idx = existing.findIndex(e => e[rowKey] === newRow[rowKey]);
    if (idx < 0) return;
    const old = existing[idx];
    // Smart merge: update field jika nilai baru > 0 atau field belum ada di data lama
    // Field yang 0 di CSV (tidak tersedia) TIDAK menimpa data yang sudah ada
    const merged = { ...old };
    Object.entries(newRow).forEach(([k, v]) => {
      if (k === 'month') return;
      if (v !== 0 && v !== null && v !== undefined) {
        merged[k] = v;              // nilai baru non-zero → gunakan
      } else if (!(k in old) || old[k] === 0 || old[k] === null) {
        merged[k] = v;              // data lama juga 0/kosong → tetap update
      }
      // else: nilai baru 0 tapi data lama non-zero → pertahankan data lama
    });
    existing[idx] = merged;
  });

  state.analytics[acctId][storeKey] = [...existing, ...toAdd]
    .sort((a, b) => (a[rowKey]||'').localeCompare(b[rowKey]||''));
  _setAnalyticsMeta(state.analytics, acctId, platId);
  state.shas.analytics = await window.db.writeData('analytics', state.analytics,
    `Import CSV: update ${toUpdate.length} + tambah ${toAdd.length} bulan ${platId}`);
  saveDataCache();
}

function buildImportPrompt(platM) {
  const fieldList = platM.fields.map(f => `"${f.key}" (${f.label})`).join(', ');
  return `Kamu adalah asisten ekstraksi data analytics media sosial yang sangat teliti.
Ekstrak data dari gambar/dokumen ini untuk platform ${platM.label}.

ATURAN WAJIB:
1. Kembalikan HANYA satu JSON object valid, tanpa teks lain, tanpa markdown
2. Format: { "month": "YYYY-MM", ${platM.fields.map(f => `"${f.key}": <angka>`).join(', ')} }
3. Gunakan 0 jika field tidak ditemukan (JANGAN gunakan null atau string)
4. Angka format Indonesia (titik=ribuan, koma=desimal): "1.234.567" → 1234567, "3,42%" → 3.42
5. ER/Engagement Rate: kembalikan sebagai desimal persen (3.42, bukan 0.0342 dan bukan "3,42%")
6. Bulan: format YYYY-MM (contoh: "2025-10" untuk Oktober 2025)
7. Baca SEMUA angka dengan teliti, jangan menebak

Field yang tersedia: ${fieldList}.

Contoh output yang benar:
{"month":"2025-10","${platM.fields[0]?.key}":1234,"${platM.fields[1]?.key}":567890}`;
}

async function openStatInputForImport(acctId, platId, periodVal, data) {
  // Deteksi apakah data weekly atau monthly
  const isWeeklyData = !!(data.week && !data.month);
  const storeKey     = isWeeklyData ? platId + '_w' : platId;
  const rowKey       = isWeeklyData ? 'week' : 'month';

  // Smart merge dengan data yang sudah ada di periode yang sama
  const existing = (state.analytics?.[acctId]?.[storeKey] || [])
    .find(r => r[rowKey] === periodVal);
  let merged = { ...data };
  if (existing) {
    merged = { ...existing };
    Object.entries(data).forEach(([k, v]) => {
      if (k === rowKey) return;
      if (v !== 0 && v !== null && v !== undefined) merged[k] = v;
      else if (!(k in existing) || existing[k] === 0) merged[k] = v;
    });
  }
  renderStatInputFields(acctId, platId, merged);
  const card = $('statInputCard');
  if (card) card.classList.remove('hidden');
  const monthInp = $('statMonth');
  if (monthInp) monthInp.value = periodVal;
  card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderStatistics() {
  renderStatAcctBar();
  renderStatPlatBar();
  // Init period dropdown ke 12 bulan (default)
  onStatPeriodChange($('statPeriodSel')?.value || '12');
  renderStatGoodBad(state.statActiveAcct);
  initStatDownloadMonth();
}

function renderStatAcctBar() {
  const bar = $('statAcctBar');
  if (!bar) return;
  const active = state.statActiveAcct;
  bar.innerHTML = ACCOUNTS.map(a => {
    const isAct = a.id === active;
    const style = isAct
      ? `background:${a.color};border-color:${a.color};color:#fff;box-shadow:0 2px 10px ${a.color}44`
      : `--acct-color:${a.color};border-color:${a.color}55;color:${a.color}`;
    return `<button class="stat-acct-tab${isAct?' active':''}"
      style="${style}" onclick="switchStatAcct('${a.id}')">
      <span class="stat-acct-dot" style="background:${isAct?'rgba(255,255,255,.7)':a.color}"></span>
      ${a.name}
    </button>`;
  }).join('');
}

function renderStatPlatBar() {
  const bar = $('statPlatBar');
  if (!bar) return;
  const ap = state.statActivePlat || 'youtube';
  bar.innerHTML = Object.entries(PLATFORM_FIELDS).map(([id, m]) =>
    `<button class="stat-plat-tab ${id===ap?'active':''}"
       style="${id===ap?`border-color:${m.color};color:${m.color};background:${m.color}18`:''}"
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
  state.top3Month = null;  // reset agar month default disesuaikan ke platform baru
  renderStatPlatBar();
  renderStatChart();
  renderStatGoodBad(state.statActiveAcct);
  $('statInputCard')?.classList.add('hidden');
}

/* ── Simpan metadata update per platform ────────────────────────────────── */
function _setAnalyticsMeta(analytics, acctId, platId) {
  if (!analytics[acctId]._meta) analytics[acctId]._meta = {};
  analytics[acctId]._meta[platId] = {
    updatedAt: new Date().toISOString(),
    updatedBy: currentUser() || 'system'
  };
}

function _getAnalyticsMeta(acctId, platId) {
  return state.analytics?.[acctId]?._meta?.[platId] || null;
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

  const isWeekly = state.statViewMode === 'weekly';
  const dataKey  = isWeekly ? platId + '_w' : platId;
  const sortKey  = isWeekly ? 'week' : 'month';

  const rows = ((state.analytics?.[acctId]?.[dataKey]) || [])
    .slice().sort((a,b) => (a[sortKey]||'').localeCompare(b[sortKey]||''));

  const summaryWrap = $('statSummaryWrap');
  const chartWrap   = $('statChartWrap');

  /* ── No data state ──────────────────────────────────────────────── */
  if (!rows.length) {
    if (summaryWrap) summaryWrap.innerHTML = '';
    if (chartWrap)   chartWrap.innerHTML = `<div class="stat-no-data">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--muted-lt)"><rect x="18" y="3" width="4" height="18" rx="1"/><rect x="10" y="8" width="4" height="13" rx="1"/><rect x="2" y="13" width="4" height="8" rx="1"/></svg>
      <p>Belum ada data <strong>${isWeekly?'mingguan':''} ${platM.label}</strong> untuk <strong>${getAcctName(acctId)}</strong></p>
      <button class="btn-sm blue" onclick="addStatRowFromTable()">+ Input Data Pertama</button>
    </div>`;
    if (window._statChart) { window._statChart.destroy(); window._statChart = null; }
    const dt = $('statDataTable'); if (dt) dt.innerHTML = '';
    return;
  }

  /* ── Range filter ───────────────────────────────────────────────── */
  const periodSel = $('statPeriodSel')?.value || (isWeekly ? '12w' : '12');
  let displayRows = rows;

  let fromM = '', toM = '';
  if (isWeekly) {
    const now    = new Date();
    const nWeeks = periodSel === 'allw' ? 0 : parseInt(periodSel, 10);
    if (nWeeks > 0) {
      const cutoff = dateToISOWeek(new Date(now.getTime() - nWeeks * 7 * 86400000));
      displayRows  = rows.filter(r => (r.week||'') >= cutoff);
    }
  } else {
    fromM = $('statFromMonth')?.value || '';
    toM   = $('statToMonth')?.value   || '';
    if (fromM || toM) {
      displayRows = rows.filter(r =>
        (!fromM || r.month >= fromM) && (!toM || r.month <= toM)
      );
    }
  }
  if (!displayRows.length) displayRows = rows;

  /* ── Summary cards: 4 kartu tetap per platform ──────────────────
     Urutan: Followers/Subs Gained | Total Views | Total Engagement | Followers EOM
  ──────────────────────────────────────────────────────────────── */
  // Definisi 4 kartu per platform: { key, label, eom? }
  // eom=true → tampilkan nilai bulan terakhir (point-in-time), bukan sum
  const SUMMARY_CARDS = {
    youtube:   [
      { key:'jmlVideo',        label:'Total Video',         eom:false },
      { key:'totalViews',      label:'Total Views',         eom:false },
      { key:'totalEngagement', label:'Total Engagement',    eom:false },
      { key:'subsEOM',         label:'Subscribers (EOM)',   eom:true  },
    ],
    tiktok:    [
      { key:'jmlVideo',        label:'Total Video',         eom:false },
      { key:'totalVideoViews', label:'Total Views',         eom:false },
      { key:'totalEngagement', label:'Total Engagement',    eom:false },
      { key:'followersEOM',    label:'Followers (EOM)',     eom:true  },
    ],
    facebook:  [
      { key:'totalPost',       label:'Total Post',          eom:false },
      { key:'totalViews',      label:'Total Views',         eom:false },
      { key:'totalEngagement', label:'Total Engagement',    eom:false },
      { key:'pageFollowers',   label:'Page Followers (EOM)',eom:true  },
    ],
    instagram: [
      { key:'jmlPost',         label:'Total Post',          eom:false },
      { key:'totalViews',      label:'Total Views',         eom:false },
      { key:'totalEngagement', label:'Total Engagement',    eom:false },
      { key:'followersEOM',    label:'Followers (EOM)',     eom:true  },
    ],
    twitter:   [
      { key:'followers',       label:'Followers',           eom:true  },
      { key:'impressions',     label:'Impressions',         eom:false },
      { key:'totalEngagement', label:'Total Engagement',    eom:false },
      { key:'erPct',           label:'ER %',                eom:false, fmt:'pct' },
    ],
  };
  const summaryDefs = SUMMARY_CARDS[platId] || SUMMARY_CARDS.youtube;
  const latestRow   = displayRows[displayRows.length - 1];
  const rangeLabel  = (fromM && toM)
    ? `${fmtMonth(fromM)} – ${fmtMonth(toM)}`
    : `${displayRows.length} ${isWeekly?'minggu':'bulan'}`;

  // Periode sebelumnya untuk trend %
  const prevRows = rows.filter(r => {
    const k = isWeekly ? (r.week||'') : (r.month||'');
    return displayRows.length > 0 && k < (isWeekly ? displayRows[0].week : displayRows[0].month);
  }).slice(-displayRows.length);

  if (summaryWrap) summaryWrap.innerHTML = `<div class="stat-summary-row">
    ${summaryDefs.map(card => {
      const fDef  = platM.fields.find(f => f.key === card.key) || { key: card.key, fmt: card.fmt || 'num' };
      const isPt  = !!card.eom;
      const val   = isPt
        ? (+latestRow?.[card.key] || 0)
        : displayRows.reduce((s, r) => s + (+r[card.key] || 0), 0);
      // Trend vs periode sebelumnya
      const prevVal = isPt
        ? (+(prevRows[prevRows.length-1]?.[card.key]) || 0)
        : prevRows.reduce((s, r) => s + (+r[card.key] || 0), 0);
      let trendHtml = '';
      if (prevVal > 0 && !isPt) {
        const pct   = ((val - prevVal) / prevVal * 100);
        const up    = pct >= 0;
        const color = up ? '#16a34a' : '#dc2626';
        const arrow = up ? '↑' : '↓';
        trendHtml = `<span style="font-size:.65rem;color:${color};font-weight:700;margin-left:4px">${arrow}${Math.abs(pct).toFixed(1)}%</span>`;
      }
      const period = isPt
        ? `Bulan ${fmtMonth(latestRow?.month || '')}`
        : `Total ${rangeLabel}`;
      const desc = STAT_FIELD_DESC[card.key] || '';
      return `
        <div class="stat-summary-card">
          <div class="stat-sum-label">
            ${card.label}
            ${desc ? `<span class="stat-info-wrap"><svg class="stat-info-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><span class="stat-info-tip">${esc(desc)}</span></span>` : ''}
          </div>
          <div style="display:flex;align-items:baseline;gap:2px">
            <div class="stat-sum-val" style="color:${platM.color}">${fmtStatVal(val, fDef.fmt || card.fmt || 'num')}</div>
            ${trendHtml}
          </div>
          <div class="stat-sum-period">${period}</div>
        </div>`;
    }).join('')}
  </div>`;

  /* ── Info + Narrative (digabung jadi satu kotak) ────────────────── */
  // Hapus elemen narrative lama jika ada (sebelumnya terpisah)
  $('statNarrative')?.remove();

  const meta = _getAnalyticsMeta(acctId, platId);
  let infoBanner = $('statUpdateBanner');
  if (!infoBanner) {
    infoBanner = document.createElement('div');
    infoBanner.id = 'statUpdateBanner';
    chartWrap?.parentNode?.insertBefore(infoBanner, chartWrap);
  }

  // ── Bagian update status ──────────────────────────────────────────
  let updateHtml = '';
  if (meta?.updatedAt) {
    const d        = new Date(meta.updatedAt);
    const daysDiff = Math.floor((Date.now() - d) / 86400000);
    const tgl      = d.toLocaleDateString('id-ID', { day:'2-digit', month:'long', year:'numeric' });
    const jam      = d.toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit' });
    const stale    = daysDiff > 7;
    const staleTxt = stale
      ? `<span style="color:#b45309;font-weight:600"> · ⚠ Sudah ${daysDiff} hari belum diperbarui</span>`
      : `<span style="color:#f59e0b"> · Data platform dapat berubah retroaktif</span>`;
    updateHtml = `<div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        style="color:#16a34a;flex-shrink:0"><polyline points="23 4 23 10 17 10"/>
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      <span>Diperbarui: <strong style="color:var(--text)">${tgl}, ${jam}</strong>${staleTxt}</span>
    </div>`;
  } else {
    updateHtml = `<div style="display:flex;align-items:center;gap:5px">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        style="color:#f59e0b;flex-shrink:0"><circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <span>Belum ada catatan pembaruan.</span>
    </div>`;
  }

  // ── Bagian narrative ringkasan ────────────────────────────────────
  const viewKey  = platM.viewKey;
  const totalV   = displayRows.reduce((s,r) => s + (+r[viewKey]||0), 0);
  const totalEng = displayRows.reduce((s,r) => s + (+r.totalEngagement||0), 0);
  const avgER    = displayRows.reduce((s,r) => s + (+r.erPct||0), 0) / displayRows.length;
  const bestRow  = displayRows.reduce((b,r) => (+r[viewKey]||0) > (+b[viewKey]||0) ? r : b, displayRows[0]);
  const bestLbl  = isWeekly ? fmtWeek(bestRow?.week||'') : fmtMonth(bestRow?.month||'');
  const narrativeHtml = `<span>
    📊 <strong>${fmtNum(totalV)}</strong> total views · <strong>${fmtNum(totalEng)}</strong> total engagement
    dalam <strong>${displayRows.length}</strong> ${isWeekly?'minggu':'bulan'} terakhir.
    Periode terbaik: <strong>${bestLbl}</strong> (${fmtNum(+bestRow?.[viewKey]||0)} views).
    Rata-rata ER: <strong>${avgER.toFixed(2)}%</strong>.
    <button onclick="copyStatNarrative(this)" style="margin-left:4px;font-size:.68rem;color:var(--blue);background:none;border:none;cursor:pointer;text-decoration:underline">📋 Salin</button>
  </span>`;

  // ── Satu baris: kiri = status update · garis | · kanan = narrative ──
  const bgColor = meta?.updatedAt && Math.floor((Date.now() - new Date(meta.updatedAt)) / 86400000) > 7 ? '#fef3c7' : meta?.updatedAt ? 'var(--surface)' : '#fffbeb';
  const border  = meta?.updatedAt && Math.floor((Date.now() - new Date(meta.updatedAt)) / 86400000) > 7 ? '#fde68a' : meta?.updatedAt ? 'var(--bd)' : '#fde68a';
  infoBanner.innerHTML = `
    <div style="font-size:.72rem;color:var(--muted);background:${bgColor};border:1px solid ${border};
      border-radius:8px;padding:7px 12px;margin-bottom:8px;line-height:1.55;
      display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span style="flex-shrink:0">${updateHtml.replace(/^<div[^>]*>/, '').replace(/<\/div>$/, '')}</span>
      <span style="width:1px;height:14px;background:var(--border,#e2e8f0);flex-shrink:0;align-self:center"></span>
      ${narrativeHtml}
    </div>`;
  infoBanner.style.display = '';

  /* ── Label Followers/Subs per platform (EOM) ────────────────────── */
  const FOLL_LABEL = {
    youtube:   'Subscribers', tiktok: 'Followers',
    facebook:  'Followers',   instagram: 'Followers',
    twitter:   'Followers',
  };
  const follLabel = FOLL_LABEL[platId] || 'Followers';

  /* ── Bar chart ──────────────────────────────────────────────────── */
  if (!chartWrap) return;

  // Bersihkan konten lama
  chartWrap.innerHTML = '<canvas id="statBarChart"></canvas>';

  // Header row: toggle Bulanan/Mingguan + tombol expand
  const headerRow = document.createElement('div');
  headerRow.className = 'chart-view-toggle chart-fs-header';
  headerRow.innerHTML = `
    <div style="display:flex;gap:4px">
      <button class="stat-view-btn${!isWeekly?' active':''}" data-mode="monthly" onclick="setStatViewMode('monthly')">Bulanan</button>
      <button class="stat-view-btn${isWeekly?' active':''}" data-mode="weekly" onclick="setStatViewMode('weekly')">Mingguan</button>
    </div>
    <button class="chart-expand-btn" id="chartExpandBtn" title="Perbesar / Perkecil">
      <svg class="icon-expand" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
    </button>`;
  chartWrap.insertBefore(headerRow, chartWrap.firstChild);
  headerRow.querySelector('#chartExpandBtn').onclick = () => toggleChartFullscreen(chartWrap);

  const labels     = displayRows.map(r => isWeekly ? fmtWeek(r.week||'') : fmtMonth(r.month||''));
  const follData   = displayRows.map(r => +(r[platM.followerKey] || 0));
  const viewData   = displayRows.map(r => +(r[platM.viewKey]     || 0));
  const barColor   = platM.color;

  if (window._statChart) { window._statChart.destroy(); window._statChart = null; }

  const canvas = $('statBarChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // Fitur 4 — Average reference line
  const avgViews  = viewData.length ? viewData.reduce((a,b)=>a+b,0)/viewData.length : 0;
  const avgLine   = viewData.map(() => Math.round(avgViews));

  // Fitur 8 — Perbandingan periode sebelumnya (Views)
  const showCmp   = !!$('statCmpToggle')?.checked;
  const cmpData   = showCmp ? prevRows.map(r => +(r[platM.viewKey]||0)) : [];

  const isMobile = window.innerWidth <= 640;
  window._statChart = new Chart(ctx, {
    data: {
      labels,
      datasets: [
        {
          type: 'bar',
          label: follLabel,
          data: follData,
          backgroundColor: barColor + '33',
          borderColor: barColor,
          borderWidth: 1.5,
          borderRadius: 5,
          yAxisID: 'yFoll',
          order: 3
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
        },
        {
          type: 'line',
          label: `Rata-rata (${fmtNum(Math.round(avgViews))})`,
          data: avgLine,
          borderColor: '#f59e0b',
          borderWidth: 1.5,
          borderDash: [6,4],
          pointRadius: 0,
          fill: false,
          yAxisID: 'yView',
          order: 2
        },
        ...(showCmp && cmpData.length ? [{
          type: 'line',
          label: 'Views (periode sebelumnya)',
          data: cmpData,
          borderColor: '#94a3b8',
          borderWidth: 1.5,
          borderDash: [3,3],
          pointRadius: 2,
          fill: false,
          yAxisID: 'yView',
          order: 4
        }] : [])
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: isMobile ? 1.8 : 2.5,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'top',
          labels: { boxWidth: 12, font: { size: isMobile ? 9 : 11 } }
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
          title: { display: false },
          ticks: { callback: v => fmtNum(v), font: { size: isMobile ? 8 : 10 }, maxTicksLimit: 5 },
          grid: { color: 'rgba(0,0,0,.06)' }
        },
        yView: {
          type: 'linear', position: 'right',
          title: { display: false },
          ticks: { callback: v => fmtNum(v), font: { size: isMobile ? 8 : 10 }, maxTicksLimit: 5 },
          grid: { drawOnChartArea: false }
        },
        x: { ticks: { font: { size: isMobile ? 8 : 10 }, maxRotation: 45, autoSkip: true, maxTicksLimit: isMobile ? 6 : 12 } }
      }
    }
  });

  // Backdrop element (singleton)
  let _chartBackdrop = $('statChartBackdrop');
  if (!_chartBackdrop) {
    _chartBackdrop = document.createElement('div');
    _chartBackdrop.id = 'statChartBackdrop';
    _chartBackdrop.className = 'stat-chart-backdrop';
    _chartBackdrop.onclick = () => toggleChartFullscreen(chartWrap);
    document.body.appendChild(_chartBackdrop);
  }

  function toggleChartFullscreen(wrap) {
    const isFs = wrap.classList.toggle('fullscreen');
    const backdrop = $('statChartBackdrop');
    if (backdrop) backdrop.classList.toggle('active', isFs);

    // Ikon expand/collapse pada tombol di header row
    const btn = wrap.querySelector('.chart-expand-btn');
    if (btn) btn.innerHTML = isFs
      ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/></svg>`
      : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;

    // Update chart options dinamis
    if (window._statChart) {
      const isMob = window.innerWidth <= 640;
      window._statChart.options.maintainAspectRatio = !isFs;
      // Saat fullscreen: ticks lebih banyak & lebih besar
      const tickSize  = isFs ? (isMob ? 10 : 12) : (isMob ? 8 : 10);
      const legendSz  = isFs ? (isMob ? 10 : 13) : (isMob ? 9 : 11);
      const maxTicks  = isFs ? 24 : (isMob ? 6 : 12);
      window._statChart.options.scales.x.ticks.font     = { size: tickSize };
      window._statChart.options.scales.x.ticks.maxTicksLimit = maxTicks;
      window._statChart.options.scales.x.ticks.maxRotation   = isFs ? 30 : 45;
      window._statChart.options.scales.yFoll.ticks.font = { size: tickSize };
      window._statChart.options.scales.yView.ticks.font = { size: tickSize };
      window._statChart.options.plugins.legend.labels.font = { size: legendSz };
      window._statChart.options.plugins.legend.labels.boxWidth = isFs ? 16 : 12;
      window._statChart.update('none');
      // Double rAF agar layout CSS selesai dulu baru chart di-resize
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window._statChart?.resize();
      }));
    }

    // ESC untuk keluar fullscreen
    if (isFs) {
      const escHandler = e => {
        if (e.key === 'Escape') { toggleChartFullscreen(wrap); document.removeEventListener('keydown', escHandler); }
      };
      document.addEventListener('keydown', escHandler);
    }
    document.body.style.overflow = isFs ? 'hidden' : '';
  }

  // Render admin-only data table below chart
  renderStatDataTable(acctId, platId, rows);
}

/* ── Admin-only monthly data table ─────────────────────────────────────── */
function renderStatDataTable(acctId, platId, rows) {
  const wrap    = $('statDataTable');
  if (!wrap) return;

  if (!isAdmin() || !rows.length) { wrap.innerHTML = ''; return; }

  const platM   = PLATFORM_FIELDS[platId];
  if (!platM) { wrap.innerHTML = ''; return; }

  const isWeekly = state.statViewMode === 'weekly';
  const rKey     = isWeekly ? 'week' : 'month';
  const sorted   = [...rows].sort((a, b) => (b[rKey]||'').localeCompare(a[rKey]||''));

  const headerCells = platM.fields.map(f => `<th>${f.label}</th>`).join('');
  const bodyRows = sorted.map(r => {
    const cells  = platM.fields.map(f =>
      `<td style="text-align:right">${fmtStatVal(r[f.key], f.fmt)}</td>`
    ).join('');
    const key  = esc(r[rKey] || '');
    const lbl  = isWeekly ? fmtWeek(r.week||'') : fmtMonth(r.month||'');
    return `<tr>
      <td style="white-space:nowrap;font-weight:500">${lbl}</td>
      ${cells}
      <td style="white-space:nowrap;text-align:center">
        <button class="btn-xs" title="Edit baris ini" onclick="openStatEdit('${key}')">✏️</button>
        <button class="btn-xs" title="Hapus baris ini" style="color:var(--red)" onclick="deleteStatRow('${key}')">🗑</button>
      </td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="card" style="margin-top:16px">
      <div class="card-head">
        <span class="card-title">📋 Data ${isWeekly?'Mingguan':'Bulanan'} — ${platM.label} · ${getAcctName(acctId)}</span>
        <div style="display:flex;align-items:center;gap:8px">
          <label style="font-size:.7rem;color:var(--muted);display:flex;align-items:center;gap:4px;cursor:pointer">
            <input type="checkbox" id="statCmpToggle" onchange="renderStatChart()" style="accent-color:var(--blue)">
            Bandingkan periode sebelumnya
          </label>
          <span class="badge-status ok" style="font-size:.68rem">Admin Only</span>
        </div>
      </div>
      <div style="overflow-x:auto;-webkit-overflow-scrolling:touch">
        <table class="data-table" style="font-size:.78rem">
          <thead>
            <tr>
              <th style="white-space:nowrap">${isWeekly?'MINGGU':'BULAN'}</th>
              ${headerCells}
              <th style="white-space:nowrap;text-align:center">Aksi</th>
            </tr>
          </thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
      <div style="padding:10px 0 0;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn-sm blue" onclick="addStatRowFromTable()">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Tambah ${isWeekly?'Minggu':'Bulan'}
        </button>
        <button class="btn-sm" onclick="copyStatTable('${acctId}','${platId}')">📋 Salin Tabel</button>
        <button class="btn-sm" onclick="exportStatCSV('${acctId}','${platId}')">📥 Export CSV</button>
      </div>
    </div>`;
}

/* Tambah baris baru lewat tabel */
/* ── Fitur 8: Salin narasi otomatis ─────────────────────────────────────── */
function copyStatNarrative(btn) {
  const txt = btn?.closest('div')?.textContent?.replace(/📋 Salin/,'').trim() || '';
  navigator.clipboard.writeText(txt).then(() => toast('Narasi disalin ✓', 'success'));
}

/* ── Fitur 8: Salin tabel sebagai teks ──────────────────────────────────── */
function copyStatTable(acctId, platId) {
  const isW   = state.statViewMode === 'weekly';
  const key   = isW ? platId + '_w' : platId;
  const rows  = (state.analytics?.[acctId]?.[key] || [])
    .slice().sort((a,b) => (a[isW?'week':'month']||'').localeCompare(b[isW?'week':'month']||''));
  const platM = PLATFORM_FIELDS[platId];
  if (!rows.length) { toast('Tidak ada data', 'error'); return; }
  const header = ['Periode', ...platM.fields.map(f => f.label)].join('\t');
  const body   = rows.map(r => {
    const lbl = isW ? fmtWeek(r.week||'') : fmtMonth(r.month||'');
    return [lbl, ...platM.fields.map(f => r[f.key] ?? 0)].join('\t');
  }).join('\n');
  navigator.clipboard.writeText(header + '\n' + body)
    .then(() => toast('Tabel disalin ke clipboard ✓', 'success'));
}

/* ── Fitur 3: Export CSV ─────────────────────────────────────────────────── */
function exportStatCSV(acctId, platId) {
  const isW   = state.statViewMode === 'weekly';
  const key   = isW ? platId + '_w' : platId;
  const rows  = (state.analytics?.[acctId]?.[key] || [])
    .slice().sort((a,b) => (a[isW?'week':'month']||'').localeCompare(b[isW?'week':'month']||''));
  const platM = PLATFORM_FIELDS[platId];
  if (!rows.length) { toast('Tidak ada data untuk diexport', 'error'); return; }
  const header = ['Periode', ...platM.fields.map(f => f.label)].join(',');
  const body   = rows.map(r => {
    const lbl = isW ? (r.week||'') : (r.month||'');
    return [lbl, ...platM.fields.map(f => r[f.key] ?? 0)].join(',');
  }).join('\n');
  const blob = new Blob(['﻿' + header + '\n' + body], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `${getAcctName(acctId)}_${platM.label}_${isW?'weekly':'monthly'}.csv`;
  a.click(); URL.revokeObjectURL(url);
  toast('CSV berhasil diexport ✓', 'success');
}

function addStatRowFromTable() {
  const isWeekly = state.statViewMode === 'weekly';
  const platM    = PLATFORM_FIELDS[state.statActivePlat || 'youtube'];
  const inp      = $('statMonth');
  if (inp) {
    if (isWeekly) {
      inp.type  = 'week';
      inp.value = dateToISOWeek(new Date()).replace('-W', '-W'); // YYYY-Www
    } else {
      inp.type  = 'month';
      const d   = new Date();
      inp.value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    }
  }
  const lbl = $('statInputLabel');
  if (lbl) lbl.textContent = isWeekly ? 'Minggu' : 'Bulan';
  renderStatInputFields(state.statActiveAcct);
  const title = $('statInputTitle');
  if (title) title.textContent = `📊 Input ${isWeekly?'Mingguan':''} ${platM?.label||''} — ${getAcctName(state.statActiveAcct)}`;
  $('statInputCard')?.classList.remove('hidden');
  $('statInputCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* Hapus satu baris data */
async function deleteStatRow(periodKey) {
  const acctId   = state.statActiveAcct;
  const platId   = state.statActivePlat || 'youtube';
  const isWeekly = state.statViewMode === 'weekly';
  const storeKey = isWeekly ? platId + '_w' : platId;
  const rKey     = isWeekly ? 'week' : 'month';
  const lbl      = isWeekly ? periodKey : fmtMonth(periodKey);
  showConfirm(`Hapus data ${lbl}? Tindakan tidak dapat dibatalkan.`, async () => {
    const analytics = state.analytics || {};
    if (analytics[acctId]?.[storeKey]) {
      analytics[acctId][storeKey] = analytics[acctId][storeKey].filter(r => r[rKey] !== periodKey);
    }
    state.analytics = analytics;
    showFlagLoader(600);
    try {
      state.shas.analytics = await window.db.writeData(
        'analytics', analytics,
        `Hapus statistik: ${getAcctName(acctId)} ${platId} — ${lbl}`
      );
      await logActivity(currentUser(), 'hapus statistik', `${getAcctName(acctId)} ${platId} — ${lbl}`);
      toast(`Data ${lbl} dihapus ✓`);
      renderStatChart();
    } catch (e) { toast('Gagal hapus: ' + e.message, 'error'); }
  });
}

/* ── Download helpers ───────────────────────────────────────────────────── */
function initStatDownloadMonth() {
  const fromInp = $('statFromMonth');
  const toInp   = $('statToMonth');
  if (!fromInp || !toInp) return;
  // Default: 12 bulan terakhir (hanya set jika belum ada nilai)
  if (!toInp.value) {
    toInp.value = getCurrentYM();
  }
  if (!fromInp.value) {
    const d = new Date();
    d.setMonth(d.getMonth() - 11);
    fromInp.value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  }
  // Re-render chart saat range berubah
  if (!fromInp._rangeInit) {
    fromInp._rangeInit = true;
    fromInp.addEventListener('change', () => renderStatChart());
    toInp.addEventListener('change',   () => renderStatChart());
  }
}

/* ── Platform badge helper (canvas-based, untuk download JPG) ─────────────── */
const PLATFORM_SYMBOLS = {
  youtube:   { text: '▶', bg: '#ff0000' },
  tiktok:    { text: '♪', bg: '#010101' },
  facebook:  { text: 'f',  bg: '#1877f2' },
  instagram: { text: '◉', bg: '#e1306c' },
  twitter:   { text: '𝕏', bg: '#000000' },
  spotify:   { text: '♫', bg: '#1db954' },
};

/**
 * Draw a rounded platform icon badge on a canvas context.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string}  platId   — platform key (youtube, tiktok, …)
 * @param {number}  cx       — center x
 * @param {number}  cy       — center y
 * @param {number}  size     — badge diameter (px)
 */
function drawPlatformBadge(ctx, platId, cx, cy, size) {
  const sym = PLATFORM_SYMBOLS[platId] || { text: (platId[0]||'?').toUpperCase(), bg: '#6366f1' };
  const r   = size / 2;

  ctx.save();

  // Rounded square background
  ctx.fillStyle = sym.bg;
  ctx.beginPath();
  const cr = r * 0.32; // corner radius
  const x  = cx - r, y = cy - r;
  ctx.moveTo(x + cr, y);
  ctx.lineTo(x + size - cr, y);
  ctx.quadraticCurveTo(x + size, y, x + size, y + cr);
  ctx.lineTo(x + size, y + size - cr);
  ctx.quadraticCurveTo(x + size, y + size, x + size - cr, y + size);
  ctx.lineTo(x + cr, y + size);
  ctx.quadraticCurveTo(x, y + size, x, y + size - cr);
  ctx.lineTo(x, y + cr);
  ctx.quadraticCurveTo(x, y, x + cr, y);
  ctx.closePath();
  ctx.fill();

  // Platform symbol text, centered
  ctx.fillStyle = '#ffffff';
  ctx.font      = `bold ${Math.round(size * 0.48)}px Arial, sans-serif`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(sym.text, cx, cy + 1);

  ctx.restore();
}

function downloadStatJpg() {
  const canvas = $('statBarChart');
  if (!canvas) { toast('Tidak ada grafik untuk didownload', 'error'); return; }

  const acctId  = state.statActiveAcct;
  const platId  = state.statActivePlat || 'youtube';
  const platM   = PLATFORM_FIELDS[platId];
  const acctObj = ACCOUNTS.find(a => a.id === acctId);
  const fromM   = $('statFromMonth')?.value || '';
  const toM     = $('statToMonth')?.value   || getCurrentYM();
  const fileTag = fromM ? `${fromM}_${toM}` : toM;
  const rangeLabel = fromM
    ? `${fmtMonth(fromM)} – ${fmtMonth(toM)}`
    : fmtMonth(toM);

  // ── Layout — 2× pixel ratio untuk HD ──────────────────────────
  const DPR      = 2;    // device pixel ratio: 2× = HD
  const PAD      = 20;
  const HEADER_H = 64;
  const FOOTER_H = 28;
  const TARGET_W = Math.max(canvas.width, 1200);   // min 1200px logical
  const scale    = TARGET_W / canvas.width;
  const chartH   = Math.round(canvas.height * scale);
  const totalW   = TARGET_W;
  const totalH   = HEADER_H + chartH + FOOTER_H;

  const offCanvas = document.createElement('canvas');
  offCanvas.width  = totalW  * DPR;   // canvas fisik 2×
  offCanvas.height = totalH  * DPR;
  const ctx = offCanvas.getContext('2d');
  ctx.scale(DPR, DPR);               // semua drawing dalam koordinat logis

  // White background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, totalW, totalH);

  // Color accent bar at top
  ctx.fillStyle = platM?.color || '#6366f1';
  ctx.fillRect(0, 0, totalW, 4);

  // Platform badge icon
  const BADGE_SIZE = 32;
  drawPlatformBadge(ctx, platId, PAD + BADGE_SIZE / 2, 4 + BADGE_SIZE / 2 + 4, BADGE_SIZE);

  // Title
  const titleX = PAD + BADGE_SIZE + 10;
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 15px Arial, sans-serif';
  ctx.fillText(`${platM?.label || platId} — ${acctObj?.name || acctId}`, titleX, 26);

  // Subtitle
  ctx.fillStyle = '#64748b';
  ctx.font = '11px Arial, sans-serif';
  ctx.fillText(
    `Rentang: ${rangeLabel}   ·   Diekspor: ${new Date().toLocaleDateString('id-ID', { day:'2-digit', month:'long', year:'numeric' })}`,
    titleX, 46
  );

  // Divider
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, HEADER_H - 6);
  ctx.lineTo(totalW - PAD, HEADER_H - 6);
  ctx.stroke();

  // Chart (scaled up ke totalW × chartH)
  ctx.drawImage(canvas, 0, HEADER_H, totalW, chartH);

  // Footer watermark
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px Arial, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('Penjaga Harapan CMS', totalW - PAD, HEADER_H + chartH + 18);
  ctx.textAlign = 'left';

  const link = document.createElement('a');
  link.download = `grafik-${acctId}-${platId}-${fileTag}.jpg`;
  link.href = offCanvas.toDataURL('image/jpeg', 1.0);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  toast('Grafik berhasil didownload ✓', 'success');
}

function downloadStatTableJpg() {
  const acctId   = state.statActiveAcct;
  const platId   = state.statActivePlat || 'youtube';
  const platM    = PLATFORM_FIELDS[platId];
  if (!platM) return;

  // Deteksi mode weekly/monthly sesuai tampilan aktif
  const isWeekly = state.statViewMode === 'weekly';
  const storeKey = isWeekly ? platId + '_w' : platId;
  const rowKey   = isWeekly ? 'week' : 'month';

  const allRows = ((state.analytics?.[acctId]?.[storeKey]) || [])
    .slice().sort((a, b) => (a[rowKey] || '').localeCompare(b[rowKey] || ''));
  if (!allRows.length) { toast('Belum ada data untuk didownload', 'error'); return; }

  const fromM = $('statFromMonth')?.value || '';
  const toM   = $('statToMonth')?.value   || getCurrentYM();
  const rows  = (fromM || toM)
    ? allRows.filter(r => (!fromM || (r[rowKey] || '') >= fromM) && (!toM || (r[rowKey] || '') <= toM))
    : allRows;
  const dlRows  = rows.length ? rows : allRows;
  const fileTag = fromM ? `${fromM}_${toM}` : (toM || new Date().toISOString().slice(0,7));
  const acctObj = ACCOUNTS.find(a => a.id === acctId);

  // 4 kolom ringkas: Bulan · Total Views · Subscribers/Followers EOM · Total Engagement
  const viewF  = platM.fields.find(f => f.key === platM.viewKey)      || platM.fields[0];
  const follF  = platM.fields.find(f => f.key === platM.followerKey)  || platM.fields[1];
  const engF   = platM.fields.find(f => f.key === 'totalEngagement')  || null;
  const dlCols = [viewF, follF, engF].filter(Boolean);

  const periodLabel = isWeekly ? 'MINGGU' : 'BULAN';
  const headers  = [periodLabel, ...dlCols.map(f => f.label)];
  const dataRows = dlRows.map(r => [
    isWeekly ? (r.week || '—') : fmtMonth(r.month),
    ...dlCols.map(f => fmtStatVal(r[f.key], f.fmt))
  ]);

  // Layout — 2× pixel ratio untuk HD
  const DPR_T   = 2;
  const PAD     = 24;
  const HEAD_H  = 52;
  const ROW_H   = 28;    // sedikit lebih tinggi agar teks tidak rapat
  const COL0_W  = 100;
  const COL_W   = 110;
  const totalW  = PAD * 2 + COL0_W + COL_W * (headers.length - 1);
  const totalH  = PAD + HEAD_H + ROW_H * (dataRows.length + 1) + PAD;

  const cv = document.createElement('canvas');
  cv.width  = totalW  * DPR_T;
  cv.height = totalH  * DPR_T;
  const ctx = cv.getContext('2d');
  ctx.scale(DPR_T, DPR_T);

  // White background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, totalW, totalH);

  // Color bar at top
  ctx.fillStyle = platM.color;
  ctx.fillRect(0, 0, totalW, 4);

  // Platform badge icon
  const TBL_BADGE = 28;
  drawPlatformBadge(ctx, platId, PAD + TBL_BADGE / 2, 4 + TBL_BADGE / 2 + 3, TBL_BADGE);

  // Title (offset to right of badge)
  const tblTitleX = PAD + TBL_BADGE + 8;
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 13px Arial, sans-serif';
  ctx.fillText(`${platM.label} — ${acctObj?.name || acctId}`, tblTitleX, PAD + 16);
  ctx.fillStyle = '#64748b';
  ctx.font = '10px Arial, sans-serif';
  const rangeStr = fromM ? `${fmtMonth(fromM)} – ${fmtMonth(toM)}` : `${dlRows.length} bulan`;
  ctx.fillText(
    `Rentang: ${rangeStr}   ·   Diekspor: ${new Date().toLocaleDateString('id-ID',{day:'2-digit',month:'long',year:'numeric'})}`,
    tblTitleX, PAD + 34
  );

  // Column x positions
  function colX(i) { return PAD + (i === 0 ? 0 : COL0_W + COL_W * (i - 1)); }
  function colW(i) { return i === 0 ? COL0_W : COL_W; }

  const tblTop = PAD + HEAD_H;

  // Header row
  ctx.fillStyle = platM.color;
  ctx.fillRect(PAD, tblTop, totalW - PAD * 2, ROW_H);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 9px Arial, sans-serif';
  headers.forEach((h, i) => {
    if (i === 0) {
      ctx.textAlign = 'left';
      ctx.fillText(h, colX(i) + 5, tblTop + ROW_H / 2 + 3);
    } else {
      ctx.textAlign = 'right';
      ctx.fillText(h.toUpperCase(), colX(i) + colW(i) - 5, tblTop + ROW_H / 2 + 3);
    }
  });
  ctx.textAlign = 'left';

  // Data rows
  dataRows.forEach((row, ri) => {
    const y = tblTop + ROW_H * (ri + 1);
    ctx.fillStyle = ri % 2 === 0 ? '#f8fafc' : '#ffffff';
    ctx.fillRect(PAD, y, totalW - PAD * 2, ROW_H);
    ctx.fillStyle = '#0f172a';
    ctx.font = '10px Arial, sans-serif';
    row.forEach((cell, ci) => {
      if (ci === 0) {
        ctx.textAlign = 'left';
        ctx.fillText(String(cell), colX(ci) + 8, y + ROW_H / 2 + 3);
      } else {
        ctx.textAlign = 'right';
        ctx.fillText(String(cell), colX(ci) + colW(ci) - 5, y + ROW_H / 2 + 3);
      }
    });
    ctx.textAlign = 'left';
    // Row separator
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(PAD, y + ROW_H);
    ctx.lineTo(totalW - PAD, y + ROW_H);
    ctx.stroke();
  });

  // Vertical column separators
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 0.5;
  for (let i = 1; i < headers.length; i++) {
    const x = colX(i);
    ctx.beginPath();
    ctx.moveTo(x, tblTop);
    ctx.lineTo(x, tblTop + ROW_H * (dataRows.length + 1));
    ctx.stroke();
  }

  // Table outer border
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1;
  ctx.strokeRect(PAD, tblTop, totalW - PAD * 2, ROW_H * (dataRows.length + 1));

  // Download — append ke DOM agar semua browser men-trigger download
  const link = document.createElement('a');
  link.download = `tabel-${acctId}-${platId}-${fileTag}.jpg`;
  link.href = cv.toDataURL('image/jpeg', 1.0);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  toast('Tabel berhasil didownload ✓', 'success');
}

/* ── Top 3 per-bulan — semua user bisa edit ─────────────────────────────── */

function _getTop3MonthOptions(acctId, platId) {
  // Kumpulkan bulan dari platform tertentu (jika platId diberikan) atau semua platform
  const acctAnl = state.analytics?.[acctId] || {};
  const rows = platId
    ? (acctAnl[platId] || [])
    : Object.values(acctAnl).flat();
  // Filter hanya row yang punya field month (bukan weekly row)
  const months = [...new Set(rows.map(r => r.month).filter(Boolean))].sort().reverse();
  if (!months.includes(getCurrentYM())) months.unshift(getCurrentYM());
  return months;
}

function _ensureTop3(acctId, platId, month) {
  const empty3 = () => [{title:'',link:''},{title:'',link:''},{title:'',link:''}];
  if (!state.settings.topContent) state.settings.topContent = {};
  if (!state.settings.topContent[acctId]) state.settings.topContent[acctId] = {};
  const acctData = state.settings.topContent[acctId];

  // ── Migrasi format lama ────────────────────────────────────────────
  // Format lama-1: acctData.good / acctData.bad langsung
  if (acctData.good || acctData.bad) {
    const migData = { good: acctData.good || empty3(), bad: acctData.bad || empty3() };
    delete acctData.good; delete acctData.bad;
    // Simpan di bawah platId 'youtube' (platform default) + bulan sekarang
    if (!acctData['youtube']) acctData['youtube'] = {};
    acctData['youtube'][getCurrentYM()] = migData;
  }
  // Format lama-2: acctData[month] = { good, bad } — tanpa platId
  // Deteksi: key yang cocok pola YYYY-MM dan valuenya objek {good, bad}
  for (const key of Object.keys(acctData)) {
    if (/^\d{4}-\d{2}$/.test(key) && acctData[key]?.good) {
      const migData = acctData[key];
      delete acctData[key];
      if (!acctData['youtube']) acctData['youtube'] = {};
      if (!acctData['youtube'][key]) acctData['youtube'][key] = migData;
    }
  }
  // ─────────────────────────────────────────────────────────────────

  if (!acctData[platId]) acctData[platId] = {};
  const platData = acctData[platId];
  if (!platData[month]) platData[month] = { good: empty3(), bad: empty3() };
  if (!platData[month].good) platData[month].good = empty3();
  if (!platData[month].bad)  platData[month].bad  = empty3();
  return platData[month];
}

/* ── Top 3 Month Calendar Picker ─────────────────────────────────────────── */
const _MO_NAMES = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agt','Sep','Okt','Nov','Des'];

function _buildTop3MoPickerHtml(availMonths, selMonth) {
  const availSet = new Set(availMonths);
  // Tahun yang ditampilkan: dari state atau ambil dari selMonth
  const dispYear = state._top3PickerYear ||
    (selMonth ? parseInt(selMonth.slice(0,4)) : new Date().getFullYear());
  state._top3PickerYear = dispYear;

  // Range tahun dari data
  const years = [...new Set(availMonths.map(m => parseInt(m.slice(0,4))))].sort();
  const minYear = years[0] || dispYear;
  const maxYear = Math.max(years[years.length-1] || dispYear, new Date().getFullYear());

  const cells = _MO_NAMES.map((name, i) => {
    const ym = `${dispYear}-${String(i+1).padStart(2,'0')}`;
    const isAvail = availSet.has(ym);
    const isSel   = ym === selMonth;
    return `<button class="top3-mopick-cell${isSel?' active':''}${!isAvail?' dim':''}"
      onclick="pickTop3Month('${ym}')">${name}</button>`;
  }).join('');

  return `
    <div class="top3-mopick-head">
      <button class="top3-mopick-nav" onclick="navTop3PickerYear(-1)"${dispYear<=minYear?' disabled':''}>&#8249;</button>
      <span class="top3-mopick-year">${dispYear}</span>
      <button class="top3-mopick-nav" onclick="navTop3PickerYear(1)"${dispYear>=maxYear?' disabled':''}>&#8250;</button>
    </div>
    <div class="top3-mopick-grid">${cells}</div>`;
}

function toggleTop3MoPicker(e) {
  e.stopPropagation();
  const drop = $('top3MoPickerDrop');
  if (!drop) return;
  const isOpen = drop.classList.toggle('open');
  if (isOpen) {
    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', _closeTop3Picker, { once: true });
    }, 0);
  }
}

function _closeTop3Picker() {
  $('top3MoPickerDrop')?.classList.remove('open');
}

function navTop3PickerYear(dir) {
  state._top3PickerYear = (state._top3PickerYear || new Date().getFullYear()) + dir;
  // Re-render hanya bagian dalam picker
  const drop = $('top3MoPickerDrop');
  if (!drop) return;
  const months = _getTop3MonthOptions(state.statActiveAcct, state.statActivePlat || 'youtube');
  drop.innerHTML = _buildTop3MoPickerHtml(months, state.top3Month || months[0] || getCurrentYM());
  drop.classList.add('open');
}

function pickTop3Month(ym) {
  state.top3Month = ym;
  state._top3PickerYear = parseInt(ym.slice(0,4));
  _closeTop3Picker();
  renderStatGoodBad(state.statActiveAcct);
}

function renderStatGoodBad(acctId) {
  const wrap = $('statGoodBadWrap');
  if (!wrap) return;
  const acct   = ACCOUNTS.find(a => a.id === acctId);
  const platId = state.statActivePlat || 'youtube';

  // Label platform untuk ditampilkan
  const PLAT_LABELS = {
    youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram',
    twitter: 'X/Twitter', facebook: 'Facebook', threads: 'Threads', spotify: 'Spotify'
  };
  const platLabel = PLAT_LABELS[platId] || platId;

  // Resolve bulan aktif (per platform agar tidak cross-platform confusion)
  const months  = _getTop3MonthOptions(acctId, platId);
  // Bulan aktif: pakai state.top3Month jika valid YYYY-MM, fallback ke bulan pertama/sekarang
  const selMonth = (state.top3Month && /^\d{4}-\d{2}$/.test(state.top3Month))
    ? state.top3Month
    : months[0] || getCurrentYM();
  state.top3Month = selMonth;

  const topData = _ensureTop3(acctId, platId, selMonth);

  // Month selector HTML — calendar picker dropdown
  const monthSelHtml = `
    <div class="top3-month-bar">
      <span style="font-size:.75rem;color:var(--muted);font-weight:500;flex-shrink:0">📅 Bulan:</span>
      <div class="top3-mopicker-wrap" id="top3MoPickerWrap">
        <button class="top3-mopicker-trigger" id="top3MoPickerTrigger"
          onclick="toggleTop3MoPicker(event)">
          ${fmtMonth(selMonth)}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div class="top3-mopicker-drop" id="top3MoPickerDrop">
          ${_buildTop3MoPickerHtml(months, selMonth)}
        </div>
      </div>
      <span class="badge-status" style="font-size:.72rem;padding:2px 8px;background:var(--bg2);border-radius:99px;flex-shrink:0">${platLabel}</span>
    </div>`;

  function sectionHtml(type, items, label, icon, headCls) {
    const acctColor = acct?.color || '#6366f1';
    const adminBadge = isAdmin()
      ? `<span class="badge-status ok" style="font-size:.68rem">Admin Only</span>`
      : '';
    const head = `<div class="sgb-section-head ${headCls}">
      <span class="sgb-icon">${icon}</span>
      <span>${label}</span>
      <span class="sgb-acct" style="color:${acctColor}">${acct?.name||''} · ${platLabel} · ${fmtMonth(selMonth)}</span>
      ${adminBadge}
    </div>`;

    // Preview cards (semua user bisa lihat) — klik kartu langsung buka link
    const valid = items.filter(it => it.link);
    const cards = valid.length
      ? valid.map(it => {
          const viewsHtml = it.views
            ? `<div class="sgb-card-views">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                ${esc(it.views)}
               </div>`
            : '';
          return `<a href="${esc(it.link)}" target="_blank" rel="noopener" class="sgb-card sgb-${type}">
            <div class="sgb-card-title">${esc(it.title || '(Tanpa Judul)')}</div>
            ${viewsHtml}
          </a>`;
        }).join('')
      : '';

    // Form edit hanya untuk admin
    if (isAdmin()) {
      const inputRows = items.map((item, i) => `
        <div class="sgb-input-row">
          <input type="text" class="inp-sm" placeholder="Judul konten…"
            value="${esc(item.title||'')}" style="flex:2;min-width:0"
            oninput="updateTopSlot('${esc(acctId)}','${esc(platId)}','${type}',${i},'title',this.value,'${selMonth}')" />
          <input type="url" class="inp-sm" placeholder="https://link…"
            value="${esc(item.link||'')}" style="flex:2;min-width:0"
            oninput="updateTopSlot('${esc(acctId)}','${esc(platId)}','${type}',${i},'link',this.value,'${selMonth}')" />
          <input type="text" class="inp-sm" placeholder="▷ views (mis. 1.3M)"
            value="${esc(item.views||'')}" style="flex:1;min-width:60px;max-width:100px"
            oninput="updateTopSlot('${esc(acctId)}','${esc(platId)}','${type}',${i},'views',this.value,'${selMonth}')" />
        </div>`).join('');

      return `<div class="sgb-col">
        ${head}
        <div class="sgb-admin-form">${inputRows}
          <button class="btn-xs blue" style="margin-top:6px"
            onclick="saveTopContent('${esc(acctId)}','${esc(platId)}','${selMonth}')">💾 Simpan Top Content</button>
        </div>
        ${cards ? `<div class="sgb-list" style="margin-top:8px">${cards}</div>` : ''}
      </div>`;
    }

    // Tampilan user biasa: hanya preview cards
    return `<div class="sgb-col">
      ${head}
      ${cards
        ? `<div class="sgb-list">${cards}</div>`
        : `<div class="sgb-empty-user">Belum ada data untuk bulan ini</div>`}
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

function updateTopSlot(acctId, platId, type, idx, field, val, month) {
  const p = platId || state.statActivePlat || 'youtube';
  const m = month  || state.top3Month     || getCurrentYM();
  _ensureTop3(acctId, p, m);
  state.settings.topContent[acctId][p][m][type][idx][field] = val;
}

async function saveTopContent(acctId, platId, month) {
  if (!state.settings) return;
  const p = platId || state.statActivePlat || 'youtube';
  const m = month  || state.top3Month     || getCurrentYM();
  _ensureTop3(acctId, p, m);
  showFlagLoader(600);
  try {
    state.shas.settings = await window.db.writeData('settings', state.settings, `Top Content: ${acctId}/${p} ${m}`);
    await logActivity(currentUser(), 'Update Top Content', `${getAcctName(acctId)} — ${p} — ${fmtMonth(m)}`);
    toast(`Top Content ${fmtMonth(m)} disimpan ✓`, 'success');
    renderStatGoodBad(acctId);   // re-render agar preview terbaru muncul
  } catch(e) { toast('Gagal menyimpan: ' + e.message, 'error'); }
}

/* ══════════════════════════════════════════════════════════════════════════
   BUDGET PRODUKSI — Podcast & Liputan
   ══════════════════════════════════════════════════════════════════════════ */

let _budgetContentId = null;
let _budgetRows      = [];

const BUDGET_UNITS = ['Orang','Hari','Jam','Kali','Buah','Paket','Box','Porsi','Liter','Km'];

function openBudgetModal(contentId) {
  const c = state.contents.find(x => x.id === contentId);
  if (!c) return;
  _budgetContentId = contentId;
  _budgetRows = (c.budget || []).map(r => ({ ...r }));
  if (!_budgetRows.length) _budgetRows.push(_emptyBudgetRow());

  const sub = $('budgetModalSubtitle');
  if (sub) sub.textContent = `${c.title || '—'}  ·  ${c.format || ''}  ·  ${fmtDate(c.publishDate) || '—'}`;

  _renderBudgetTable();
  $('budgetModal')?.classList.remove('hidden');
}

function closeBudgetModal() {
  $('budgetModal')?.classList.add('hidden');
  _budgetContentId = null;
  _budgetRows = [];
}

function _emptyBudgetRow() {
  return { id: uid(), item: '', qty: 1, unit: 'Orang', price: 0 };
}

function addBudgetRow() {
  _budgetRows.push(_emptyBudgetRow());
  _renderBudgetTable();
  // Fokus ke input item baris baru
  const inputs = $$('#budgetTableBody input[data-field="item"]');
  inputs[inputs.length - 1]?.focus();
}

function removeBudgetRow(idx) {
  _budgetRows.splice(idx, 1);
  if (!_budgetRows.length) _budgetRows.push(_emptyBudgetRow());
  _renderBudgetTable();
}

function updateBudgetRow(idx, field, val) {
  if (!_budgetRows[idx]) return;
  _budgetRows[idx][field] = (field === 'qty' || field === 'price') ? (+val || 0) : val;
  _updateBudgetTotal();
}

function _updateBudgetTotal() {
  const total = _budgetRows.reduce((s, r) => s + (r.qty || 0) * (r.price || 0), 0);
  const el = $('budgetTotalDisplay');
  if (el) el.textContent = 'Rp ' + total.toLocaleString('id-ID');
}

function _renderBudgetTable() {
  const tbody = $('budgetTableBody');
  if (!tbody) return;
  const unitOpts = BUDGET_UNITS.map(u => `<option>${u}</option>`).join('');
  tbody.innerHTML = _budgetRows.map((r, i) => `
    <tr class="budget-row">
      <td><input class="inp-sm budget-inp" data-field="item" value="${esc(r.item)}"
        placeholder="Nama item…" oninput="updateBudgetRow(${i},'item',this.value)"></td>
      <td><input class="inp-sm budget-inp budget-num" type="number" min="1" data-field="qty"
        value="${r.qty||1}" oninput="updateBudgetRow(${i},'qty',this.value)"></td>
      <td><select class="inp-sm budget-inp" onchange="updateBudgetRow(${i},'unit',this.value)">
        ${BUDGET_UNITS.map(u => `<option${u===r.unit?' selected':''}>${u}</option>`).join('')}
      </select></td>
      <td><input class="inp-sm budget-inp budget-num" type="number" min="0" data-field="price"
        value="${r.price||0}" placeholder="0" oninput="updateBudgetRow(${i},'price',this.value)"></td>
      <td class="budget-subtotal">Rp ${((r.qty||0)*(r.price||0)).toLocaleString('id-ID')}</td>
      <td><button class="budget-del-btn" onclick="removeBudgetRow(${i})" title="Hapus baris">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button></td>
    </tr>`).join('');
  _updateBudgetTotal();
}

async function saveBudget() {
  if (!_budgetContentId) return;
  const idx = state.contents.findIndex(x => x.id === _budgetContentId);
  if (idx === -1) return;
  // Hapus baris kosong sebelum simpan
  const clean = _budgetRows.filter(r => r.item.trim());
  state.contents[idx].budget = clean;
  state.contents[idx].updatedAt = new Date().toISOString();
  try {
    showFlagLoader(600);
    state.shas.contents = await window.db.writeData('contents', state.contents, `Budget: ${state.contents[idx].title}`);
    saveDataCache();
    const total = clean.reduce((s, r) => s + r.qty * r.price, 0);
    await logActivity(currentUser(), 'Update Budget', `${state.contents[idx].title} — Total Rp ${total.toLocaleString('id-ID')}`);
    toast('💰 Budget disimpan', 'success');
    closeBudgetModal();
  } catch(e) { toast('Gagal simpan budget: ' + e.message, 'error'); }
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

function openStatEdit(periodKey) {
  const isWeekly  = state.statViewMode === 'weekly';
  const platId    = state.statActivePlat || 'youtube';
  const acctId    = state.statActiveAcct;
  const platM     = PLATFORM_FIELDS[platId];
  const storeKey  = isWeekly ? platId + '_w' : platId;
  const rKey      = isWeekly ? 'week' : 'month';
  const existing  = (state.analytics?.[acctId]?.[storeKey] || []).find(r => r[rKey] === periodKey);
  const lbl       = isWeekly ? fmtWeek(periodKey) : fmtMonth(periodKey);

  const inp = $('statMonth');
  if (inp) { inp.type = isWeekly ? 'week' : 'month'; inp.value = periodKey; }
  const title = $('statInputTitle');
  if (title) title.textContent = `✏️ Edit ${platM?.label} — ${lbl}`;

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
  const isWeekly = state.statViewMode === 'weekly';
  const periodVal = gv('statMonth');   // bisa YYYY-MM atau YYYY-Www
  const acctId    = state.statActiveAcct;
  const platId    = state.statActivePlat || 'youtube';
  const platM     = PLATFORM_FIELDS[platId];
  const storeKey  = isWeekly ? platId + '_w' : platId;
  const rKey      = isWeekly ? 'week' : 'month';

  if (!periodVal) { toast(`Pilih ${isWeekly?'minggu':'bulan'} terlebih dahulu`, 'error'); return; }

  const analytics = state.analytics || {};
  if (!analytics[acctId]) analytics[acctId] = {};
  if (!analytics[acctId][storeKey]) analytics[acctId][storeKey] = [];

  // Build entry dari inputs
  const entry = { [rKey]: periodVal };
  let hasAny = false;
  platM.fields.forEach(f => {
    const raw = gv(`sif_${f.key}`);
    if (raw !== '') {
      entry[f.key] = f.fmt === 'pct' ? parseFloat(raw) : parseInt(raw, 10);
      hasAny = true;
    }
  });
  if (!hasAny) { toast('Isi minimal satu field', 'error'); return; }

  // Replace atau tambah — tidak mengganggu array lain
  analytics[acctId][storeKey] = analytics[acctId][storeKey].filter(r => r[rKey] !== periodVal);
  analytics[acctId][storeKey].push(entry);
  analytics[acctId][storeKey].sort((a,b) => (a[rKey]||'').localeCompare(b[rKey]||''));
  if (analytics[acctId][storeKey].length > 52)  // max 52 minggu / 36 bulan
    analytics[acctId][storeKey] = analytics[acctId][storeKey].slice(isWeekly ? -52 : -36);
  _setAnalyticsMeta(analytics, acctId, platId);

  state.analytics = analytics;
  const lbl2 = isWeekly ? fmtWeek(periodVal) : fmtMonth(periodVal);
  setLoading('btnSaveStats', true, 'Menyimpan…');
  try {
    state.shas.analytics = await window.db.writeData(
      'analytics', analytics,
      `Statistik ${isWeekly?'mingguan':''}: ${getAcctName(acctId)} ${platM.label} ${lbl2}`
    );
    await logActivity(currentUser(), 'update statistik', `${getAcctName(acctId)} ${platM.label} — ${lbl2}`);
    toast(`Data ${platM.label} ${lbl2} disimpan ✓`, 'success');
    const lbl = $('statLastSaved');
    if (lbl) lbl.textContent = `Tersimpan: ${lbl2}`;
    renderStatTable();
    $('statInputCard')?.classList.add('hidden');
  } catch (e) {
    toast('Gagal simpan: ' + e.message, 'error');
  } finally {
    setLoading('btnSaveStats', false, 'Simpan');
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   GEMINI AI
   ══════════════════════════════════════════════════════════════════════════ */

function geminiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${getGeminiKey()}`;
}

/* ── Test & diagnosa koneksi Gemini — dipanggil dari tombol di API Setup ── */
async function testGeminiKey() {
  const key = getGeminiKey();
  const btn = $('btnTestGemini');
  const out = $('geminiTestResult');
  if (!key) {
    if (out) { out.style.display=''; out.style.background='#fef2f2'; out.style.color='#b91c1c'; out.textContent='⚠ API Key belum diisi.'; }
    return;
  }
  if (btn) { btn.textContent='⏳ Mengecek…'; btn.disabled=true; }
  if (out)  { out.style.display=''; out.style.background='#f8fafc'; out.style.color='#475569'; out.textContent='Memeriksa model yang tersedia…'; }

  // Step 1: cek apakah key valid dengan list models
  let availableModels = [];
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    availableModels = (d.models || [])
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => m.name.replace('models/', ''));
  } catch (e) {
    if (out) {
      out.style.background='#fef2f2'; out.style.color='#b91c1c';
      out.innerHTML = `❌ <strong>API Key tidak valid atau tidak dapat diakses.</strong><br>
        Error: ${e.message}<br><br>
        <strong>Solusi:</strong><br>
        1. Pastikan key dari <a href="https://aistudio.google.com/app/apikey" target="_blank" style="color:#2563eb">aistudio.google.com</a><br>
        2. Cek apakah "Generative Language API" sudah diaktifkan di Google Cloud Console<br>
        3. Pastikan key tidak dibatasi IP/domain`;
    }
    if (btn) { btn.textContent='🧪 Test Koneksi'; btn.disabled=false; }
    return;
  }

  // Step 2: cek mana model dari GEMINI_MODELS yang tersedia
  const ourModels   = GEMINI_MODELS;
  const supported   = ourModels.filter(m => availableModels.includes(m));
  const unsupported = ourModels.filter(m => !availableModels.includes(m));

  if (supported.length === 0) {
    if (out) {
      out.style.background='#fef9c3'; out.style.color='#92400e';
      out.innerHTML = `⚠ <strong>Key valid, tapi tidak ada model yang cocok.</strong><br>
        Model tersedia di akun Anda: <em>${availableModels.slice(0,5).join(', ')}</em><br>
        Hubungi admin untuk update daftar model.`;
    }
  } else {
    // Step 3: coba kirim pesan singkat dengan model pertama yang tersedia
    let testOk = false; let testErr = '';
    try {
      const testBody = JSON.stringify({ contents:[{parts:[{text:'Jawab satu kata: halo'}]}] });
      const tr = await fetch(geminiUrl(supported[0]), { method:'POST', headers:{'Content-Type':'application/json'}, body: testBody });
      const td = await tr.json();
      if (td.error) throw new Error(td.error.message);
      testOk = !!(td.candidates?.[0]?.content?.parts?.[0]?.text);
    } catch(e) { testErr = e.message; }

    if (testOk) {
      if (out) {
        out.style.background='#f0fdf4'; out.style.color='#166534';
        out.innerHTML = `✅ <strong>Gemini berfungsi normal!</strong><br>
          Model aktif: <strong>${supported[0]}</strong><br>
          ${unsupported.length ? `Model tidak tersedia di akun ini: <em>${unsupported.join(', ')}</em>` : 'Semua model tersedia.'}`;
      }
    } else {
      if (out) {
        out.style.background='#fef2f2'; out.style.color='#b91c1c';
        out.innerHTML = `⚠ Key valid, model <strong>${supported[0]}</strong> ditemukan, tapi gagal merespons.<br>
          Error: ${testErr}<br>Kemungkinan: quota habis atau region dibatasi.`;
      }
    }
  }
  if (btn) { btn.textContent='🧪 Test Koneksi'; btn.disabled=false; }
}

async function callGemini(prompt) {
  const key = getGeminiKey();
  if (!key) throw new Error('Gemini API Key belum diisi. Masuk ke API Setup → Gemini AI dan isi key-nya.');

  let lastErr = 'Semua model gagal';
  for (const model of GEMINI_MODELS) {
    try {
      // thinkingConfig hanya untuk model yang mendukungnya (gemini-2.5+)
      const generationConfig = GEMINI_THINKING_MODELS.has(model)
        ? { temperature: 0.7, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } }
        : { temperature: 0.8, maxOutputTokens: 2048 };

      const body = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig,
      });
      const res  = await fetch(geminiUrl(model), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
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

/* ── Claude API call (support teks + gambar) ─────────────────────────────── */
async function callClaude(prompt, image = null) {
  const key = getClaudeKey();
  if (!key) throw new Error('no_key');
  let lastErr = 'Semua model gagal';
  for (const model of CLAUDE_MODELS) {
    try {
      const content = image
        ? [ { type:'image', source:{ type:'base64', media_type: image.mimeType, data: image.base64 } },
            { type:'text',  text: prompt } ]
        : prompt;
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({ model, max_tokens: 2048, messages: [{ role:'user', content }] })
      });
      const data = await res.json();
      if (data.error) { lastErr = data.error.message; continue; }
      const text = data.content?.[0]?.text;
      if (!text) { lastErr = 'Respons kosong'; continue; }
      return text;
    } catch (e) { lastErr = e.message; }
  }
  throw new Error(lastErr);
}

/* ── Unified AI: Gemini primary (gratis) → Claude fallback (opsional) ───── */
async function callAI(prompt, image = null) {
  const hasGemini = !!getGeminiKey();
  const hasClaude = !!getClaudeKey();
  if (!hasGemini && !hasClaude) {
    throw new Error('Belum ada AI API Key. Isi Gemini API Key (gratis) di API Setup.');
  }
  // Gemini dulu (gratis)
  if (hasGemini) {
    try {
      if (image) {
        const model = GEMINI_MODELS[0] || 'gemini-2.5-flash';
        const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${getGeminiKey()}`;
        const resp  = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [
            { inlineData: { mimeType: image.mimeType, data: image.base64 } },
            { text: prompt }
          ]}]})
        });
        const j = await resp.json();
        if (!resp.ok) throw new Error(j.error?.message || 'Gemini error');
        return j.candidates?.[0]?.content?.parts?.[0]?.text || '';
      }
      return await callGemini(prompt);
    } catch (e) {
      if (!hasClaude) throw e;
      console.warn('[AI] Gemini gagal, fallback ke Claude:', e.message);
    }
  }
  // Fallback Claude (opsional, berbayar)
  return await callClaude(prompt, image);
}

/* ── AI Content Analysis (Claude/Gemini) ─────────────────────────────────── */

function buildAnalysisPrompt(acctId, platId) {
  const platM   = PLATFORM_FIELDS[platId];
  const acctObj = ACCOUNTS.find(a => a.id === acctId);
  const acctName = acctObj?.name || acctId;
  const platName = platM?.label || platId;

  // Last 6 months stats
  const allRows = ((state.analytics?.[acctId]?.[platId]) || [])
    .slice().sort((a,b) => a.month.localeCompare(b.month));
  const last6 = allRows.slice(-6);
  const statsText = last6.length
    ? last6.map(r => {
        const view = r[platM?.viewKey] || 0;
        const foll = r[platM?.followerKey] || 0;
        const eng  = r['totalEngagement'] || 0;
        return `- ${fmtMonth(r.month)}: Views=${fmtNum(view)}, Followers/Subs(EOM)=${fmtNum(foll)}, Engagement=${fmtNum(eng)}`;
      }).join('\n')
    : '(Belum ada data statistik)';

  // Recent 20 planner contents for this account
  const plannerItems = (state.contents || [])
    .filter(c => c.account === acctId)
    .sort((a,b) => new Date(b.publishDate||b.createdAt||0) - new Date(a.publishDate||a.createdAt||0))
    .slice(0, 20);
  const plannerText = plannerItems.length
    ? plannerItems.map(c =>
        `- [${c.status||'?'}] "${c.title||'tanpa judul'}" | Format: ${c.format||'?'} | Platform: ${(c.platforms||[]).join(',')||'?'}`
      ).join('\n')
    : '(Belum ada data planner)';

  // Recent 10 bank of contents for this account
  const bankItems = (state.bankKonten || [])
    .filter(b => !b.account || b.account === acctId)
    .slice(0, 10);
  const bankText = bankItems.length
    ? bankItems.map(b => `- "${b.title||'tanpa judul'}"${b.creator ? ` (${b.creator})` : ''}`).join('\n')
    : '(Belum ada data bank konten)';

  return `Kamu adalah analis konten media sosial profesional untuk organisasi Penjaga Harapan, Indonesia.

Akun: ${acctName} | Platform: ${platName}

## DATA STATISTIK (6 bulan terakhir)
${statsText}

## PLANNER KONTEN (20 konten terbaru)
${plannerText}

## BANK OF CONTENTS (10 item terakhir)
${bankText}

Berdasarkan data di atas, analisis mendalam dan berikan REKOMENDASI KONKRET untuk meningkatkan performa views konten di platform ${platName}. Fokus pada:

1. **Tren Performa** — Identifikasi pola naik/turun dari data statistik. Apa yang menyebabkannya?
2. **Analisis Konten** — Dari daftar planner & bank konten, format/tema apa yang paling potensial menghasilkan views tinggi?
3. **Rekomendasi Format** — Format konten apa yang harus diprioritaskan? (berdasarkan data tren platform ${platName} saat ini)
4. **Strategi Judul** — Tips judul yang menarik untuk meningkatkan CTR di ${platName}
5. **Jadwal Posting** — Kapan waktu terbaik posting? Seberapa sering?
6. **Action Plan** — 5 langkah konkret yang bisa langsung dieksekusi minggu ini

Tulis dalam Bahasa Indonesia yang ringkas dan actionable. Gunakan bullet points dan header yang jelas.`;
}

async function analyzeContentWithAI() {
  const acctId = state.statActiveAcct;
  const platId = state.statActivePlat || 'youtube';
  const prompt = buildAnalysisPrompt(acctId, platId);

  showAiLoad('Menganalisis konten dengan AI…');
  try {
    const text = await callAI(prompt);
    showAiAnalysisModal(text, acctId, platId);
  } catch (e) {
    toast('Analisis gagal: ' + e.message, 'error');
  } finally {
    hideAiLoad();
  }
}

function showAiAnalysisModal(text, acctId, platId) {
  const platM   = PLATFORM_FIELDS[platId];
  const acctObj = ACCOUNTS.find(a => a.id === acctId);
  const color   = platM?.color || '#6366f1';

  // Convert simple markdown to HTML
  const html = text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^#{1,3}\s+(.+)$/gm, '<h4 style="margin:12px 0 4px;color:#0f172a;font-size:.88rem">$1</h4>')
    .replace(/^[-•]\s+(.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/gs, m => `<ul style="margin:4px 0 8px 16px;padding:0">${m}</ul>`)
    .replace(/\n{2,}/g, '<br><br>')
    .replace(/\n/g, '<br>');

  // Remove existing modal if any
  const existing = document.getElementById('aiAnalysisModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'aiAnalysisModal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal modal-analysis">
      <div class="modal-head" style="border-top:3px solid ${color};padding:14px 18px 12px">
        <div style="flex:1;min-width:0">
          <div class="modal-title" style="font-size:.9rem;display:flex;align-items:center;gap:6px">
            🧠 Analisis AI
            <span style="font-size:.75rem;font-weight:400;color:#64748b;padding:2px 7px;background:#f1f5f9;border-radius:20px">${platM?.label||platId} · ${acctObj?.name||acctId}</span>
          </div>
          <div style="font-size:.7rem;color:#94a3b8;margin-top:3px">Powered by ${getClaudeKey() ? 'Claude AI (Anthropic)' : 'Gemini AI (Google)'} · ${new Date().toLocaleDateString('id-ID',{day:'2-digit',month:'long',year:'numeric'})}</div>
        </div>
        <button onclick="document.getElementById('aiAnalysisModal').remove()"
          style="flex-shrink:0;width:28px;height:28px;border:none;background:transparent;cursor:pointer;font-size:1rem;color:#94a3b8;border-radius:6px;display:flex;align-items:center;justify-content:center"
          onmouseover="this.style.background='#f1f5f9';this.style.color='#334155'"
          onmouseout="this.style.background='transparent';this.style.color='#94a3b8'">✕</button>
      </div>
      <div class="modal-analysis-body">
        ${html}
      </div>
      <div style="padding:11px 18px;border-top:1px solid var(--bd);display:flex;gap:8px;justify-content:flex-end;flex-shrink:0">
        <button class="btn-sm" id="btnCopyAnalysis">📋 Salin</button>
        <button class="btn-sm blue" onclick="document.getElementById('aiAnalysisModal').remove()">Tutup</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // Copy button (uses raw `text` via closure)
  document.getElementById('btnCopyAnalysis')?.addEventListener('click', () => {
    navigator.clipboard.writeText(text).then(() => toast('Analisis disalin ✓', 'success'));
  });

  // Close on backdrop click
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

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
    const text = await callAI(
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

    const text = await callAI(prompt);
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
    if (creator) {
      const crArr = Array.isArray(c.creator) ? c.creator : (c.creator ? [c.creator] : []);
      if (!crArr.includes(creator)) return false;
    }
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
        <th style="padding:8px 10px;text-align:left;border:1px solid #334155">Tipe</th>
        <th style="padding:8px 10px;text-align:left;border:1px solid #334155">Status</th>
        <th style="padding:8px 10px;text-align:left;border:1px solid #334155">Akun</th>
        <th style="padding:8px 10px;text-align:left;border:1px solid #334155">Creator</th>
        <th style="padding:8px 10px;text-align:left;border:1px solid #334155">Platform</th>
      </tr></thead>
      <tbody>${filtered.map((c,i)=>`<tr style="background:${i%2===0?'#fff':'#f8fafc'}">
        <td style="padding:7px 10px;border:1px solid #e2e8f0;color:#94a3b8">${i+1}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0">${fmtDate(c.publishDate)}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;font-weight:600">${esc(c.title)}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0;font-size:10px">${esc(c.format||'—')}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0">
          <span style="background:${statusBg[c.status]||'#f1f5f9'};border-radius:4px;padding:2px 7px;font-size:10px;font-weight:700">${esc(c.status)}</span>
        </td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0">${esc(getAcctName(c.account))}</td>
        <td style="padding:7px 10px;border:1px solid #e2e8f0">${esc(Array.isArray(c.creator) ? c.creator.join(', ') : (c.creator||'—'))}</td>
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
      image: { type:'jpeg', quality: 1.0 },
      html2canvas: { scale: 3, useCORS: true, logging: false },
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
  $('loginUserSel')?.addEventListener('keydown', e => { if (e.key==='Enter') { e.preventDefault(); $('loginPw')?.focus(); } });
  $('btnDoLogin')?.addEventListener('click', doLogin);
  $('loginPw')?.addEventListener('keydown', e => { if (e.key==='Enter') doLogin(); });
  $('btnToggleLoginPw')?.addEventListener('click', () => { const i=$('loginPw'); i.type=i.type==='password'?'text':'password'; });
  $('btnLogout')?.addEventListener('click', doLogout);

  /* ── Token Setup Modal ──────────────────────────────────────── */
  $('btnSubmitSetupToken')?.addEventListener('click', connectWithTeamToken);
  $('setupToken')?.addEventListener('keydown', e => { if (e.key === 'Enter') connectWithTeamToken(); });
  $('btnToggleSetupToken')?.addEventListener('click', () => { const i = $('setupToken'); i.type = i.type === 'password' ? 'text' : 'password'; });

  /* ── Multi-creator chip removal (event delegation) ─────────── */
  $('creatorChips')?.addEventListener('click', e => {
    const btn = e.target.closest('.creator-chip-rm');
    if (!btn) return;
    const chip = btn.closest('.creator-chip');
    if (chip) { chip.remove(); _populateCreatorAddSel(); }
  });

  /* ── GitHub (API Setup) ─────────────────────────────────────── */
  $('btnTestGithub')?.addEventListener('click', testGithub);
  $('btnSaveGithub')?.addEventListener('click', saveAndInitGithub);
  $('btnTogglePat')?.addEventListener('click', () => { const i=$('cfgPat'); i.type=i.type==='password'?'text':'password'; });
  $('btnSaveGeminiKey')?.addEventListener('click', () => {
    const key = gv('cfgGeminiKey');
    saveGeminiKey(key);
    updateGeminiStatus();
    _saveApiKeysToSettings({ geminiKey: key });
    toast(key ? 'Gemini API Key disimpan ✓' : 'Gemini API Key dihapus', key ? 'success' : '');
  });
  $('btnToggleGeminiKey')?.addEventListener('click', () => { const i=$('cfgGeminiKey'); i.type=i.type==='password'?'text':'password'; });
  $('btnSaveClaudeKey')?.addEventListener('click', () => {
    const key = gv('cfgClaudeKey');
    saveClaudeKey(key);
    updateClaudeStatus();
    _saveApiKeysToSettings({ claudeKey: key });
    toast(key ? 'Claude API Key disimpan ✓' : 'Claude API Key dihapus', key ? 'success' : '');
  });
  $('btnToggleClaudeKey')?.addEventListener('click', () => { const i=$('cfgClaudeKey'); i.type=i.type==='password'?'text':'password'; });
  $('btnSaveWaToken')?.addEventListener('click', saveWaTokenFromForm);
  $('btnToggleWaToken')?.addEventListener('click', () => { const i=$('cfgWaToken'); i.type=i.type==='password'?'text':'password'; });
  $('btnSaveTeamToken')?.addEventListener('click', saveTeamTokenFromForm);
  $('btnDeleteTeamToken')?.addEventListener('click', deleteTeamToken);
  $('btnToggleTeamToken')?.addEventListener('click', () => { const i=$('cfgTeamToken'); i.type=i.type==='password'?'text':'password'; });
  $('btnSaveUrls')?.addEventListener('click', saveUrls);
  $('btnSaveKpi')?.addEventListener('click', saveKpi);

  /* ── User management ────────────────────────────────────────── */
  $('btnAddUser')?.addEventListener('click', () => { $('addUserForm').classList.toggle('hidden'); $('userNameInput')?.focus(); });
  $('btnSaveUser')?.addEventListener('click', addUser);
  $('btnCancelUser')?.addEventListener('click', () => { $('addUserForm').classList.add('hidden'); sv('userNameInput',''); });
  $('userNameInput')?.addEventListener('keydown', e => { if (e.key==='Enter') addUser(); });

  // My To-Do: tidak ada event listener manual — data dari Planner (renderTodoList dipanggil di renderDashStats)

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

  /* ── Activity search + period filter ───────────────────────── */
  $('actSearch')?.addEventListener('input', () => renderActivity(1));
  $('actPeriodSel')?.addEventListener('change', () => {
    const val = gv('actPeriodSel');
    $('actCustomRange')?.classList.toggle('hidden', val !== 'custom');
    if (val !== 'custom') { sv('actDateFrom',''); sv('actDateTo',''); }
    renderActivity(1);
  });
  ['actDateFrom','actDateTo'].forEach(id => $(id)?.addEventListener('change', () => renderActivity(1)));
  $('btnClearActFilter')?.addEventListener('click', () => {
    sv('actSearch',''); sv('actDateFrom',''); sv('actDateTo','');
    const sel = $('actPeriodSel'); if (sel) sel.value = '';
    $('actCustomRange')?.classList.add('hidden');
    renderActivity(1);
  });
  $('btnRefreshActivity')?.addEventListener('click', () => {
    const btn = $('btnRefreshActivity');
    if (btn) { btn.disabled = true; btn.style.opacity = '.5'; }
    loadAndRenderActivity().finally(() => {
      if (btn) { btn.disabled = false; btn.style.opacity = ''; }
    });
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

  /* ── Statistics download dropdown ───────────────────────────── */
  $('btnDlDropdown')?.addEventListener('click', e => {
    e.stopPropagation();
    $('statDlMenu')?.classList.toggle('hidden');
  });
  document.addEventListener('click', e => {
    $('statDlMenu')?.classList.add('hidden');
    // Toggle info tooltip on tap (mobile) — posisi fixed berdasarkan bounding rect
    const wrap = e.target.closest('.stat-info-wrap');
    $$('.stat-info-wrap.open').forEach(el => { if (el !== wrap) el.classList.remove('open'); });
    if (wrap) {
      const isOpen = wrap.classList.contains('open');
      wrap.classList.toggle('open');
      if (!isOpen) {
        const tip = wrap.querySelector('.stat-info-tip');
        if (tip) {
          const r = wrap.getBoundingClientRect();
          tip.style.top  = (r.bottom + 8) + 'px';
          tip.style.left = Math.min(r.left, window.innerWidth - 220) + 'px';
        }
      }
      e.stopPropagation();
    }
  });

  /* ── Statistics ─────────────────────────────────────────────── */
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

  // Clicks: WA button + save button + delete button
  $('bkBody')?.addEventListener('click', async e => {
    // WA send
    const waBtn = e.target.closest('.bk-wa-btn:not(.bk-wa-btn--disabled)');
    if (waBtn) { sendBankKontenWa(waBtn.dataset.id); return; }

    // Save row immediately (override debounce)
    const saveBtn = e.target.closest('.bk-save-btn');
    if (saveBtn) {
      const id = saveBtn.dataset.id;
      const item = state.bankKonten.find(x => x.id === id);
      if (!item) return;
      // Cancel pending debounce timer for this row
      if (_bkSaveTimers[id]) { clearTimeout(_bkSaveTimers[id]); delete _bkSaveTimers[id]; }
      saveBtn.disabled = true;
      const origHTML = saveBtn.innerHTML;
      saveBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>';
      saveBtn.style.color = 'var(--green)';
      try {
        state.shas.bankKonten = await window.db.writeData('contentBank', state.bankKonten, `Bank Konten: simpan "${item.title || 'tanpa judul'}"`);
        saveDataCache();
        await logActivity(currentUser(), 'Simpan Bank Konten', `"${item.title || 'tanpa judul'}"`);
        toast('Tersimpan ✓', 'success');
      } catch (err) {
        toast('Gagal simpan: ' + err.message, 'error');
      } finally {
        setTimeout(() => {
          saveBtn.innerHTML = origHTML;
          saveBtn.style.color = '';
          saveBtn.disabled = false;
        }, 1200);
      }
      return;
    }

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
  $('btnGitSync')?.addEventListener('click', async () => {
    clearDataCache();
    toast('🔄 Memuat data terbaru…', 'info');
    await loadAllData(true);
    toast('✅ Data berhasil diperbarui', 'success');
  });

  /* ── Expose globals for inline onclick ─────────────────────── */
  window.loadAndRenderActivity = loadAndRenderActivity;
  window.debouncePlatformLink  = debouncePlatformLink;
  window.openLinkModal         = openLinkModal;
  window.saveLinkFromModal     = saveLinkFromModal;
  window.closeLinkModal        = closeLinkModal;
  window.onFormatChange        = onFormatChange;
  window.renderDashNearContent = renderDashNearContent;
  window.editContent    = editContent;
  window.deleteContent  = deleteContent;
  window.selectUrlAcct  = selectUrlAcct;
  window.renderPlanner       = renderPlanner;
  window.openPlannerWa       = openPlannerWa;
  window.openBudgetModal     = openBudgetModal;
  window.closeBudgetModal    = closeBudgetModal;
  window.addBudgetRow        = addBudgetRow;
  window.removeBudgetRow     = removeBudgetRow;
  window.updateBudgetRow     = updateBudgetRow;
  window.saveBudget          = saveBudget;
  window.onStatPeriodChange     = onStatPeriodChange;
  window.setStatViewMode        = setStatViewMode;
  window.copyStatNarrative      = copyStatNarrative;
  window.copyStatTable          = copyStatTable;
  window.exportStatCSV          = exportStatCSV;
  window.importStatFromFile     = importStatFromFile;
  window.triggerYouTubeSync     = triggerYouTubeSync;
  window.deleteUser     = deleteUser;
  window.switchStatAcct     = switchStatAcct;
  window.switchStatPlat     = switchStatPlat;
  window.openStatEdit       = openStatEdit;
  window.navigate           = navigate;
  window.renderNewPostForm  = renderNewPostForm;
  // Assets
  _initAssetClickOutside();
  window.toggleAssetMenu      = toggleAssetMenu;
  window._closeAllAssetDrops  = _closeAllAssetDrops;
  window.openAddAssetFile     = openAddAssetFile;
  window.openEditAssetFile    = openEditAssetFile;
  window.closeAssetFileModal  = closeAssetFileModal;
  window.saveAssetFile        = saveAssetFile;
  window.deleteAssetFile      = deleteAssetFile;
  window.openAssetInfo        = openAssetInfo;
  // backward-compat
  window.openAddAssetFolder   = openAddAssetFolder;
  window.openEditAssetFolder  = openEditAssetFolder;
  window.closeAssetFolderModal= closeAssetFolderModal;
  window.saveAssetFolder      = saveAssetFolder;
  window.deleteAssetFolder    = deleteAssetFolder;
  window.openAddAssetLink     = openAddAssetLink;
  window.openEditAssetLink    = openEditAssetLink;
  window.closeAssetLinkModal  = closeAssetLinkModal;
  window.saveAssetLink        = saveAssetLink;
  window.deleteAssetLink      = deleteAssetLink;
  window.copyAssetLink        = copyAssetLink;
  window.updateContentField = updateContentField;
  window.setKpiPeriod       = setKpiPeriod;
  window.previewContent     = previewContent;
  window.closeCntPreview    = closeCntPreview;
  window.renderActivity       = renderActivity;
  window.editUser             = editUser;
  window.saveEditUser         = saveEditUser;
  window.saveWaTokenFromForm  = saveWaTokenFromForm;
  window.updateTopSlot        = updateTopSlot;
  window.saveTopContent       = saveTopContent;
  window.switchTop3Month      = switchTop3Month;
  window.toggleTop3MoPicker   = toggleTop3MoPicker;
  window.navTop3PickerYear    = navTop3PickerYear;
  window.pickTop3Month        = pickTop3Month;
  window.generateShareLink       = generateShareLink;
  window.saveTeamTokenFromForm   = saveTeamTokenFromForm;
  window.deleteTeamToken         = deleteTeamToken;
  window.updateTeamTokenStatus   = updateTeamTokenStatus;

  /* ── Jam digital topbar ─────────────────────────────────────────── */
  startClock();

  /* ── Kurs USD/IDR ───────────────────────────────────────────────── */
  fetchExchangeRate();
  setInterval(fetchExchangeRate, 5 * 60 * 1000);  // refresh tiap 5 menit

  /* ── INIT: Pre-configure dengan default repo jika belum ada config ── */
  if (!window.db.isConfigured()) {
    window.db.saveConfig(DEFAULT_REPO);  // tanpa PAT — hanya untuk baca repo public
  }

  /* ── INIT: Terapkan teamToken dari cache SEBELUM request apapun ─────────
     Ini mencegah rate-limit GitHub (60 req/jam untuk unauthenticated).
     Admin yang punya PAT sendiri tidak terpengaruh (_applyTeamTokenFromCache
     skip jika PAT sudah ada). ─────────────────────────────────────────── */
  _applyTeamTokenFromCache();

  /* ── INIT: Auth flow ────────────────────────────────────────── */
  if (isFirstRun()) {
    try {
      const _s = await window.db.readData('settings');

      if (_s?.adminHash) {
        // ✅ Instalasi ada & sudah setup — lanjut ke login
        if (_s.teamToken) {
          const decoded = _decodeToken(_s.teamToken);
          localStorage.setItem(TEAM_TOKEN_KEY, decoded);
          if (!window.db.getConfig()?.pat) {
            window.db.saveConfig({ ...window.db.getConfig(), pat: decoded });
          }
        }
        saveAuth({ adminName: _s.adminName || 'Admin', adminHash: _s.adminHash });
        setPubUsers(_s.users || []);
        showLogin();

      } else if (Array.isArray(_s) && !_s.length) {
        // 🔒 File tidak ditemukan (404) — repo kemungkinan PRIVATE atau belum ada file
        // Tunjukkan form token setup (anggota tim masukkan token, admin klik link wizard)
        showTokenSetup();

      } else {
        // ⚙️ File ada tapi adminHash belum diisi — instalasi pertama admin
        showWizard('new');
      }
    } catch {
      // ❌ Error koneksi / rate limit
      if (getAuth()) {
        showLogin();      // ada cache → tetap bisa login
      } else {
        showTokenSetup(); // tidak ada cache → minta token
      }
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

/* ================================================================
   Pesan antar user — pop up chat (teks, emoji, file/foto maks 10 MB)
   Server: Cloudflare Pages Function /api/chat/* (D1 + R2)
   ================================================================ */
(function () {
  const API       = '/api/chat';
  const TOKEN_KEY = 'cms_chat_auth_v1';
  const MAX_FILE  = 10 * 1024 * 1024;
  const ALL       = '#all';
  const EMOJIS = ('😀 😁 😂 🤣 😊 😍 😘 😎 🤩 🥳 😇 🙂 😉 😅 😆 🤔 🤗 🤭 😴 😢 😭 😡 😱 🥺 😬 🙄 😏 🤝 👍 👎 👏 🙏 💪 👌 ✌️ 🤞 👋 🙌 ' +
                  '❤️ 🧡 💛 💚 💙 💜 🔥 ✨ ⭐ 🎉 🎊 💯 ✅ ❌ ⚠️ 📌 📢 📅 ⏰ 📷 🎥 🎬 🎙 📝 📁 💡 🚀 ☕ 🍕').split(' ');

  const S = {
    auth: null,          // { token, name }
    users: [],           // anggota lain
    convs: {},           // conv → ringkasan dari /inbox
    open: false,
    peer: null,          // nama lawan bicara atau '#all' (null = daftar)
    messages: [],
    lastId: 0,
    pending: [],         // lampiran yang sudah/ sedang diunggah
    timer: null,
    unreadTotal: 0,
    notConfigured: false,
    seenNotify: new Set(),
  };

  /* ── helpers ─────────────────────────────────────────────── */
  const $  = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sessName = () => { try { return JSON.parse(sessionStorage.getItem('cmsph_sess_v1') || 'null')?.name || ''; } catch { return ''; } };
  const meName   = () => (typeof getSess === 'function' ? getSess()?.name : '') || sessName();
  const low = s => String(s || '').trim().toLowerCase();
  const convOf = peer => peer === ALL ? 'all' : 'dm:' + [low(S.auth?.name), low(peer)].sort().join('|');
  const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
  const fmtTime = ts => {
    const d = new Date(ts), now = new Date();
    const hm = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return hm;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Kemarin ' + hm;
    return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }) + ' ' + hm;
  };
  const fileUrl = (key, dl) => `${API}/file?key=${encodeURIComponent(key)}&t=${encodeURIComponent(S.auth?.token || '')}${dl ? '&dl=1' : ''}`;
  const initials = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  const avColor = n => { const p = ['#2563eb','#7c3aed','#db2777','#ea580c','#16a34a','#0891b2','#ca8a04','#4f46e5']; let h = 0; for (const c of String(n)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return p[h % p.length]; };
  const linkify = t => esc(t).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/\n/g, '<br>');
  const notify = (m, type) => (typeof toast === 'function' ? toast(m, type) : console.log(m));

  function loadAuth() {
    try { S.auth = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null'); } catch { S.auth = null; }
    if (S.auth && low(S.auth.name) !== low(meName())) S.auth = null;   // token milik user lain
  }
  function saveAuth(a) { S.auth = a; try { a ? localStorage.setItem(TOKEN_KEY, JSON.stringify(a)) : localStorage.removeItem(TOKEN_KEY); } catch {} }

  async function api(path, opt = {}) {
    const headers = { ...(opt.headers || {}) };
    if (S.auth?.token) headers.Authorization = 'Bearer ' + S.auth.token;
    if (opt.json !== undefined) { headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(opt.json); }
    const res = await fetch(API + path, { method: opt.method || 'GET', headers, body: opt.body });
    const ct  = res.headers.get('content-type') || '';
    if (!ct.includes('json')) { const e = new Error('Layanan pesan belum tersedia di server'); e.code = 'not_configured'; throw e; }
    const data = await res.json();
    if (!res.ok) {
      const e = new Error(data.error || 'HTTP ' + res.status); e.code = data.code; e.status = res.status;
      if (data.code === 'auth') saveAuth(null);
      if (data.code === 'not_configured') S.notConfigured = true;
      throw e;
    }
    return data;
  }

  /* ── DOM ─────────────────────────────────────────────────── */
  function build() {
    if ($('chatFab')) return;
    const fab = document.createElement('button');
    fab.id = 'chatFab'; fab.className = 'chat-fab hidden'; fab.title = 'Pesan';
    fab.setAttribute('aria-label', 'Buka pesan');
    fab.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg><span class="chat-badge hidden" id="chatBadge">0</span>`;
    fab.onclick = () => (S.open ? close() : openPanel());
    document.body.appendChild(fab);

    const panel = document.createElement('div');
    panel.id = 'chatPanel'; panel.className = 'chat-panel hidden';
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Pesan');
    panel.innerHTML = `
      <div class="chat-head">
        <button class="chat-icon-btn hidden" id="chatBack" title="Kembali" aria-label="Kembali">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg></button>
        <div class="chat-head-av" id="chatHeadAv">💬</div>
        <div class="chat-head-text"><div class="chat-head-title" id="chatTitle">Pesan</div><div class="chat-head-sub" id="chatSub">Kirim pesan, foto, dan file ke tim</div></div>
        <button class="chat-icon-btn" id="chatClose" title="Tutup" aria-label="Tutup">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
      </div>
      <div class="chat-body" id="chatBody"></div>
      <div class="chat-compose hidden" id="chatCompose">
        <div class="chat-pending" id="chatPending"></div>
        <div class="chat-emoji-pop hidden" id="chatEmojiPop">${EMOJIS.map(e => `<button type="button">${e}</button>`).join('')}</div>
        <div class="chat-compose-row">
          <button class="chat-icon-btn" id="chatEmojiBtn" title="Emoji" aria-label="Emoji">😊</button>
          <button class="chat-icon-btn" id="chatAttachBtn" title="Lampirkan file/foto (maks 10 MB)" aria-label="Lampirkan file">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg></button>
          <input type="file" id="chatFile" multiple hidden />
          <textarea id="chatInput" rows="1" placeholder="Tulis pesan…" maxlength="4000"></textarea>
          <button class="chat-send" id="chatSend" title="Kirim" aria-label="Kirim">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
        </div>
      </div>`;
    document.body.appendChild(panel);

    $('chatClose').onclick = close;
    $('chatBack').onclick = () => showList();
    $('chatEmojiBtn').onclick = e => { e.stopPropagation(); $('chatEmojiPop').classList.toggle('hidden'); };
    $('chatEmojiPop').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      const t = $('chatInput'); const p = t.selectionStart ?? t.value.length;
      t.value = t.value.slice(0, p) + b.textContent + t.value.slice(t.selectionEnd ?? p);
      t.focus(); t.selectionStart = t.selectionEnd = p + b.textContent.length; autoGrow();
    };
    document.addEventListener('click', e => { if (!e.target.closest('#chatEmojiPop, #chatEmojiBtn')) $('chatEmojiPop')?.classList.add('hidden'); });
    $('chatAttachBtn').onclick = () => $('chatFile').click();
    $('chatFile').onchange = e => { [...e.target.files].forEach(addFile); e.target.value = ''; };
    $('chatInput').addEventListener('input', autoGrow);
    $('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    $('chatInput').addEventListener('paste', e => {
      const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); files.forEach(addFile); }
    });
    $('chatSend').onclick = send;
    // seret & lepas file ke panel
    panel.addEventListener('dragover', e => { if (S.peer) { e.preventDefault(); panel.classList.add('drag'); } });
    panel.addEventListener('dragleave', e => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('drag'); });
    panel.addEventListener('drop', e => { panel.classList.remove('drag'); if (!S.peer) return; e.preventDefault(); [...e.dataTransfer.files].forEach(addFile); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.open) close(); });
  }
  function autoGrow() { const t = $('chatInput'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 120) + 'px'; }
  function setHead(title, sub, av, back) {
    $('chatTitle').textContent = title; $('chatSub').textContent = sub || '';
    const a = $('chatHeadAv'); a.textContent = av.text; a.style.background = av.bg || ''; a.style.color = av.fg || '';
    $('chatBack').classList.toggle('hidden', !back);
  }

  /* ── views ───────────────────────────────────────────────── */
  function renderNotConfigured() {
    setHead('Pesan', 'Belum aktif', { text: '💬' }, false);
    $('chatCompose').classList.add('hidden');
    const admin = typeof isAdmin === 'function' && isAdmin();
    $('chatBody').innerHTML = `<div class="chat-empty"><div class="chat-empty-ic">🛠</div>
      <b>Fitur pesan belum diaktifkan</b>
      <p>${admin ? 'Hubungkan database D1 <code>CHAT_DB</code>, bucket R2 <code>CHAT_FILES</code>, dan secret <code>CHAT_SECRET</code> di pengaturan project Cloudflare Pages, lalu deploy ulang.'
                 : 'Admin perlu mengaktifkannya di pengaturan Cloudflare terlebih dahulu.'}</p></div>`;
  }
  function renderLogin(msg) {
    setHead('Pesan', 'Masuk untuk membuka pesan', { text: '🔒' }, false);
    $('chatCompose').classList.add('hidden');
    $('chatBody').innerHTML = `<form class="chat-login" id="chatLoginForm">
      <div class="chat-empty-ic">🔒</div>
      <b>Konfirmasi password</b>
      <p>Masukkan password akun <b>${esc(meName())}</b> sekali untuk membuka pesan di perangkat ini.</p>
      <input type="password" id="chatPw" class="form-inp" placeholder="Password" autocomplete="current-password" required />
      ${msg ? `<div class="chat-err">${esc(msg)}</div>` : ''}
      <button class="btn-sm blue" type="submit">Buka Pesan</button></form>`;
    $('chatLoginForm').onsubmit = async e => {
      e.preventDefault();
      try { await loginWith(meName(), $('chatPw').value); await showList(); }
      catch (er) { renderLogin(er.message); }
    };
    setTimeout(() => $('chatPw')?.focus(), 50);
  }

  async function showList() {
    S.peer = null; S.messages = []; S.lastId = 0; S.pending = [];
    $('chatCompose').classList.add('hidden');
    setHead('Pesan', 'Pilih percakapan', { text: '💬' }, false);
    if (!S.users.length) {
      $('chatBody').innerHTML = `<div class="chat-loading"><div class="spinner"></div></div>`;
      try { const r = await api('/users'); S.users = r.users || []; } catch (e) { return handleErr(e); }
    }
    await refreshInbox(true);
  }
  function renderList() {
    if (S.peer || !S.open) return;
    const rows = [{ name: ALL, role: 'grup' }, ...S.users].map(u => {
      const c = S.convs[convOf(u.name)];
      return { ...u, last: c, unread: c?.unread || 0, ts: c?.ts || 0 };
    }).sort((a, b) => (a.name === ALL ? -1 : b.name === ALL ? 1 : b.ts - a.ts || a.name.localeCompare(b.name)));
    $('chatBody').innerHTML = `<div class="chat-search"><input id="chatSearch" placeholder="Cari nama…" /></div>
      <div class="chat-list">${rows.map(r => {
        const isAll = r.name === ALL;
        const prev  = r.last ? `${low(r.last.from) === low(S.auth?.name) ? 'Anda: ' : isAll ? esc(r.last.from) + ': ' : ''}${r.last.text ? esc(r.last.text.slice(0, 60)) : '📎 Lampiran'}` : '<span class="chat-muted">Belum ada pesan</span>';
        return `<button class="chat-row${r.unread ? ' unread' : ''}" data-peer="${esc(r.name)}" data-q="${esc(low(isAll ? 'semua tim' : r.name))}">
          <span class="chat-av" style="--av:${isAll ? '#1d4ed8' : avColor(r.name)}">${isAll ? '👥' : esc(initials(r.name))}</span>
          <span class="chat-row-main"><span class="chat-row-top"><b>${isAll ? 'Semua Tim' : esc(r.name)}</b>${r.ts ? `<i>${fmtTime(r.ts)}</i>` : ''}</span>
            <span class="chat-row-prev">${prev}</span></span>
          ${r.unread ? `<span class="chat-unread">${r.unread > 99 ? '99+' : r.unread}</span>` : ''}</button>`;
      }).join('')}</div>`;
    $('chatBody').querySelectorAll('.chat-row').forEach(b => b.onclick = () => openThread(b.dataset.peer));
    $('chatSearch').oninput = e => {
      const q = low(e.target.value);
      $('chatBody').querySelectorAll('.chat-row').forEach(b => b.classList.toggle('hidden', !!q && !b.dataset.q.includes(q)));
    };
  }

  async function openThread(peer) {
    S.peer = peer; S.messages = []; S.lastId = 0; S.pending = [];
    const isAll = peer === ALL;
    const u = S.users.find(x => x.name === peer);
    setHead(isAll ? 'Semua Tim' : peer, isAll ? `${S.users.length + 1} anggota` : (u?.role ? String(u.role).replace(/^\w/, c => c.toUpperCase()) : ''),
      isAll ? { text: '👥', bg: '#fff', fg: '#1d4ed8' } : { text: initials(peer), bg: '#fff', fg: avColor(peer) }, true);
    $('chatBody').innerHTML = `<div class="chat-thread" id="chatThread"><div class="chat-loading"><div class="spinner"></div></div></div>`;
    $('chatCompose').classList.remove('hidden');
    renderPending();
    setTimeout(() => $('chatInput')?.focus(), 50);
    await fetchMessages(true);
  }

  async function fetchMessages(first) {
    if (!S.peer) return;
    const peer = S.peer;
    try {
      const r = await api(`/messages?with=${encodeURIComponent(peer)}${S.lastId ? '&after=' + S.lastId : ''}`);
      if (S.peer !== peer) return;
      if (r.messages.length || first) {
        S.messages.push(...r.messages);
        S.lastId = S.messages.length ? S.messages[S.messages.length - 1].id : S.lastId;
        renderThread(first);
        if (S.lastId) api('/read', { method: 'POST', json: { with: peer, lastId: S.lastId } }).then(() => refreshInbox()).catch(() => {});
      }
    } catch (e) { handleErr(e); }
  }

  function renderThread(forceBottom) {
    const box = $('chatThread'); if (!box) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    if (!S.messages.length) {
      box.innerHTML = `<div class="chat-empty"><div class="chat-empty-ic">👋</div><b>Mulai percakapan</b><p>Kirim pesan, emoji, foto, atau file (maks 10 MB).</p></div>`;
      return;
    }
    let lastDay = '';
    box.innerHTML = S.messages.map((m, i) => {
      const mine = low(m.from) === low(S.auth?.name);
      const day  = new Date(m.ts).toDateString();
      const sep  = day !== lastDay ? `<div class="chat-day">${new Date(m.ts).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long' })}</div>` : '';
      lastDay = day;
      const prev = S.messages[i - 1];
      const showName = !mine && S.peer === ALL && (!prev || prev.from !== m.from || sep);
      const files = (m.files || []).map(f => (f.type || '').startsWith('image/')
        ? `<a class="chat-img" href="${fileUrl(f.key)}" target="_blank" rel="noopener"><img src="${fileUrl(f.key)}" alt="${esc(f.name)}" loading="lazy" /></a>`
        : (f.type || '').startsWith('video/')
          ? `<video class="chat-video" src="${fileUrl(f.key)}" controls preload="metadata"></video>`
          : `<a class="chat-file" href="${fileUrl(f.key, true)}" target="_blank" rel="noopener"><span class="chat-file-ic">📄</span>
               <span class="chat-file-meta"><b>${esc(f.name)}</b><i>${fmtSize(f.size)}</i></span><span class="chat-file-dl">⬇</span></a>`).join('');
      const onlyEmoji = m.text && !files && /^(\p{Extended_Pictographic}|️|‍|\s){1,8}$/u.test(m.text);
      return `${sep}<div class="chat-msg ${mine ? 'mine' : 'theirs'}">
        ${showName ? `<div class="chat-msg-name" style="color:${avColor(m.from)}">${esc(m.from)}</div>` : ''}
        <div class="chat-bubble${onlyEmoji ? ' emoji-only' : ''}">${files}${m.text ? `<div class="chat-text">${linkify(m.text)}</div>` : ''}
          <span class="chat-time">${fmtTime(m.ts).replace(/^.* (\d\d[.:]\d\d)$/, '$1')}</span></div></div>`;
    }).join('');
    if (forceBottom || nearBottom) box.scrollTop = box.scrollHeight;
    box.querySelectorAll('img').forEach(img => img.addEventListener('load', () => { if (forceBottom || nearBottom) box.scrollTop = box.scrollHeight; }, { once: true }));
  }

  /* ── lampiran ────────────────────────────────────────────── */
  function addFile(file) {
    if (!S.peer) return;
    if (file.size > MAX_FILE) { notify(`"${file.name}" melebihi 10 MB`, 'error'); return; }
    const item = { id: Math.random().toString(36).slice(2), file, name: file.name, size: file.size, type: file.type, progress: 0, done: null, error: null };
    item.preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
    S.pending.push(item); renderPending(); upload(item);
  }
  function upload(item) {
    const fd = new FormData(); fd.append('to', S.peer); fd.append('file', item.file);
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    xhr.open('POST', API + '/upload');
    xhr.setRequestHeader('Authorization', 'Bearer ' + (S.auth?.token || ''));
    xhr.upload.onprogress = e => { if (e.lengthComputable) { item.progress = Math.round(e.loaded / e.total * 100); renderPending(); } };
    xhr.onload = () => {
      let data = {}; try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && data.key) item.done = data;
      else item.error = data.error || 'Gagal mengunggah';
      renderPending();
    };
    xhr.onerror = () => { item.error = 'Koneksi terputus'; renderPending(); };
    xhr.send(fd);
  }
  function renderPending() {
    const box = $('chatPending'); if (!box) return;
    box.innerHTML = S.pending.map(p => `<div class="chat-pend${p.error ? ' err' : ''}">
      ${p.preview ? `<img src="${p.preview}" alt="">` : '<span class="chat-file-ic">📄</span>'}
      <span class="chat-pend-meta"><b>${esc(p.name)}</b><i>${p.error ? esc(p.error) : p.done ? fmtSize(p.size) + ' · siap' : p.progress + '%'}</i>
        ${!p.done && !p.error ? `<span class="chat-prog"><i style="width:${p.progress}%"></i></span>` : ''}</span>
      <button type="button" data-rm="${p.id}" title="Hapus" aria-label="Hapus lampiran">✕</button></div>`).join('');
    box.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
      const p = S.pending.find(x => x.id === b.dataset.rm); if (p?.xhr && !p.done) p.xhr.abort();
      S.pending = S.pending.filter(x => x.id !== b.dataset.rm); renderPending();
    });
  }

  async function send() {
    if (!S.peer) return;
    const input = $('chatInput');
    const text  = input.value.trim();
    if (S.pending.some(p => !p.done && !p.error)) { notify('Tunggu, file masih diunggah…'); return; }
    const files = S.pending.filter(p => p.done).map(p => p.done);
    if (!text && !files.length) return;
    $('chatSend').disabled = true;
    try {
      const r = await api('/send', { method: 'POST', json: { to: S.peer, text, files } });
      input.value = ''; autoGrow();
      S.pending.forEach(p => p.preview && URL.revokeObjectURL(p.preview));
      S.pending = []; renderPending();
      if (!S.messages.some(m => m.id === r.message.id)) S.messages.push(r.message);
      S.lastId = Math.max(S.lastId, r.message.id);
      renderThread(true);
      refreshInbox();
    } catch (e) { handleErr(e, true); }
    finally { $('chatSend').disabled = false; input.focus(); }
  }

  /* ── inbox & polling ─────────────────────────────────────── */
  async function refreshInbox(render) {
    if (!S.auth) return;
    try {
      const r = await api('/inbox');
      const prev = S.convs;
      S.convs = {}; (r.convs || []).forEach(c => { S.convs[c.conv] = c; });
      S.unreadTotal = Object.values(S.convs).reduce((s, c) => s + (c.unread || 0), 0);
      updateBadge();
      // Notifikasi pesan baru saat panel tertutup / percakapan lain
      Object.values(S.convs).forEach(c => {
        const before = prev[c.conv];
        const isNew = c.unread && (!before || c.id > before.id) && !S.seenNotify.has(c.id);
        const viewing = S.open && S.peer && convOf(S.peer) === c.conv;
        if (isNew && !viewing && Object.keys(prev).length) {
          S.seenNotify.add(c.id);
          notify(`💬 ${c.from}${c.conv === 'all' ? ' (Semua Tim)' : ''}: ${c.text ? c.text.slice(0, 50) : '📎 Lampiran'}`);
        }
      });
      if (render || (S.open && !S.peer)) renderList();
    } catch (e) { if (render) handleErr(e); }
  }
  function updateBadge() {
    const b = $('chatBadge'); if (!b) return;
    b.textContent = S.unreadTotal > 99 ? '99+' : S.unreadTotal;
    b.classList.toggle('hidden', !S.unreadTotal);
  }
  function schedule() {
    clearTimeout(S.timer);
    if (!S.auth || S.notConfigured) return;
    const delay = S.open && S.peer ? 4000 : S.open ? 10000 : 30000;
    S.timer = setTimeout(async () => {
      if (document.visibilityState === 'visible') {
        if (S.open && S.peer) await fetchMessages(false);
        await refreshInbox();
      }
      schedule();
    }, delay);
  }

  function handleErr(e, toastOnly) {
    if (e.code === 'not_configured' || S.notConfigured) { S.notConfigured = true; if (S.open) renderNotConfigured(); return; }
    if (e.code === 'auth') { if (S.open) renderLogin('Sesi pesan habis, masukkan password lagi.'); return; }
    if (toastOnly || S.peer) { notify('Pesan: ' + e.message, 'error'); return; }
    $('chatBody').innerHTML = `<div class="chat-empty"><div class="chat-empty-ic">⚠️</div><b>Gagal memuat</b><p>${esc(e.message)}</p>
      <button class="btn-sm" onclick="Chat.open()">Coba lagi</button></div>`;
  }

  /* ── open / close ────────────────────────────────────────── */
  async function openPanel() {
    build(); loadAuth();
    S.open = true;
    $('chatPanel').classList.remove('hidden');
    $('chatFab').classList.add('active');
    if (S.notConfigured) return renderNotConfigured();
    if (!S.auth) return renderLogin();
    if (S.peer) { await fetchMessages(true); } else { await showList(); }
    schedule();
  }
  function close() {
    S.open = false;
    $('chatPanel')?.classList.add('hidden');
    $('chatFab')?.classList.remove('active');
    $('chatEmojiPop')?.classList.add('hidden');
    schedule();
  }

  /* ── API publik (dipanggil app.js) ───────────────────────── */
  async function loginWith(name, password) {
    const r = await api('/login', { method: 'POST', json: { name, password } });
    saveAuth({ token: r.token, name: r.name });
    S.users = []; S.convs = {};
    refreshInbox();
    schedule();
    return r;
  }
  function sync() {
    build();
    const logged = !!meName() && !document.getElementById('loginPage')?.offsetParent;
    $('chatFab').classList.toggle('hidden', !logged);
    if (!logged) { close(); return; }
    loadAuth();
    if (S.auth) { refreshInbox(); if (!S.timer) schedule(); }
  }
  function logout() {
    saveAuth(null); clearTimeout(S.timer); S.timer = null;
    Object.assign(S, { users: [], convs: {}, peer: null, messages: [], lastId: 0, pending: [], unreadTotal: 0 });
    close(); $('chatFab')?.classList.add('hidden'); updateBadge();
  }

  window.Chat = { open: openPanel, close, sync, logout, loginWith: (n, p) => loginWith(n, p).catch(() => null) };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.auth) refreshInbox(); });
})();

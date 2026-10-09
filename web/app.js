/* OpenCode Remote PWA — vanilla, dependency-free (xterm loads lazily for terminal). */
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const view = $('#view');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Minimal safe markdown: escape first, then decorate. */
function md(src) {
  let t = esc(src);
  const blocks = [];
  t = t.replace(/```(\w*)\n?([\s\S]*?)(?:```|$)/g, (_, lang, code) => {
    blocks.push(`<div class="codeblock"><button data-copy-code tabindex="-1">Copy</button><pre><code>${code.replace(/^\n+|\s+$/g, '')}</code></pre></div>`);
    return `\u0000B${blocks.length - 1}\u0000`;
  });
  t = t.replace(/^#### (.*)$/gm, '<h4>$1</h4>').replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h2>$1</h2>');
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const lines = t.split('\n');
  let html = '', inList = false, para = [];
  const flushPara = () => { if (para.length) { html += `<p>${para.join('<br>')}</p>`; para = []; } };
  for (const ln of lines) {
    if (/^\u0000B\d+\u0000$/.test(ln)) { flushPara(); if (inList) { html += '</ul>'; inList = false; } html += ln; continue; }
    if (/^<h\d>/.test(ln) || /^<pre>/.test(ln) || /^<div class="codeblock">/.test(ln)) { flushPara(); if (inList) { html += '</ul>'; inList = false; } html += ln; continue; }
    const lm = ln.match(/^\s*[-*] (.*)$/) || ln.match(/^\s*\d+[.)] (.*)$/);
    if (lm) { flushPara(); if (!inList) { html += '<ul>'; inList = true; } html += `<li>${lm[1]}</li>`; continue; }
    if (ln.trim() === '') { flushPara(); if (inList) { html += '</ul>'; inList = false; } continue; }
    para.push(ln);
  }
  flushPara(); if (inList) html += '</ul>';
  html = html.replace(/\u0000B(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  return html;
}

function rel(ts) {
  if (!ts) return '—';
  const d = Date.now() - ts;
  if (d < 0) return 'now';
  const m = Math.floor(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
    new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function buzz(ms) {
  try { if (navigator.vibrate) navigator.vibrate(ms); } catch { /* unsupported */ }
}

function fullTime(ts) {
  try { return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
}

/* Keeps every relative timestamp fresh without rebuilding anything. */
function paintRels() {
  $$('[data-rel]').forEach((el) => {
    const ts = Number(el.dataset.rel);
    if (ts) {
      el.textContent = rel(ts);
      el.title = fullTime(ts);
    }
  });
}
setInterval(paintRels, 30000);

function uuid() {
  return (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)));
}

let toastTimer = null;
function toast(msg, onTap) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  el.onclick = onTap || null;
  el.style.cursor = onTap ? 'pointer' : '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); el.onclick = null; }, onTap ? 8000 : 2600);
}

function csrf() {
  const m = document.cookie.match(/(?:^|; )ocr_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(opts.csrf === false ? {} : { 'x-csrf-token': csrf() }), ...(opts.headers || {}) },
    ...opts,
  });
  if (res.status === 401) {
    S.authed = false;
    go('#/login');
    throw new Error('Session expired — please sign in again.');
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { throw new Error('Bad server response'); }
  if (!res.ok) throw new Error((body && body.error && body.error.message) || `Request failed (${res.status})`);
  return body;
}

/* ---------------- state ---------------- */
const S = {
  authed: false,
  setupRequired: false,
  sessions: [],
  lastSync: 0,
  streamOk: false,
  streamDown: false,
  filter: { q: '', project: '', view: 'active' },
  projects: { allowlist: [], discovered: [] },
  models: [], agents: [], defaults: {},
  current: null, // session id
  messages: [],
  msgLoading: false,
  sending: false,
  pendingSend: null, // {key, text} — optimistic bubble until confirmed
  streamText: '',
  menu: false,
  confirmDelete: false,
  renaming: false,
  sessionsLoaded: false,
  sessionsError: '',
  ptys: [],
  termCursors: {}, // ptyID -> last upstream cursor for resume
  termDir: '', // preserved terminal-list directory choice
  conn: null,
  settings: null,
  lastId: Number(localStorage.getItem('ocr_lastId') || 0),
};

const STATE_LABEL = { running: 'Working', 'active-external': 'Active', attention: 'Attention', idle: 'Idle' };

/* ---------------- SSE stream ---------------- */
let es = null, esBackoff = 1000, refetchTimer = null, lastDeltaAt = 0, currentActivityAt = 0;

function noteActivity(ts) {
  // The open conversation gained externally-visible activity (usually found
  // by polling, since other processes share no live bus with us). Pull the
  // authoritative history unless our own stream is mid-burst.
  if (!ts || ts <= currentActivityAt) return;
  currentActivityAt = ts;
  if (Date.now() - lastDeltaAt < 3000) return;
  scheduleRefetch();
}

function connectStream() {
  if (es) { try { es.close(); } catch {} es = null; }
  if (!S.authed) return;
  const url = `/api/stream?lastId=${S.lastId}`;
  try { es = new EventSource(url); } catch { scheduleReconnect(); return; }
  es.onopen = () => { esBackoff = 1000; S.streamOk = true; S.streamDown = false; paintPill(); };
  es.onerror = () => { S.streamOk = false; S.streamDown = true; paintPill(); try { es.close(); } catch {} scheduleReconnect(); };
  es.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.id) { S.lastId = msg.id; localStorage.setItem('ocr_lastId', String(msg.id)); }
      handleEvent(msg);
    } catch { /* ignore */ }
  };
}

function scheduleReconnect() {
  setTimeout(() => { if (S.authed) connectStream(); }, esBackoff);
  esBackoff = Math.min(esBackoff * 2, 30000);
}

function handleEvent(msg) {
  const t = msg.type;
  if (t === 'sessions') {
    S.sessions = msg.data.sessions || [];
    if (onSessions()) renderSessionsList();
    if (onSessionView()) {
      paintSessionHeader();
      const s = sess();
      if (s) noteActivity(s.lastActivity);
    }
  } else if (t === 'sync') {
    S.lastSync = msg.data.at || Date.now();
    if (msg.data.sessions) {
      S.sessions = msg.data.sessions;
      if (onSessions()) renderSessionsList();
      if (onSessionView()) {
        paintSessionHeader();
        const s = sess();
        if (s) noteActivity(s.lastActivity);
      }
    }
    paintPill();
    // Status re-renders rebuild the page — throttle background refreshes so
    // the reader's scroll position survives; explicit taps always refresh.
    if (onConnection() && connStale()) renderConnection();
  } else if (t === 'session.status' || t === 'session.event') {
    if (onSessions()) renderSessionsList();
    if (onSessionView() && msg.sessionID === S.current) { paintSessionHeader(); scheduleRefetch(); }
    if (onConnection() && connStale()) renderConnection();
  } else if (t === 'session.message') {
    if (onSessionView() && msg.sessionID === S.current) scheduleRefetch();
    if (onSessions()) renderSessionsList();
  } else if (t === 'session.delta') {
    if (onSessionView() && msg.sessionID === S.current) {
      S.streamText += (msg.data && msg.data.delta) || '';
      lastDeltaAt = Date.now();
      paintStreamBubble();
    }
  } else if (t === 'pty') {
    if (onTerminalList()) loadPtys();
  } else if (t === 'health') {
    paintPill();
    if (onConnection() && connStale()) renderConnection();
  }
}

let connRenderedAt = 0;
function noteConnRendered() { connRenderedAt = Date.now(); }
function connStale() { return Date.now() - connRenderedAt > 20000; }

function scheduleRefetch() {
  clearTimeout(refetchTimer);
  refetchTimer = setTimeout(() => { if (onSessionView() && S.current) loadMessages(false); }, 900);
}

function paintPill() {
  const el = $('#conn-pill');
  if (!S.authed) { el.className = 'pill'; el.innerHTML = '<span class="dot"></span><span class="lbl">Signed out</span>'; return; }
  const stale = S.lastSync && Date.now() - S.lastSync > 90000;
  if (S.streamDown) { el.className = 'pill bad'; el.innerHTML = '<span class="dot"></span><span class="lbl">Reconnecting</span>'; }
  else if (stale) { el.className = 'pill warn'; el.innerHTML = '<span class="dot"></span><span class="lbl">Stale sync</span>'; }
  else { el.className = 'pill ok'; el.innerHTML = '<span class="dot"></span><span class="lbl">Live</span>'; }
  el.title = S.lastSync ? `Last sync ${new Date(S.lastSync).toLocaleTimeString()}` : 'Not synced yet';
}

/* ---------------- router ---------------- */
function route() { return location.hash || '#/sessions'; }
function go(h) { if (location.hash === h) render(); else location.hash = h; }
function onSessions() { return route() === '#/sessions'; }
function onSessionView() { return route().startsWith('#/s/'); }
function onTerminalList() { return route() === '#/terminal'; }
function onConnection() { return route() === '#/connection'; }

window.addEventListener('hashchange', render);
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.authed && !es) connectStream(); });

function setTab(name) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
}

async function boot() {
  try {
    const st = await api('/api/auth/status', { method: 'GET', csrf: false });
    S.setupRequired = !!st.setupRequired;
    S.authed = !!st.authenticated;
  } catch { S.authed = false; }
  if (!S.authed) { render(); return; }
  paintPill();
  connectStream();
  render();
  // background loads
  loadSessions();
  loadProjectsModels();
}

async function loadSessions() {
  try {
    const r = await api('/api/sessions?view=all');
    S.sessions = r.sessions || [];
    S.sessionsLoaded = true;
    S.sessionsError = '';
    S.lastSync = r.lastSync || S.lastSync;
    if (onSessions()) renderSessionsList();
    if (onSessionView()) paintSessionHeader();
    paintPill();
  } catch (e) {
    S.sessionsError = e.message;
    if (onSessions()) renderSessionsList();
  }
}

async function loadProjectsModels() {
  try {
    const [p, m] = await Promise.all([api('/api/projects'), api('/api/models')]);
    S.projects = p;
    S.models = m.models || [];
    S.agents = m.agents || [];
    S.defaults = { model: m.defaultModel, agent: m.defaultAgent };
  } catch { /* optional data */ }
}

/* ---------------- sessions view ---------------- */
function projHue(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function modelOptions(selected) {
  // Group a long model catalog by provider so the picker stays scannable.
  const byProv = new Map();
  for (const m of S.models) {
    if (!byProv.has(m.providerID)) byProv.set(m.providerID, []);
    byProv.get(m.providerID).push(m);
  }
  const isSel = (m) => selected && selected.id === m.id && selected.providerID === m.providerID;
  return [...byProv.entries()].map(([prov, list]) =>
    `<optgroup label="${esc(prov)}">${list.map((m) => `<option value="${esc(m.providerID)}/${esc(m.id)}"${isSel(m) ? ' selected' : ''}>${esc(m.name || m.id)}</option>`).join('')}</optgroup>`).join('');
}

function filteredSessions() {
  const f = S.filter;
  let list = S.sessions.filter((s) => !s.hidden);
  if (f.view === 'active') list = list.filter((s) => s.state === 'running' || s.state === 'active-external' || s.state === 'attention');
  if (f.view === 'hidden') list = S.sessions.filter((s) => s.hidden);
  if (f.project) list = list.filter((s) => (s.projectID || s.projectName) === f.project);
  if (f.q) {
    const q = f.q.toLowerCase();
    list = list.filter((s) => s.title.toLowerCase().includes(q) || s.id.toLowerCase().includes(q) ||
      s.directory.toLowerCase().includes(q) || (s.preview || '').toLowerCase().includes(q));
  }
  return list;
}

function renderSessions() {
  setTab('sessions');
  view.innerHTML = `
    <h1>Sessions</h1>
    <div class="toolbar">
      <input id="q" type="text" placeholder="Search title, project, text…" value="${esc(S.filter.q)}" autocomplete="off">
    </div>
    <div class="chips" id="proj-chips"></div>
    <div class="view-toggle" role="tablist">
      ${['active', 'all', 'hidden'].map((v) => `<button data-v="${v}" class="${S.filter.view === v ? 'active' : ''}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}
    </div>
    <div class="small muted" id="view-hint" style="margin:0 2px 8px">${S.filter.view === 'active' ? 'Working now or active in the last 15 minutes.' : S.filter.view === 'hidden' ? 'Archived here — history is kept, nothing is deleted.' : 'Every session on this laptop, newest first.'}</div>
    <div class="row small muted" style="margin:2px 2px 8px"><span class="grow" id="sess-count"></span><span id="sync-note"></span></div>
    <div id="no-proj"></div>
    <div id="list"></div>`;
  const projs = [...new Map(S.sessions.filter((s) => !s.hidden).map((s) => [s.projectID || s.projectName, s.projectName])).entries()];
  const chips = $('#proj-chips');
  chips.innerHTML = `<button class="chip ${!S.filter.project ? 'active' : ''}" data-p="">All projects</button>` +
    projs.map(([id, name]) => `<button class="chip ${S.filter.project === id ? 'active' : ''}" data-p="${esc(id)}">${esc(name)}</button>`).join('');
  chips.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; S.filter.project = b.dataset.p; renderSessions(); };
  $$('.view-toggle button').forEach((b) => b.onclick = () => { S.filter.view = b.dataset.v; renderSessions(); });
  $('#q').oninput = (e) => { S.filter.q = e.target.value; renderSessionsList(); $('#q').focus(); const v = $('#q'); v.setSelectionRange(v.value.length, v.value.length); };
  renderSessionsList();
}

function renderSessionsList() {
  const listEl = $('#list');
  if (!listEl) return;
  if (!S.sessionsLoaded) {
    listEl.innerHTML = S.sessionsError
      ? `<div class="empty">${esc(S.sessionsError)}<br><br><button class="ghost" id="retry">Retry</button></div>`
      : `<div class="empty"><span class="spin"></span> Loading sessions…</div>`;
    const rb = $('#retry');
    if (rb) rb.onclick = () => loadSessions();
    const sn0 = $('#sync-note');
    if (sn0) sn0.textContent = 'connecting…';
    return;
  }
  const sc = $('#view');
  const savedTop = sc ? sc.scrollTop : 0;
  const noProj = $('#no-proj');
  if (noProj) {
    noProj.innerHTML = (!S.projects.allowlist.length)
      ? `<div class="warn-note">No projects configured yet — sessions are read-only until you allow a directory. <a href="#/settings" style="color:var(--blue)">Open Settings</a></div>` : '';
  }
  const list = filteredSessions();
  const cnt = $('#sess-count');
  if (cnt) {
    const active = S.sessions.filter((s) => !s.hidden && s.state !== 'idle').length;
    cnt.textContent = `${list.length} shown · ${active} active`;
  }
  const sn = $('#sync-note');
  if (sn) sn.innerHTML = `${S.lastSync ? `synced ${rel(S.lastSync)}` : 'syncing…'} · <button class="ghost" id="sync-now" style="min-height:30px;font-size:12px;padding:0 10px">Refresh</button>`;
  const sy = $('#sync-now');
  if (sy) sy.onclick = (e) => { e.stopPropagation(); loadSessions(); };
  if (!list.length) {
    const filtering = S.filter.q || S.filter.project || S.filter.view !== 'all';
    listEl.innerHTML = `<div class="empty">${S.sessions.length
      ? (filtering ? 'Nothing matches this filter.<br>Try the All tab or clear the search.' : 'No sessions to show.')
      : 'No sessions yet.<br>Create one from the New tab, or start OpenCode on the laptop — it will appear here automatically.'}</div>`;
    if (sc) sc.scrollTop = savedTop;
    return;
  }
  // group by project, keep global recency within groups
  const groups = new Map();
  for (const s of list) {
    const k = s.projectName || s.directory;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  listEl.innerHTML = [...groups.entries()].map(([name, arr]) => `
    <div class="proj"><span class="proj-dot" style="background:hsl(${projHue(name)},45%,55%)"></span>${esc(name)} <span class="muted">· ${arr.length}</span></div>
    ${arr.map((s) => `
      <button class="sess" data-id="${esc(s.id)}">
        <span class="t"><span class="st ${esc(s.state)}"></span><span class="name">${esc(s.title || 'Untitled')}</span>${s.controllable ? '' : '<span class="ro-tag">read-only</span>'}</span>
        <span class="meta"><span class="st-label ${esc(s.state)}">${STATE_LABEL[s.state] || s.state}</span><span>·</span><span>${esc(s.model ? s.model.id : 'default model')}</span><span>·</span><span data-rel="${s.lastActivity}" title="${esc(fullTime(s.lastActivity))}">${esc(rel(s.lastActivity))}</span></span>
        ${s.preview ? `<span class="prev">${esc(s.preview)}</span>` : ''}
      </button>`).join('')}`).join('');
  $$('#list .sess').forEach((b) => b.onclick = () => go(`#/s/${b.dataset.id}`));
  // Rebuilds happen on live updates — don't lose the reader's scroll position.
  if (sc) sc.scrollTop = savedTop;
}

/* ---------------- new session ---------------- */
function renderNew() {
  setTab('new');
  const allow = S.projects.allowlist;
  const models = S.models;
  view.innerHTML = `
    <h1>New session</h1>
    ${allow.length ? '' : '<div class="warn-note">Add a project directory in Settings first.</div>'}
    <div class="card">
      <label for="ns-proj">Project directory</label>
      <select id="ns-proj">${allow.map((d) => `<option value="${esc(d.directory)}">${esc(d.directory)}</option>`).join('')}</select>
      <label for="ns-model">Model</label>
      <select id="ns-model">
        <option value="">Session default${S.defaults.model ? ` (${esc(S.defaults.model.id)})` : ''}</option>
        ${modelOptions(null)}
      </select>
      <label for="ns-agent">Agent</label>
      <select id="ns-agent">
        <option value="">Default${S.defaults.agent ? ` (${esc(S.defaults.agent)})` : ''}</option>
        ${S.agents.map((a) => `<option value="${esc(a.name)}">${esc(a.name)}</option>`).join('')}
      </select>
      <label for="ns-title">Title (optional)</label>
      <input id="ns-title" type="text" placeholder="e.g. Fix login redirect" maxlength="200">
      <label for="ns-prompt">First message</label>
      <textarea id="ns-prompt" placeholder="What should the agent do?"></textarea>
      <div class="btn-row"><button class="primary" id="ns-go">Create &amp; start</button></div>
    </div>`;
  $('#ns-go').onclick = async () => {
    const btn = $('#ns-go');
    const dir = $('#ns-proj').value;
    if (!dir) { toast('Pick a project directory'); return; }
    const mv = $('#ns-model').value;
    const model = mv ? { providerID: mv.split('/')[0], id: mv.split('/').slice(1).join('/') } : undefined;
    const agent = $('#ns-agent').value || undefined;
    const title = $('#ns-title').value.trim() || undefined;
    const prompt = $('#ns-prompt').value.trim() || undefined;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Creating…';
    try {
      const r = await api('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ directory: dir, title, agent, model, prompt, idempotencyKey: uuid() }),
      });
      toast('Session created');
      await loadSessions();
      go(`#/s/${r.session.id}`);
    } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Create & start'; }
  };
}

/* ---------------- session view ---------------- */
function sess() { return S.sessions.find((s) => s.id === S.current); }

function toolStateClass(st) {
  const s = String(st || '').toLowerCase();
  if (/error|fail|reject|deny/.test(s)) return 'err';
  if (/progress|running|pending|waiting|ask/.test(s)) return 'run';
  if (/complete|success|done/.test(s)) return 'ok';
  return 'idle';
}

function renderPart(p) {
  if (p.type === 'text' && typeof p.text === 'string') return `<div class="md">${md(p.text)}</div>`;
  if (p.type === 'reasoning' && p.text) return `<details class="reasoning"><summary>Thinking</summary><div class="md">${md(String(p.text))}</div></details>`;
  if (p.type === 'tool') {
    // Real shape (verified): state is an OBJECT {status, input, output},
    // older parts may carry a plain string. Never render the raw object.
    const st = (p.state !== undefined ? p.state : (p.metadata || {}).status) || 'pending';
    const status = typeof st === 'string' ? st : (st.status || 'pending');
    const sObj = (st && typeof st === 'object' ? st : {});
    const meta = p.metadata || {};
    const input = sObj.input !== undefined ? sObj.input : (meta.input !== undefined ? meta.input : p.input);
    const output = sObj.output !== undefined ? sObj.output : (meta.output !== undefined ? meta.output : p.output);
    return `<details class="tool"><summary><span class="tstate ${toolStateClass(status)}">${esc(String(status))}</span><span class="tn">${esc(p.tool || 'tool')}</span></summary>
      <div class="tb">${input !== undefined ? `<div>Input</div><pre>${esc(typeof input === 'string' ? input : JSON.stringify(input, null, 1)).slice(0, 2000)}</pre>` : ''}
      ${output !== undefined ? `<div>Output</div><pre>${esc(typeof output === 'string' ? output : JSON.stringify(output, null, 1)).slice(0, 3000)}</pre>` : ''}</div></details>`;
  }
  if (p.type === 'step-start' || p.type === 'step-finish') return '';
  if (p.type === 'file') return `<div class="tool"><div class="tb">File: <span class="mono">${esc(p.filename || p.path || p.url || 'attachment')}</span></div></div>`;
  // Approvals or unknown future parts: show a tolerant card, never hide them.
  if (/permission/i.test(p.type)) {
    const pid = p.id || p.requestID || p.permissionID;
    return `<div class="approval"><div><strong>Permission requested</strong> — <span class="mono small">${esc(p.tool || p.action || p.type)}</span></div>
      <div class="small muted">${esc(p.pattern || p.description || '')}</div>
      <div class="btn-row"><button data-perm="${esc(pid)}" data-r="once">Allow once</button><button data-perm="${esc(pid)}" data-r="always">Always</button><button class="danger" data-perm="${esc(pid)}" data-r="reject">Deny</button></div></div>`;
  }
  if (/question/i.test(p.type)) {
    const qid = p.id || p.requestID;
    const opts = p.options || p.questions || [];
    return `<div class="approval"><div><strong>Question</strong></div><div class="small">${esc(p.question || p.text || '')}</div>
      <div class="btn-row">${Array.isArray(opts) ? opts.map((o) => `<button data-q="${esc(qid)}" data-a="${esc(typeof o === 'string' ? o : (o.label || o.value || ''))}">${esc(typeof o === 'string' ? o : (o.label || ''))}</button>`).join('') : ''}</div></div>`;
  }
  return `<details class="tool"><summary><span class="tstate idle">${esc(p.type)}</span></summary><div class="tb"><pre>${esc(JSON.stringify(p, null, 1)).slice(0, 1500)}</pre></div></details>`;
}

function renderMessages() {
  const chat = $('#chat');
  if (!chat) return;
  chat.innerHTML = S.messages.map((m) => {
    const parts = (m.parts || []).map(renderPart).join('');
    if (!parts.trim() && m.info.role === 'assistant') return '';
    const err = m.info.error ? `<div class="msg-err">${esc(typeof m.info.error === 'string' ? m.info.error : JSON.stringify(m.info.error).slice(0, 500))}</div>` : '';
    const ts = (m.info.time && (m.info.time.completed || m.info.time.created)) || 0;
    return `<div class="msg ${m.info.role}"><div class="bubble"><div class="who">${m.info.role === 'user' ? 'You' : `Assistant${m.info.model ? ' · ' + esc(m.info.model.id) : ''}`}</div>${parts}${err}${ts ? `<div class="time" data-rel="${ts}" title="${esc(fullTime(ts))}">${esc(rel(ts))}</div>` : ''}</div></div>`;
  }).join('') + (S.streamText ? `<div class="msg assistant"><div class="bubble"><div class="who">Assistant</div><div class="md stream-caret">${md(S.streamText)}</div></div></div>` : '');
  // approval buttons
  $$('#chat [data-perm]').forEach((b) => b.onclick = () => replyPerm(b.dataset.perm, b.dataset.r));
  $$('#chat [data-q]').forEach((b) => b.onclick = () => replyQuestion(b.dataset.q, b.dataset.a));
  // code copy buttons (textContent gives back the raw code, entities decoded)
  $$('#chat [data-copy-code]').forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    const code = b.parentElement.querySelector('pre code');
    const txt = code ? code.textContent : '';
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(txt);
      else throw new Error('no clipboard');
      b.textContent = 'Copied';
    } catch { b.textContent = 'Copy failed'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  });
  const pb = $('#pending-bubble');
  if (pb && S.pendingSend && S.pendingSend.failed) pb.onclick = () => sendMessage(true);
  // Never yank the reader away from history they scrolled up to.
  scrollIfNearBottom();
}

let streamPaintAt = 0;
function paintStreamBubble() {
  // Deltas arrive in bursts; throttling keeps long streams smooth.
  if (!$('#chat')) return;
  const now = Date.now();
  if (now - streamPaintAt < 200) return;
  streamPaintAt = now;
  renderMessages();
  scrollIfNearBottom();
}

function scrollIfNearBottom() {
  const sc = $('#view');
  if (!sc) return;
  if (sc.scrollHeight - sc.scrollTop - sc.clientHeight < 400) sc.scrollTop = sc.scrollHeight;
}

async function replyPerm(pid, r) {
  try {
    await api(`/api/sessions/${S.current}/permissions/${encodeURIComponent(pid)}`, { method: 'POST', body: JSON.stringify({ response: r }) });
    toast(r === 'reject' ? 'Denied' : 'Approved');
    loadMessages(false);
  } catch (e) { toast(e.message); }
}

async function replyQuestion(qid, answer) {
  try {
    await api(`/api/questions/${encodeURIComponent(qid)}/reply`, { method: 'POST', body: JSON.stringify({ answers: [[answer]] }) });
    toast('Answered');
    loadMessages(false);
  } catch (e) { toast(e.message); }
}

function renderSession(id) {
  setTab('sessions');
  S.current = id;
  S.messages = [];
  S.streamText = '';
  currentActivityAt = (sess() && sess().lastActivity) || 0;
  S.menu = false; S.confirmDelete = false; S.renaming = false;
  // Tell the backend to watch this conversation for foreign writes (~2s
  // latency instead of the discovery poll). Heartbeat keeps the watch alive.
  const lastLoadedId = () => (S.messages.length ? S.messages[S.messages.length - 1].info.id : '');
  const watch = () => api('/api/watch', { method: 'POST', body: JSON.stringify({ sessionID: id, lastMsgId: lastLoadedId() }) }).catch(() => {});
  watch();
  clearInterval(S.watchBeat);
  S.watchBeat = setInterval(() => { if (S.current === id) watch(); }, 60000);
  view.innerHTML = `
    <div class="sess-head">
      <div class="t"><button class="ghost icon-btn" id="back" aria-label="Back">←</button><span class="grow ellipsis" id="s-title">Loading…</span><button class="ghost icon-btn" id="s-refresh" aria-label="Refresh conversation" title="Refresh">⟳</button><span id="s-dot"></span></div>
      <div class="sub" id="s-sub"></div>
      <div class="menu" id="s-actions" style="display:none"></div>
      <div id="s-menu-toggle"><button class="ghost" id="menu-btn" style="min-height:38px;font-size:13px;margin-top:6px">Actions ▾</button></div>
      <div id="s-inline"></div>
    </div>
    <div id="chat"><div class="empty"><span class="spin"></span> Loading conversation…</div></div>
    <div id="composer"><div class="box"><textarea id="c-text" placeholder="Message the agent…" rows="1"></textarea>
      <button class="primary send" id="c-send" aria-label="Send">↑</button>
      <button class="danger send" id="c-stop" aria-label="Stop" style="display:none">■</button></div>
      <div class="small muted" id="c-hint" style="margin-top:4px"></div></div>`;
  $('#back').onclick = () => go('#/sessions');
  $('#s-refresh').onclick = () => { toast('Refreshing…'); loadMessages(false); };
  $('#menu-btn').onclick = () => { S.menu = !S.menu; paintSessionHeader(); };
  const ta = $('#c-text');
  ta.oninput = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; };
  ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } };
  $('#c-send').onclick = sendMessage;
  $('#c-stop').onclick = stopTask;
  paintSessionHeader();
  loadMessages(true);
}

function paintSessionHeader() {
  const s = sess();
  if (!s || !$('#s-title')) return;
  $('#s-title').textContent = s.title || 'Untitled';
  $('#s-dot').innerHTML = `<span class="st ${s.state}" style="display:inline-block"></span> <span class="st-label ${s.state}">${STATE_LABEL[s.state] || s.state}</span>`;
  $('#s-sub').innerHTML = `${esc(s.projectName)} · <span class="mono">${esc(s.directory)}</span><br>${esc(s.model ? s.model.id : 'default model')} · ${esc(s.agent || 'default agent')} · ${esc(rel(s.lastActivity))}${s.controllable ? '' : ' · <span class="ro-tag">read-only</span>'}`;
  const running = s.state === 'running' || s.state === 'active-external';
  const sendBtn = $('#c-send'), stopBtn = $('#c-stop');
  if (sendBtn && stopBtn) {
    sendBtn.style.display = running ? 'none' : '';
    stopBtn.style.display = running ? '' : 'none';
  }
  const hint = $('#c-hint');
  if (hint) hint.textContent = s.controllable ? (running ? 'Working — you can send a follow-up or stop the task.' : 'Send a message to continue this conversation.') : 'Outside allowed projects: history is view-only.';
  const ta = $('#c-text');
  if (ta) ta.disabled = !s.controllable;
  if (sendBtn) sendBtn.disabled = !s.controllable;
  const box = $('#s-actions');
  if (!box) return;
  box.style.display = S.menu ? 'flex' : 'none';
  $('#menu-btn').textContent = S.menu ? 'Actions ▴' : 'Actions ▾';
  box.innerHTML = `
    <button id="a-rename">Rename</button>
    ${s.hidden ? '<button id="a-unhide">Unhide</button>' : '<button id="a-hide">Archive</button>'}
    <button id="a-close">Close</button>
    <button class="danger" id="a-delete">Delete…</button>`;
  $('#a-rename').onclick = () => { S.renaming = true; paintInline(); };
  $('#a-hide').onclick = () => hideSession(true);
  const uh = $('#a-unhide');
  if (uh) uh.onclick = () => hideSession(false);
  $('#a-close').onclick = () => closeSession();
  $('#a-delete').onclick = () => { S.confirmDelete = true; paintInline(); };
  paintInline();
}

function paintInline() {
  const el = $('#s-inline');
  if (!el) return;
  if (S.renaming) {
    el.innerHTML = `<div class="row" style="margin-top:8px"><input id="rn" type="text" maxlength="200" value="${esc(sess().title || '')}"><button class="primary" id="rn-go">Save</button></div>`;
    $('#rn-go').onclick = async () => {
      try {
        await api(`/api/sessions/${S.current}`, { method: 'PATCH', body: JSON.stringify({ title: $('#rn').value }) });
        S.renaming = false; toast('Renamed'); await loadSessions(); paintSessionHeader();
      } catch (e) { toast(e.message); }
    };
  } else if (S.confirmDelete) {
    const running = sess() && (sess().state === 'running' || sess().state === 'active-external');
    el.innerHTML = `<div class="confirm"><strong>Delete this session permanently?</strong>
      <div class="small" style="margin:6px 0">Removes the conversation, messages and history from OpenCode on the laptop. This cannot be undone.${running ? ' <strong>It looks like work is in progress.</strong>' : ''}</div>
      <div class="btn-row"><button class="ghost" id="del-no">Cancel</button><button class="danger" id="del-yes">Delete history</button></div></div>`;
    $('#del-no').onclick = () => { S.confirmDelete = false; paintInline(); };
    $('#del-yes').onclick = async () => {
      try {
        await api(`/api/sessions/${S.current}`, { method: 'DELETE', body: JSON.stringify({ deleteHistory: true, confirm: true }) });
        toast('Session deleted'); S.confirmDelete = false; await loadSessions(); go('#/sessions');
      } catch (e) { toast(e.message); }
    };
  } else el.innerHTML = '';
}

async function loadMessages(scroll) {
  if (!S.current) return;
  S.msgLoading = true;
  try {
    const r = await api(`/api/sessions/${S.current}/messages?limit=100`);
    S.messages = r.messages || [];
    // A fresh authoritative fetch supersedes any buffered stream text.
    S.streamText = '';
    // Marker in the SERVER's clock (never the phone clock — they can differ).
    let newest = 0;
    for (const m of S.messages) {
      const t = (m.info && m.info.time) || {};
      if (t.completed && t.completed > newest) newest = t.completed;
      if (t.created && t.created > newest) newest = t.created;
    }
    const s = sess();
    if (s && s.lastActivity > newest) newest = s.lastActivity;
    if (newest > currentActivityAt) currentActivityAt = newest;
    renderMessages();
    if (scroll !== false) { const sc = $('#view'); sc.scrollTop = sc.scrollHeight; }
  } catch (e) {
    const chat = $('#chat');
    if (chat && !S.messages.length) chat.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    else toast(e.message);
  } finally { S.msgLoading = false; }
}

async function sendMessage(isRetry) {
  const ta = $('#c-text');
  const text = isRetry && S.pendingSend ? S.pendingSend.text : ta.value.trim();
  if (!text || S.sending) return;
  S.sending = true;
  $('#c-send').disabled = true;
  // Show the message instantly; the same idempotency key makes retries safe.
  const key = (isRetry && S.pendingSend && S.pendingSend.key) || uuid();
  S.pendingSend = { key, text, failed: false };
  buzz(10);
  renderMessages();
  const sc = $('#view');
  if (sc) sc.scrollTop = sc.scrollHeight;
  try {
    await api(`/api/sessions/${S.current}/messages`, { method: 'POST', body: JSON.stringify({ text, idempotencyKey: key }) });
    ta.value = '';
    ta.style.height = 'auto';
    S.streamText = '';
    S.sending = false;
    const btn = $('#c-send');
    if (btn) btn.disabled = false;
    // Confirm delivery in the background without blocking the composer:
    // wait until our text echoes back in the authoritative history.
    void confirmSend(key, text);
  } catch (e) {
    if (S.pendingSend && S.pendingSend.key === key) S.pendingSend.failed = true;
    renderMessages();
    toast(e.message);
    S.sending = false;
    const btn = $('#c-send');
    if (btn) btn.disabled = false;
  }
}

async function confirmSend(key, text) {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 800));
    if (!S.pendingSend || S.pendingSend.key !== key || !onSessionView()) return;
    try {
      const r = await api(`/api/sessions/${S.current}/messages?limit=10`);
      const found = (r.messages || []).some((m) => m.info.role === 'user' &&
        (m.parts || []).some((p) => p.type === 'text' && typeof p.text === 'string' && p.text.trim() === text));
      if (found) break;
    } catch { /* the poll-driven sync path covers failures here */ }
  }
  if (S.pendingSend && S.pendingSend.key === key) S.pendingSend = null;
  if (onSessionView() && S.current) loadMessages(false);
}

async function stopTask() {
  try {
    await api(`/api/sessions/${S.current}/abort`, { method: 'POST', body: JSON.stringify({}) });
    toast('Stop requested');
    setTimeout(() => loadMessages(false), 1200);
  } catch (e) { toast(e.message); }
}

async function hideSession(hidden) {
  try {
    await api(`/api/sessions/${S.current}/hide`, { method: 'POST', body: JSON.stringify({ hidden }) });
    toast(hidden ? 'Archived — history kept' : 'Restored');
    await loadSessions();
    paintSessionHeader();
  } catch (e) { toast(e.message); }
}

async function closeSession() {
  try {
    await api(`/api/sessions/${S.current}`, { method: 'DELETE', body: JSON.stringify({}) });
    toast('Closed — history kept');
    await loadSessions();
    go('#/sessions');
  } catch (e) { toast(e.message); }
}

/* ---------------- terminal ---------------- */
async function loadPtys() {
  try {
    const r = await api('/api/ptys');
    S.ptys = r.ptys || [];
  } catch (e) { S.ptys = []; toast(e.message); }
  if (onTerminalList()) renderTerminalList();
}

function renderTerminalList() {
  setTab('terminal');
  closeTerm();
  const dirs = S.projects.allowlist.map((d) => d.directory);
  if (S.termDir && !dirs.includes(S.termDir)) S.termDir = '';
  const sel = S.termDir || dirs[0] || '';
  view.innerHTML = `
    <h1>Terminal</h1>
    <div class="card">
      <div class="small muted" style="margin-bottom:8px">Managed shells running on the laptop via OpenCode's terminal. Existing laptop console windows can't be attached — only these sessions are interactive here.</div>
      <label for="pt-dir">Directory</label>
      <select id="pt-dir">${dirs.map((d) => `<option value="${esc(d)}"${d === sel ? ' selected' : ''}>${esc(d)}</option>`).join('')}</select>
      <div class="btn-row"><button class="primary" id="pt-new">New shell</button></div>
    </div>
    <h2>Sessions</h2>
    <div id="pt-list" class="term-list"></div>`;
  $('#pt-dir').onchange = (e) => { S.termDir = e.target.value; };
  $('#pt-new').onclick = async () => {
    const dir = $('#pt-dir').value;
    if (!dir) { toast('Configure a project in Settings first'); return; }
    try {
      const r = await api('/api/ptys', { method: 'POST', body: JSON.stringify({ directory: dir }) });
      go(`#/t/${r.pty.id}?dir=${encodeURIComponent(dir)}`);
    } catch (e) { toast(e.message); }
  };
  const el = $('#pt-list');
  el.innerHTML = S.ptys.length ? S.ptys.map((t) => `
    <button class="sess" data-id="${esc(t.id)}" data-dir="${esc(t.directory)}">
      <span class="t"><span class="st ${t.status === 'running' ? 'running' : ''}"></span><span class="name">${esc(t.title || t.id)}</span></span>
      <span class="meta"><span>${esc(t.status)}${t.exitCode !== undefined ? ` · exit ${t.exitCode}` : ''}</span><span>·</span><span>${esc(t.cwd || t.directory)}</span></span>
    </button>`).join('') : '<div class="empty">No terminal sessions.</div>';
  $$('#pt-list .sess').forEach((b) => b.onclick = () => go(`#/t/${b.dataset.id}?dir=${encodeURIComponent(b.dataset.dir)}`));
}

let termObjs = null;
function closeTerm() {
  if (termObjs) {
    try { termObjs.ws.close(); } catch {}
    try { termObjs.term.dispose(); } catch {}
    termObjs = null;
  }
}

async function renderTerm(id, dir) {
  setTab('terminal');
  closeTerm();
  view.innerHTML = `
    <div class="sess-head">
      <div class="t"><button class="ghost icon-btn" id="back" aria-label="Back">←</button><span class="grow ellipsis" id="t-title">Terminal</span></div>
      <div class="sub mono small" id="t-sub">${esc(dir)}</div>
    </div>
    <div id="term-wrap"><div id="term"></div>
      <div id="term-bar">
        <button id="t-keys">⌨ Ctrl+C</button>
        <button id="t-resize">Fit</button>
        <button class="danger" id="t-kill">End session</button>
      </div>
      <div id="term-keys" aria-label="Extra keys">
        <button data-k="\x1b">Esc</button><button data-k="\t">Tab</button><button data-k="\x1b[A">↑</button><button data-k="\x1b[B">↓</button><button data-k="\x1b[C">→</button><button data-k="\x1b[D">←</button>
      </div></div>
    <div class="small muted" id="t-state" style="margin-top:6px">Connecting…</div>`;
  $('#back').onclick = () => go('#/terminal');
  $('#t-kill').onclick = async () => {
    if (!confirm('End this terminal session? The shell process will be terminated.')) return;
    try { await api(`/api/ptys/${id}?directory=${encodeURIComponent(dir)}`, { method: 'DELETE' }); toast('Terminal ended'); go('#/terminal'); }
    catch (e) { toast(e.message); }
  };
  try {
    if (!document.querySelector('link[data-xterm]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = '/vendor/xterm.css'; l.dataset.xterm = '1';
      document.head.appendChild(l);
    }
    if (!window.Terminal) await loadScript('/vendor/xterm.js');
    if (!window.FitAddon && await vendorExists('/vendor/addon-fit.js')) await loadScript('/vendor/addon-fit.js');
  } catch { $('#t-state').textContent = 'Terminal engine failed to load (run setup first).'; return; }
  const term = new window.Terminal({ cursorBlink: true, fontSize: 14, theme: { background: '#08090b' } });
  let fit = null;
  if (window.FitAddon) { fit = new window.FitAddon.FitAddon(); term.loadAddon(fit); }
  term.open($('#term'));
  if (fit) { try { fit.fit(); } catch {} }
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Resume from the last seen cursor when reopening a live session so recent
  // output is replayed instead of lost.
  const resumeCursor = S.termCursors[id] !== undefined ? S.termCursors[id] : -1;
  const ws = new WebSocket(`${scheme}//${location.host}/api/ptys/${id}/connect?directory=${encodeURIComponent(dir)}&cursor=${resumeCursor}`);
  ws.binaryType = 'arraybuffer';
  let cursor = -1;
  termObjs = { ws, term, cursor };
  $('#t-state').textContent = 'Connecting…';
  ws.onopen = () => {
    $('#t-state').textContent = 'Connected';
    sendResize();
  };
  ws.onmessage = (ev) => {
    const d = ev.data;
    if (typeof d === 'string') term.write(d);
    else {
      const u8 = new Uint8Array(d);
      if (u8.length > 1 && u8[0] === 0) {
        try { cursor = JSON.parse(new TextDecoder().decode(u8.slice(1))).cursor; termObjs.cursor = cursor; S.termCursors[id] = cursor; } catch {}
      } else term.write(u8);
    }
  };
  ws.onclose = () => { $('#t-state').textContent = 'Disconnected — go back and reopen to resume.'; };
  ws.onerror = () => { $('#t-state').textContent = 'Connection error.'; };
  term.onData((data) => { if (ws.readyState === 1) ws.send(data); });
  const sendResize = () => {
    if (ws.readyState !== 1) return;
    const dims = fit ? { cols: term.cols, rows: term.rows } : { cols: 80, rows: 24 };
    ws.send('\0' + JSON.stringify({ resize: { rows: dims.rows, cols: dims.cols } }));
  };
  $('#t-resize').onclick = () => { if (fit) { try { fit.fit(); } catch {} } sendResize(); };
  $('#t-keys').onclick = () => { if (ws.readyState === 1) ws.send('\x03'); term.focus(); };
  $$('#term-keys [data-k]').forEach((b) => b.onclick = () => {
    if (ws.readyState !== 1) return;
    ws.send(JSON.parse(`"${b.dataset.k}"`));
    term.focus();
  });
  window.addEventListener('resize', sendResize, { once: true });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('load ' + src));
    document.head.appendChild(s);
  });
}
async function vendorExists(src) {
  try { const r = await fetch(src, { method: 'HEAD' }); return r.ok; } catch { return false; }
}

/* ---------------- connection ---------------- */
async function renderConnection() {
  setTab('connection');
  let c = S.conn;
  try { c = await api('/api/connection'); S.conn = c; } catch (e) { /* show cached + error */ }
  const h = await api('/api/health').catch(() => null);
  if (!$('#view') || !onConnection()) return;
  noteConnRendered();
  view.innerHTML = `
    <h1>Status</h1>
    <div class="card">
      <div class="kv"><span class="k">Service</span><span class="v">${h && h.ok ? 'Running' : 'Unreachable'}</span></div>
      <div class="kv"><span class="k">OpenCode</span><span class="v">${c && c.opencode.reachable ? `reachable · v${esc(c.opencode.version)}` : 'unreachable'}</span></div>
      <div class="kv"><span class="k">Live updates</span><span class="v">${S.streamOk ? 'connected' : 'reconnecting…'}</span></div>
      <div class="kv"><span class="k">Last sync</span><span class="v">${S.lastSync ? `${rel(S.lastSync)} (${new Date(S.lastSync).toLocaleTimeString()})` : 'never'}</span></div>
      <div class="kv"><span class="k">App</span><span class="v">opencode-remote ${esc((h && h.app) || '?')}</span></div>
      <div class="btn-row"><button id="re-btn">Reconnect now</button></div>
    </div>
    <h2>Open on this phone</h2>
    <div class="card" id="urls">${c ? `
      ${c.tailscaleUrl ? `<div class="small muted">Private (Tailscale — use this)</div><div class="url-row"><code>${esc(c.tailscaleUrl)}</code><button data-copy="${esc(c.tailscaleUrl)}">Copy</button></div>` : ''}
      ${c.lanUrls.map((u) => `<div class="url-row"><code>${esc(u)}</code><button data-copy="${esc(u)}">Copy</button></div>`).join('')}
      <div class="url-row"><code>${esc(c.localUrl)}</code><button data-copy="${esc(c.localUrl)}">Copy</button></div>
      ${c.tailscaleUrl
        ? '<div class="small muted" style="margin-top:8px">Bookmark this URL or Add to Home Screen for an app-like experience.</div>'
        : c.tailscale && c.tailscale.installed
          ? '<div class="warn-note" style="margin-top:8px">Tailscale is installed but signed out. Open Tailscale on the laptop and sign in once — the private phone URL will appear here.</div>'
          : '<div class="small muted" style="margin-top:8px">Tailscale not detected on the laptop — install it and connect both devices for access away from home Wi-Fi. See README.</div>'}
    ` : '<div class="empty">Could not load connection info.</div>'}</div>
    <h2>Troubleshooting</h2>
    <div class="card"><ul class="steps">
      <li>Laptop must be <strong>powered on, awake and on the network</strong>. Remote control cannot wake it.</li>
      <li>If the page stops updating, tap <strong>Reconnect now</strong> — missed changes reconcile automatically.</li>
      <li>New laptop CLI sessions appear by themselves within ~10 seconds. Nothing to import.</li>
      <li>“Read-only” sessions live outside your allowed projects — change this in Settings.</li>
      <li>Closing the phone tab for a while is fine: reopen and it resumes where it left off.</li>
    </ul></div>`;
  $('#re-btn').onclick = () => { noteConnRendered(); connectStream(); loadSessions(); renderConnection(); toast('Reconnecting…'); };
  $$('#urls [data-copy]').forEach((b) => b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); }
    catch { toast(b.dataset.copy); }
  });
}

/* ---------------- settings ---------------- */
async function renderSettings() {
  setTab('settings');
  try { S.settings = await api('/api/settings'); } catch (e) { view.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  try { await loadProjectsModels(); } catch {}
  const st = S.settings;
  const discovered = S.projects.discovered.filter((d) => !st.projects.includes(d.worktree));
  view.innerHTML = `
    <h1>Settings</h1>
    <h2>Project directories</h2>
    <div class="card">
      <div class="small muted">Only these directories can be used to create sessions, send messages, or open terminals. Everything else is read-only.</div>
      <div id="proj-list" style="margin-top:8px">${st.projects.map((d) => `
        <div class="kv"><span class="v mono" style="text-align:left">${esc(d)}</span><button class="ghost" data-rm="${esc(d)}" style="min-height:38px">Remove</button></div>`).join('') || '<div class="empty">None yet.</div>'}</div>
      <div class="row" style="margin-top:8px"><input id="proj-add" type="text" placeholder="C:\\path\\to\\project"><button class="primary" id="proj-go">Add</button></div>
      ${discovered.length ? `<h2>Discovered on laptop</h2>${discovered.map((d) => `
        <div class="kv"><span class="v mono" style="text-align:left">${esc(d.worktree)} <span class="muted">(${d.sessions} sessions)</span></span><button class="ghost" data-add="${esc(d.worktree)}" style="min-height:38px">Add</button></div>`).join('')}` : ''}
    </div>
    <h2>Defaults</h2>
    <div class="card">
      <label>Default model</label>
      <select id="set-model"><option value="">Session default</option>
        ${modelOptions(st.defaultModel)}</select>
      <label>Default agent</label>
      <select id="set-agent"><option value="">Default</option>
        ${S.agents.map((a) => `<option ${st.defaultAgent === a.name ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
      <div class="btn-row"><button class="primary" id="set-save">Save defaults</button></div>
    </div>
    <h2>Account</h2>
    <div class="card">
      <label>Current password</label><input id="pw-cur" type="password" autocomplete="current-password">
      <label>New password (min 12 chars)</label><input id="pw-next" type="password" autocomplete="new-password">
      <div class="btn-row"><button id="pw-go">Change password</button><button class="ghost" id="logout">Sign out</button></div>
    </div>`;
  const saveProjects = async (projects) => {
    try { await api('/api/settings', { method: 'PUT', body: JSON.stringify({ projects }) }); toast('Saved'); await loadSessions(); renderSettings(); }
    catch (e) { toast(e.message); }
  };
  $$('#proj-list [data-rm]').forEach((b) => b.onclick = () => saveProjects(st.projects.filter((d) => d !== b.dataset.rm)));
  $$('[data-add]').forEach((b) => b.onclick = () => saveProjects([...st.projects, b.dataset.add]));
  $('#proj-go').onclick = () => { const v = $('#proj-add').value.trim(); if (v) saveProjects([...st.projects, v]); };
  $('#set-save').onclick = async () => {
    const mv = $('#set-model').value;
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify({
        defaultModel: mv ? { providerID: mv.split('/')[0], id: mv.split('/').slice(1).join('/') } : null,
        defaultAgent: $('#set-agent').value || null,
      }) });
      toast('Defaults saved');
    } catch (e) { toast(e.message); }
  };
  $('#pw-go').onclick = async () => {
    try { await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ current: $('#pw-cur').value, next: $('#pw-next').value }) }); toast('Password changed — sign in again'); location.hash = '#/login'; location.reload(); }
    catch (e) { toast(e.message); }
  };
  $('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) }).catch(() => {}); location.reload(); };
}

/* ---------------- auth views ---------------- */
function renderLogin() {
  setTab('');
  if (S.setupRequired) return renderSetup();
  view.innerHTML = `
    <h1>Sign in</h1>
    <div class="card">
      <label for="pw">Remote password</label>
      <input id="pw" type="password" autocomplete="current-password">
      <div class="btn-row"><button class="primary btn-block" id="go">Sign in</button></div>
      <div class="small muted" style="margin-top:8px">Set on the laptop during first-run setup. Wrong guesses are rate-limited.</div>
    </div>`;
  $('#go').onclick = doLogin;
  $('#pw').onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
  setTimeout(() => $('#pw').focus(), 50);
  async function doLogin() {
    try {
      await api('/api/auth/login', { method: 'POST', csrf: false, body: JSON.stringify({ password: $('#pw').value }) });
      S.authed = true;
      paintPill(); connectStream(); loadProjectsModels(); loadSessions();
      go('#/sessions');
    } catch (e) { toast(e.message); }
  }
}

function renderSetup() {
  setTab('');
  view.innerHTML = `
    <h1>First-run setup</h1>
    <div class="card">
      <div class="small muted">This laptop has no remote password yet. This screen only works <strong>on the laptop itself</strong>.</div>
      <label for="pw1">New remote password (min 12 chars)</label>
      <input id="pw1" type="password" autocomplete="new-password">
      <label for="pw2">Repeat password</label>
      <input id="pw2" type="password" autocomplete="new-password">
      <div class="btn-row"><button class="primary btn-block" id="go">Set password &amp; continue</button></div>
    </div>`;
  $('#go').onclick = async () => {
    if ($('#pw1').value !== $('#pw2').value) { toast('Passwords do not match'); return; }
    try {
      await api('/api/auth/setup', { method: 'POST', csrf: false, body: JSON.stringify({ password: $('#pw1').value }) });
      await api('/api/auth/login', { method: 'POST', csrf: false, body: JSON.stringify({ password: $('#pw1').value }) });
      S.authed = true; S.setupRequired = false;
      paintPill(); connectStream(); loadProjectsModels(); loadSessions();
      toast('Password set — now add a project in Settings');
      location.hash = '#/settings'; render();
    } catch (e) { toast(e.message); }
  };
}

/* ---------------- render ---------------- */
function render() {
  closeTerm();
  if (!S.authed) { renderLogin(); paintPill(); $$('#tabs button').forEach((b) => b.classList.remove('active')); return; }
  const r = route();
  if (!r.startsWith('#/s/') && S.current) {
    // Leaving a conversation: release the fast watch.
    const id = S.current;
    S.current = null;
    clearInterval(S.watchBeat);
    api('/api/watch', { method: 'POST', body: JSON.stringify({ sessionID: id, release: true }) }).catch(() => {});
  }
  if (r === '#/sessions' || r === '/' || r === '') renderSessions();
  else if (r === '#/new') renderNew();
  else if (r.startsWith('#/s/')) renderSession(decodeURIComponent(r.slice(4).split('?')[0]));
  else if (r === '#/terminal') { loadPtys().then(() => { if (onTerminalList()) renderTerminalList(); }); setTab('terminal'); view.innerHTML = '<div class="empty"><span class="spin"></span></div>'; }
  else if (r.startsWith('#/t/')) {
    const rest = r.slice(4);
    const id = decodeURIComponent(rest.split('?')[0]);
    const dir = new URLSearchParams(rest.split('?')[1] || '').get('dir') || '';
    renderTerm(id, dir);
  }
  else if (r === '#/connection') renderConnection();
  else if (r === '#/settings') renderSettings();
  else if (r === '#/login') renderLogin();
  else go('#/sessions');
}

$$('#tabs button').forEach((b) => b.onclick = () => go(b.dataset.route));

// Safety net: while a conversation is open and visible, re-pull history
// periodically. Event-driven updates cover the normal path; this covers
// anything missed (sleep, dropped SSE, foreign-process writes).
setInterval(() => {
  if (document.hidden || !S.authed || !onSessionView() || !S.current) return;
  if (Date.now() - lastDeltaAt < 5000) return;
  const s = sess();
  if (s && s.lastActivity > currentActivityAt) loadMessages(false);
  else if (!s) loadSessions();
}, 15000);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').then((reg) => {
    const check = () => {
      const w = reg.waiting;
      if (w) toast('App updated — tap here to reload', () => location.reload());
    };
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (sw) sw.addEventListener('statechange', () => { if (sw.state === 'installed') check(); });
    });
    check();
  }).catch(() => {}));
}
boot();

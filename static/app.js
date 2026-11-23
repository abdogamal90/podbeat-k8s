'use strict';

/* ==========================================================================
   podbeat ui - no framework, no build step. state in, html out.
   ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  ctx: '',
  ns: '',
  tab: 'pods',
  q: '',
  filter: 'all',
  pods: [],
  nodes: [],
  nodeNote: '',
  rows: [],          // rows of the active tab
  selIdx: -1,
  selected: null,    // {kind, ns, name, row}
  drawerTab: '',
  detail: {},        // cache: key -> payload
  writes: false,
  forwards: [],
  lastRestartSeq: null,
  restartCount: 0,
  logAbort: null,
  sort: { pods: { key: 'upSec', dir: 1 }, default: { key: 'name', dir: 1 } },
  tick: 0,
  stuck: false,
  token: '',
  prodPattern: 'prod',
};

const TAB_ORDER = ['pods', 'nodes', 'deployments', 'services', 'configmaps', 'secrets', 'events', 'restarts'];
const DRAWER_TABS = {
  pods: ['overview', 'logs', 'restarts', 'yaml', 'describe', 'actions'],
  configmaps: ['data', 'yaml', 'describe'],
  secrets: ['data', 'yaml', 'describe'],
  deployments: ['overview', 'yaml', 'describe', 'actions'],
  statefulsets: ['overview', 'yaml', 'describe', 'actions'],
  daemonsets: ['overview', 'yaml', 'describe', 'actions'],
};

/* ---------- utils ---------- */

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtAge(sec) {
  if (!sec || sec < 0) return '-';
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h';
  return Math.floor(sec / 86400) + 'd';
}

function fmtDur(sec) {
  if (!sec || sec < 0) return '-';
  if (sec < 100) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm';
  if (sec < 86400) {
    const hours = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    return hours + 'h' + (mins ? mins + 'm' : '');
  }
  return Math.floor(sec / 86400) + 'd';
}

function danger(status) {
  if (['CrashLoopBackOff', 'Error', 'Failed', 'OOMKilled', 'ImagePullBackOff',
    'ErrImagePull', 'CreateContainerConfigError', 'Evicted', 'InvalidImageName',
    'RunContainerError', 'NotReady'].includes(status)) return 's-bad';
  if (['Pending', 'Terminating', 'ContainerCreating', 'PodInitializing', 'Unknown'].includes(status)) return 's-warn';
  if (status === 'Succeeded' || status === 'Completed') return 's-done';
  return 's-running';
}

function restartClass(n) {
  return n === 0 ? 'r0' : n < 3 ? 'r1' : 'r2';
}

// The signature: an EKG blip per restart. Old restarts sit still, a restart in
// the last hour traces live, and a quiet namespace flatlines.
const BEAT_PATH = 'M1 7 L4 7 L5.5 3.2 L7 10.4 L8.6 7 L14 7';
const FLAT_PATH = 'M1 7 L14 7';

function beatGlyph(live, cls = '') {
  const path = cls === 'flat' ? FLAT_PATH : BEAT_PATH;
  const classes = `beat ${cls}${live ? ' live' : ''}`;
  return `<svg class="${classes}" viewBox="0 0 15 14" width="15" height="10" aria-hidden="true"><path d="${path}"/></svg>`;
}

async function api(path, opts = {}) {
  // every call carries the per-launch token from /api/health; without it the
  // server refuses /api/* (that is what stops other websites from driving us)
  const headers = Object.assign({ 'X-Podbeat-Token': state.token }, opts.headers || {});
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((body && body.error) || body || res.statusText);
  return body;
}

function banner(message) {
  const el = $('#banner');
  if (!message) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = message;
}

function toast(html, opts = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (opts.info ? ' info' : '');
  el.innerHTML = html;
  el.addEventListener('click', () => {
    if (opts.onClick) opts.onClick();
    el.remove();
  });
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), opts.info ? 5000 : 15000);
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`<div class="t-pod">copied ${esc(label || '')}</div>`, { info: true });
  } catch (e) {
    toast(`<div class="t-pod">copy failed</div><div class="t-meta">${esc(e.message)}</div>`);
  }
}

// In-page confirm. Native confirm() is a different beast in every webview,
// so the app owns its own dialog.
let modalResolve = null;

function uiConfirm(title, body, okLabel = 'confirm', danger = true) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    $('#modal-title').textContent = title;
    $('#modal-body').textContent = body;
    const ok = $('#modal-ok');
    ok.textContent = okLabel;
    ok.className = 'btn ' + (danger ? 'bad' : '');
    $('#modal').hidden = false;
    ok.focus();
  });
}

function closeModal(result) {
  if ($('#modal').hidden) return;
  $('#modal').hidden = true;
  const resolve = modalResolve;
  modalResolve = null;
  if (resolve) resolve(result);
}

$('#modal-ok').onclick = () => closeModal(true);
$('#modal-cancel').onclick = () => closeModal(false);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(false); });

/* ---------- api calls ---------- */

async function loadContexts() {
  const data = await api('/api/contexts');
  const sel = $('#ctx');
  const current = data.contexts.find(c => c.current) || data.contexts[0];
  // EKS ARNs all end in the same place; show "cluster · account" so prod/qa are obvious
  const label = (name) => {
    const m = name.match(/^arn:aws:eks:[^:]+:(\d+):cluster\/(.+)$/);
    return m ? `${m[2]} · ${m[1]}` : name;
  };
  sel.innerHTML = data.contexts.map(c =>
    `<option value="${esc(c.name)}" title="${esc(c.name)}"${c === current ? ' selected' : ''}>${esc(label(c.name))}</option>`
  ).join('');
  state.ctx = (current && current.name) || sel.value;
  sel.value = state.ctx;
  const picked = data.contexts.find(c => c.name === state.ctx);
  if (picked && picked.namespace) state.ns = picked.namespace;
  sel.onchange = async () => {
    closeDrawer();
    state.ctx = sel.value;
    const next = data.contexts.find(c => c.name === sel.value);
    state.ns = next?.namespace || 'default';
    state.detail = {};
    try {
      await loadNamespaces();
      refresh();
    } catch (err) {
      banner(err.message);
      $('#ns').innerHTML = '<option>unavailable</option>';
      $('#view').innerHTML = `<div class="empty">${esc(state.ctx)} is unreachable<br><span class="muted">${esc(err.message)}</span></div>`;
      state.stuck = true;
    }
  };
}

async function loadNamespaces() {
  const data = await api('/api/namespaces?ctx=' + encodeURIComponent(state.ctx));
  const sel = $('#ns');
  const current = data.namespaces.includes(state.ns) ? state.ns : (data.namespaces.includes('default') ? 'default' : data.namespaces[0]);
  sel.innerHTML = data.namespaces.map(n =>
    `<option value="${esc(n)}"${n === current ? ' selected' : ''}>${esc(n)}</option>`
  ).join('');
  state.ns = sel.value;
  sel.onchange = () => { closeDrawer(); state.ns = sel.value; state.detail = {}; refresh(); };
}

async function loadPods() {
  const data = await api(`/api/pods?ctx=${encodeURIComponent(state.ctx)}&ns=${encodeURIComponent(state.ns)}`);
  state.pods = data.pods;
  state.summary = data.summary;
  $('#n-pods').textContent = data.summary.problems ? `${data.summary.problems}!` : data.summary.total;
  $('#n-pods').style.color = data.summary.problems ? 'var(--bad)' : '';
  if (state.tab === 'pods') render();
  return data;
}

async function pollRestarts(silent = false) {
  const after = state.lastRestartSeq == null ? 0 : state.lastRestartSeq;
  const data = await api('/api/restarts?after=' + after);
  const first = state.lastRestartSeq == null;
  state.lastRestartSeq = data.latest;
  const badge = $('#n-restarts');
  if (badge) {
    badge.textContent = data.count24h || '';
    badge.style.color = data.count24h ? 'var(--warn)' : '';
  }
  if (first || silent) return;
  for (const ev of data.events) {
    if (ev.historical) continue;
    toast(
      `<div class="t-pod">${esc(ev.pod)}</div>
       <div class="t-meta">restarted · ${esc(ev.reason)}${ev.exitCode != null ? ' · exit ' + ev.exitCode : ''}${ev.ranForSec ? ' · ran ' + fmtDur(ev.ranForSec) : ''}</div>`,
      { onClick: () => openPodByName(ev.ns, ev.pod) }
    );
  }
  if (data.events.length && state.tab === 'restarts') render();
}

async function loadForwards() {
  try {
    const data = await api('/api/forwards');
    state.forwards = data.forwards;
    $('#fwdbar').innerHTML = data.forwards.map(f =>
      `<span class="fwd" title="stop port-forward">${esc(f.ports)} → <b data-fwd="${f.id}">${esc(f.pod.slice(0, 22))}</b></span>`
    ).join('');
  } catch (e) { /* non fatal */ }
}

/* ---------- table helper ---------- */

// loading state: quiet shimmering rows instead of a spinner
function skeletonTable(cells = 9, rows = 14) {
  const row = `<tr class="skeleton">${'<td></td>'.repeat(cells)}</tr>`;
  return `<table><tbody>${row.repeat(rows)}</tbody></table>`;
}

function table(columns, rows, opts = {}) {  const sort = opts.sortKey ? state.sort[opts.sortKey] : null;
  const col = sort && columns.find(c => c.key === sort.key);
  const html = [];
  html.push('<table><thead><tr>');
  for (const c of columns) {
    const sorted = sort && sort.key === c.key;
    const arrow = sorted ? (sort.dir > 0 ? ' ▲' : ' ▼') : '';
    html.push(`<th class="${c.num ? 'num' : ''}${sorted ? ' sorted' : ''}" data-sort="${esc(c.key || '')}">${esc(c.label)}${arrow}</th>`);
  }
  html.push('</tr></thead><tbody>');
  if (!rows.length) {
    html.push(`<tr><td colspan="${columns.length}" class="empty">nothing here</td></tr>`);
  }
  rows.forEach((row, idx) => {
    html.push(`<tr data-idx="${idx}" class="${idx === state.selIdx ? 'sel' : ''} ${opts.rowClass ? opts.rowClass(row) : ''}">`);
    for (const c of columns) {
      html.push(`<td class="${c.cls || ''}${c.num ? ' num' : ''}${c.wrap ? ' wrap' : ''}"${c.title ? ` title="${esc(c.title(row))}"` : ''}>${c.render ? c.render(row) : esc(row[c.key])}</td>`);
    }
    html.push('</tr>');
  });
  html.push('</tbody></table>');
  return html.join('');
}

function bindTable(handler) {
  const view = $('#view');
  view.querySelectorAll('thead th[data-sort]').forEach(th => {
    th.onclick = () => {
      const key = th.dataset.sort;
      if (!key) return;
      const s = state.sort[state.tab] || (state.sort[state.tab] = { key, dir: 1 });
      if (s.key === key) s.dir = -s.dir; else { s.key = key; s.dir = 1; }
      render();
    };
  });
  view.querySelectorAll('tbody tr[data-idx]').forEach(tr => {
    tr.onclick = (e) => {
      if (e.target.closest('button')) return;
      state.selIdx = Number(tr.dataset.idx);
      handler(state.rows[state.selIdx]);
    };
  });
}

function sortRows(rows, key, dir) {
  const arr = rows.slice();
  arr.sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av == null && bv == null) return tiebreak(a, b);
    if (av == null) return 1;
    if (bv == null) return -1;
    const delta = typeof av === 'number' && typeof bv === 'number'
      ? av - bv
      : String(av).localeCompare(String(bv));
    return delta !== 0 ? delta * dir : tiebreak(a, b);
  });
  return arr;
}

// stable, readable order when the sorted column has equal values
function tiebreak(a, b) {
  if (!a.name || !b.name) return 0;
  return a.name.localeCompare(b.name);
}

function isProblem(status) {
  return !['Running', 'Completed', 'Succeeded'].includes(status);
}

// PRODUCTION marker: matches the context name against the server-provided
// pattern (PODBEAT_PROD_PATTERN, default "prod"), so no account is hardcoded.
function isProdContext() {
  const pattern = state.prodPattern || '';
  return pattern.length > 0 && state.ctx.toLowerCase().includes(pattern.toLowerCase());
}

function rbacBlocked(message) {
  return /forbidden|RBAC/i.test(message || '');
}

function blockedPanel(what, message) {
  return `
    <div class="empty">
      <div style="font-size:14px;color:var(--fg);margin-bottom:8px">${esc(what)} are blocked for your user</div>
      <div style="font-family:var(--mono);font-size:11px;color:var(--dim);margin-bottom:12px">${esc(message)}</div>
      <div style="font-size:12px;color:var(--dim);max-width:640px;margin:0 auto;line-height:1.6">
        That's an RBAC limit on your cluster user, not a podbeat bug.<br>
        Everything else still works: pods, logs, nodes, deploys, services, configmaps.<br>
        Restart history comes from podbeat's own watcher, so you don't need events for that.
      </div>
    </div>`;
}

function searchMatch(row, fields) {
  if (!state.q) return true;
  const q = state.q.toLowerCase();
  return fields.some(f => {
    const v = typeof f === 'function' ? f(row) : row[f];
    return String(v == null ? '' : v).toLowerCase().includes(q);
  });
}

/* ---------- render: pods ---------- */

function renderPods() {
  const f = state.filter;
  let rows = state.pods.filter(p => searchMatch(p, ['name', 'node', 'owner', 'status', 'images', 'ns']));
  if (f === 'problems') rows = rows.filter(p => isProblem(p.status));
  if (f === 'restarted') rows = rows.filter(p => p.lastRestartAgoSec > 0 && p.lastRestartAgoSec < 86400);
  if (f === 'crash') rows = rows.filter(p => p.status === 'CrashLoopBackOff' || p.lastReason === 'OOMKilled');
  if (f === 'notready') rows = rows.filter(p => !p.ready);
  const s = state.sort.pods;
  rows = sortRows(rows, s.key, s.dir);
  state.rows = rows;

  const cols = [
    { key: 'name', label: 'pod', cls: 'name', render: p => esc(p.name) },
    {
      key: 'status', label: 'status', render: p =>
        `<span class="${danger(p.status)}">${esc(p.status)}</span>` +
        (p.status === 'Running' && !p.ready ? ' <span class="tag warn">not ready</span>' : '')
    },
    { key: 'readyText', label: 'ready', cls: 'mono' },
    {
      key: 'restarts', label: 'restarts', num: true, render: p => {
        if (!p.restarts) return `<span class="r0">${beatGlyph(false, 'flat')}0</span>`;
        const fresh = p.lastRestartAgoSec > 0 && p.lastRestartAgoSec < 3600;
        return `<span class="${restartClass(p.restarts)}">${beatGlyph(fresh, fresh ? '' : (p.lastRestartAgoSec < 86400 ? 'warn' : ''))}${p.restarts}</span>`;
      }
    },
    {
      key: 'lastRestartAgoSec', label: 'last restart', cls: 'mono', render: p => {
        if (!p.lastRestartAgoSec) return '<span class="r0">never</span>';
        return `<span class="${p.lastRestartAgoSec < 3600 ? 's-bad' : 's-warn'}">${fmtAge(p.lastRestartAgoSec)} ago</span>` +
          (p.lastReason ? ` <span class="tag bad">${esc(p.lastReason)}</span>` : '');
      }
    },
    {
      // uptime = since the running container started; age = since the pod object was created
      key: 'upSec', label: 'up', num: true, render: p => {
        if (!p.upSec) return '<span class="r0">-</span>';
        const cls = p.upSec < 600 ? 's-bad' : p.upSec < 3600 ? 's-warn' : '';
        return `<span class="${cls}" title="container uptime · pod age ${fmtAge(p.ageSec)}">${fmtDur(p.upSec)}</span>`;
      }
    },
    { key: 'cpu', label: 'cpu', num: true, render: p => esc(p.cpuText) },
    { key: 'mem', label: 'mem', num: true, render: p => esc(p.memText) },
    {
      key: 'node', label: 'node', cls: 'mono', render: p => esc((p.node || '-').split('.')[0]),
      title: p => p.node
    },
    { key: 'ageSec', label: 'age', num: true, render: p => fmtAge(p.ageSec) },
  ];

  const sm = state.summary || {};
  $('#view').innerHTML = `
    <div class="filters">
      <button class="chip ${f === 'all' ? 'on' : ''}" data-filter="all">all (${state.pods.length})</button>
      <button class="chip ${f === 'problems' ? 'on' : ''}" data-filter="problems">problems (${sm.problems || 0})</button>
      <button class="chip ${f === 'restarted' ? 'on' : ''}" data-filter="restarted">restarted &lt;24h (${state.pods.filter(p => p.lastRestartAgoSec && p.lastRestartAgoSec < 86400).length})</button>
      <button class="chip ${f === 'crash' ? 'on' : ''}" data-filter="crash">crashloop/oom</button>
      <button class="chip ${f === 'notready' ? 'on' : ''}" data-filter="notready">not ready</button>
      <span class="spacer"></span>
      <span class="muted">${state.pods.length} pods · ${sm.nodes || 0} nodes · ${sm.restarts || 0} total restarts</span>
    </div>
    ${table(cols, rows, { sortKey: 'pods', rowClass: p => isProblem(p.status) ? 'dim' : '' })}`;

  bindTable(row => openPod(row));
  $$('#view .chip').forEach(chip => {
    chip.onclick = () => { state.filter = chip.dataset.filter; state.selIdx = -1; render(); };
  });
}

/* ---------- render: nodes ---------- */

function renderNodes() {
  let rows = state.nodes.filter(n => searchMatch(n, ['name', 'instanceType', 'nodegroup', 'zone', 'capacityType']));
  rows = sortRows(rows, state.sort.nodes ? state.sort.nodes.key : 'name', state.sort.nodes ? state.sort.nodes.dir : 1);
  state.rows = rows;
  const cols = [
    { key: 'short', label: 'node', cls: 'name', render: n => esc(n.short), title: n => n.name },
    { key: 'instanceType', label: 'type', cls: 'mono' },
    { key: 'nodegroup', label: 'node group', cls: 'mono' },
    { key: 'capacityType', label: 'capacity', render: n => `<span class="tag ${n.capacityType === 'SPOT' ? 'warn' : ''}">${esc(n.capacityType || '?')}</span>` },
    { key: 'zone', label: 'zone', cls: 'mono' },
    { key: 'pods', label: 'pods', num: true },
    { key: 'restarts', label: 'restarts', num: true, render: n => `<span class="${restartClass(n.restarts)}">${n.restarts}</span>` },
    { key: 'cpu', label: 'cpu', num: true, render: n => esc(n.cpuText) },
    { key: 'mem', label: 'mem', num: true, render: n => esc(n.memText) },
  ];
  $('#view').innerHTML = `
    ${state.nodeNote ? `<div class="banner" style="display:block">${esc(state.nodeNote)} — showing what node metrics expose (nodes are RBAC-locked for your IAM user).</div>` : ''}
    ${table(cols, rows, { sortKey: 'nodes' })}`;
  bindTable(row => {
    // nodes are read-only here; the useful action is "show me the pods on it"
    switchTab('pods');
    $('#search').value = row.short;
    state.q = row.short;
    render();
  });
}

/* ---------- render: restarts ---------- */

async function renderRestarts() {
  const data = await api('/api/restarts?after=0&limit=500');
  const events = data.events.slice().reverse().filter(e => !state.ns || e.ns === state.ns || e.ns === '');
  state.rows = events;
  const cols = [
    { key: 'ts', label: 'when', cls: 'mono', render: e => {
      const fresh = e.ts > Math.floor(Date.now() / 1000) - 3600;
      return `${beatGlyph(fresh, fresh ? '' : 'flat')}${fmtAge(Math.floor(Date.now() / 1000) - e.ts)} ago`;
    }, title: e => new Date(e.ts * 1000).toLocaleString() },
    { key: 'ns', label: 'ns', cls: 'mono' },
    { key: 'pod', label: 'pod', cls: 'name', render: e => esc(e.pod) + (e.historical ? ' <span class="tag" title="read from the pod\'s last state when podbeat started">prior</span>' : '') },
    { key: 'container', label: 'container', cls: 'mono' },
    { key: 'reason', label: 'reason', render: e => `<span class="${e.reason === 'Completed' ? 's-done' : 's-bad'}">${esc(e.reason)}</span>` },    { key: 'exitCode', label: 'exit', num: true, render: e => e.exitCode == null ? '-' : esc(e.exitCode) },
    { key: 'ranForSec', label: 'ran for', num: true, render: e => fmtDur(e.ranForSec) },
    { key: 'delta', label: 'restarts', num: true, render: e => `+${e.delta} → ${e.total}` },
  ];
  $('#view').innerHTML = events.length
    ? table(cols, events, { sortKey: 'restarts' })
    : `<div class="empty">${beatGlyph(false, 'flat')} steady — no restarts recorded<br><span class="muted">watcher is polling namespace(s): ${esc((state.watch || ['default']).join(', '))}</span></div>`;
  bindTable(e => {
    state.ns = e.ns;
    $('#ns').value = e.ns;
    openPodByName(e.ns, e.pod);
  });
}

/* ---------- render: generic (deployments/services/cm/secrets/events) ---------- */

const GENERIC = {
  deployments: {
    fields: ['name', 'readyText', 'images', 'ageSec'],
    cols: [
      { key: 'name', label: 'name', cls: 'name' },
      { key: 'readyText', label: 'ready', cls: 'mono', render: d => d.desired === 0
        ? `<span class="muted">0/0 · scaled to zero</span>`
        : `<span class="${d.healthy ? 's-running' : 's-bad'}">${esc(d.readyText)}</span>` },
      { key: 'images', label: 'image', cls: 'mono', render: d => esc((d.images || []).join(', ')), title: d => (d.images || []).join('\n') },
      { key: 'strategy', label: 'strategy', cls: 'mono' },
      { key: 'ageSec', label: 'age', num: true, render: d => fmtAge(d.ageSec) },
    ],
  },
  services: {
    fields: ['name', 'type', 'clusterIP', 'ports', 'selector', 'external'],
    cols: [
      { key: 'name', label: 'name', cls: 'name' },
      { key: 'type', label: 'type', cls: 'mono' },
      { key: 'clusterIP', label: 'cluster ip', cls: 'mono' },
      { key: 'ports', label: 'ports', cls: 'mono' },
      { key: 'external', label: 'external', cls: 'mono' },
      { key: 'selector', label: 'selector', cls: 'mono' },
      { key: 'ageSec', label: 'age', num: true, render: s => fmtAge(s.ageSec) },
    ],
  },
  configmaps: {
    fields: ['name', 'keys'],
    cols: [
      { key: 'name', label: 'name', cls: 'name' },
      { key: 'keyCount', label: 'keys', num: true },
      { key: 'keys', label: 'contents', cls: 'mono', render: c => esc((c.keys || []).join('  ')) },
      { key: 'ageSec', label: 'age', num: true, render: c => fmtAge(c.ageSec) },
    ],
  },
  secrets: {
    fields: ['name', 'keys', 'type'],
    cols: [
      { key: 'name', label: 'name', cls: 'name' },
      { key: 'type', label: 'type', cls: 'mono' },
      { key: 'keyCount', label: 'keys', num: true },
      { key: 'keys', label: 'contents', cls: 'mono', render: c => esc((c.keys || []).join('  ')) },
      { key: 'ageSec', label: 'age', num: true, render: c => fmtAge(c.ageSec) },
    ],
  },
  events: {
    fields: ['reason', 'objectName', 'message', 'type', 'source'],
    cols: [
      { key: 'type', label: 'type', render: e => `<span class="${e.type === 'Warning' ? 's-warn' : 'muted'}">${esc(e.type)}</span>` },
      { key: 'reason', label: 'reason', cls: 'mono' },
      { key: 'objectName', label: 'object', cls: 'mono', render: e => `${esc((e.objectKind || '').toLowerCase())}/${esc(e.objectName)}` },
      { key: 'message', label: 'message', cls: '', wrap: true },
      { key: 'count', label: 'count', num: true },
      { key: 'lastSeenAgoSec', label: 'last seen', num: true, render: e => fmtAge(e.lastSeenAgoSec) },
    ],
    rowClass: e => e.type === 'Warning' ? '' : 'dim',
  },
};

async function renderGeneric(kind) {
  const data = await api(`/api/resources?kind=${kind}&ctx=${encodeURIComponent(state.ctx)}&ns=${encodeURIComponent(state.ns)}`);
  const conf = GENERIC[kind] || GENERIC.configmaps;
  let rows = data.rows.filter(r => searchMatch(r, conf.fields));
  const s = state.sort[kind] || { key: kind === 'events' ? 'lastSeenAgoSec' : 'name', dir: 1 };
  rows = sortRows(rows, s.key, s.dir);
  state.rows = rows;
  $('#view').innerHTML = table(conf.cols, rows, {
    sortKey: kind,
    rowClass: conf.rowClass,
  });
  bindTable(row => {
    if (kind === 'events') {
      if (row.objectKind === 'Pod') openPodByName(state.ns, row.objectName);
      else openObject(kind, row.name, row);
    } else {
      openObject(kind, row.name, row);
    }
  });
}

/* ---------- render dispatch ---------- */

async function render() {
  banner('');
  try {
    if (state.tab === 'pods') { renderPods(); }
    else if (state.tab === 'nodes') {
      if (!state.nodes.length) $('#view').innerHTML = skeletonTable(9);
      const data = await api(`/api/nodes?ctx=${encodeURIComponent(state.ctx)}&ns=${encodeURIComponent(state.ns)}`);
      state.nodes = data.nodes; state.nodeNote = data.note;
      renderNodes();
    }
    else if (state.tab === 'restarts') { await renderRestarts(); }
    else { await renderGeneric(state.tab); }
  } catch (err) {
    banner(err.message);
    if (rbacBlocked(err.message) && (state.tab === 'secrets' || state.tab === 'events')) {
      $('#view').innerHTML = blockedPanel(state.tab, err.message);
    } else if (!$('#view').innerHTML.trim() || $('#view').innerHTML.includes('loading')) {
      $('#view').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  }
}

async function refresh() {
  $('#clock').textContent = new Date().toLocaleTimeString();
  try {
    if (state.tab !== 'nodes') await loadPods().catch(e => { throw e; });
    await render();
    state.stuck = false;
  } catch (err) {
    banner(err.message);
    if (/unreachable|expired|timed out|connection refused/i.test(err.message)) state.stuck = true;
  }
  loadForwards();
}

function switchTab(tab) {
  // a leftover detail panel on top of another tab is just clutter
  if (!$('#drawer').hidden) closeDrawer();
  state.tab = tab;
  state.selIdx = -1;
  $$('#tabs button[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'nodes') state.nodes = [];
  render();
}

/* ---------- drawer ---------- */

function showDrawer() {
  const sel = state.selected;
  $('#drawer').hidden = false;
  $('#d-rail-title').textContent = sel ? sel.name : '';
  // selecting something always opens the panel, even if it was collapsed before
  setDrawerCollapsed(false);
}

function setDrawerCollapsed(collapsed) {
  if (collapsed && state.logAbort) { state.logAbort.abort(); state.logAbort = null; }
  $('#drawer').classList.toggle('collapsed', collapsed);
  $('#d-rail-title').textContent = state.selected ? state.selected.name : '';
}

function toggleDrawerCollapsed() {
  if ($('#drawer').hidden) return;
  setDrawerCollapsed(!$('#drawer').classList.contains('collapsed'));
}

function closeDrawer() {
  if (state.logAbort) { state.logAbort.abort(); state.logAbort = null; }
  $('#drawer').hidden = true;
  $('#drawer').classList.remove('collapsed');
  state.selected = null;
  state.drawerTab = '';
}

function openPod(row) {
  state.selected = { kind: 'pods', ns: row.ns || state.ns, name: row.name, row };
  state.drawerTab = 'overview';
  showDrawer();
  renderDrawer();
}

function openPodByName(ns, name) {
  const row = state.pods.find(p => p.name === name && p.ns === ns);
  if (row) return openPod(row);
  state.selected = { kind: 'pods', ns, name, row: null };
  state.drawerTab = 'overview';
  showDrawer();
  renderDrawer();
}

function openObject(kind, name, row) {
  state.selected = { kind, ns: state.ns, name, row };
  state.drawerTab = (DRAWER_TABS[kind] || ['overview'])[0];
  showDrawer();
  renderDrawer();
}

function renderDrawer() {
  const sel = state.selected;
  if (!sel) return;
  const tabs = DRAWER_TABS[sel.kind] || ['overview', 'yaml', 'describe'];
  const row = sel.row || {};
  $('#d-title').textContent = sel.name;
  const meta = [];
  if (sel.kind === 'pods' && row.status) meta.push(row.status);
  if (row.readyText) meta.push('ready ' + row.readyText);
  if (sel.kind === 'pods' && row.restarts) meta.push(row.restarts + ' restarts');
  meta.push(`${sel.kind} · ${sel.ns}`);
  $('#d-sub').textContent = meta.join('  ·  ');
  $('#d-tabs').innerHTML = tabs.map(t =>
    `<button data-dtab="${t}" class="${t === state.drawerTab ? 'active' : ''}">${t}</button>`
  ).join('');
  $$('#d-tabs button').forEach(b => {
    b.onclick = () => { state.drawerTab = b.dataset.dtab; renderDrawer(); };
  });
  renderDrawerBody();
}

function renderDrawerBody() {
  const sel = state.selected;
  if (!sel) return;
  const tab = state.drawerTab;
  const body = $('#d-body');
  if (state.logAbort && tab !== 'logs') { state.logAbort.abort(); state.logAbort = null; }

  if (sel.kind === 'pods' && tab === 'overview') return body.innerHTML = podOverview(sel);
  if (sel.kind === 'pods' && tab === 'logs') return mountLogs(sel);
  if (sel.kind === 'pods' && tab === 'restarts') return mountPodRestarts(sel);
  if (tab === 'data') return mountData(sel);
  if (tab === 'yaml') return mountText(sel, 'yaml');
  if (tab === 'describe') return mountText(sel, 'describe');
  if (tab === 'actions') return mountActions(sel);
  if (tab === 'overview') return mountObjectOverview(sel);
  body.innerHTML = '';
}

function podOverview(sel) {
  const row = sel.row;
  if (!row) return '<div class="empty">pod not in the current list (different namespace?)</div>';
  const containers = (row.containers || []).map(c => `
    <tr>
      <td class="name">${esc(c.name)}</td>
      <td><span class="${c.ready ? 's-running' : 's-bad'}">${c.ready ? 'ready' : c.state}</span></td>
      <td class="mono">${esc(c.state)}${c.reason ? ' · ' + esc(c.reason) : ''}</td>
      <td class="num"><span class="${restartClass(c.restarts)}">${c.restarts}</span></td>
      <td class="mono">${c.lastReason ? esc(c.lastReason) : '-'}${c.lastExitCode != null ? ' / exit ' + c.lastExitCode : ''}</td>
      <td class="num mono">${c.ranForSec ? fmtDur(c.ranForSec) : '-'}</td>
      <td class="mono">${esc(c.cpuReq ? c.cpuReq * 1000 + 'm' : '-')} / ${esc(c.cpuLim ? c.cpuLim * 1000 + 'm' : '-')}</td>
      <td class="mono">${esc(c.memReq ? Math.round(c.memReq / 1048576) + 'Mi' : '-')} / ${esc(c.memLim ? Math.round(c.memLim / 1048576) + 'Mi' : '-')}</td>
    </tr>`).join('');

  const d = [
    ['status', `<span class="${danger(row.status)}">${esc(row.status)}</span>`],
    ['namespace', esc(row.ns)],
    ['node', esc(row.node || '-')],
    ['owner', esc(row.owner || '-')],
    ['qos', esc(row.qos || '-')],
    ['up', row.upSec ? `${fmtDur(row.upSec)} <span class="muted">(pod age ${fmtAge(row.ageSec)})</span>` : '-'],
    ['age', fmtAge(row.ageSec)],
    ['restarts', `<span class="${restartClass(row.restarts)}">${row.restarts}</span>` +
      (row.lastRestartAgoSec ? ` <span class="muted">last ${fmtAge(row.lastRestartAgoSec)} ago · ${esc(row.lastReason || '')}</span>` : '')],
    ['cpu / mem', `${esc(row.cpuText)} / ${esc(row.memText)}`],
    ['pod ip', esc((row.containers && row.podIP) || '-')],
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');

  return `
    <dl class="kv">${d}</dl>
    <h4 style="margin:16px 0 6px;font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.4px">containers</h4>
    <table>
      <thead><tr><th>container</th><th>state</th><th>detail</th><th class="num">restarts</th><th>last exit</th><th class="num">ran for</th><th>cpu req/lim</th><th>mem req/lim</th></tr></thead>
      <tbody>${containers}</tbody>
    </table>
    <div class="toolbar" style="margin-top:10px">
      <button class="btn" data-act="prev-logs">logs of previous (crashed) container</button>
      <button class="btn" data-act="copy-cmd">copy kubectl describe</button>
    </div>`;
}

async function mountObjectOverview(sel) {
  const body = $('#d-body');
  body.innerHTML = '<div class="empty">loading…</div>';
  const key = `obj:${state.ctx}:${sel.kind}:${sel.ns}:${sel.name}`;
  try {
    const data = state.detail[key] || (state.detail[key] = await api(
      `/api/object?kind=${sel.kind}&ctx=${encodeURIComponent(state.ctx)}&ns=${encodeURIComponent(sel.ns)}&name=${encodeURIComponent(sel.name)}`));
    const obj = data.object || {};
    const spec = obj.spec || {};
    const status = obj.status || {};
    const pairs = [
      ['namespace', esc(obj.metadata?.namespace || sel.ns)],
      ['created', obj.metadata?.creationTimestamp ? fmtAge(Math.floor(Date.now() / 1000) - Date.parse(obj.metadata.creationTimestamp) / 1000) + ' ago' : '-'],
      ['replicas', spec.replicas != null ? `${status.readyReplicas || 0} ready / ${spec.replicas} desired` : '-'],
      ['image', esc((((spec.template || {}).spec || {}).containers || []).map(c => c.image).join(', ') || '-')],
      ['selector', esc(Object.entries(spec.selector?.matchLabels || {}).map(([k, v]) => k + '=' + v).join(', ') || '-')],
      ['labels', esc(Object.entries(obj.metadata?.labels || {}).map(([k, v]) => k + '=' + v).join(', ') || '-')],
    ];
    const conditions = (status.conditions || []).map(c =>
      `<tr><td class="mono">${esc(c.type)}</td><td><span class="${c.status === 'True' ? 's-running' : 's-warn'}">${esc(c.status)}</span></td><td class="mono wrap">${esc(c.reason || '')} ${esc(c.message || '')}</td></tr>`
    ).join('');
    body.innerHTML = `
      <dl class="kv">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>
      ${conditions ? `<h4 style="margin:16px 0 6px;font-size:11px;color:var(--dim);text-transform:uppercase">conditions</h4>
      <table><thead><tr><th>type</th><th>status</th><th>message</th></tr></thead><tbody>${conditions}</tbody></table>` : ''}`;
  } catch (err) {
    body.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

/* ---------- drawer: configmap / secret data ---------- */

async function mountData(sel) {
  const body = $('#d-body');
  body.innerHTML = '<div class="empty">loading…</div>';
  try {
    if (sel.kind === 'secrets') {
      const data = await api(`/api/secret?ctx=${encodeURIComponent(state.ctx)}&ns=${encodeURIComponent(sel.ns)}&name=${encodeURIComponent(sel.name)}`);
      const entries = Object.entries(data.data || {});
      body.innerHTML = `
        <div class="toolbar">
          <span class="muted">${esc(data.type)} · ${entries.length} keys</span>
          <span class="spacer"></span>
          <button class="btn" id="reveal">reveal values</button>
        </div>
        ${entries.map(([k, v]) => `
          <details class="cm-key">
            <summary>${esc(k)} <span class="muted">(${v.length} chars)</span></summary>
            <div class="sec-value" data-secret="${esc(k)}" style="filter:blur(4px)">${esc(v)}</div>
          </details>`).join('')}`;
      const btn = $('#reveal');
      if (btn) btn.onclick = () => {
        $$('.sec-value').forEach(el => { el.style.filter = 'none'; });
        btn.textContent = 'values revealed';
        btn.disabled = true;
      };
      return;
    }
    const key = `obj:${state.ctx}:${sel.kind}:${sel.ns}:${sel.name}`;
    const data = state.detail[key] || (state.detail[key] = await api(
      `/api/object?kind=${sel.kind}&ctx=${encodeURIComponent(state.ctx)}&ns=${encodeURIComponent(sel.ns)}&name=${encodeURIComponent(sel.name)}`));
    const obj = data.object || {};
    if (sel.kind === 'configmaps') return renderConfigMapView(sel, obj);
    const entries = Object.entries(obj.data || {});
    body.innerHTML = `
      <div class="toolbar">
        <span class="muted">${entries.length} keys${obj.immutable ? ' · immutable' : ''}</span>
        <span class="spacer"></span>
        <button class="btn" id="copy-all">copy all</button>
      </div>
      ${entries.length ? entries.map(([k, v]) => `
        <details class="cm-key" ${entries.length < 4 ? 'open' : ''}>
          <summary>${esc(k)} <span class="muted">(${v.length} chars)</span></summary>
          <pre class="code" style="padding:8px;background:#0d1116">${esc(v)}</pre>
        </details>`).join('') : '<div class="empty">no data</div>'}`;
    const all = $('#copy-all');
    if (all) all.onclick = () => copy(entries.map(([k, v]) => `# ${k}\n${v}`).join('\n\n'), sel.name);
  } catch (err) {
    body.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

/* ---------- configmaps: view + edit ---------- */

function invalidateObject(sel) {
  const suffix = `:${sel.kind}:${sel.ns}:${sel.name}`;
  for (const key of Object.keys(state.detail)) {
    if (key.endsWith(suffix)) delete state.detail[key];
  }
}

function renderConfigMapView(sel, obj) {
  const entries = Object.entries(obj.data || {});
  const rv = obj.metadata?.resourceVersion || '';
  const why = obj.immutable ? 'immutable configmap' : !state.writes ? 'read-only mode: restart with PODBEAT_ALLOW_WRITES=1' : 'edit keys';
  $('#d-body').innerHTML = `
    <div class="toolbar">
      <span class="muted">${entries.length} keys</span>
      ${obj.immutable ? '<span class="tag warn">immutable</span>' : ''}
      ${state.writes ? '' : '<span class="tag" title="restart with PODBEAT_ALLOW_WRITES=1, or ./install.sh --writes">read-only</span>'}
      <span class="spacer"></span>
      <button class="btn" id="cm-edit" ${state.writes && !obj.immutable ? '' : 'disabled'} title="${esc(why)}">edit</button>
      <button class="btn" id="copy-all">copy all</button>
    </div>
    ${entries.length ? entries.map(([k, v]) => `
      <details class="cm-key" ${entries.length < 4 ? 'open' : ''}>
        <summary>${esc(k)} <span class="muted">(${v.length} chars)</span></summary>
        <pre class="code" style="padding:8px;background:#0d1116">${esc(v)}</pre>
      </details>`).join('') : '<div class="empty">no data — use edit to add keys</div>'}`;
  $('#copy-all').onclick = () => copy(entries.map(([k, v]) => `# ${k}\n${v}`).join('\n\n'), sel.name);
  $('#cm-edit').onclick = () => renderConfigMapEditor(sel, obj, rv);
}

function cmRow(key, value) {
  return `
    <div class="cm-row">
      <div class="cm-row-head">
        <input class="cm-key" value="${esc(key)}" placeholder="key" spellcheck="false" autocomplete="off">
        <button class="btn ghost cm-del" title="remove key">✕</button>
      </div>
      <textarea class="cm-val" spellcheck="false" rows="${Math.min(14, Math.max(4, (value.match(/\n/g) || []).length + 2))}">${esc(value)}</textarea>
    </div>`;
}

function renderConfigMapEditor(sel, obj, rv) {
  const entries = Object.entries(obj.data || {});
  const body = $('#d-body');
  body.innerHTML = `
    <div class="toolbar">
      <span class="muted">editing <b>${esc(sel.name)}</b> · ${isProdContext() ? 'PRODUCTION' : 'this cluster'}</span>
      <span class="spacer"></span>
      <button class="btn" id="cm-add">+ key</button>
      <button class="btn" id="cm-cancel">cancel</button>
      <button class="btn warn" id="cm-save">save</button>
    </div>
    <div id="cm-rows">${entries.map(([k, v]) => cmRow(k, v)).join('')}</div>
    <div class="muted" style="margin-top:10px;line-height:1.6">
      keys: letters, digits, <code>-</code>, <code>_</code>, <code>.</code> · empty value deletes nothing, remove the key instead<br>
      mounted files pick this up in ~1 minute · env vars need a pod restart
    </div>`;

  const rows = () => $$('#cm-rows .cm-row');
  const wire = (row) => {
    row.querySelector('.cm-del').onclick = () => row.remove();
  };
  rows().forEach(wire);
  $('#cm-add').onclick = () => {
    $('#cm-rows').insertAdjacentHTML('beforeend', cmRow('', ''));
    const last = rows()[rows().length - 1];
    wire(last);
    last.querySelector('.cm-key').focus();
  };
  $('#cm-cancel').onclick = () => renderConfigMapView(sel, obj);
  $('#cm-save').onclick = async () => {
    const data = {};
    const problems = [];
    for (const row of rows()) {
      const key = row.querySelector('.cm-key').value.trim();
      const value = row.querySelector('.cm-val').value;
      if (!key) { problems.push('a key is empty'); continue; }
      if (!/^[-._a-zA-Z0-9]+$/.test(key)) { problems.push(`invalid key "${key}"`); continue; }
      if (Object.prototype.hasOwnProperty.call(data, key)) { problems.push(`duplicate key "${key}"`); continue; }
      data[key] = value;
    }
    if (problems.length) {
      return toast(`<div class="t-pod">not saved</div><div class="t-meta">${esc(problems.join(' · '))}</div>`);
    }
    const before = obj.data || {};
    const changed = Object.keys(data).filter(k => before[k] !== data[k]);
    const removed = Object.keys(before).filter(k => !(k in data));
    if (!changed.length && !removed.length) {
      return toast('<div class="t-pod">no changes</div>', { info: true });
    }
    const summary = [
      changed.length ? `changed: ${changed.join(', ')}` : '',
      removed.length ? `removed: ${removed.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    const confirmed = await uiConfirm(
      `Save configmap ${sel.name}?`,
      `${summary}\n\nThis writes to the live cluster. Mounted files refresh in ~1 min; env vars need a pod restart.`,
      'save');
    if (!confirmed) return;
    try {
      const res = await api('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save-configmap', ctx: state.ctx, ns: sel.ns, name: sel.name,
          data, resourceVersion: rv,
        }),
      });
      invalidateObject(sel);
      toast(`<div class="t-pod">saved ${esc(sel.name)}</div><div class="t-meta">${res.changed.length} changed · ${res.removed.length} removed · ${res.keys} keys</div>`, { info: true });
      await mountData(sel);
      render();
    } catch (err) {
      toast(`<div class="t-pod">save failed</div><div class="t-meta">${esc(err.message)}</div>`);
      if (/changed since/i.test(err.message)) {
        invalidateObject(sel);
        await mountData(sel);
      }
    }
  };
}

/* ---------- drawer: yaml / describe ---------- */

async function mountText(sel, kind) {
  const body = $('#d-body');
  body.innerHTML = '<div class="empty">loading…</div>';
  const key = `${kind}:${state.ctx}:${sel.kind}:${sel.ns}:${sel.name}`;
  try {
    const text = state.detail[key] || (state.detail[key] = await api(
      `/api/${kind}?kind=${sel.kind}&ctx=${encodeURIComponent(state.ctx)}&ns=${encodeURIComponent(sel.ns)}&name=${encodeURIComponent(sel.name)}`));
    body.innerHTML = `
      <div class="toolbar">
        <span class="muted">${esc(kind)} · ${text.split('\n').length} lines</span>
        <span class="spacer"></span>
        <button class="btn" id="copy-text">copy</button>
      </div>
      <pre class="code">${esc(text)}</pre>`;
    $('#copy-text').onclick = () => copy(text, kind);
  } catch (err) {
    body.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

/* ---------- drawer: pod restart history ---------- */

async function mountPodRestarts(sel) {
  const body = $('#d-body');
  body.innerHTML = '<div class="empty">loading…</div>';
  try {
    const data = await api('/api/restarts?after=0&limit=500');
    const events = data.events.filter(e => e.pod === sel.name && e.ns === sel.ns).reverse();
    if (!events.length) {
      body.innerHTML = `<div class="empty">no restarts recorded for this pod<br>
        <span class="muted">podbeat records every restart it sees while running, plus the watcher in ${esc((state.watch || []).join(', '))}</span></div>`;
      return;
    }
    body.innerHTML = `<table><thead><tr><th>when</th><th>container</th><th>reason</th><th class="num">exit</th><th class="num">ran for</th><th class="num">count</th></tr></thead><tbody>
      ${events.map(e => `<tr>
        <td class="mono" title="${esc(new Date(e.ts * 1000).toLocaleString())}">${fmtAge(Math.floor(Date.now() / 1000) - e.ts)} ago</td>
        <td class="mono">${esc(e.container)}</td>
        <td><span class="${e.reason === 'Completed' ? 's-done' : 's-bad'}">${esc(e.reason)}</span></td>
        <td class="num mono">${e.exitCode == null ? '-' : esc(e.exitCode)}</td>
        <td class="num mono">${fmtDur(e.ranForSec)}</td>
        <td class="num mono">+${e.delta} → ${e.total}</td>
      </tr>`).join('')}</tbody></table>
      <div class="muted" style="margin-top:8px">restart history is podbeat's own record; k8s events are not required.</div>`;
  } catch (err) {
    body.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

/* ---------- drawer: logs ---------- */

function mountLogs(sel) {
  const body = $('#d-body');
  const row = sel.row || {};
  const containers = (row.containers || []).map(c => c.name);
  body.innerHTML = `
    <div class="toolbar">
      <select id="log-container">${containers.map(c => `<option>${esc(c)}</option>`).join('')}</select>
      <label><input type="checkbox" id="log-follow" checked> follow</label>
      <label><input type="checkbox" id="log-prev"> previous</label>
      <label><input type="checkbox" id="log-ts"> timestamps</label>
      <select id="log-tail">
        <option>200</option><option selected>500</option><option>2000</option><option>10000</option>
      </select>
      <button class="btn" id="log-reload">reload</button>
      <span class="spacer"></span>
      <span class="muted" id="log-status"></span>
    </div>
    <pre class="log" id="log-out"></pre>`;

  const start = () => {
    if (state.logAbort) state.logAbort.abort();
    const controller = new AbortController();
    state.logAbort = controller;
    const out = $('#log-out');
    const status = $('#log-status');
    out.textContent = '';
    status.textContent = 'connecting…';
    const params = new URLSearchParams({
      ctx: state.ctx, ns: sel.ns, pod: sel.name,
      container: $('#log-container').value || '',
      tail: $('#log-tail').value,
      follow: $('#log-follow').checked ? '1' : '0',
      previous: $('#log-prev').checked ? '1' : '0',
      timestamps: $('#log-ts').checked ? '1' : '0',
    });
    fetch('/api/logs?' + params, {
      signal: controller.signal,
      headers: { 'X-Podbeat-Token': state.token },
    }).then(async res => {
      if (!res.ok) { out.textContent = await res.text(); status.textContent = ''; return; }
      status.innerHTML = $('#log-follow').checked ? '<span class="live-dot"></span>LIVE' : 'loaded';
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const stick = out.scrollTop + out.clientHeight >= out.scrollHeight - 40;
        out.textContent += dec.decode(value, { stream: true });
        // keep the DOM sane on chatty pods; nobody scrolls back 400k chars
        if (out.textContent.length > 400000) {
          out.textContent = '… trimmed …\n' + out.textContent.slice(-300000);
        }
        if (stick) out.scrollTop = out.scrollHeight;
      }
      status.textContent = 'stream ended';
    }).catch(err => {
      if (err.name !== 'AbortError') { out.textContent += '\n' + err.message; status.textContent = 'error'; }
    });
  };
  $('#log-reload').onclick = start;
  $('#log-container').onchange = start;
  start();
}

/* ---------- drawer: actions ---------- */

function mountActions(sel) {
  const body = $('#d-body');
  const ro = state.writes ? '' : 'disabled';
  const roNote = state.writes ? '' : '<div class="muted" style="margin-bottom:10px">read-only mode. restart with <code>PODBEAT_ALLOW_WRITES=1</code> to unlock writes.</div>';

  if (sel.kind === 'pods') {
    body.innerHTML = `
      ${roNote}
      <div class="toolbar">
        <button class="btn bad" ${ro} data-act="delete-pod">delete pod</button>
        <span class="muted">the ReplicaSet will recreate it</span>
      </div>
      <h4 style="margin:18px 0 6px;font-size:11px;color:var(--dim);text-transform:uppercase">port forward</h4>
      <div class="toolbar">
        <input id="pf-ports" type="text" placeholder="8080:80" size="12" ${ro}>
        <button class="btn" ${ro} data-act="pf-start">start</button>
        <span class="muted">then localhost:8080</span>
      </div>
      <h4 style="margin:18px 0 6px;font-size:11px;color:var(--dim);text-transform:uppercase">exec</h4>
      <div class="toolbar">
        <select id="exec-container">${(sel.row?.containers || []).map(c => `<option>${esc(c.name)}</option>`).join('')}</select>
        <input id="exec-cmd" type="text" placeholder="ls -la /app" size="30" ${ro}>
        <button class="btn" ${ro} data-act="exec">run</button>
      </div>
      <pre class="code" id="exec-out" style="margin-top:8px"></pre>`;
    return;
  }

  const kindArg = sel.kind === 'deployments' ? 'deployment' : sel.kind === 'statefulsets' ? 'statefulset' : 'daemonset';
  body.innerHTML = `
    ${roNote}
    <div class="toolbar">
      <button class="btn warn" ${ro} data-act="rollout-restart" data-kind="${kindArg}">rollout restart</button>
      <span class="muted">rolling restart, zero-downtime</span>
    </div>
    <h4 style="margin:18px 0 6px;font-size:11px;color:var(--dim);text-transform:uppercase">scale</h4>
    <div class="toolbar">
      <input id="scale-replicas" type="text" size="4" value="${sel.row?.desired ?? ''}" ${ro}>
      <button class="btn" ${ro} data-act="scale" data-kind="${kindArg}">apply</button>
    </div>`;
}

async function runAction(action, payload, doneMessage) {
  try {
    const out = await api('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ctx: state.ctx, ns: state.selected?.ns || state.ns, ...payload }),
    });
    toast(`<div class="t-pod">${esc(doneMessage)}</div><div class="t-meta">${esc((out.output || '').trim().slice(0, 200))}</div>`, { info: true });
    refresh();
    return out;
  } catch (err) {
    toast(`<div class="t-pod">action failed</div><div class="t-meta">${esc(err.message)}</div>`);
  }
}

/* ---------- drawer event wiring (delegated) ---------- */

$('#d-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  const sel = state.selected;
  if (!btn || !sel) return;
  const act = btn.dataset.act;

  if (act === 'copy-cmd') {
    const cmd = `kubectl --context ${state.ctx} -n ${sel.ns} describe pod ${sel.name}`;
    return copy(cmd, 'kubectl describe');
  }
  if (act === 'copy-yaml-cmd') {
    const cmd = `kubectl --context ${state.ctx} -n ${sel.ns} get ${sel.kind} ${sel.name} -o yaml`;
    return copy(cmd, 'kubectl get -o yaml');
  }
  if (act === 'prev-logs') {
    state.drawerTab = 'logs';
    renderDrawer();
    setTimeout(() => { const p = $('#log-prev'); if (p) { p.checked = true; $('#log-reload').click(); } }, 60);
    return;
  }
  if (act === 'delete-pod') {
    if (!await uiConfirm(`Delete pod ${sel.name}?`, 'Its ReplicaSet (or StatefulSet) will recreate it. Traffic goes to the other replicas meanwhile.')) return;
    return runAction('delete-pod', { pod: sel.name }, 'pod deleted');
  }
  if (act === 'rollout-restart') {
    if (!await uiConfirm(`Rollout restart ${sel.name}?`, 'Rolling restart: pods are replaced one by one, no downtime.')) return;
    return runAction('rollout-restart', { kind: btn.dataset.kind, name: sel.name }, 'rollout restarted');
  }
  if (act === 'scale') {
    const replicas = $('#scale-replicas').value.trim();
    if (!/^\d+$/.test(replicas)) return toast('<div class="t-pod">replicas must be a number</div>');
    if (!await uiConfirm(`Scale ${sel.name} to ${replicas}?`, `This changes live replica count in ${isProdContext() ? 'PRODUCTION' : 'this cluster'}.`)) return;
    return runAction('scale', { kind: btn.dataset.kind, name: sel.name, replicas }, 'scaled');
  }
  if (act === 'pf-start') {
    const ports = $('#pf-ports').value.trim();
    if (!ports) return;
    try {
      const res = await api('/api/forwards/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ctx: state.ctx, ns: sel.ns, pod: sel.name, ports }),
      });
      toast(`<div class="t-pod">port-forward started</div><div class="t-meta">localhost:${esc(res.local)} → ${esc(sel.name)}</div>`, { info: true });
      loadForwards();
    } catch (err) {
      toast(`<div class="t-pod">port-forward failed</div><div class="t-meta">${esc(err.message)}</div>`);
    }
    return;
  }
  if (act === 'exec') {
    const cmd = $('#exec-cmd').value.trim();
    if (!cmd) return;
    // exec is the one action with no undo; confirm it when the marker says prod
    if (isProdContext() && !await uiConfirm(`Run in ${sel.name}?`, `This executes a shell command in a PRODUCTION pod:\n${cmd.slice(0, 200)}`)) return;
    const out = $('#exec-out');
    out.textContent = '$ ' + cmd + '\n…';
    try {
      const res = await api('/api/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'exec', ctx: state.ctx, ns: sel.ns, pod: sel.name,
          container: $('#exec-container').value, cmd,
        }),
      });
      out.textContent = '$ ' + cmd + '\n' + (res.output || '(no output)');
    } catch (err) {
      out.textContent = '$ ' + cmd + '\n' + err.message;
    }
  }
});

$('#d-close').onclick = closeDrawer;
$('#d-collapse').onclick = () => setDrawerCollapsed(true);
$('#d-expand').onclick = () => setDrawerCollapsed(false);

/* ---------- header wiring ---------- */

$('#search').oninput = (e) => { state.q = e.target.value.trim(); state.selIdx = -1; render(); };
$('#refresh').onclick = () => { state.detail = {}; refresh(); };
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) switchTab(b.dataset.tab);
});
$('#fwdbar').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-fwd]');
  if (!b) return;
  await api('/api/forwards/stop', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: Number(b.dataset.fwd) }),
  });
  loadForwards();
});

/* ---------- keyboard ---------- */

function moveSel(delta) {
  if (!state.rows.length) return;
  state.selIdx = Math.max(0, Math.min(state.rows.length - 1, state.selIdx + delta));
  $$('#view tbody tr').forEach(tr => tr.classList.toggle('sel', Number(tr.dataset.idx) === state.selIdx));
  const el = $(`#view tbody tr[data-idx="${state.selIdx}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
}

function openSelected(kind) {
  const row = state.rows[state.selIdx];
  if (!row) return;
  if (state.tab === 'pods') return openPod(row);
  if (state.tab === 'restarts') { openPodByName(row.ns, row.pod); return; }
  if (state.tab === 'nodes') return openPodByName(state.ns, row.name);
  openObject(state.tab, row.name, row);
}

document.addEventListener('keydown', (e) => {
  if (!$('#modal').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); closeModal(false); }
    else if (e.key === 'Enter' && document.activeElement?.id !== 'modal-cancel') { e.preventDefault(); closeModal(true); }
    return;
  }
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (e.key === 'Escape') {
    if (state.selected) closeDrawer();
    else if (state.q) { $('#search').value = ''; state.q = ''; render(); }
    if (typing) document.activeElement.blur();
    return;
  }
  if (typing) return;
  if (e.key === '/') { e.preventDefault(); $('#search').focus(); $('#search').select(); return; }
  if (e.key === 'r') { state.detail = {}; refresh(); return; }
  if (e.key === 'j') { e.preventDefault(); moveSel(1); return; }
  if (e.key === 'k') { e.preventDefault(); moveSel(-1); return; }
  if (e.key === 'Enter') { openSelected(); return; }
  if (e.key === 'g' || e.key === 'l') { if (state.selected) { state.drawerTab = 'logs'; renderDrawer(); } return; }
  if (e.key === 'c') { toggleDrawerCollapsed(); return; }
  if (e.key === 'y' && state.selected) { state.drawerTab = 'yaml'; renderDrawer(); return; }
  if (e.key === 'd' && state.selected) { state.drawerTab = 'describe'; renderDrawer(); return; }
  const n = Number(e.key);
  if (n >= 1 && n <= TAB_ORDER.length) switchTab(TAB_ORDER[n - 1]);
});

/* ---------- polling ---------- */

async function tick() {
  state.tick++;
  try {
    await pollRestarts();
  } catch (e) { /* server hiccup */ }
  if (document.hidden) return;

  // self-heal: a dead context or a restarted backend must not leave the UI stuck
  if (state.stuck) {
    try {
      if (!$('#ns').options.length || $('#ns').value === 'unavailable') await loadNamespaces();
      await refresh(); // clears state.stuck when it succeeds
    } catch (e) { /* still broken, keep trying quietly */ }
    return;
  }

  if (state.tab === 'pods' || state.tab === 'restarts') {
    try { await loadPods(); } catch (e) { banner(e.message); }
  }
  if (state.tab === 'nodes' && state.tick % 2 === 0) render();
  if (state.tab === 'events' && state.tick % 3 === 0) render();
  if (state.tab === 'restarts' && state.tick % 3 === 0) render();
  if (state.tick % 2 === 0) loadForwards();
  $('#clock').textContent = new Date().toLocaleTimeString();
}

/* ---------- boot ---------- */

async function boot() {
  $('#view').innerHTML = skeletonTable();
  try {
    const health = await api('/api/health');
    state.writes = health.writes;
    state.watch = health.watch;
    state.prodPattern = health.prodPattern;
    state.token = health.token;
    const pill = $('#writes');
    pill.textContent = health.writes ? 'write mode' : 'read-only';
    pill.className = 'pill ' + (health.writes ? 'rw' : 'ro');
    pill.title = health.writes
      ? 'delete / restart / scale / exec are enabled'
      : 'view only. restart podbeat with PODBEAT_ALLOW_WRITES=1 to unlock';

    await loadContexts();
    await loadNamespaces();
    await pollRestarts();
    await loadForwards();
    await refresh();
    await pollRestarts(true); // swallow the initial history, don't toast 90 pods
    setInterval(tick, 5000);
    $('#hint').textContent = `watching ${(health.watch || []).join(', ')} for restarts`;
  } catch (err) {
    banner(err.message);
    $('#view').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    state.stuck = true;
  }
}

boot();

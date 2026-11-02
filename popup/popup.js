/**
 * popup.js - Panel de control de la extensión.
 *
 * Los servidores MCP se definen en server/servers.json (la extensión los detecta sola): aquí solo se activan,
 * se les da permiso y se prueban. Desde el panel se puede abrir ese archivo y reiniciar el puente.
 * Las tarjetas se reutilizan entre refrescos (no se recrean), así las transiciones se animan en lugar de saltar.
 */
import { MAX_ACTIVE_SERVERS, RECOMMENDED_ACTIVE_SERVERS, PERMISSIONS, PERMISSION_LABELS, DEMO_SERVER } from '../shared/constants.js';

const $ = (selector, root = document) => root.querySelector(selector);
const STATUS_TEXT = {
  connected: 'Conectado', connecting: 'Conectando…', disconnected: 'Sin conexión (reintentando)', error: 'Error de conexión',
};
const DEMO_TOOL = 'info_sistema';

const ICONS = {
  trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>',
  power: '<svg viewBox="0 0 24 24"><path d="M12 3v9"/><path d="M6.4 6.6a8 8 0 1 0 11.2 0"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>',
};
for (const el of document.querySelectorAll('.ico[data-ico]')) el.innerHTML = ICONS[el.dataset.ico] ?? '';

/** Envía un mensaje al service worker y lanza excepción si la respuesta no es ok. */
async function api(type, payload = {}) {
  let res;
  try { res = await chrome.runtime.sendMessage({ type, ...payload }); } catch (err) { throw new Error(err.message); }
  if (!res?.ok) throw new Error(res?.error ?? 'Error desconocido.');
  return res;
}

function toast(message, ms = 3200) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), ms);
}

const guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (err) { toast(err.message); }
  await refresh(true);
};

/** Solo se abren enlaces https (el service worker ya los valida; esto es un segundo candado). */
const openLink = (url) => {
  try { if (new URL(url).protocol === 'https:') chrome.tabs.create({ url }); } catch { /* enlace inválido */ }
};

const setLabel = (btn, text) => { btn.querySelector('span:not(.ico)').textContent = text; };
const setBusy = (btn, busy) => { btn.disabled = busy; btn.classList.toggle('busy', busy); };

const isDemo = (server) => {
  if (String(server.name).toLowerCase() === 'demo') return true;
  try { return new URL(server.url).port === new URL(DEMO_SERVER.url).port; } catch { return false; }
};

let latest = null; // último estado recibido

// ───────────────────────── Puente ─────────────────────────

let restarting = false;
let opening = false;
let togglingBridge = false;

function renderBridge(state) {
  const b = state.bridge ?? {};
  const dot = $('#bridge-dot');
  const title = $('#bridge-title');
  const sub = $('#bridge-sub');
  const hint = $('#offline-hint');
  const cfgErr = $('#config-error');

  if (!b.checked) {
    dot.className = 'dot connecting';
    title.textContent = 'Comprobando el puente…';
    sub.textContent = '';
  } else if (b.online) {
    dot.className = 'dot online';
    title.textContent = 'Puente conectado';
    const listening = state.servers.filter((s) => s.bridgeStatus === 'listening').length;
    sub.textContent = `v${b.version ?? '?'} · ${listening} servidor${listening === 1 ? '' : 'es'} publicado${listening === 1 ? '' : 's'}`;
  } else {
    dot.className = 'dot offline';
    title.textContent = 'Puente apagado';
    sub.textContent = 'La extensión no lo encuentra en este equipo.';
  }

  cfgErr.hidden = !(b.online && b.configError);
  if (!cfgErr.hidden) cfgErr.textContent = `servers.json tiene un error: ${b.configError}. Corrígelo y guarda: el puente lo recarga solo (mientras tanto sigue con la configuración anterior).`;

  hint.hidden = !(b.checked && !b.online);
  if (!hint.hidden) {
    if (b.launcherOnline) {
      hint.textContent = b.paused
        ? 'El puente est\u00e1 apagado a prop\u00f3sito. Pulsa \u00abIniciar puente\u00bb para encenderlo.'
        : 'El puente se ha ca\u00eddo; el lanzador lo est\u00e1 levantando. Si no vuelve, pulsa \u00abIniciar puente\u00bb.';
    } else {
      hint.replaceChildren('Para encenderlo desde aqu\u00ed, instala el lanzador una vez: doble clic en ', Object.assign(document.createElement('code'), { textContent: 'server/install.cmd' }),
        '. Mientras tanto puedes abrirlo a mano con ', Object.assign(document.createElement('code'), { textContent: 'server/start_bridge_loop.pyw' }), '.');
    }
  }

  const toggle = $('#toggle-bridge');
  if (!togglingBridge) {
    setLabel(toggle, b.online ? 'Apagar puente' : 'Iniciar puente');
    toggle.disabled = !b.checked || !b.launcherOnline;
    toggle.title = b.launcherOnline
      ? (b.online ? 'Apaga el puente (queda apagado hasta que lo inicies de nuevo)' : 'Enciende el puente')
      : 'Necesita el lanzador: se instala una vez con server/install.cmd';
  }

  const restart = $('#restart-bridge');
  if (!restarting) {
    restart.disabled = !b.online;
    restart.title = !b.online ? 'El puente está apagado' : (b.canControl ? 'Cierra y vuelve a abrir el puente (recarga servers.json y los MCP)' : 'Tu puente es antiguo: ábrelo una vez con restart_bridge.cmd para activar este botón');
  }
  $('#open-config').title = b.config ? `Abrir ${b.config}` : 'Abrir servers.json en tu editor';
}

$('#open-config').addEventListener('click', async (event) => {
  if (opening) return;
  opening = true;
  setBusy(event.currentTarget, true);
  try {
    await api('OPEN_CONFIG');
    toast('Abriendo servers.json… guarda el archivo y el puente lo recarga solo.');
  } catch (err) {
    const path = latest?.bridge?.config;
    toast(path && !err.message.includes(path) ? `${err.message} Archivo: ${path}` : err.message, 6500);
  } finally {
    opening = false;
    setBusy(event.currentTarget, false);
  }
});

$('#toggle-bridge').addEventListener('click', async (event) => {
  if (togglingBridge) return;
  const btn = event.currentTarget;
  const turnOff = Boolean(latest?.bridge?.online);
  togglingBridge = true;
  setBusy(btn, true);
  setLabel(btn, turnOff ? 'Apagando\u2026' : 'Iniciando\u2026');
  try {
    const res = await api(turnOff ? 'STOP_BRIDGE' : 'START_BRIDGE');
    toast(turnOff ? 'Puente apagado.' : (res.configError ? 'Puente iniciado, pero servers.json tiene un error.' : 'Puente iniciado \u2713'), 4200);
  } catch (err) {
    toast(err.message, 7000);
  } finally {
    togglingBridge = false;
    setBusy(btn, false);
    await refresh(true);
  }
});
$('#restart-bridge').addEventListener('click', async (event) => {
  if (restarting) return;
  const btn = event.currentTarget;
  restarting = true;
  setBusy(btn, true);
  setLabel(btn, 'Reiniciando…');
  try {
    const res = await api('RESTART_BRIDGE');
    toast(res.configError ? 'Puente reiniciado, pero servers.json tiene un error.' : 'Puente reiniciado ✓', 4200);
  } catch (err) {
    toast(err.message, 7000);
  } finally {
    restarting = false;
    setBusy(btn, false);
    setLabel(btn, 'Reiniciar puente');
    await refresh(true);
  }
});

// ───────────────────────── Servidores ─────────────────────────

const cards = new Map();        // id → { li, els, server }
const demoOutputs = new Map();  // id → { ok, text }

/** Selector de 3 estados: Permitir siempre · Preguntar siempre · No permitir. */
function permSelect(onChange, label) {
  const select = document.createElement('select');
  select.className = 'perm';
  select.setAttribute('aria-label', label);
  for (const perm of PERMISSIONS) select.append(new Option(PERMISSION_LABELS[perm], perm));
  select.addEventListener('change', guard(() => onChange(select.value)));
  return select;
}

function buildCard(server) {
  const card = { server, els: {} };
  const li = document.createElement('li');
  li.className = 'server';

  const toggle = document.createElement('label');
  toggle.className = 'switch';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.addEventListener('change', guard(() => api('TOGGLE_SERVER', { id: card.server.id, enabled: checkbox.checked })));
  toggle.append(checkbox, document.createElement('span'));

  const info = document.createElement('div');
  info.className = 'info';
  const name = document.createElement('div');
  name.className = 'name';
  const dot = document.createElement('i');
  const title = document.createElement('span');
  title.className = 'title';
  const manual = document.createElement('span');
  manual.className = 'badge';
  manual.textContent = 'manual';
  manual.title = 'Añadido a mano en versiones anteriores (no viene de servers.json)';
  const demo = document.createElement('span');
  demo.className = 'badge demo';
  demo.textContent = 'demo';
  demo.title = 'Servidor de prueba incluido con la extensión';
  name.append(dot, title, manual, demo);
  const meta = document.createElement('div');
  meta.className = 'meta';

  const tools = document.createElement('div');
  tools.className = 'tools';
  const select = permSelect((value) => api('SET_PERMISSION', { id: card.server.id, permission: value }), `Permiso de ${server.name}`);
  const test = document.createElement('button');
  test.type = 'button';
  test.className = 'test-btn';
  test.innerHTML = `${ICONS.play}<span>Probar</span>`;
  test.title = 'Ejecuta info_sistema: te muestra datos reales de tu equipo (lo activa si hace falta)';
  test.addEventListener('click', () => runDemo(card));
  tools.append(select, test);
  info.append(name, meta, tools);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'icon-btn danger';
  remove.innerHTML = ICONS.trash;
  remove.title = 'Quitar de la extensión';
  remove.setAttribute('aria-label', 'Quitar de la extensión');
  remove.dataset.armed = '¿Seguro?';
  remove.addEventListener('click', () => {
    if (!remove.classList.contains('armed')) { // primer clic: pide confirmación en el propio botón
      remove.classList.add('armed');
      clearTimeout(remove.timer);
      remove.timer = setTimeout(() => remove.classList.remove('armed'), 2600);
      return;
    }
    clearTimeout(remove.timer);
    guard(() => api('REMOVE_SERVER', { id: card.server.id }))();
  });
  actions.append(remove);

  li.append(toggle, info, actions);
  Object.assign(card, { li, els: { toggle, checkbox, dot, title, manual, demo, meta, select, test, remove, out: null } });
  return card;
}

function updateCard(card, server, activeCount) {
  card.server = server;
  const { li, els } = card;
  li.classList.toggle('on', server.enabled);

  els.toggle.title = server.enabled ? 'Desactivar' : 'Activar';
  els.checkbox.checked = server.enabled;
  els.checkbox.disabled = !server.enabled && activeCount >= MAX_ACTIVE_SERVERS;
  els.checkbox.setAttribute('aria-label', `Activar ${server.name}`);

  const bridgeBroken = server.bridgeStatus === 'error';
  els.dot.className = `dot ${bridgeBroken ? 'error' : (server.enabled ? server.status : '')}`;
  els.title.textContent = server.name;
  els.title.title = server.name;
  els.manual.hidden = Boolean(server.auto);
  els.demo.hidden = !isDemo(server);
  els.remove.parentElement.hidden = Boolean(server.auto); // los de servers.json se quitan editando el archivo

  let meta;
  if (bridgeBroken) meta = `${server.url} · El puente no pudo abrirlo: ${server.bridgeError ?? 'error'}`;
  else if (server.permission === 'deny') meta = `${server.url} · Bloqueado (no se describe a la IA)`;
  else if (server.enabled) {
    meta = `${server.url} · ${STATUS_TEXT[server.status] ?? server.status}${server.status === 'connected' ? ` · ${server.toolCount} herramientas` : ''}`;
  } else meta = server.url;
  els.meta.textContent = meta;
  els.meta.classList.toggle('err', bridgeBroken);
  els.meta.title = server.enabled && server.error && server.status !== 'connected' ? server.error : '';

  if (document.activeElement !== els.select) els.select.value = server.permission;
  els.select.dataset.perm = server.permission;
  els.test.hidden = !isDemo(server);

  const out = demoOutputs.get(server.id);
  if (out) {
    if (!els.out) {
      els.out = document.createElement('div');
      els.out.className = 'demo-out';
      els.out.title = 'Clic para ocultar';
      els.out.append(document.createElement('pre'));
      els.out.addEventListener('click', () => { demoOutputs.delete(card.server.id); updateCard(card, card.server, activeCount); });
      li.append(els.out);
    }
    els.out.classList.toggle('bad', !out.ok);
    els.out.firstChild.textContent = out.text;
  } else if (els.out) {
    els.out.remove();
    els.out = null;
  }
}

/** Prueba rápida: activa el demo si hace falta y ejecuta info_sistema. */
async function runDemo(card) {
  const btn = card.els.test;
  btn.disabled = true;
  try {
    if (!card.server.enabled) await api('TOGGLE_SERVER', { id: card.server.id, enabled: true });
    const res = await api('CALL_TOOL', { server: card.server.slug ?? card.server.name, name: DEMO_TOOL, arguments: {} });
    const text = (res.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    demoOutputs.set(card.server.id, { ok: !res.result?.isError, text: text || 'El servidor respondió sin texto.' });
  } catch (err) {
    const hint = /no existe|no está conectado/.test(err.message) ? '\nReinicia el puente para cargar la demo actualizada.' : '';
    demoOutputs.set(card.server.id, { ok: false, text: err.message + hint });
  } finally {
    btn.disabled = false;
    await refresh(true);
  }
}

function renderServers(state) {
  const list = $('#server-list');
  const active = state.servers.filter((s) => s.enabled);

  $('#counter').textContent = `${active.length}/${MAX_ACTIVE_SERVERS} activos`;
  const tokens = active.reduce((sum, s) => sum + s.approxTokens, 0);
  $('#tokens').textContent = active.length ? `≈ ${tokens.toLocaleString('es')} tokens de herramientas` : '';

  const warning = $('#warning');
  warning.hidden = active.length <= RECOMMENDED_ACTIVE_SERVERS;
  warning.textContent = `Tienes ${active.length} MCP activos. Cada herramienta ocupa contexto de la IA y puede saturarlo. Lo recomendable es 1 a la vez.`;
  $('#empty').hidden = state.servers.length > 0;

  const seen = new Set();
  state.servers.forEach((server, index) => {
    seen.add(server.id);
    let card = cards.get(server.id);
    if (!card) {
      card = buildCard(server);
      cards.set(server.id, card);
      card.li.classList.add('enter');
      card.li.style.setProperty('--i', index);
      card.li.addEventListener('animationend', (e) => { if (e.target === card.li) card.li.classList.remove('enter'); });
    }
    updateCard(card, server, active.length);
    if (list.children[index] !== card.li) list.insertBefore(card.li, list.children[index] ?? null);
  });
  for (const [id, card] of cards) {
    if (seen.has(id)) continue;
    cards.delete(id);
    card.li.classList.add('leaving');
    setTimeout(() => card.li.remove(), 260);
  }
}

/** Selector global: muestra «Mixto» si los MCP tienen permisos distintos. */
function renderGlobalPermission(servers) {
  const select = $('#perm-all');
  const perms = new Set(servers.map((s) => s.permission));
  const value = perms.size === 1 ? [...perms][0] : (perms.size === 0 ? 'ask' : 'mixed');
  select.value = value;
  select.dataset.perm = value;
  $('#perm-all').closest('.perm-all').hidden = servers.length === 0;
  $('#perm-hint').textContent = {
    allow: 'Los tienes todos permitidos: no se pregunta nada.',
    ask: 'Se pregunta en cada llamada de la IA.',
    deny: 'Todos bloqueados: la IA no recibe ninguna herramienta.',
    mixed: 'Cada MCP tiene un permiso distinto.',
  }[value];
}
$('#perm-all').addEventListener('change', guard((e) => api('SET_ALL_PERMISSIONS', { permission: e.target.value })));

// ───────────────────────── Avisos ─────────────────────────

const LEVEL_TEXT = { info: 'Novedad', update: 'Versión nueva', warning: 'Importante' };
let noticesSig = '';

function renderNotices(state) {
  const data = state.notices ?? { items: [], unread: 0 };
  const badge = $('#notices-badge');
  badge.hidden = !data.unread;
  badge.textContent = data.unread > 9 ? '9+' : String(data.unread);

  const sig = JSON.stringify([data.items, data.checkedAt, data.error]);
  if (sig === noticesSig) return;
  noticesSig = sig;

  const list = $('#notice-list');
  list.replaceChildren();
  $('#notices-empty').hidden = data.items.length > 0;
  $('#read-all').hidden = !data.unread;

  for (const n of data.items) {
    const li = document.createElement('li');
    li.className = `notice ${n.level}${n.unread ? ' unread' : ''}`;
    const title = document.createElement('div');
    title.className = 'n-title';
    title.textContent = n.title;
    const date = document.createElement('div');
    date.className = 'n-date';
    date.textContent = [LEVEL_TEXT[n.level], n.date ? new Date(n.date).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' }) : null].filter(Boolean).join(' · ');
    li.append(title, date);
    if (n.message) {
      const msg = document.createElement('div');
      msg.className = 'n-msg';
      msg.textContent = n.message;
      li.append(msg);
    }
    const actions = document.createElement('div');
    actions.className = 'n-actions';
    if (n.url) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'primary small';
      open.textContent = 'Ver en GitHub';
      open.addEventListener('click', guard(async () => { openLink(n.url); await api('READ_NOTICES', { ids: [n.id] }); }));
      actions.append(open);
    }
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'soft small';
    dismiss.textContent = 'Descartar';
    dismiss.addEventListener('click', guard(() => api('DISMISS_NOTICE', { id: n.id })));
    actions.append(dismiss);
    li.append(actions);
    list.append(li);
  }

  const when = data.checkedAt ? `Revisado ${new Date(data.checkedAt).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })}` : 'Aún sin revisar';
  $('#notices-line').textContent = data.error ? `${data.error}` : when;
}
$('#read-all').addEventListener('click', guard(() => api('READ_NOTICES', { ids: 'all' })));
$('#check-notices').addEventListener('click', async (event) => {
  const btn = event.currentTarget;
  setBusy(btn, true);
  try {
    const res = await api('CHECK_NOTICES');
    toast(res.count ? `Hay ${res.count} aviso${res.count === 1 ? '' : 's'} vigente${res.count === 1 ? '' : 's'}.` : 'No hay avisos nuevos.');
  } catch (err) { toast(err.message, 5000); }
  setBusy(btn, false);
  noticesSig = '';
  await refresh(true);
});

// ───────────────────────── Historial ─────────────────────────

let historySig = '';
async function renderHistory() {
  const { history } = await api('GET_HISTORY');
  const sig = JSON.stringify(history);
  if (sig === historySig) return;
  historySig = sig;
  const list = $('#history-list');
  list.replaceChildren();
  $('#history-empty').hidden = history.length > 0;
  history.forEach((h, index) => {
    const li = document.createElement('li');
    li.style.setProperty('--i', Math.min(index, 10));
    const row = document.createElement('div');
    row.className = 'row';
    const title = document.createElement('span');
    title.textContent = `${h.server} · ${h.tool}`;
    const status = document.createElement('span');
    status.className = h.status;
    status.textContent = h.status === 'ok' ? `OK${h.ms ? ` · ${h.ms} ms` : ''}` : 'Error';
    row.append(title, status);
    const detail = document.createElement('small');
    detail.textContent = `${new Date(h.ts).toLocaleTimeString('es')} · ${h.error ?? h.args}`;
    li.append(row, detail);
    list.append(li);
  });
}
$('#clear-history').addEventListener('click', guard(async () => { await api('CLEAR_HISTORY'); historySig = ''; }));

// ───────────────────────── Ajustes ─────────────────────────

function renderSettings(state) {
  const { settings } = state;
  $('#master').checked = settings.bridgeEnabled;
  $('#master-label').textContent = settings.bridgeEnabled ? 'Activado' : 'Desactivado';
  $('#main').classList.toggle('off', !settings.bridgeEnabled);
  if (document.activeElement?.id !== 'set-maxResultChars') $('#set-maxResultChars').value = settings.maxResultChars;
  $('#set-autoInject').checked = settings.autoInject;
  $('#set-autoSend').checked = settings.autoSend;
  $('#set-reminder').checked = settings.reminder;
  $('#set-autoDiscover').checked = settings.autoDiscover !== false;
  $('#set-autoEnableDiscovered').checked = Boolean(settings.autoEnableDiscovered);
  $('#set-focusFallback').checked = settings.focusFallback;
  $('#set-showNotices').checked = settings.showNotices !== false;
  if (document.activeElement?.id !== 'set-reinjectEvery') $('#set-reinjectEvery').value = settings.reinjectEvery;

  $('#version').textContent = state.version ? `v${state.version}` : '';
  $('#version-line').textContent = state.version ? `Web MCP Bridge v${state.version}` : '';
}

$('#gh-link').addEventListener('click', (e) => { e.preventDefault(); openLink('https://github.com/AstraxOf'); });

$('#master').addEventListener('change', guard((e) => api('UPDATE_SETTINGS', { settings: { bridgeEnabled: e.target.checked } })));

for (const key of ['autoInject', 'autoSend', 'reminder', 'focusFallback', 'autoDiscover', 'autoEnableDiscovered', 'showNotices']) {
  $(`#set-${key}`).addEventListener('change', guard((e) => api('UPDATE_SETTINGS', { settings: { [key]: e.target.checked } })));
}
$('#set-reinjectEvery').addEventListener('change', guard((e) => {
  const value = Math.min(100, Math.max(0, Math.round(Number(e.target.value)) || 0));
  return api('UPDATE_SETTINGS', { settings: { reinjectEvery: value } });
}));
$('#discover-now').addEventListener('click', guard(async () => {
  const res = await api('DISCOVER', { reset: true });
  toast(res.added ? `Detectados ${res.added} servidor(es) nuevo(s).` : 'Servidores al día.');
}));
$('#set-maxResultChars').addEventListener('change', guard((e) => {
  const value = Math.min(100000, Math.max(500, Number(e.target.value) || 12000));
  return api('UPDATE_SETTINGS', { settings: { maxResultChars: value } });
}));

// ───────────────────────── Pestañas y refresco ─────────────────────────

let selectFocusedAt = 0;
document.addEventListener('focusin', (e) => { if (e.target.matches?.('select')) selectFocusedAt = Date.now(); });

const tabsBar = $('.tabs');
const ink = $('.tab-ink');
function moveInk() {
  const selected = tabsBar.querySelector('[aria-selected="true"]');
  if (!selected) return;
  ink.style.width = `${selected.offsetWidth}px`;
  ink.style.transform = `translateX(${selected.offsetLeft}px)`;
}
moveInk();
requestAnimationFrame(() => requestAnimationFrame(() => tabsBar.classList.add('ready')));

let currentTab = 'servers';
for (const btn of document.querySelectorAll('.tabs button')) {
  btn.addEventListener('click', () => {
    currentTab = btn.dataset.tab;
    for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b === btn));
    for (const section of document.querySelectorAll('main > section')) section.hidden = section.id !== `tab-${currentTab}`;
    moveInk();
    historySig = '';
    refresh(true);
  });
}

let lastSig = '';
async function refresh(force = false) {
  // No re-renderizar mientras el usuario escribe en un campo.
  if (!force && document.activeElement?.matches('input[type="text"], input[type="number"]')) return;
  if (!force && document.activeElement?.matches('select') && Date.now() - selectFocusedAt < 6000) return; // solo unos segundos
  try {
    const state = await api('GET_STATE');
    latest = state;
    const sig = JSON.stringify([state.version, state.notices, state.settings, state.bridge,
      state.servers.map((s) => [s.id, s.name, s.url, s.enabled, s.permission, s.status, s.toolCount, s.auto, s.error, s.bridgeStatus, s.bridgeError])]);
    if (force || sig !== lastSig) {
      lastSig = sig;
      renderBridge(state);
      renderServers(state);
      renderGlobalPermission(state.servers);
      renderSettings(state);
      renderNotices(state);
    }
    if (currentTab === 'history') await renderHistory();
  } catch (err) { toast(err.message); }
}

refresh(true);
setInterval(refresh, 1500);
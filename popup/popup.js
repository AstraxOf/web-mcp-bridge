/**
 * popup.js - Panel de control de la extensión.
 *
 * Los servidores MCP se definen en server/servers.json (la extensión los detecta sola): aquí solo se activan,
 * se les da permiso y se prueban. Desde el panel se puede abrir ese archivo y reiniciar el puente.
 * Las tarjetas se reutilizan entre refrescos (no se recrean), así las transiciones se animan en lugar de saltar.
 */
import { MAX_ACTIVE_SERVERS, RECOMMENDED_ACTIVE_SERVERS, PERMISSIONS, DEMO_SERVER } from '../shared/constants.js';

const WMB = globalThis.WMB; // shared/i18n.js (script clásico que se carga antes que este módulo)
const t = (key, vars) => WMB.t(key, vars);
const tp = (key, n, vars) => WMB.tp(key, n, vars);
const loc = () => (WMB.i18n.getLang() === 'es' ? 'es' : 'en');
const $ = (selector, root = document) => root.querySelector(selector);
const statusText = (status) => (['connected', 'connecting', 'disconnected', 'error'].includes(status) ? t(`st.${status}`) : status);
const DEMO_TOOL = 'system_info';

const ICONS = {
  trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>',
  power: '<svg viewBox="0 0 24 24"><path d="M12 3v9"/><path d="M6.4 6.6a8 8 0 1 0 11.2 0"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>',
};
for (const el of document.querySelectorAll('.ico[data-ico]')) el.innerHTML = ICONS[el.dataset.ico] ?? '';

/** Envía un mensaje al service worker y lanza excepción si la respuesta no es ok. */
async function api(type, payload = {}) {
  let res;
  try { res = await chrome.runtime.sendMessage({ type, ...payload }); } catch (err) { throw new Error(err.message); }
  if (!res?.ok) throw new Error(res?.error ?? t('common.unknownError'));
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
    title.textContent = t('p.bridge.checking');
    sub.textContent = '';
  } else if (b.online) {
    dot.className = 'dot online';
    title.textContent = t('p.bridge.online');
    const listening = state.servers.filter((s) => s.bridgeStatus === 'listening').length;
    sub.textContent = tp('p.bridge.sub', listening, { v: b.version ?? '?' });
  } else {
    dot.className = 'dot offline';
    title.textContent = t('p.bridge.offline');
    sub.textContent = t('p.bridge.offlineSub');
  }

  cfgErr.hidden = !(b.online && b.configError);
  if (!cfgErr.hidden) cfgErr.textContent = t('p.bridge.configError', { error: b.configError });

  hint.hidden = !(b.checked && !b.online);
  if (!hint.hidden) {
    if (b.launcherOnline) hint.textContent = t(b.paused ? 'p.bridge.hintPaused' : 'p.bridge.hintCrashed');
    else hint.innerHTML = t('p.bridge.hintNoLauncher'); // texto propio del diccionario (no viene de fuera)
  }

  const toggle = $('#toggle-bridge');
  if (!togglingBridge) {
    setLabel(toggle, t(b.online ? 'p.bridge.stop' : 'p.bridge.start'));
    toggle.disabled = !b.checked || !b.launcherOnline;
    toggle.title = b.launcherOnline ? t(b.online ? 'p.bridge.tipStop' : 'p.bridge.tipStart') : t('p.bridge.tipNeedLauncher');
  }

  const restart = $('#restart-bridge');
  if (!restarting) {
    restart.disabled = !b.checked || (!b.online && !b.launcherOnline);
    setLabel(restart, t(b.online ? 'p.bridge.restart' : 'p.bridge.startRestart'));
    restart.title = (!b.online && !b.launcherOnline) ? t('p.bridge.tipNeedLauncher') : t('p.bridge.tipRestart');
  }
  $('#open-config').title = b.config ? t('p.bridge.openConfigTip', { path: b.config }) : t('p.bridge.openConfigGeneric');
}

$('#open-config').addEventListener('click', async (event) => {
  if (opening) return;
  opening = true;
  setBusy(event.currentTarget, true);
  try {
    await api('OPEN_CONFIG');
    toast(t('p.toast.opening'));
  } catch (err) {
    const path = latest?.bridge?.config;
    toast(path && !err.message.includes(path) ? t('p.toast.file', { error: err.message, path }) : err.message, 6500);
  } finally {
    opening = false;
    setBusy(event.currentTarget, false);
  }
});

$('#open-editor').addEventListener('click', async () => {
  const url = chrome.runtime.getURL('editor/editor.html');
  try {
    const [existing] = await chrome.tabs.query({ url });
    if (existing) { await chrome.tabs.update(existing.id, { active: true }); await chrome.windows.update(existing.windowId, { focused: true }); window.close(); return; }
  } catch { /* sin permiso para consultar pestañas: se abre una nueva */ }
  chrome.tabs.create({ url });
  window.close();
});

$('#toggle-bridge').addEventListener('click', async (event) => {
  if (togglingBridge) return;
  const btn = event.currentTarget;
  const turnOff = Boolean(latest?.bridge?.online);
  togglingBridge = true;
  setBusy(btn, true);
  setLabel(btn, t(turnOff ? 'p.bridge.stopping' : 'p.bridge.starting'));
  try {
    const res = await api(turnOff ? 'STOP_BRIDGE' : 'START_BRIDGE');
    toast(turnOff ? t('p.toast.stopped') : t(res.configError ? 'p.toast.startedErr' : 'p.toast.started'), 4200);
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
  setLabel(btn, t('p.bridge.restarting'));
  try {
    const res = await api('BRIDGE_GLOBAL', { action: 'restart' });
    toast(t(res.configError ? 'p.toast.restartedErr' : 'p.toast.restarted'), 4200);
  } catch (err) {
    toast(err.message, 7000);
  } finally {
    restarting = false;
    setBusy(btn, false);
    setLabel(btn, t(latest?.bridge?.online ? 'p.bridge.restart' : 'p.bridge.startRestart'));
    await refresh(true);
  }
});

// ───────────────────────── Servidores ─────────────────────────

const cards = new Map();        // id → { li, els, server }
const demoOutputs = new Map();  // id → { ok, text }

/** Selector de 3 estados: Permitir siempre · Preguntar siempre · No permitir. */
function permSelect(onChange) {
  const select = document.createElement('select');
  select.className = 'perm';
  for (const perm of PERMISSIONS) select.append(new Option(t(`perm.${perm}`), perm));
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
  const demo = document.createElement('span');
  demo.className = 'badge demo';
  name.append(dot, title, manual, demo);
  const meta = document.createElement('div');
  meta.className = 'meta';

  const tools = document.createElement('div');
  tools.className = 'tools';
  const select = permSelect((value) => api('SET_PERMISSION', { id: card.server.id, permission: value }));
  const test = document.createElement('button');
  test.type = 'button';
  test.className = 'test-btn';
  test.innerHTML = `${ICONS.play}<span></span>`;
  test.addEventListener('click', () => runDemo(card));
  tools.append(select, test);
  info.append(name, meta, tools);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'icon-btn danger';
  remove.innerHTML = ICONS.trash;
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

  els.toggle.title = t(server.enabled ? 'p.srv.deactivate' : 'p.srv.activate');
  els.checkbox.checked = server.enabled;
  els.checkbox.disabled = !server.enabled && activeCount >= MAX_ACTIVE_SERVERS;
  els.checkbox.setAttribute('aria-label', t('p.srv.activateAria', { name: server.name }));

  const bridgeBroken = server.bridgeStatus === 'error';
  els.dot.className = `dot ${bridgeBroken ? 'error' : (server.enabled ? server.status : '')}`;
  els.title.textContent = server.name;
  els.title.title = server.name;
  els.manual.textContent = t('p.srv.manual');
  els.manual.title = t('p.srv.manualTip');
  els.manual.hidden = Boolean(server.auto);
  els.demo.textContent = t('p.srv.demo');
  els.demo.title = t('p.srv.demoTip');
  els.demo.hidden = !isDemo(server);
  els.remove.parentElement.hidden = Boolean(server.auto); // los de servers.json se quitan editando el archivo
  els.remove.title = t('p.srv.remove');
  els.remove.setAttribute('aria-label', t('p.srv.remove'));
  els.remove.dataset.armed = t('p.srv.sure');

  let meta;
  if (bridgeBroken) meta = `${server.url} · ${t('p.srv.bridgeBroken', { error: server.bridgeError ?? t('p.srv.errorWord') })}`;
  else if (server.permission === 'deny') meta = `${server.url} · ${t('p.srv.blocked')}`;
  else if (server.enabled) {
    meta = `${server.url} · ${statusText(server.status)}${server.status === 'connected' ? ` · ${t('p.srv.toolsCount', { n: server.toolCount })}` : ''}`;
  } else meta = server.url;
  els.meta.textContent = meta;
  els.meta.classList.toggle('err', bridgeBroken);
  els.meta.title = server.enabled && server.error && server.status !== 'connected' ? server.error : '';

  [...els.select.options].forEach((option) => { option.textContent = t(`perm.${option.value}`); });
  els.select.setAttribute('aria-label', t('p.srv.permAria', { name: server.name }));
  if (document.activeElement !== els.select) els.select.value = server.permission;
  els.select.dataset.perm = server.permission;
  els.test.hidden = !isDemo(server);
  els.test.querySelector('span').textContent = t('p.srv.test');
  els.test.title = t('p.srv.testTip');

  const out = demoOutputs.get(server.id);
  if (out) {
    if (!els.out) {
      els.out = document.createElement('div');
      els.out.className = 'demo-out';
      els.out.title = t('common.close');
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

/** Prueba rápida: activa el demo si hace falta y ejecuta system_info. */
async function runDemo(card) {
  const btn = card.els.test;
  btn.disabled = true;
  try {
    if (!card.server.enabled) await api('TOGGLE_SERVER', { id: card.server.id, enabled: true });
    const res = await api('CALL_TOOL', { server: card.server.slug ?? card.server.name, name: DEMO_TOOL, arguments: {} });
    const text = (res.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    demoOutputs.set(card.server.id, { ok: !res.result?.isError, text: text || t('p.srv.demoNoText') });
  } catch (err) {
    const hint = /no existe|no está conectado|doesn't exist|not connected/i.test(err.message) ? `\n${t('p.srv.demoRestart')}` : '';
    demoOutputs.set(card.server.id, { ok: false, text: err.message + hint });
  } finally {
    btn.disabled = false;
    await refresh(true);
  }
}

function renderServers(state) {
  const list = $('#server-list');
  const active = state.servers.filter((s) => s.enabled);

  $('#counter').textContent = t('p.srv.active', { n: active.length, max: MAX_ACTIVE_SERVERS });
  const tokens = active.reduce((sum, s) => sum + s.approxTokens, 0);
  $('#tokens').textContent = active.length ? t('p.srv.tokens', { n: tokens.toLocaleString(loc()) }) : '';

  const warning = $('#warning');
  warning.hidden = active.length <= RECOMMENDED_ACTIVE_SERVERS;
  warning.textContent = t('p.srv.warn', { n: active.length });
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
  $('#perm-hint').textContent = t({ allow: 'p.srv.hintAllow', ask: 'p.srv.hintAsk', deny: 'p.srv.hintDeny', mixed: 'p.srv.hintMixed' }[value]);
}
$('#perm-all').addEventListener('change', guard((e) => api('SET_ALL_PERMISSIONS', { permission: e.target.value })));

// ───────────────────────── Avisos ─────────────────────────

let noticesSig = '';

function renderNotices(state) {
  const data = state.notices ?? { items: [], unread: 0 };
  const badge = $('#notices-badge');
  badge.hidden = !data.unread;
  badge.textContent = data.unread > 9 ? '9+' : String(data.unread);

  const sig = JSON.stringify([data.items, data.checkedAt, data.error, loc()]);
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
    date.textContent = [t(`p.nt.lvl.${n.level}`), n.date ? new Date(n.date).toLocaleDateString(loc(), { day: 'numeric', month: 'short', year: 'numeric' }) : null].filter(Boolean).join(' · ');
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
      open.textContent = t('p.nt.viewGithub');
      open.addEventListener('click', guard(async () => { openLink(n.url); await api('READ_NOTICES', { ids: [n.id] }); }));
      actions.append(open);
    }
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'soft small';
    dismiss.textContent = t('p.nt.dismiss');
    dismiss.addEventListener('click', guard(() => api('DISMISS_NOTICE', { id: n.id })));
    actions.append(dismiss);
    li.append(actions);
    list.append(li);
  }

  const when = data.checkedAt ? t('p.nt.checked', { when: new Date(data.checkedAt).toLocaleString(loc(), { dateStyle: 'short', timeStyle: 'short' }) }) : t('p.nt.never');
  $('#notices-line').textContent = data.error ? `${data.error}` : when;
}
$('#read-all').addEventListener('click', guard(() => api('READ_NOTICES', { ids: 'all' })));
$('#check-notices').addEventListener('click', async (event) => {
  const btn = event.currentTarget;
  setBusy(btn, true);
  try {
    const res = await api('CHECK_NOTICES');
    toast(res.count ? tp('p.nt.found', res.count) : t('p.nt.none'));
  } catch (err) { toast(err.message, 5000); }
  setBusy(btn, false);
  noticesSig = '';
  await refresh(true);
});

// ───────────────────────── Historial ─────────────────────────

let historySig = '';
async function renderHistory() {
  const { history } = await api('GET_HISTORY');
  const sig = JSON.stringify([history, loc()]);
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
    status.textContent = h.status === 'ok' ? `OK${h.ms ? ` · ${h.ms} ms` : ''}` : t('p.hs.error');
    row.append(title, status);
    const detail = document.createElement('small');
    detail.textContent = `${new Date(h.ts).toLocaleTimeString(loc())} · ${h.error ?? h.args}`;
    li.append(row, detail);
    list.append(li);
  });
}
$('#clear-history').addEventListener('click', guard(async () => { await api('CLEAR_HISTORY'); historySig = ''; }));

// ───────────────────────── Ajustes ─────────────────────────

const SUN = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

function renderSettings(state) {
  const { settings } = state;
  $('#master').checked = settings.bridgeEnabled;
  $('#master-label').textContent = t(settings.bridgeEnabled ? 'common.on' : 'common.off');
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
  if (document.activeElement?.id !== 'set-responseDelaySec') $('#set-responseDelaySec').value = (settings.responseDelayMs ?? 1500) / 1000;
  if (document.activeElement?.id !== 'set-language') $('#set-language').value = settings.language ?? 'en';
  if (document.activeElement?.id !== 'set-theme') $('#set-theme').value = settings.theme ?? 'dark';

  // Cabecera: idioma y tema
  for (const btn of document.querySelectorAll('#lang-seg button')) {
    const on = btn.dataset.lang === (settings.language ?? 'en');
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  const light = settings.theme === 'light';
  const themeBtn = $('#theme-btn');
  themeBtn.innerHTML = light ? MOON : SUN;
  themeBtn.title = t(light ? 'theme.toDark' : 'theme.toLight');
  themeBtn.setAttribute('aria-label', themeBtn.title);

  $('#version').textContent = state.version ? `v${state.version}` : '';
  $('#version-line').textContent = state.version ? `Web MCP Bridge v${state.version}` : '';
}

$('#gh-link').addEventListener('click', (e) => { e.preventDefault(); openLink('https://github.com/AstraxOf'); });
$('#open-guide').addEventListener('click', () => { chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html?guide=1') }); window.close(); });

$('#master').addEventListener('change', guard((e) => api('UPDATE_SETTINGS', { settings: { bridgeEnabled: e.target.checked } })));

/** Idioma y tema se aplican al instante (sin esperar al service worker) y luego se guardan. */
async function chooseLanguage(code) {
  WMB.i18n.setLang(code);
  applyStatic();
  await api('UPDATE_SETTINGS', { settings: { language: code, languageChosen: true } });
}
async function chooseTheme(value) {
  WMB.i18n.setTheme(value);
  await api('UPDATE_SETTINGS', { settings: { theme: value } });
}
for (const btn of document.querySelectorAll('#lang-seg button')) btn.addEventListener('click', guard(() => chooseLanguage(btn.dataset.lang)));
$('#theme-btn').addEventListener('click', guard(() => chooseTheme(latest?.settings?.theme === 'light' ? 'dark' : 'light')));
$('#set-language').addEventListener('change', guard((e) => chooseLanguage(e.target.value)));
$('#set-theme').addEventListener('change', guard((e) => chooseTheme(e.target.value)));

for (const key of ['autoInject', 'autoSend', 'reminder', 'focusFallback', 'autoDiscover', 'autoEnableDiscovered', 'showNotices']) {
  $(`#set-${key}`).addEventListener('change', guard((e) => api('UPDATE_SETTINGS', { settings: { [key]: e.target.checked } })));
}
$('#set-reinjectEvery').addEventListener('change', guard((e) => {
  const value = Math.min(100, Math.max(0, Math.round(Number(e.target.value)) || 0));
  return api('UPDATE_SETTINGS', { settings: { reinjectEvery: value } });
}));
$('#set-responseDelaySec').addEventListener('change', guard((e) => {
  const seconds = Math.min(60, Math.max(0, Number(e.target.value) || 0));
  return api('UPDATE_SETTINGS', { settings: { responseDelayMs: Math.round(seconds * 1000) } });
}));
$('#discover-now').addEventListener('click', guard(async () => {
  const res = await api('DISCOVER', { reset: true });
  toast(res.added ? t('p.set.foundNew', { n: res.added }) : t('p.set.upToDate'));
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
let lastLang = '';

/** Pinta los textos estáticos del HTML en el idioma activo y recoloca la tinta de las pestañas. */
function applyStatic() {
  WMB.i18n.apply();
  const label = (btn, text) => { if (!btn.disabled || !btn.classList.contains('busy')) setLabel(btn, text); };
  if (!togglingBridge) label($('#toggle-bridge'), t(latest?.bridge?.online ? 'p.bridge.stop' : 'p.bridge.start'));
  if (!restarting) label($('#restart-bridge'), t(latest?.bridge?.online ? 'p.bridge.restart' : 'p.bridge.startRestart'));
  $('#bridge-title').textContent = $('#bridge-title').textContent || t('p.bridge.checking');
  requestAnimationFrame(moveInk);
}

async function refresh(force = false) {
  // No re-renderizar mientras el usuario escribe en un campo.
  if (!force && document.activeElement?.matches('input[type="text"], input[type="number"]')) return;
  if (!force && document.activeElement?.matches('select') && Date.now() - selectFocusedAt < 6000) return; // solo unos segundos
  try {
    const state = await api('GET_STATE');
    latest = state;
    WMB.i18n.setLang(state.settings.language);
    WMB.i18n.setTheme(state.settings.theme);
    const sig = JSON.stringify([state.version, state.notices, state.settings, state.bridge,
      state.servers.map((s) => [s.id, s.name, s.url, s.enabled, s.permission, s.status, s.toolCount, s.auto, s.error, s.bridgeStatus, s.bridgeError])]);
    if (force || sig !== lastSig) {
      lastSig = sig;
      if (lastLang !== state.settings.language) { lastLang = state.settings.language; applyStatic(); }
      renderBridge(state);
      renderServers(state);
      renderGlobalPermission(state.servers);
      renderSettings(state);
      renderNotices(state);
    }
    if (currentTab === 'history') await renderHistory();
  } catch (err) { toast(err.message); }
}

applyStatic();
refresh(true);
setInterval(refresh, 1500);

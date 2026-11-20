/**
 * popup.js — Interfaz de la extensión. La MISMA página funciona como ventana emergente y como panel lateral.
 *
 * Pestañas:
 *   - MCP:       estado del puente local, detectar / editar MCP, activar (máx. 5), permisos y herramientas de cada MCP.
 *   - Actividad: llamadas a herramientas y registro de eventos (filtrar, exportar, borrar).
 *   - Ajustes:   interfaz (panel lateral) y comportamiento en el chat.
 */
import { versionInfo } from '../shared/versioning.js';
import { MAX_ACTIVE_SERVERS, RECOMMENDED_ACTIVE_SERVERS, PERMISSIONS, PERMISSION_LABELS, DEMO_SERVER, PLATFORM_LABELS } from '../shared/constants.js';
import { mergeActivity, matchesFilter, CATEGORY_LABEL, fmtMs } from '../shared/activity.js';

const $ = (selector, root = document) => root.querySelector(selector);
const STATUS_TEXT = {
  connected: 'Conectado', connecting: 'Conectando…', disconnected: 'Sin conexión, reintentando', error: 'Error de conexión',
};

// ───────────────────────── Contexto: popup o panel lateral ─────────────────────────

const isPopup = (chrome.extension?.getViews?.({ type: 'popup' }) ?? []).includes(window);
document.documentElement.dataset.view = isPopup ? 'popup' : 'panel';
let windowId = null;
chrome.windows?.getCurrent?.().then((w) => { windowId = w.id; }).catch(() => {});

const store = {
  get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* sin almacenamiento */ } },
};

// ───────────────────────── Utilidades ─────────────────────────

async function api(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error ?? 'Error desconocido.');
  return res;
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3400);
}

const guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (err) { toast(err.message); }
  await refresh(true);
};

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

function icon(name, cls = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function iconButton(name, title, onClick, extra = '') {
  return el('button', { type: 'button', class: `icon-btn ${extra}`.trim(), title, 'aria-label': title, onclick: onClick }, icon(name));
}

const ago = (ts) => {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'hace un momento';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  return new Date(ts).toLocaleTimeString('es');
};

// ───────────────────────── Puente local ─────────────────────────

function renderBridge(bridge) {
  const dot = $('#bridge-dot');
  const title = $('#bridge-title');
  const detail = $('#bridge-detail');
  if (!bridge || bridge.ok === null) {
    dot.className = 'dot connecting';
    title.textContent = 'Comprobando el puente local…';
    detail.textContent = '';
  } else if (bridge.ok) {
    dot.className = 'dot ok';
    title.textContent = 'Puente local activo';
    detail.textContent = `${bridge.count} MCP configurado${bridge.count === 1 ? '' : 's'} en tu PC · ${ago(bridge.at)}`;
  } else {
    dot.className = 'dot down';
    title.textContent = 'El puente local no responde';
    detail.textContent = 'Arráncalo con scripts\\windows\\install.ps1 (después inicia solo con Windows).';
  }
  const banner = $('#config-error');
  banner.hidden = !bridge?.configError;
  banner.textContent = bridge?.configError
    ? `La configuración de MCP tiene un error y no se aplicó: ${bridge.configError}. Corrígela en «Añadir o editar MCP».`
    : '';
}

/** Pide al puente los MCP del PC y registra los nuevos (desactivados). `quiet`: sin avisos si no hay nada nuevo. */
async function discover(quiet = false) {
  const button = $('#discover');
  button.disabled = true;
  try {
    const { found, added } = await api('DISCOVER_SERVERS');
    if (added.length) toast(`Nuevos MCP: ${added.join(', ')}. Actívalos con su interruptor.`);
    else if (!quiet) toast(found ? `Sin MCP nuevos (${found} configurados).` : 'El puente no tiene MCP configurados.');
  } catch (err) {
    if (!quiet) toast(err.message);
  } finally {
    button.disabled = false;
  }
  await refresh(true);
}

// ───────────────────────── Lista de MCP ─────────────────────────

const openTools = new Set(); // MCP con la lista de herramientas desplegada (sobrevive a los refrescos)

function permSelect(value, onChange, label) {
  const select = el('select', { class: 'perm', 'aria-label': label });
  select.dataset.perm = value;
  for (const perm of PERMISSIONS) select.append(new Option(PERMISSION_LABELS[perm], perm, false, perm === value));
  select.addEventListener('change', guard(() => onChange(select.value)));
  return select;
}

function startRename(label, server) {
  const input = el('input', { type: 'text', maxlength: '40', 'aria-label': `Nuevo nombre de ${server.name}` });
  input.value = server.name;
  label.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = guard(async (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (save && value && value !== server.name) await api('RENAME_SERVER', { id: server.id, name: value });
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

/** Quita un MCP de servers.json del puente (acepta los tres formatos del archivo). Devuelve true si lo encontró. */
async function removeFromBridgeConfig(name) {
  const { content } = await api('GET_BRIDGE_CONFIG');
  const data = JSON.parse(content);
  let removed = false;
  if (Array.isArray(data.servers)) {
    const before = data.servers.length;
    data.servers = data.servers.filter((s) => s.name !== name);
    removed = data.servers.length < before;
  } else {
    const box = data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : data;
    if (Object.hasOwn(box, name)) { delete box[name]; removed = true; }
  }
  if (removed) await api('PUT_BRIDGE_CONFIG', { content: JSON.stringify(data, null, 2) });
  return removed;
}

/** Copia el comando de terminal para detener este MCP (usa la ruta real de servers.json del puente). */
async function copyStopCommand(server) {
  let script = 'server\\mcp_ctl.py';
  try {
    const { path } = await api('GET_BRIDGE_CONFIG');
    if (path) script = `${path.replace(/[\\/][^\\/]*$/, '')}\\mcp_ctl.py`;
  } catch { /* puente apagado: se deja la ruta relativa */ }
  const command = `py -3 "${script}" stop "${server.name}"`;
  try {
    await navigator.clipboard.writeText(command);
    toast('Comando copiado: pégalo en PowerShell. Con «start» lo reanudas y con «remove» lo quitas.');
  } catch {
    prompt('Copia este comando y pégalo en PowerShell:', command);
  }
}

function renderServer(server, activeCount) {
  const blocked = server.permission === 'deny';
  const li = el('li', { class: `server${server.enabled ? ' on' : ''}` });

  const checkbox = el('input', { type: 'checkbox', 'aria-label': `Activar ${server.name}` });
  checkbox.checked = server.enabled;
  checkbox.disabled = !server.enabled && activeCount >= MAX_ACTIVE_SERVERS;
  checkbox.addEventListener('change', guard(() => api('TOGGLE_SERVER', { id: server.id, enabled: checkbox.checked })));
  const toggle = el('label', { class: 'switch', title: server.enabled ? 'Desactivar' : (checkbox.disabled ? `Máximo ${MAX_ACTIVE_SERVERS} activos` : 'Activar') }, checkbox, el('span'));

  const label = el('span', { text: server.name });
  const idChip = server.slug && server.slug !== server.name ? el('code', { class: 'slug', title: 'Id que usa la IA en sus llamadas', text: server.slug }) : null;
  const name = el('div', { class: 'name' }, el('i', { class: `dot ${server.enabled ? server.status : ''}` }), label, idChip);
  let metaText = server.url;
  if (blocked) metaText += ' · Bloqueado: la IA no lo ve';
  else if (server.enabled) metaText += ` · ${STATUS_TEXT[server.status] ?? server.status}`;
  const info = el('div', { class: 'grow' }, name, el('div', { class: 'meta', text: metaText }));
  if (server.enabled && server.error && server.status !== 'connected') info.append(el('div', { class: 'error-detail', text: server.error }));

  const actions = el('div', { class: 'actions' },
    iconButton('edit', 'Renombrar', () => startRename(label, server)),
    server.managed ? iconButton('terminal', 'Copiar el comando para detenerlo desde PowerShell', () => copyStopCommand(server).catch((err) => toast(err.message))) : null,
    iconButton('trash', server.managed ? 'Quitar (también de servers.json)' : 'Quitar de la extensión', guard(async () => {
      if (server.managed) {
        if (!confirm(`«${server.name}» viene de servers.json del puente: si solo lo quitas de la extensión, «Detectar» lo vuelve a añadir.\n\nAceptar = quitarlo también de servers.json (queda copia en servers.json.bak).\nCancelar = no hacer nada.`)) return;
        try { await removeFromBridgeConfig(server.name); } catch (err) { toast(`No se pudo quitar de servers.json: ${err.message}`); return; }
        await api('REMOVE_SERVER', { id: server.id });
        return;
      }
      if (confirm(`¿Quitar «${server.name}» de la extensión? (No se borra de la configuración del PC; «Detectar» lo volvería a añadir).`)) {
        await api('REMOVE_SERVER', { id: server.id });
      }
    }), 'danger'),
  );
  li.append(el('div', { class: 'server-main' }, toggle, info, actions));

  const foot = el('div', { class: 'server-foot' });
  const tools = server.tools ?? [];
  if (tools.length) {
    const expanded = openTools.has(server.id);
    const on = tools.filter((t) => t.enabled !== false).length;
    const label = on === tools.length ? `${tools.length} herramientas` : `${on} de ${tools.length} herramientas`;
    const btn = el('button', { type: 'button', class: 'tools-toggle', 'aria-expanded': String(expanded) },
      icon('chevron', 'icon chev'), label);
    btn.addEventListener('click', () => {
      if (openTools.has(server.id)) openTools.delete(server.id); else openTools.add(server.id);
      refresh(true);
    });
    foot.append(btn);
  } else foot.append(el('span'));
  foot.append(permSelect(server.permission, (value) => api('SET_PERMISSION', { id: server.id, permission: value }), `Permiso de ${server.name}`));
  li.append(foot);

  if (tools.length && openTools.has(server.id)) li.append(renderTools(server, tools));
  return li;
}

// ───────────────────────── Herramientas de cada MCP (cuáles ve la IA) ─────────────────────────

const toolFilter = new Map(); // id del MCP → texto del buscador
let focusFilter = null;       // MCP cuyo buscador tenía el foco (se restaura tras redibujar)

function renderTools(server, tools) {
  const box = el('div', { class: 'tools-box' });
  const on = tools.filter((t) => t.enabled !== false).length;
  const filter = toolFilter.get(server.id) ?? '';
  const search = el('input', {
    type: 'text', class: 'tools-search', placeholder: `Buscar entre ${tools.length} herramientas…`,
    'aria-label': `Buscar herramientas de ${server.name}`, 'data-filter': server.id,
  });
  search.value = filter;
  search.addEventListener('input', () => { toolFilter.set(server.id, search.value); focusFilter = server.id; refresh(true); });
  const setAll = (enabled, names) => guard(() => api('SET_TOOLS_ENABLED', { id: server.id, enabled, names }));
  const q = filter.trim().toLowerCase();
  const shown = q ? tools.filter((t) => t.name.toLowerCase().includes(q) || (t.description ?? '').toLowerCase().includes(q)) : tools;
  const bar = el('div', { class: 'tools-bar' },
    el('span', { class: 'muted', text: `${on} de ${tools.length} activas · la IA solo ve las activas` }),
    el('span', { class: 'row-gap' },
      el('button', { type: 'button', class: 'ghost small', onclick: setAll(true, q ? shown.map((t) => t.name) : undefined) }, q ? 'Activar estas' : 'Todas'),
      el('button', { type: 'button', class: 'ghost small', onclick: setAll(false, q ? shown.map((t) => t.name) : undefined) }, q ? 'Desactivar estas' : 'Ninguna')));
  const list = el('ul', { class: 'tools' }, ...shown.map((t) => {
    const check = el('input', { type: 'checkbox', 'aria-label': `Permitir ${t.name}` });
    check.checked = t.enabled !== false;
    check.addEventListener('change', guard(() => api('SET_TOOLS_ENABLED', { id: server.id, names: [t.name], enabled: check.checked })));
    return el('li', { class: t.enabled === false ? 'off' : '' },
      el('label', { class: 'tool-row' }, check, el('span', {}, el('b', { text: t.name }), t.description ? el('span', { text: t.description }) : null)));
  }));
  if (!shown.length) list.append(el('li', { class: 'muted', text: 'Ninguna coincide con la búsqueda.' }));
  box.append(search, bar, list);
  return box;
}

function renderServers(state) {
  const active = state.servers.filter((s) => s.enabled);
  $('#counter').textContent = `${active.length} ${active.length === 1 ? 'activo' : 'activos'} · máx. ${MAX_ACTIVE_SERVERS}`;
  $('#counter').title = `Máximo de MCP activos a la vez: ${MAX_ACTIVE_SERVERS}. Ahora hay ${state.servers.length} MCP en la lista.`;
  const tokens = active.reduce((sum, s) => sum + s.approxTokens, 0);
  $('#tokens').textContent = active.length ? `· ≈ ${tokens.toLocaleString('es')} tokens` : '';
  $('#summary').hidden = state.servers.length === 0;

  const warning = $('#warning');
  warning.hidden = active.length <= RECOMMENDED_ACTIVE_SERVERS;
  warning.textContent = `Tienes ${active.length} MCP activos: cada herramienta ocupa contexto de la IA. Activa solo los que necesites para esta tarea.`;
  $('#empty').hidden = state.servers.length > 0;

  $('#server-list').replaceChildren(...state.servers.map((s) => renderServer(s, active.length)));
  if (focusFilter) { // el buscador de herramientas conserva el foco y el cursor al redibujar
    const input = document.querySelector(`input[data-filter="${focusFilter}"]`);
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }
}

function renderGlobalPermission(servers) {
  const select = $('#perm-all');
  const perms = new Set(servers.map((s) => s.permission));
  const value = perms.size === 1 ? [...perms][0] : (perms.size === 0 ? 'ask' : 'mixed');
  select.value = value;
  select.dataset.perm = value;
}

// ───────────────────────── Actividad (registro + llamadas en un solo listado) ─────────────────────────

let activityFilter = store.get('wmb-activity-filter', 'all');
let activityQuery = '';
let activitySig = '';
const expandedRows = new Set();
const ACTIVITY_SHOWN = 200;

function syncChips() {
  for (const b of document.querySelectorAll('.chips button')) b.setAttribute('aria-pressed', String(b.dataset.filter === activityFilter));
}

function setActivityFilter(filter) {
  activityFilter = filter;
  store.set('wmb-activity-filter', filter);
  syncChips();
  activitySig = '';
  renderActivity().catch((err) => toast(err.message));
}

function activityRow(item) {
  const open = expandedRows.has(item.key);
  const badges = [el('span', { class: `badge cat-${item.cat}`, text: CATEGORY_LABEL[item.cat] })];
  if (item.status) badges.push(el('span', { class: `badge st-${item.status.tone}`, text: item.status.text }));
  if (item.ms != null) badges.push(el('span', { class: 'badge', text: fmtMs(item.ms) }));
  if (item.platform) badges.push(el('span', { class: 'badge', text: item.platform }));
  if (item.cid) {
    badges.push(el('button', {
      type: 'button', class: 'badge cid', title: 'Ver solo los pasos de esta llamada', text: `#${item.cid}`,
      onclick: (e) => { e.stopPropagation(); $('#act-search').value = item.cid; activityQuery = item.cid; setActivityFilter('all'); },
    }));
  }
  return el('li', {
    class: `act-row lvl-${item.level}${open ? ' open' : ''}`,
    onclick: () => { if (expandedRows.has(item.key)) expandedRows.delete(item.key); else expandedRows.add(item.key); activitySig = ''; renderActivity().catch((err) => toast(err.message)); },
  },
  el('div', { class: 'act-head' }, el('div', { class: 'badges' }, ...badges), el('time', { text: new Date(item.ts).toLocaleTimeString('es') })),
  el('div', { class: 'act-title', text: item.title }),
  item.summary ? el('small', { text: item.summary }) : null,
  open ? el('pre', { class: 'act-raw', text: JSON.stringify({ evento: item.event, origen: item.source, ...(item.raw.details ?? {}) }, null, 2) }) : null);
}

async function renderActivity() {
  const [{ logs }, { history }] = await Promise.all([api('GET_LOGS'), api('GET_HISTORY')]);
  const items = mergeActivity(logs, history);
  const shown = items.filter((i) => matchesFilter(i, activityFilter, activityQuery)).slice(0, ACTIVITY_SHOWN);
  const sig = `${items.length}|${shown.map((i) => i.key + (expandedRows.has(i.key) ? '+' : '')).join(',')}`;
  $('#act-empty').hidden = shown.length > 0;
  $('#act-count').textContent = items.length ? `${items.length} eventos guardados · se muestran ${shown.length}` : '';
  if (sig === activitySig) return; // nada cambió: no repintar (conserva la selección de texto)
  activitySig = sig;
  $('#act-list').replaceChildren(...shown.map(activityRow));
}

// ───────────────────────── Ajustes ─────────────────────────

function renderSettings(settings) {
  $('#master').checked = settings.bridgeEnabled;
  $('#master-label').textContent = settings.bridgeEnabled ? 'Bridge activado' : 'Bridge desactivado: no se conecta ni se inyecta nada';
  $('#main').classList.toggle('off', !settings.bridgeEnabled);
  for (const key of ['autoInject', 'autoSend', 'reminder', 'focusFallback', 'preferSidePanel']) $(`#set-${key}`).checked = Boolean(settings[key]);
  $('#set-autoUpdate').checked = settings.autoUpdate !== false;
  for (const [id] of Object.entries(PLATFORM_LABELS)) {
    const box = $(`#plat-${id}`);
    if (box) box.checked = settings.platforms?.[id] !== false;
  }
  if (document.activeElement?.id !== 'set-maxResultChars') $('#set-maxResultChars').value = settings.maxResultChars;
  if (document.activeElement?.id !== 'set-reinjectEvery') $('#set-reinjectEvery').value = settings.reinjectEvery;
  if (document.activeElement?.id !== 'set-toolTimeoutSec') $('#set-toolTimeoutSec').value = settings.toolTimeoutSec ?? 300;
  if (document.activeElement?.id !== 'set-sendPauseMinSec') $('#set-sendPauseMinSec').value = settings.sendPauseMinSec ?? 2;
  if (document.activeElement?.id !== 'set-sendPauseMaxSec') $('#set-sendPauseMaxSec').value = settings.sendPauseMaxSec ?? 5;
  if (document.activeElement?.id !== 'set-maxSendsPerMinute') $('#set-maxSendsPerMinute').value = settings.maxSendsPerMinute ?? 8;
}

function renderVersion(update) {
  const info = versionInfo({ version: update?.version, commit: update?.commit, branch: update?.branch, latest: update?.latest, bootCommit: update?.bootCommit });
  const chip = $('#version-chip');
  chip.textContent = info.label;
  chip.dataset.state = info.state;
  chip.title = `${info.title}\n\n(clic: copiar)`;
  chip.dataset.copy = info.title.split('\n\n')[0];
}

function renderUpdate(update) {
  renderVersion(update);
  const out = $('#update-status');
  if (!update?.commit) {
    out.textContent = 'No instalada: ejecuta scripts\\windows\\install.ps1 para registrar la tarea que baja las versiones nuevas de main.';
    return;
  }
  const when = update.checkedAt ? ` · comprobado ${ago(Date.parse(update.checkedAt))}` : '';
  const pending = update.pendingReload ? ' · versión nueva lista: se recargará al terminar la llamada en curso' : '';
  out.textContent = `${versionInfo({ version: update.version, commit: update.commit, branch: update.branch, latest: update.latest, bootCommit: update.bootCommit }).title.split('\n').join(' · ')}${when}. ${update.status ?? ''}${pending}`;
}

// ───────────────────────── Pestañas y refresco ─────────────────────────

let currentTab = store.get('wmb-tab', 'mcp');

function setTab(tab) {
  currentTab = ['mcp', 'activity', 'settings'].includes(tab) ? tab : 'mcp';
  store.set('wmb-tab', currentTab);
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === currentTab));
  for (const section of document.querySelectorAll('main > section')) section.hidden = section.id !== `tab-${currentTab}`;
  refresh(true);
}

let selectFocusedAt = 0;
document.addEventListener('focusin', (e) => { if (e.target.matches?.('select')) selectFocusedAt = Date.now(); });
document.addEventListener('focusout', (e) => { if (e.target.matches?.('.tools-search')) setTimeout(() => { if (!document.activeElement?.matches?.('.tools-search')) focusFilter = null; }, 0); });

async function refresh(force = false) {
  if (!force && document.activeElement?.matches('input[type="text"], input[type="number"]')) return; // escribiendo
  if (!force && document.activeElement?.matches('select') && Date.now() - selectFocusedAt < 6000) return;
  try {
    const state = await api('GET_STATE');
    renderBridge(state.bridge);
    renderServers(state);
    renderGlobalPermission(state.servers);
    renderSettings(state.settings);
    renderUpdate(state.update);
    if (currentTab === 'activity') await renderActivity();
  } catch (err) { toast(err.message); }
}

// ───────────────────────── Eventos ─────────────────────────

for (const btn of document.querySelectorAll('.tabs button')) btn.addEventListener('click', () => setTab(btn.dataset.tab));
$('#version-chip').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#version-chip').dataset.copy ?? ''); toast('Versión copiada'); } catch { toast('No se pudo copiar'); }
});
document.querySelector('.tabs').addEventListener('keydown', (e) => { // flechas entre pestañas
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const tabs = [...document.querySelectorAll('.tabs button')];
  const i = tabs.findIndex((t) => t.dataset.tab === currentTab);
  const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  next.focus();
  setTab(next.dataset.tab);
});
for (const btn of document.querySelectorAll('.chips button')) btn.addEventListener('click', () => setActivityFilter(btn.dataset.filter));
$('#act-search').addEventListener('input', (e) => { activityQuery = e.target.value; activitySig = ''; renderActivity().catch((err) => toast(err.message)); });
syncChips();

$('#open-panel').addEventListener('click', async () => {
  try {
    if (windowId == null) throw new Error('No se encontró la ventana.');
    await chrome.sidePanel.open({ windowId });
    window.close();
  } catch (err) { toast(`No se pudo abrir el panel lateral: ${err.message}`); }
});
$('#discover').addEventListener('click', () => discover(false));
$('#open-editor').addEventListener('click', guard(async () => { await api('OPEN_EDITOR'); if (isPopup) window.close(); }));
$('#add-demo').addEventListener('click', guard(() => api('ADD_SERVER', DEMO_SERVER)));
$('#add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('ADD_SERVER', { name: $('#add-name').value, url: $('#add-url').value });
    event.target.reset();
    toast('MCP añadido.');
  } catch (err) { toast(err.message); }
  await refresh(true);
});
$('#perm-all').addEventListener('change', guard((e) => api('SET_ALL_PERMISSIONS', { permission: e.target.value })));
$('#master').addEventListener('change', guard((e) => api('UPDATE_SETTINGS', { settings: { bridgeEnabled: e.target.checked } })));
for (const key of ['autoInject', 'autoSend', 'reminder', 'focusFallback', 'preferSidePanel', 'autoUpdate']) {
  $(`#set-${key}`).addEventListener('change', guard((e) => api('UPDATE_SETTINGS', { settings: { [key]: e.target.checked } })));
}
$('#set-reinjectEvery').addEventListener('change', guard((e) => {
  const value = Math.min(100, Math.max(0, Math.round(Number(e.target.value)) || 0));
  return api('UPDATE_SETTINGS', { settings: { reinjectEvery: value } });
}));
for (const key of ['sendPauseMinSec', 'sendPauseMaxSec']) {
  $(`#set-${key}`).addEventListener('change', guard(() => {
    const clamp = (v) => Math.min(120, Math.max(0, Math.round(Number(v)) || 0));
    let min = clamp($('#set-sendPauseMinSec').value);
    let max = clamp($('#set-sendPauseMaxSec').value);
    if (key === 'sendPauseMinSec' && min > max) max = min;       // el rango siempre es válido (mín ≤ máx)
    if (key === 'sendPauseMaxSec' && max < min) min = max;
    $('#set-sendPauseMinSec').value = min;
    $('#set-sendPauseMaxSec').value = max;
    return api('UPDATE_SETTINGS', { settings: { sendPauseMinSec: min, sendPauseMaxSec: max } });
  }));
}
$('#set-maxSendsPerMinute').addEventListener('change', guard((e) => {
  const value = Math.min(60, Math.max(0, Math.round(Number(e.target.value)) || 0));
  return api('UPDATE_SETTINGS', { settings: { maxSendsPerMinute: value } });
}));
$('#set-toolTimeoutSec').addEventListener('change', guard((e) => {
  const value = Math.min(1800, Math.max(10, Math.round(Number(e.target.value)) || 300));
  return api('UPDATE_SETTINGS', { settings: { toolTimeoutSec: value } });
}));
$('#set-maxResultChars').addEventListener('change', guard((e) => {
  const value = Math.min(100000, Math.max(500, Number(e.target.value) || 12000));
  return api('UPDATE_SETTINGS', { settings: { maxResultChars: value } });
}));
$('#clear-logs').addEventListener('click', guard(async () => {
  if (!confirm('¿Borrar toda la actividad (registro y llamadas)?')) return;
  await api('CLEAR_LOGS');
  await api('CLEAR_HISTORY');
  expandedRows.clear();
  activitySig = '';
}));
$('#export-logs').addEventListener('click', guard(async () => {
  const [{ logs }, { history }] = await Promise.all([api('GET_LOGS'), api('GET_HISTORY')]);
  const payload = { exportedAt: new Date().toISOString(), version: chrome.runtime.getManifest().version, userAgent: navigator.userAgent, logs, history };
  const a = el('a', { download: `web-mcp-bridge-actividad-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json` });
  a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`Exportados ${logs.length} eventos y ${history.length} llamadas.`);
}));

// Plataformas: casillas generadas a partir de PLATFORM_LABELS
$('#platforms').replaceChildren(...Object.entries(PLATFORM_LABELS).map(([id, name]) => {
  const box = el('input', { type: 'checkbox', id: `plat-${id}` });
  box.addEventListener('change', guard(async () => {
    const { settings } = await api('GET_STATE');
    await api('UPDATE_SETTINGS', { settings: { platforms: { ...settings.platforms, [id]: box.checked } } });
  }));
  return el('label', { class: 'platform' }, box, el('span', { text: name }));
}));

// ───────────────────────── Inicio ─────────────────────────

setTab(currentTab);
discover(true);
setInterval(refresh, 1500);
if (!isPopup) setInterval(() => discover(true), 20_000); // el panel queda abierto: el estado del puente se mantiene al día

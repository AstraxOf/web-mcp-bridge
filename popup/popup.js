/**
 * popup.js — Panel de control de la extensión.
 *
 * Permite registrar / renombrar / eliminar servidores MCP y elegir cuáles están
 * activos (máx. 5; por defecto solo 1 para no saturar el contexto de la IA).
 */
import { MAX_ACTIVE_SERVERS, RECOMMENDED_ACTIVE_SERVERS, PERMISSIONS, PERMISSION_LABELS, DEMO_SERVER } from '../shared/constants.js';

const $ = (selector, root = document) => root.querySelector(selector);
const STATUS_TEXT = {
  connected: 'Conectado', connecting: 'Conectando…', disconnected: 'Sin conexión (reintentando)', error: 'Error de conexión',
};

/** Envía un mensaje al service worker y lanza excepción si la respuesta no es ok. */
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
  toast.timer = setTimeout(() => el.classList.remove('show'), 3200);
}

const guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (err) { toast(err.message); }
  await refresh(true);
};

// ───────────────────────── Servidores ─────────────────────────

function renderServers(state) {
  const list = $('#server-list');
  list.replaceChildren();
  const active = state.servers.filter((s) => s.enabled);

  $('#counter').textContent = `${active.length}/${MAX_ACTIVE_SERVERS} activos`;
  const tokens = active.reduce((sum, s) => sum + s.approxTokens, 0);
  $('#tokens').textContent = active.length ? `≈ ${tokens.toLocaleString('es')} tokens de herramientas` : '';

  const warning = $('#warning');
  warning.hidden = active.length <= RECOMMENDED_ACTIVE_SERVERS;
  warning.textContent = `⚠️ Tienes ${active.length} MCP activos. Cada herramienta ocupa contexto de la IA y puede saturarlo. Lo recomendable es 1 a la vez.`;
  $('#empty').hidden = state.servers.length > 0;
  $('#offline-hint').hidden = !(active.length > 0 && active.every((s) => s.status !== 'connected'));

  for (const server of state.servers) {
    const li = document.createElement('li');
    li.className = `server${server.enabled ? ' on' : ''}`;

    const toggle = document.createElement('label');
    toggle.className = 'switch';
    toggle.title = server.enabled ? 'Desactivar' : 'Activar';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = server.enabled;
    checkbox.disabled = !server.enabled && active.length >= MAX_ACTIVE_SERVERS;
    checkbox.setAttribute('aria-label', `Activar ${server.name}`);
    checkbox.addEventListener('change', guard(() => api('TOGGLE_SERVER', { id: server.id, enabled: checkbox.checked })));
    toggle.append(checkbox, document.createElement('span'));

    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.className = 'name';
    const dot = document.createElement('i');
    dot.className = `dot ${server.enabled ? server.status : ''}`;
    const label = document.createElement('span');
    label.textContent = server.name;
    name.append(dot, label);
    const meta = document.createElement('div');
    meta.className = 'meta';
    const blocked = server.permission === 'deny';
    meta.textContent = blocked ? `${server.url} · Bloqueado (no se describe a la IA)`
      : server.enabled
        ? `${server.url} · ${STATUS_TEXT[server.status]}${server.status === 'connected' ? ` · ${server.toolCount} herramientas` : ''}`
        : server.url;
    if (server.enabled && server.error && server.status !== 'connected') meta.title = server.error;
    info.append(name, meta);

    info.append(permSelect(server.permission, (value) => api('SET_PERMISSION', { id: server.id, permission: value }), `Permiso de ${server.name}`));

    const actions = document.createElement('div');
    actions.className = 'actions';
    const rename = iconButton('✎', 'Renombrar', () => startRename(label, server));
    const remove = iconButton('✕', 'Eliminar', guard(async () => {
      if (confirm(`¿Eliminar «${server.name}»?`)) await api('REMOVE_SERVER', { id: server.id });
    }));
    actions.append(rename, remove);

    li.append(toggle, info, actions);
    list.append(li);
  }
}

/** Selector de 3 estados: Permitir siempre · Preguntar siempre · No permitir. */
function permSelect(value, onChange, label) {
  const select = document.createElement('select');
  select.className = 'perm';
  select.dataset.perm = value;
  select.setAttribute('aria-label', label);
  for (const perm of PERMISSIONS) {
    const option = new Option(PERMISSION_LABELS[perm], perm, false, perm === value);
    select.append(option);
  }
  select.addEventListener('change', guard(() => onChange(select.value)));
  return select;
}

function iconButton(text, title, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn';
  btn.textContent = text;
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.addEventListener('click', onClick);
  return btn;
}

function startRename(label, server) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = server.name;
  input.maxLength = 40;
  label.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = guard(async (save) => {
    if (done) return;
    done = true;
    if (save && input.value.trim() && input.value.trim() !== server.name) {
      await api('RENAME_SERVER', { id: server.id, name: input.value });
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

$('#add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('ADD_SERVER', { name: $('#add-name').value, url: $('#add-url').value });
    event.target.reset();
    toast('Servidor añadido.');
  } catch (err) { toast(err.message); }
  await refresh(true);
});

// ───────────────────────── Historial ─────────────────────────

async function renderHistory() {
  const { history } = await api('GET_HISTORY');
  const list = $('#history-list');
  list.replaceChildren();
  $('#history-empty').hidden = history.length > 0;
  for (const h of history) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'row';
    const title = document.createElement('span');
    title.textContent = `${h.server} › ${h.tool}`;
    const status = document.createElement('span');
    status.className = h.status;
    status.textContent = h.status === 'ok' ? `OK${h.ms ? ` · ${h.ms} ms` : ''}` : 'Error';
    row.append(title, status);
    const detail = document.createElement('small');
    detail.textContent = `${new Date(h.ts).toLocaleTimeString('es')} · ${h.error ?? h.args}`;
    li.append(row, detail);
    list.append(li);
  }
}
$('#clear-history').addEventListener('click', guard(async () => { await api('CLEAR_HISTORY'); }));

// ───────────────────────── Ajustes ─────────────────────────

function renderSettings(settings) {
  $('#master').checked = settings.bridgeEnabled;
  $('#master-label').textContent = settings.bridgeEnabled ? 'Bridge activado' : 'Bridge desactivado';
  $('#main').classList.toggle('off', !settings.bridgeEnabled);
  if (document.activeElement?.id !== 'set-maxResultChars') $('#set-maxResultChars').value = settings.maxResultChars;
  $('#set-autoInject').checked = settings.autoInject;
  $('#set-autoSend').checked = settings.autoSend;
  $('#set-reminder').checked = settings.reminder;
  $('#set-focusFallback').checked = settings.focusFallback;
  if (document.activeElement?.id !== 'set-reinjectEvery') $('#set-reinjectEvery').value = settings.reinjectEvery;
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

$('#master').addEventListener('change', guard((e) => api('UPDATE_SETTINGS', { settings: { bridgeEnabled: e.target.checked } })));

for (const key of ['autoInject', 'autoSend', 'reminder', 'focusFallback']) {
  $(`#set-${key}`).addEventListener('change', guard((e) => api('UPDATE_SETTINGS', { settings: { [key]: e.target.checked } })));
}
$('#set-reinjectEvery').addEventListener('change', guard((e) => {
  const value = Math.min(100, Math.max(0, Math.round(Number(e.target.value)) || 0));
  return api('UPDATE_SETTINGS', { settings: { reinjectEvery: value } });
}));
$('#add-demo').addEventListener('click', guard(() => api('ADD_SERVER', DEMO_SERVER)));
$('#set-maxResultChars').addEventListener('change', guard((e) => {
  const value = Math.min(100000, Math.max(500, Number(e.target.value) || 12000));
  return api('UPDATE_SETTINGS', { settings: { maxResultChars: value } });
}));

// ───────────────────────── Pestañas y refresco ─────────────────────────

let selectFocusedAt = 0;
document.addEventListener('focusin', (e) => { if (e.target.matches?.('select')) selectFocusedAt = Date.now(); });

let currentTab = 'servers';
for (const btn of document.querySelectorAll('.tabs button')) {
  btn.addEventListener('click', () => {
    currentTab = btn.dataset.tab;
    for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b === btn));
    for (const section of document.querySelectorAll('main > section')) section.hidden = section.id !== `tab-${currentTab}`;
    refresh(true);
  });
}

async function refresh(force = false) {
  // No re-renderizar mientras el usuario escribe en un campo.
  if (!force && document.activeElement?.matches('input[type="text"], input[type="number"]')) return;
  if (!force && document.activeElement?.matches('select') && Date.now() - selectFocusedAt < 6000) return; // solo unos segundos
  try {
    const state = await api('GET_STATE');
    renderServers(state);
    renderGlobalPermission(state.servers);
    renderSettings(state.settings);
    if (currentTab === 'history') await renderHistory();
  } catch (err) { toast(err.message); }
}

refresh(true);
setInterval(refresh, 1500);

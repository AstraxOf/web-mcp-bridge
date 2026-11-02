/**
 * background.js — Service Worker (Manifest V3).
 *
 * Responsabilidades:
 *   1. Guardar la configuración (servidores, ajustes, historial) en chrome.storage.local.
 *   2. Mantener una conexión WebSocket SOLO con los servidores MCP habilitados.
 *   3. Exponer a popup y content scripts una API de mensajes (ver `handleMessage`).
 */
import { McpConnection } from './ws_client.js';
import {
  STORAGE_KEYS as KEYS, LEGACY_STORAGE_KEYS, DEFAULT_SETTINGS, MAX_ACTIVE_SERVERS,
  CALL_TIMEOUT_MS, HISTORY_LIMIT, SUPPORTED_URL_PATTERNS, PERMISSIONS,
  NOTICES_URL, NOTICES_EVERY_MS, NOTICES_RETRY_MS, NOTICES_MAX_BYTES,
} from '../shared/constants.js';
import { compareVersions, normalizeFeed, publicNotices, mergeFeed, safeLink } from './notices.js';

/** @type {Map<string, McpConnection>} serverId → conexión */
const connections = new Map();

// Serializa las mutaciones de storage para evitar condiciones de carrera.
let lock = Promise.resolve();
const withLock = (fn) => {
  const run = lock.then(() => fn());
  lock = run.catch(() => {});
  return run;
};

// ───────────────────────── Estado y almacenamiento ─────────────────────────

async function loadState() {
  const data = await chrome.storage.local.get([KEYS.servers, KEYS.settings]);
  const stored = data[KEYS.settings] ?? {};
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  delete settings.checkUpdates; // v1.4: las actualizaciones automaticas ya no existen
  // Migración desde 1.0: «ejecutar sin preguntar» (autoExecute) pasa a ser el permiso «allow».
  if (!PERMISSIONS.includes(stored.defaultPermission)) settings.defaultPermission = stored.autoExecute ? 'allow' : 'ask';
  const servers = (data[KEYS.servers] ?? []).filter((s) => s.url).map((s) => ({ // sin dirección = marcador de la 1.1: se descarta
    ...s,
    permission: PERMISSIONS.includes(s.permission) ? s.permission : settings.defaultPermission,
  }));
  return { servers, settings };
}

/** Servidores que pueden conectarse y usarse: activos, con dirección y no bloqueados. */
const isUsable = (s) => s.enabled && s.url && s.permission !== 'deny';

const saveServers = (servers) => chrome.storage.local.set({ [KEYS.servers]: servers });

/** Identificador legible y único que usará la IA para nombrar cada servidor. */
function assignSlugs(servers) {
  const used = new Set();
  const slugs = new Map();
  // Los MCP ya configurados (con dirección) eligen primero: así el MCP por defecto sin configurar no les quita el nombre.
  for (const s of [...servers].sort((a, b) => Boolean(b.url) - Boolean(a.url))) {
    const base = s.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'mcp';
    let slug = base;
    for (let n = 2; used.has(slug); n += 1) slug = `${base}_${n}`;
    used.add(slug);
    slugs.set(s.id, slug);
  }
  return slugs;
}

// ───────────────────────── Conexiones ─────────────────────────

// ------------- Deteccion automatica desde servers.json (v1.3.0) -------------
// El puente (mcp_ws_bridge.py --config servers.json) publica su lista en http://127.0.0.1:8099/servers.
// Los servidores nuevos aparecen solos en la extension; los que se quiten de servers.json desaparecen.

let lastDiscovery = 0;

// Estado del puente local (lo consulta el popup y lo usan "Reiniciar" y "Abrir servers.json").
const bridge = {
  checked: false, online: false, version: null, pid: null, config: null, configError: null,
  supervised: false, startedAt: null, servers: [], error: null, launcherOnline: false, paused: false,
};
let lastProbe = 0;
let probing = null;
let storedConfig = null;
chrome.storage.local.get(KEYS.bridge).then((data) => {
  storedConfig = data[KEYS.bridge]?.config ?? null;
  if (!bridge.config) bridge.config = storedConfig;
}).catch(() => {});

async function bridgeFetch(path, { method = 'GET', timeout = 1500 } = {}) {
  const { settings } = await loadState();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(`http://127.0.0.1:${settings.controlPort || 8099}${path}`, { method, cache: 'no-store', signal: ctl.signal });
    let body = null;
    try { body = await res.json(); } catch { /* respuesta sin cuerpo */ }
    return { status: res.status, body };
  } finally { clearTimeout(timer); }
}

/** Pregunta al puente quien es y que servidores publica. Sin esperas largas: si no responde, queda "sin conexion". */
function probeBridge(force = false) {
  if (!force && Date.now() - lastProbe < 2500) return Promise.resolve(bridge);
  if (probing) return probing;
  probing = (async () => {
    try {
      const { status, body } = await bridgeFetch('/servers');
      if (status !== 200 || !body?.ok) throw new Error('Respuesta inesperada del puente.');
      Object.assign(bridge, {
        checked: true, online: true, version: body.version ?? null, pid: body.pid ?? null, config: body.config ?? bridge.config,
        configError: body.config_error ?? null, supervised: Boolean(body.supervised), startedAt: body.started_at ?? null,
        servers: Array.isArray(body.servers) ? body.servers : [], error: null,
      });
      if (body.config && body.config !== storedConfig) {
        storedConfig = body.config;
        chrome.storage.local.set({ [KEYS.bridge]: { config: body.config } }).catch(() => {});
      }
    } catch (err) {
      Object.assign(bridge, {
        checked: true, online: false, pid: null, configError: null, servers: [],
        error: err?.name === 'AbortError' ? 'sin respuesta' : (err?.message ?? 'sin conexion'),
      });
    }
    await probeLauncher();
    lastProbe = Date.now();
    return bridge;
  })().finally(() => { probing = null; });
  return probing;
}
const portOf = (u) => { try { return new URL(u).port; } catch { return ''; } };
const isLocalUrl = (u) => { try { return ['localhost', '127.0.0.1'].includes(new URL(u).hostname); } catch { return false; } };
const safeUrl = (raw) => { try { return validateUrl(String(raw)); } catch { return null; } };

async function discoverServers(force = false) {
  const { settings } = await loadState();
  if (settings.autoDiscover === false) return { ok: true, skipped: true };
  if (!force && Date.now() - lastDiscovery < 8000) return { ok: true, throttled: true };
  lastDiscovery = Date.now();

  const info = await probeBridge(true);
  if (!info.online) return { ok: false, error: 'No se encontro el puente. Abrelo con server/start_bridge_loop.pyw' };

  const list = (Array.isArray(info.servers) ? info.servers : [])
    .map((s) => ({ name: String(s?.name ?? '').trim(), url: safeUrl(s?.url) }))
    .filter((s) => s.name && s.url);
  const listed = new Set(list.map((s) => s.url));

  return withLock(async () => {
    const { servers, settings: cfg } = await loadState();
    const store = await chrome.storage.local.get(KEYS.dismissed);
    const dismissed = (store[KEYS.dismissed] ?? []).filter((u) => listed.has(u)); // lo descartado que ya no esta en servers.json se olvida
    let changed = false;
    let added = 0;

    for (const s of list) {
      if (dismissed.includes(s.url)) continue;
      const existing = servers.find((x) => x.url === s.url || (isLocalUrl(x.url) && portOf(x.url) === portOf(s.url)));
      if (existing) {
        if (existing.auto && !existing.renamed && existing.name !== s.name) { existing.name = s.name; changed = true; }
        continue;
      }
      const active = servers.filter((x) => x.enabled).length;
      const enable = cfg.autoEnableDiscovered ? active < MAX_ACTIVE_SERVERS : active === 0;
      servers.push({ id: crypto.randomUUID(), name: s.name, url: s.url, enabled: enable, permission: cfg.defaultPermission, auto: true });
      changed = true;
      added += 1;
    }
    const kept = servers.filter((x) => !(x.auto && !listed.has(x.url)));
    if (kept.length !== servers.length) changed = true;
    if (dismissed.length !== (store[KEYS.dismissed] ?? []).length) await chrome.storage.local.set({ [KEYS.dismissed]: dismissed });
    if (changed) { await saveServers(kept); await reconcile(); scheduleBroadcast(); }
    return { ok: true, changed, added, total: list.length };
  });
}

let broadcastTimer = null;
function scheduleBroadcast() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(async () => {
    const tabs = await chrome.tabs.query({ url: SUPPORTED_URL_PATTERNS });
    for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type: 'STATE_CHANGED' }).catch(() => {});
  }, 300);
}

function onConnectionChange(evt) {
  if (evt.kind === 'tools' || evt.prev === 'connected' || evt.next === 'connected') scheduleBroadcast();
}

/** Alinea las conexiones abiertas con los servidores habilitados en storage. */
async function updateBadge(enabled) {
  let unread = 0;
  try { unread = (await readNotices()).unread; } catch { /* sin avisos guardados */ }
  await chrome.action.setBadgeText({ text: !enabled ? 'OFF' : (unread ? (unread > 9 ? '9+' : String(unread)) : '') });
  await chrome.action.setBadgeBackgroundColor({ color: !enabled ? '#8a8078' : '#c9803a' });
}
async function reconcile() {
  const { servers, settings } = await loadState();
  updateBadge(settings.bridgeEnabled).catch(() => {});
  // Con el bridge apagado no se mantiene ninguna conexión.
  const wanted = new Map((settings.bridgeEnabled ? servers : []).filter(isUsable).slice(0, MAX_ACTIVE_SERVERS).map((s) => [s.id, s]));

  for (const [id, conn] of connections) {
    const target = wanted.get(id);
    if (!target || target.url !== conn.server.url) {
      conn.close();
      connections.delete(id);
    }
  }
  for (const [id, server] of wanted) {
    const existing = connections.get(id);
    if (existing) {
      existing.server = server;
    } else {
      const conn = new McpConnection(server, onConnectionChange);
      connections.set(id, conn);
      conn.connect();
    }
  }
}

// ───────────────────────── Consultas ─────────────────────────

async function getSnapshot() {
  discoverServers().catch(() => {});
  probeBridge().catch(() => {});
  const { servers, settings } = await loadState();
  const slugs = assignSlugs(servers);
  return {
    ok: true,
    settings,
    version: localVersion(),
    notices: await readNotices(),
    bridge: publicBridge(),
    max: MAX_ACTIVE_SERVERS,
    servers: servers.map((s) => {
      const conn = connections.get(s.id);
      const live = bridge.servers.find((b) => b.url === s.url || (isLocalUrl(s.url) && portOf(b.url) === portOf(s.url)));
      return {
        ...s,
        bridgeStatus: live?.status ?? null,
        bridgeError: live?.error ?? null,
        slug: slugs.get(s.id),
        status: conn?.status ?? 'disconnected',
        error: conn?.lastError ?? null,
        toolCount: conn?.tools.length ?? 0,
        approxTokens: conn ? Math.ceil(JSON.stringify(conn.tools).length / 4) : 0,
      };
    }),
  };
}

/** Herramientas de los servidores ACTIVOS (esto es lo que se inyecta al chat). */
async function getActiveTools() {
  await discoverServers().catch(() => {});
  await reconcile();
  const { servers, settings } = await loadState();
  if (!settings.bridgeEnabled) return { ok: true, tools: [], disabled: true };
  const slugs = assignSlugs(servers);
  const active = servers.filter(isUsable); // los MCP bloqueados («No permitir») no se describen a la IA: ahorra tokens
  await Promise.all(active.map((s) => connections.get(s.id)?.whenReady(4000)));

  const tools = [];
  for (const s of active) {
    for (const t of connections.get(s.id)?.tools ?? []) {
      tools.push({
        server: slugs.get(s.id),
        serverLabel: s.name,
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      });
    }
  }
  return { ok: true, tools };
}

async function addHistory(entry) {
  return withLock(async () => {
    const data = await chrome.storage.local.get(KEYS.history);
    const history = [entry, ...(data[KEYS.history] ?? [])].slice(0, HISTORY_LIMIT);
    await chrome.storage.local.set({ [KEYS.history]: history });
  });
}

async function callTool({ server, name, arguments: args }) {
  const { servers, settings } = await loadState();
  if (!settings.bridgeEnabled) return { ok: false, error: 'El bridge está desactivado.' };
  const slugs = assignSlugs(servers);
  const active = servers.filter((s) => s.enabled && s.url);
  const target = server
    ? active.find((s) => slugs.get(s.id) === server || s.name === server || s.id === server)
    : (active.length === 1 ? active[0] : null);

  const label = target ? slugs.get(target.id) : (server ?? '?');
  const entry = { ts: Date.now(), server: label, tool: name, args: JSON.stringify(args ?? {}).slice(0, 300) };
  const fail = async (error) => {
    await addHistory({ ...entry, status: 'error', error });
    return { ok: false, error };
  };

  if (!target) return fail(`El servidor «${label}» no está activo.`);
  if (target.permission === 'deny') return fail(`El usuario no permite usar «${label}».`);
  const conn = connections.get(target.id);
  if (conn && conn.status !== 'connected') conn.connect(); // sin esperar al backoff: reconecta ya
  if (!conn || !(await conn.whenReady(10_000))) return fail(`El servidor «${label}» no está conectado.`);
  if (!conn.tools.some((t) => t.name === name)) return fail(`La herramienta «${name}» no existe en «${label}».`);

  const started = Date.now();
  try {
    const result = await conn.callTool(name, args, CALL_TIMEOUT_MS);
    await addHistory({ ...entry, status: result?.isError ? 'error' : 'ok', ms: Date.now() - started });
    return { ok: true, result };
  } catch (err) {
    await addHistory({ ...entry, status: 'error', error: err.message, ms: Date.now() - started });
    return { ok: false, error: err.message };
  }
}

// ───────────────────────── Mutaciones (desde el popup) ─────────────────────────

function validateUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('La dirección no es válida.'); }
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('La dirección debe empezar por ws:// o wss://');
  return url.toString().replace(/\/$/, '');
}

const mutate = (fn) => withLock(async () => {
  const { servers, settings } = await loadState();
  const result = await fn(servers, settings);
  await reconcile();
  scheduleBroadcast();
  return result ?? { ok: true };
});

const mutations = {
  ADD_SERVER: ({ name, url }) => mutate(async (servers, settings) => {
    const cleanUrl = validateUrl(String(url ?? '').trim());
    const cleanName = String(name ?? '').trim() || 'mcp';
    if (servers.some((s) => s.url === cleanUrl)) throw new Error('Esa dirección ya está registrada.');
    // Por defecto solo hay 1 MCP activo: el primero que se registra.
    servers.push({
      id: crypto.randomUUID(), name: cleanName, url: cleanUrl, enabled: servers.every((s) => !s.enabled), permission: settings.defaultPermission,
    });
    await saveServers(servers);
  }),

  /** Permiso de UN MCP: allow (siempre) · ask (preguntar) · deny (no permitir). */
  SET_PERMISSION: ({ id, permission }) => mutate(async (servers) => {
    if (!PERMISSIONS.includes(permission)) throw new Error('Permiso no válido.');
    const server = servers.find((s) => s.id === id);
    if (!server) throw new Error('Servidor no encontrado.');
    server.permission = permission;
    await saveServers(servers);
  }),

  /** Mismo selector para TODOS los MCP (y para los que se añadan después). */
  SET_ALL_PERMISSIONS: ({ permission }) => mutate(async (servers, settings) => {
    if (!PERMISSIONS.includes(permission)) throw new Error('Permiso no válido.');
    servers.forEach((s) => { s.permission = permission; });
    await saveServers(servers);
    await chrome.storage.local.set({ [KEYS.settings]: { ...settings, defaultPermission: permission } });
  }),

  REMOVE_SERVER: ({ id }) => mutate(async (servers) => {
    const gone = servers.find((s) => s.id === id);
    if (gone?.auto) { // un servidor detectado que el usuario borra no vuelve a aparecer mientras siga en servers.json
      const store = await chrome.storage.local.get(KEYS.dismissed);
      await chrome.storage.local.set({ [KEYS.dismissed]: [...new Set([...(store[KEYS.dismissed] ?? []), gone.url])] });
    }
    await saveServers(servers.filter((s) => s.id !== id));
  }),

  RENAME_SERVER: ({ id, name }) => mutate(async (servers) => {
    const server = servers.find((s) => s.id === id);
    if (!server) throw new Error('Servidor no encontrado.');
    server.name = String(name ?? '').trim() || server.name;
    server.renamed = true;
    await saveServers(servers);
  }),

  TOGGLE_SERVER: ({ id, enabled }) => mutate(async (servers) => {
    const server = servers.find((s) => s.id === id);
    if (!server) throw new Error('Servidor no encontrado.');
    if (enabled && servers.filter((s) => s.enabled && s.id !== id).length >= MAX_ACTIVE_SERVERS) {
      throw new Error(`Solo puedes tener ${MAX_ACTIVE_SERVERS} servidores MCP activos a la vez.`);
    }
    server.enabled = Boolean(enabled);
    await saveServers(servers);
  }),

  UPDATE_SETTINGS: ({ settings: patch }) => mutate(async (_servers, settings) => {
    await chrome.storage.local.set({ [KEYS.settings]: { ...settings, ...patch } });
  }),
};

// ───────────────────────── Router de mensajes ─────────────────────────

/** Temporizador que NO depende de la pestaña: las pestañas ocultas frenan sus setTimeout, el service worker no. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(Number(ms) || 0, 0), 30_000)));

async function focusTab(sender) {
  const tab = sender?.tab;
  if (!tab?.id) return { ok: false, error: 'Sin pestaña.' };
  const [previous] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  const prev = previous && previous.id !== tab.id ? { tabId: previous.id, windowId: previous.windowId } : null;
  return { ok: true, prev };
}

async function restoreFocus({ prev }) {
  if (!prev) return { ok: true };
  await chrome.tabs.update(prev.tabId, { active: true }).catch(() => {});
  await chrome.windows.update(prev.windowId, { focused: true }).catch(() => {});
  return { ok: true };
}

// ------------- Puente: reiniciar y abrir servers.json (v1.5.0) -------------

const localVersion = () => chrome.runtime.getManifest?.().version ?? '0.0.0';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bridgeCanControl = () => bridge.online && (compareVersions(bridge.version, '1.4.0') ?? -1) >= 0;

function publicBridge() {
  const { servers: _servers, ...rest } = bridge;
  return { ...rest, canControl: bridgeCanControl() };
}

const OLD_BRIDGE = 'Tu puente es de una version anterior y todavia no sabe hacerlo. Ciérralo y ábrelo UNA vez con server/restart_bridge.cmd; después este botón funcionará.';

// ------------- Lanzador (v1.6.0): encender / apagar / reiniciar el puente desde el panel -------------
// Una extension no puede lanzar procesos; lo hace server/start_bridge_loop.pyw (puerto 8098), que se instala una vez.

async function launcherFetch(path, { method = 'GET', timeout = 1500 } = {}) {
  const { settings } = await loadState();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(`http://127.0.0.1:${settings.launcherPort || 8098}${path}`, { method, cache: 'no-store', signal: ctl.signal });
    let body = null;
    try { body = await res.json(); } catch { /* respuesta sin cuerpo */ }
    return { status: res.status, body };
  } finally { clearTimeout(timer); }
}

async function probeLauncher() {
  try {
    const { status, body } = await launcherFetch('/status');
    bridge.launcherOnline = status === 200 && Boolean(body?.launcher);
    bridge.paused = bridge.launcherOnline && Boolean(body?.paused);
  } catch {
    bridge.launcherOnline = false;
    bridge.paused = false;
  }
}

const NO_LAUNCHER = 'Falta el lanzador: haz doble clic en server/install.cmd (una sola vez) y podr\u00e1s encender, apagar y reiniciar el puente desde aqu\u00ed.';

/** action: 'start' | 'stop' | 'restart'. Pide la orden al lanzador y espera a ver el resultado real en el puente. */
async function controlBridge(action) {
  const before = await probeBridge(true);
  if (!before.launcherOnline) return { ok: false, noLauncher: true, error: NO_LAUNCHER };
  const oldPid = before.online ? before.pid : null;
  try {
    const { status, body } = await launcherFetch(`/${action}`, { method: 'POST', timeout: 5000 });
    if (status !== 200 || !body?.ok) return { ok: false, error: body?.error ?? 'El lanzador no acept\u00f3 la orden.' };
  } catch {
    return { ok: false, error: 'No se pudo contactar con el lanzador.' };
  }
  const wantOnline = action !== 'stop';
  const end = Date.now() + (wantOnline ? 30_000 : 15_000);
  while (Date.now() < end) {
    await delay(700);
    const probe = await probeBridge(true);
    if (!wantOnline) {
      if (!probe.online) { scheduleBroadcast(); return { ok: true, stopped: true }; }
    } else if (probe.online && (action !== 'restart' || oldPid === null || probe.pid !== oldPid)) {
      for (const conn of connections.values()) conn.connect(); // reconecta ya, sin esperar al backoff
      await discoverServers(true).catch(() => {});
      scheduleBroadcast();
      return { ok: true, pid: probe.pid, supervised: probe.supervised, configError: probe.configError };
    }
  }
  return {
    ok: false,
    error: wantOnline ? 'El puente no volvi\u00f3 a encenderse en 30 segundos. Revisa server/bridge.log.' : 'El puente no se apag\u00f3 en 15 segundos.',
  };
}
async function restartBridge() {
  const before = await probeBridge(true);
  if (before.launcherOnline && (!before.online || !bridgeCanControl())) return controlBridge('restart');
  if (!before.online) {
    return { ok: false, error: 'El puente no está encendido, así que no hay nada que reiniciar desde aquí. Ábrelo con server/start_bridge_loop.pyw.' };
  }
  if (!bridgeCanControl()) return { ok: false, error: OLD_BRIDGE };
  const oldPid = before.pid;
  try {
    const { status, body } = await bridgeFetch('/restart', { method: 'POST', timeout: 4000 });
    if (status !== 200 || !body?.ok) return { ok: false, error: body?.error ?? 'El puente no aceptó el reinicio.' };
  } catch {
    return { ok: false, error: 'No se pudo contactar con el puente.' };
  }
  // Espera a que vuelva con OTRO proceso (otro pid): así sabemos que arrancó de cero y no es el viejo cerrándose.
  const end = Date.now() + 30_000;
  let after = null;
  while (Date.now() < end) {
    await delay(700);
    const probe = await probeBridge(true);
    if (probe.online && probe.pid !== oldPid) { after = probe; break; }
  }
  if (!after) return { ok: false, error: 'El puente no volvió a encenderse en 30 segundos. Revisa server/bridge.log o ábrelo con start_bridge_loop.pyw.' };
  for (const conn of connections.values()) conn.connect(); // reconecta ya, sin esperar al backoff
  await discoverServers(true).catch(() => {});
  scheduleBroadcast();
  return { ok: true, pid: after.pid, supervised: after.supervised, configError: after.configError };
}

async function openConfig() {
  const info = await probeBridge(true);
  if (!info.online) {
    return { ok: false, offline: true, path: info.config, error: 'El puente no está encendido, así que no puedo abrir el archivo por ti.' };
  }
  try {
    const { status, body } = await bridgeFetch('/open-config', { method: 'POST', timeout: 4000 });
    if (status === 404) return { ok: false, path: info.config, error: OLD_BRIDGE };
    if (status !== 200 || !body?.ok) return { ok: false, path: info.config, error: body?.error ?? 'No se pudo abrir el archivo.' };
    return { ok: true, path: body.path ?? info.config };
  } catch {
    return { ok: false, path: info.config, error: 'No se pudo contactar con el puente.' };
  }
}

// ------------- Avisos del autor (v1.5.0) -------------
// Un notices.json publico en GitHub. Solo se muestra texto y un enlace; nunca se descarga ni se ejecuta nada.

const readNoticesRecord = async () => (await chrome.storage.local.get(KEYS.notices))[KEYS.notices] ?? null;
const readNotices = async () => publicNotices(await readNoticesRecord());

function notifyNotice(notice) {
  try {
    chrome.notifications?.create?.(`wmb-notice:${notice.id}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: notice.title,
      message: notice.message || 'Abre Web MCP Bridge para ver los detalles.',
      priority: notice.level === 'warning' ? 1 : 0,
    }, () => {
      if (chrome.runtime.lastError) console.warn('[WMB] notificacion de aviso no mostrada:', chrome.runtime.lastError.message);
    });
  } catch { /* sin permiso de notificaciones */ }
}

async function fetchNoticesFeed() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    // El parametro t evita la cache de GitHub (raw.githubusercontent guarda ~5 min) para ver los avisos nuevos enseguida.
    const res = await fetch(`${NOTICES_URL}?t=${Date.now()}`, { cache: 'no-store', credentials: 'omit', signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (new URL(res.url || NOTICES_URL).hostname !== new URL(NOTICES_URL).hostname) throw new Error('Respuesta de un sitio inesperado.');
    const text = await res.text();
    if (text.length > NOTICES_MAX_BYTES) throw new Error('El archivo de avisos es demasiado grande.');
    return JSON.parse(text);
  } finally { clearTimeout(timer); }
}

let noticesRun = null;
function checkNotices(force = false) {
  if (noticesRun) return noticesRun;
  noticesRun = runNoticesCheck(force).finally(() => { noticesRun = null; });
  return noticesRun;
}

async function failNotices(message) {
  await withLock(async () => {
    const prev = (await readNoticesRecord()) ?? { items: [], read: [], dismissed: [], notified: [] };
    // Conserva los ultimos avisos buenos y reintenta en ~5 min en lugar de esperar el ciclo completo.
    await chrome.storage.local.set({ [KEYS.notices]: { ...prev, checkedAt: Date.now() - NOTICES_EVERY_MS + NOTICES_RETRY_MS, error: message } });
  });
  return { ok: false, error: message };
}

async function runNoticesCheck(force) {
  const { settings } = await loadState();
  if (!force && settings.showNotices === false) return { ok: true, skipped: true };
  if (!force) {
    const prev = await readNoticesRecord();
    if (Date.now() - (prev?.checkedAt ?? 0) < NOTICES_EVERY_MS) return { ok: true, throttled: true };
  }
  let feed;
  try {
    feed = await fetchNoticesFeed();
  } catch (err) {
    const reason = err?.name === 'AbortError' ? 'sin respuesta' : err instanceof SyntaxError ? 'el archivo no es un JSON válido' : (err?.message ?? 'error');
    return failNotices(`No se pudieron consultar los avisos (${reason}).`);
  }
  const parsed = normalizeFeed(feed, { version: localVersion() });
  if (!parsed.ok) return failNotices(parsed.error);

  const result = await withLock(async () => {
    const latest = await readNoticesRecord(); // se relee dentro del candado: no pisa lo que el usuario marcó mientras se descargaba
    const { record, toNotify } = mergeFeed(latest, parsed.items);
    await chrome.storage.local.set({ [KEYS.notices]: record });
    return { record, toNotify };
  });
  if (settings.showNotices !== false) result.toNotify.slice(0, 3).forEach(notifyNotice);
  await updateBadge(settings.bridgeEnabled).catch(() => {});
  return { ok: true, count: parsed.items.length, skipped: parsed.skipped, notices: publicNotices(result.record) };
}

async function markNoticesRead(ids, { dismiss = false } = {}) {
  await withLock(async () => {
    const rec = await readNoticesRecord();
    if (!rec) return;
    const targets = ids === 'all' ? rec.items.map((n) => n.id) : (Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []);
    rec.read = [...new Set([...(rec.read ?? []), ...targets])];
    if (dismiss) rec.dismissed = [...new Set([...(rec.dismissed ?? []), ...targets])];
    await chrome.storage.local.set({ [KEYS.notices]: rec });
  });
  updateBadge((await loadState()).settings.bridgeEnabled).catch(() => {});
  return { ok: true, notices: await readNotices() };
}

chrome.notifications?.onClicked?.addListener(async (id) => {
  if (!String(id).startsWith('wmb-notice:')) return;
  const noticeId = String(id).slice('wmb-notice:'.length);
  const rec = await readNoticesRecord().catch(() => null);
  const link = safeLink(rec?.items?.find((n) => n.id === noticeId)?.url);
  if (link) chrome.tabs.create({ url: link });
  await markNoticesRead([noticeId]).catch(() => {});
  chrome.notifications.clear(id);
});

/** Tras instalar o actualizar la extension, las pestañas de chat que ya estaban abiertas reciben los scripts nuevos sin recargar. */
async function reinjectContentScripts() {
  if (!chrome.scripting?.executeScript) return;
  for (const cs of chrome.runtime.getManifest?.().content_scripts ?? []) {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: cs.matches }); } catch { continue; }
    for (const tab of tabs) {
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: cs.js }); } catch { /* pestaña cerrada o sin acceso */ }
    }
  }
}
async function handleMessage(msg, sender) {
  if (mutations[msg.type]) return mutations[msg.type](msg);
  switch (msg.type) {
    case 'SLEEP': await sleep(msg.ms); return { ok: true };
    case 'FOCUS_TAB': return focusTab(sender);
    case 'RESTORE_FOCUS': return restoreFocus(msg);
    case 'GET_STATE': return getSnapshot();
    case 'GET_ACTIVE_TOOLS': return getActiveTools();
    case 'CALL_TOOL': return callTool(msg);
    case 'DISCOVER':
      if (msg.reset) await chrome.storage.local.remove(KEYS.dismissed);
      return discoverServers(true);
    case 'GET_NOTICES': return { ok: true, notices: await readNotices() };
    case 'CHECK_NOTICES': return checkNotices(true);
    case 'READ_NOTICES': return markNoticesRead(msg.ids ?? 'all');
    case 'DISMISS_NOTICE': return markNoticesRead([msg.id], { dismiss: true });
    case 'RESTART_BRIDGE': return restartBridge();
    case 'START_BRIDGE': return controlBridge('start');
    case 'STOP_BRIDGE': return controlBridge('stop');
    case 'OPEN_CONFIG': return openConfig();
    case 'PROBE_BRIDGE': await probeBridge(true); return { ok: true, bridge: publicBridge() };
    case 'GET_HISTORY': {
      const data = await chrome.storage.local.get(KEYS.history);
      return { ok: true, history: data[KEYS.history] ?? [] };
    }
    case 'CLEAR_HISTORY':
      await chrome.storage.local.remove(KEYS.history);
      return { ok: true };
    case 'RECONNECT':
      connections.get(msg.id)?.close();
      connections.delete(msg.id);
      await reconcile();
      return { ok: true };
    default:
      return { ok: false, error: `Mensaje desconocido: ${msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err?.message ?? String(err) }));
  return true; // respuesta asíncrona
});

// ───────────────────────── Ciclo de vida ─────────────────────────

// La extensión se instala SIN ningún MCP: cada usuario añade los suyos (astrax_mcp u otros) desde el popup.
chrome.runtime.onInstalled.addListener(async (details) => {
  const { servers } = await loadState();                 // ya descarta los marcadores sin direccion de la 1.1
  await saveServers(servers);
  await chrome.storage.local.remove(LEGACY_STORAGE_KEYS).catch(() => {});
  await reconcile();
  if (details?.reason === 'install' || details?.reason === 'update') reinjectContentScripts().catch(() => {});
  if (details?.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') }).catch(() => {});
  checkNotices().catch(() => {});
});
// Red de seguridad: si el SW se duerme, la alarma lo despierta y reconecta.
chrome.alarms.create('wmb-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'wmb-keepalive') { reconcile().catch(() => {}); discoverServers().catch(() => {}); checkNotices().catch(() => {}); }
});

reconcile().then(() => discoverServers(true)).catch((err) => console.error('[WMB] reconcile', err));
chrome.storage.local.remove(LEGACY_STORAGE_KEYS).catch(() => {});
checkNotices().catch(() => {});

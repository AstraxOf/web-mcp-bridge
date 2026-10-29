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
  STORAGE_KEYS as KEYS, DEFAULT_SETTINGS, MAX_ACTIVE_SERVERS,
  CALL_TIMEOUT_MS, HISTORY_LIMIT, SUPPORTED_URL_PATTERNS, PERMISSIONS,
} from '../shared/constants.js';

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
  await chrome.action.setBadgeText({ text: enabled ? '' : 'OFF' });
  await chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
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
  const { servers, settings } = await loadState();
  const slugs = assignSlugs(servers);
  return {
    ok: true,
    settings,
    max: MAX_ACTIVE_SERVERS,
    servers: servers.map((s) => {
      const conn = connections.get(s.id);
      return {
        ...s,
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
    await saveServers(servers.filter((s) => s.id !== id));
  }),

  RENAME_SERVER: ({ id, name }) => mutate(async (servers) => {
    const server = servers.find((s) => s.id === id);
    if (!server) throw new Error('Servidor no encontrado.');
    server.name = String(name ?? '').trim() || server.name;
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

async function handleMessage(msg, sender) {
  if (mutations[msg.type]) return mutations[msg.type](msg);
  switch (msg.type) {
    case 'SLEEP': await sleep(msg.ms); return { ok: true };
    case 'FOCUS_TAB': return focusTab(sender);
    case 'RESTORE_FOCUS': return restoreFocus(msg);
    case 'GET_STATE': return getSnapshot();
    case 'GET_ACTIVE_TOOLS': return getActiveTools();
    case 'CALL_TOOL': return callTool(msg);
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
chrome.runtime.onInstalled.addListener(async () => {
  const { servers } = await loadState();                 // ya descarta los marcadores sin dirección de la 1.1
  await saveServers(servers);
  await reconcile();
});

// Red de seguridad: si el SW se duerme, la alarma lo despierta y reconecta.
chrome.alarms.create('wmb-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'wmb-keepalive') reconcile().catch(() => {});
});

reconcile().catch((err) => console.error('[WMB] reconcile', err));

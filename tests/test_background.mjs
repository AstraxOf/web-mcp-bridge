// Pruebas del service worker (permisos, MCP por defecto, migración) con la API de Chrome simulada.
import assert from 'node:assert/strict';

// ───────── Mocks de chrome.* y WebSocket ─────────
const store = {};
const focusLog = [];
let onMessage;
let installed;
const realWarn = console.warn;
console.warn = () => {}; // los errores esperados del registro no ensucian la salida
globalThis.chrome = {
  storage: { local: {
    get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, structuredClone(store[k])])),
    set: async (obj) => { Object.assign(store, structuredClone(obj)); },
    remove: async (key) => { delete store[key]; },
  } },
  runtime: { onMessage: { addListener: (fn) => { onMessage = fn; } }, onInstalled: { addListener: (fn) => { installed = fn; } } },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  tabs: {
    query: async () => [{ id: 7, windowId: 70 }], sendMessage: async () => {},
    update: async (tabId, props) => { focusLog.push(['tab', tabId, props.active]); },
  },
  windows: { update: async (windowId, props) => { focusLog.push(['win', windowId, props.focused]); } },
};
class FakeWebSocket {
  static OPEN = 1; static CONNECTING = 0;
  constructor(url) { this.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 5); }
  send(raw) {
    const msg = JSON.parse(raw);
    if (msg.id === undefined) return;
    const results = {
      initialize: { serverInfo: { name: 'fake' } },
      'tools/list': { tools: [{ name: 'astrax_ver_pantalla', description: 'ver', inputSchema: { type: 'object', properties: {} } }] },
      'tools/call': { content: [{ type: 'image', data: 'QUJD', mimeType: 'image/jpeg' }] },
      ping: {},
    };
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: results[msg.method] ?? {} }) }), 2);
  }
  close() { this.readyState = 3; this.onclose?.(); }
}
globalThis.WebSocket = FakeWebSocket;

const call = (msg, sender) => new Promise((resolve) => onMessage(msg, sender, resolve));
await import('../background/background.js');

// 1) Instalación limpia: NINGÚN MCP (astrax_mcp es del usuario, no una integración nativa)
await installed();
let state = await call({ type: 'GET_STATE' });
assert.equal(state.servers.length, 0);
assert.equal((await call({ type: 'GET_ACTIVE_TOOLS' })).tools.length, 0);

// 1b) Un marcador sin dirección de la 1.1 se descarta al actualizar
await chrome.storage.local.set({ wmb_servers: [{ id: 'old', name: 'astrax_mcp', url: '', enabled: false, permission: 'ask' }] });
await installed();
assert.equal((await call({ type: 'GET_STATE' })).servers.length, 0);

// 2) El usuario añade el suyo y se conecta
assert.equal((await call({ type: 'ADD_SERVER', name: 'astrax_mcp', url: 'ws://localhost:8080' })).ok, true);
const id = (await call({ type: 'GET_STATE' })).servers[0].id;
await new Promise((r) => setTimeout(r, 60));
state = await call({ type: 'GET_STATE' });
assert.equal(state.servers[0].enabled, true);
assert.equal(state.servers[0].status, 'connected');
assert.equal(state.servers[0].permission, 'ask');
assert.equal(state.servers[0].slug, 'astrax_mcp');

// 3) Permiso «ask»: hay herramientas; la imagen llega íntegra desde el MCP
let tools = await call({ type: 'GET_ACTIVE_TOOLS' });
assert.equal(tools.tools.length, 1);
let res = await call({ type: 'CALL_TOOL', server: 'astrax_mcp', name: 'astrax_ver_pantalla', arguments: {} });
assert.equal(res.result.content[0].type, 'image');
assert.equal(res.result.content[0].data, 'QUJD');

// 4) Selector global y por MCP
assert.equal((await call({ type: 'SET_ALL_PERMISSIONS', permission: 'allow' })).ok, true);
state = await call({ type: 'GET_STATE' });
assert.equal(state.servers[0].permission, 'allow');
assert.equal(state.settings.defaultPermission, 'allow');
assert.match((await call({ type: 'SET_PERMISSION', id, permission: 'siempre' })).error, /no válido/);

// 5) Un MCP añadido después hereda el permiso global
assert.equal((await call({ type: 'ADD_SERVER', name: 'otro', url: 'ws://localhost:9001' })).ok, true);
state = await call({ type: 'GET_STATE' });
assert.equal(state.servers.find((s) => s.name === 'otro').permission, 'allow');

// 6) «No permitir»: sin herramientas para la IA y llamada bloqueada también en el background
await call({ type: 'SET_PERMISSION', id, permission: 'deny' });
tools = await call({ type: 'GET_ACTIVE_TOOLS' });
assert.equal(tools.tools.length, 0);
res = await call({ type: 'CALL_TOOL', server: 'astrax_mcp', name: 'astrax_ver_pantalla', arguments: {} });
assert.equal(res.ok, false);
assert.match(res.error, /no permite/);

// 7) Migración desde 1.0: autoExecute=true → permiso «allow»; sin él → «ask»
await chrome.storage.local.set({ wmb_settings: { autoExecute: true }, wmb_servers: [{ id: 'old', name: 'astrax-mcp', url: 'ws://localhost:8080', enabled: true }] });
state = await call({ type: 'GET_STATE' });
assert.equal(state.servers[0].permission, 'allow');
assert.equal(state.servers[0].slug, 'astrax-mcp', 'el id conserva el guion medio del nombre');
await chrome.storage.local.set({ wmb_settings: {} });
state = await call({ type: 'GET_STATE' });
assert.equal(state.servers[0].permission, 'ask');

// 8) Temporizador del service worker (no se congela con la pestaña oculta) y «despertar» de pestaña con vuelta a la anterior
const t0 = Date.now();
assert.equal((await call({ type: 'SLEEP', ms: 80 })).ok, true);
assert.ok(Date.now() - t0 >= 70);
const focus = await call({ type: 'FOCUS_TAB' }, { tab: { id: 3, windowId: 30 } });
assert.deepEqual(focus.prev, { tabId: 7, windowId: 70 });
await call({ type: 'RESTORE_FOCUS', prev: focus.prev });
assert.deepEqual(focusLog, [['tab', 3, true], ['win', 30, true], ['tab', 7, true], ['win', 70, true]]);

// 8b) Herramientas desactivadas por el usuario: la IA no las ve ni puede ejecutarlas
await call({ type: 'UPDATE_SETTINGS', settings: { bridgeEnabled: true } });
await call({ type: 'ADD_SERVER', name: 'herramientas', url: 'ws://localhost:9911' });
state = await call({ type: 'GET_STATE' });
const nuevo = state.servers.find((s) => s.name === 'herramientas');
for (const s of state.servers) if (s.enabled && s.id !== nuevo.id) await call({ type: 'TOGGLE_SERVER', id: s.id, enabled: false });
await call({ type: 'TOGGLE_SERVER', id: nuevo.id, enabled: true });
await call({ type: 'SET_PERMISSION', id: nuevo.id, permission: 'allow' });
await call({ type: 'GET_ACTIVE_TOOLS' }); // conecta y espera las herramientas
state = await call({ type: 'GET_STATE' });
const conTools = state.servers.find((s) => s.id === nuevo.id);
assert.ok(conTools.toolCount > 0, 'hay un MCP conectado con herramientas');
const nombre = conTools.tools[0].name;
assert.equal((await call({ type: 'SET_TOOLS_ENABLED', id: conTools.id, names: [nombre], enabled: false })).ok, true);
state = await call({ type: 'GET_STATE' });
const tras = state.servers.find((s) => s.id === conTools.id);
assert.equal(tras.tools.find((t) => t.name === nombre).enabled, false);
assert.equal(tras.toolCount, tras.totalTools - 1);
assert.ok(!(await call({ type: 'GET_ACTIVE_TOOLS' })).tools.some((t) => t.name === nombre), 'la IA no la ve');
const bloqueada = await call({ type: 'CALL_TOOL', server: tras.slug, name: nombre, arguments: {} });
assert.equal(bloqueada.ok, false);
assert.match(bloqueada.error, /desactivada por el usuario/);
await call({ type: 'SET_TOOLS_ENABLED', id: conTools.id, enabled: true }); // todas de nuevo
assert.ok((await call({ type: 'GET_ACTIVE_TOOLS' })).tools.some((t) => t.name === nombre));

// 8c) Plataformas: una configuración antigua sin `platforms` se completa con todas activas
assert.deepEqual(state.settings.platforms, { chatgpt: true, gemini: true, claude: true, deepseek: true, mistral: true, kimi: true, webllm: true });
await call({ type: 'UPDATE_SETTINGS', settings: { platforms: { ...state.settings.platforms, gemini: false } } });
assert.equal((await call({ type: 'GET_STATE' })).settings.platforms.gemini, false);

// 9) Registro de eventos: llamadas, cambios de configuración y eventos del chat; recorte de textos y borrado
let logs = (await call({ type: 'GET_LOGS' })).logs;
const events = new Set(logs.map((l) => l.event));
for (const e of ['sw.start', 'server.connected', 'tool.call', 'action.set_permission', 'action.add_server']) assert.ok(events.has(e), `falta el evento ${e}`);
assert.ok(logs.some((l) => l.event === 'tool.call' && l.level === 'error'), 'una llamada bloqueada se registra como error');
assert.ok(!events.has('action.get_state') && !events.has('action.sleep'), 'las consultas frecuentes no se registran');
await call({ type: 'LOG', level: 'warn', event: 'chat.panel', platform: 'deepseek', details: { message: 'x'.repeat(1000) } }, { tab: { id: 1 } });
logs = (await call({ type: 'GET_LOGS' })).logs;
const fromChat = logs.at(-1);
assert.equal(fromChat.source, 'content');
assert.equal(fromChat.platform, 'deepseek');
assert.ok(fromChat.details.message.length < 400, 'los textos largos se recortan');
assert.equal((await call({ type: 'CLEAR_LOGS' })).ok, true);
logs = (await call({ type: 'GET_LOGS' })).logs;
assert.deepEqual(logs.map((l) => l.event), ['logs.cleared']);

console.warn = realWarn;
console.log('✔ test_background: todo correcto');
process.exit(0); // el keepalive del service worker mantiene vivo el proceso

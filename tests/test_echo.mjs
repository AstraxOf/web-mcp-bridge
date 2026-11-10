// Prueba del ECO: una llamada MCP vieja NO debe volver a ejecutarse cuando la IA no ha escrito nada nuevo.
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
globalThis.location = { pathname: '/c/t', href: 'http://x/c/t' };
globalThis.sessionStorage = { getItem: () => null, setItem() {} };
globalThis.document = { body: {}, hidden: false, addEventListener() {}, removeEventListener() {}, hasFocus: () => true };
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };

let messages = [];
const mk = (t) => ({ textContent: t, closest: () => null, getAttribute: () => null });
const hash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return String(h); };
globalThis.WMB = {
  sleep: (ms) => sleep(Math.min(ms, 5)),
  waitFor: async (fn) => fn() || null,
  isBackground: () => false,
  bg: async () => ({}),
  hash,
  firstVisible: () => null,
  allMatches: () => messages,
  exists: () => false,
  extractMcpCalls: (t) => [...String(t).matchAll(/CALL:(\w+)/g)].map((m) => ({ name: m[1] })),
  extensionAlive: () => true,
  dom: { getText: () => '', setText: async () => true, purgeStale: async () => false },
};
await import('../content_scripts/adapters/base_adapter.js');

const adapter = new WMB.BaseAdapter({ id: 't', name: 'T', selectors: { composer: ['c'], sendButton: ['s'], assistantMessages: ['a'], stopButton: ['x'] } });
const fired = [];
messages = [mk('hola')];
const stop = adapter.observeResponses((d) => fired.push(d.malformed ? 'bad' : d.call.name));
adapter.baselineUntil = 0;
const settle = () => sleep(60);
const delivered = () => { adapter.deliveries += 1; adapter.lastDeliveryAt = Date.now(); adapter.msgsAtDelivery = messages.length; adapter.genSinceDelivery = false; adapter.markActivity(); };

// 1) llamada nueva tras un envio del usuario -> se ejecuta
adapter.markActivity();
messages.push(mk('voy a leer. CALL:a'));
await settle();
assert.deepEqual(fired, ['a'], 'la llamada nueva debe ejecutarse una vez');

// 2) ECO: se entrega el resultado y la IA aun no escribio nada nuevo, pero algo marca "ya contesto" -> NO se re-ejecuta la vieja
delivered();
adapter.genSinceDelivery = true;
adapter.rescan();
await settle();
assert.deepEqual(fired, ['a'], 'ECO: la llamada vieja se volvio a ejecutar sin mensaje nuevo');

// 3) la pagina se repinta (elementos nuevos, mismo texto) -> tampoco
adapter.markActivity();
messages = messages.map((m) => mk(m.textContent));
adapter.genSinceDelivery = true;
adapter.rescan();
await settle();
assert.deepEqual(fired, ['a'], 'ECO: un repintado volvio a ejecutar la llamada vieja');

// 4) mensaje realmente nuevo con otra llamada -> se ejecuta
messages.push(mk('listo, sigo. CALL:b'));
await settle();
assert.deepEqual(fired, ['a', 'b']);

// 5) la IA repite la MISMA llamada en un mensaje nuevo (un solo mensaje mas) -> repeticion real, se ejecuta
delivered();
messages.push(mk('listo, sigo. CALL:b'));
await settle();
assert.deepEqual(fired, ['a', 'b', 'b'], 'una repeticion legitima (mensaje nuevo) debe ejecutarse');

// 6) bloque a medias: NO es 'ilegible' hasta que el texto lleve un rato quieto (la IA puede seguir escribiendo)
WMB.looksMalformed = (x) => /CALLBAD/.test(x);
adapter.malformedStableMs = 400;
adapter.markActivity();
messages.push(mk('CALLBAD a medias'));
await sleep(150);
assert.equal(fired.filter((x) => x === 'bad').length, 0, 'se aviso de bloque ilegible mientras la IA aun escribia');
await sleep(600);
assert.equal(fired.filter((x) => x === 'bad').length, 1, 'tras quedar quieto debia avisar una vez');

stop();
console.log('✔ test_echo: todo correcto');
process.exit(0);
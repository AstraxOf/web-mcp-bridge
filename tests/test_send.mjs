// Prueba de los 3 envíos automáticos de BaseAdapter.sendToolResult con un «chat» simulado (sin navegador).
import assert from 'node:assert/strict';

// ---- entorno mínimo ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Ev { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }
globalThis.KeyboardEvent = Ev;
globalThis.InputEvent = Ev;
globalThis.location = { pathname: '/c/test' };
globalThis.sessionStorage = { getItem: () => null, setItem() {} };
globalThis.document = { body: {}, hidden: false, addEventListener() {}, hasFocus: () => true };
globalThis.window = { addEventListener() {} };

let composer;
let button;
const behavior = { click: 'clear', enter: 'none', ctrl: 'none', form: 'none' };
const log = [];

const WMB = {
  sleep,
  // timeouts reducidos para que la prueba sea rápida
  waitFor: async (fn, { timeout = 3000, interval = 100 } = {}) => {
    const end = Date.now() + Math.min(timeout, 120);
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(Math.min(interval, 15)); }
    return fn() || null;
  },
  isBackground: () => false,
  bg: async () => ({}),
  hash: (s) => String(s).length,
  firstVisible: (sel) => (sel[0] === 'composer' ? composer : button),
  allMatches: () => [],
  exists: () => false,
  extractMcpCalls: () => [],
  extensionAlive: () => true,
  dom: {
    getText: (el) => el.value,
    setText: async (el, text, { append = true } = {}) => { el.value = append ? el.value + text : text; return true; },
    purgeStale: async () => false,
  },
};
globalThis.WMB = WMB;
await import('../content_scripts/adapters/base_adapter.js');

function reset(opts) {
  Object.assign(behavior, { click: 'none', enter: 'none', ctrl: 'none', form: 'none' }, opts);
  log.length = 0;
  const apply = (how) => {
    if (how === 'clear') composer.value = '';
    else if (how === 'late') setTimeout(() => { composer.value = ''; }, 220); // se vacía DESPUÉS de que el primer intento diera por fallida la confirmación
  };
  composer = {
    value: '',
    focus() {},
    closest: () => ({ requestSubmit: () => { log.push('form'); apply(behavior.form); } }),
    dispatchEvent(ev) {
      if (ev.type === 'keydown' && ev.key === 'Enter') {
        if (ev.ctrlKey) { log.push('ctrl'); apply(behavior.ctrl); } else { log.push('enter'); apply(behavior.enter); }
      }
    },
  };
  button = { disabled: false, getAttribute: () => null, click: () => { log.push('click'); apply(behavior.click); } };
}

const adapter = new WMB.BaseAdapter({ id: 't', name: 'T', selectors: { composer: ['composer'], sendButton: ['send'], assistantMessages: ['a'], stopButton: ['stop'] } });
const TEXT = '[MCP_RESULT server=x tool=y status=ok]\nhola mundo\n[/MCP_RESULT]';

// 1) el botón funciona a la primera
reset({ click: 'clear' });
let r = await adapter.sendToolResult(TEXT);
assert.equal(r.ok, true); assert.deepEqual(log, ['click']);

// 2) el botón no hace nada, Enter sí -> segundo intento
reset({ enter: 'clear' });
r = await adapter.sendToolResult(TEXT);
assert.equal(r.ok, true); assert.ok(log.includes('enter') && !log.includes('ctrl'), `log=${log}`);

// 3) solo Ctrl+Enter funciona -> tercer intento
reset({ ctrl: 'clear' });
r = await adapter.sendToolResult(TEXT);
assert.equal(r.ok, true); assert.ok(log.includes('ctrl'), `log=${log}`);

// 4) solo el formulario funciona (tercer intento, tras Ctrl+Enter)
reset({ form: 'clear' });
r = await adapter.sendToolResult(TEXT);
assert.equal(r.ok, true); assert.ok(log.includes('form'), `log=${log}`);

// 5) nada funciona -> falla tras 3 intentos y el texto sigue en el cuadro (no se pierde)
reset({});
r = await adapter.sendToolResult(TEXT);
assert.equal(r.ok, false); assert.match(r.error, /3 intentos/);
assert.ok(composer.value.includes('hola mundo'));

// 6) confirmación lenta: el texto sale del cuadro tarde -> NO se reenvía por segunda vez
reset({ click: 'late' });
r = await adapter.sendToolResult(TEXT);
assert.equal(r.ok, true); assert.deepEqual(log, ['click'], `no debe duplicar el envío: ${log}`);

// 7) hasReacted: sin respuesta nueva = false; con mensaje nuevo o generando = true
reset({ click: 'clear' });
await adapter.sendToolResult(TEXT);
assert.equal(adapter.hasReacted(), false);
adapter.genSinceDelivery = true;
assert.equal(adapter.hasReacted(), true);

console.log('✔ test_send: todo correcto');

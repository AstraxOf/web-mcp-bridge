// Pruebas del receptor de lotes del registro (setLogSink) sin navegador: chrome.storage simulado.
import assert from 'node:assert/strict';

const store = {};
globalThis.chrome = { storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => { Object.assign(store, o); } } } };
const { log, flushLogs, setLogSink } = await import('../background/logger.js');

const recibidos = [];
setLogSink((lote) => recibidos.push(...lote));
log('info', 'tool.call', { server: 'autocad-mcp', tool: 'dibujar', status: 'ok', ms: 10 });
log('warn', 'call.unreadable', { problem: 'json' });
await flushLogs();
assert.deepEqual(recibidos.map((e) => e.event), ['tool.call', 'call.unreadable'], 'el receptor recibe cada lote ya guardado');
assert.equal(recibidos[0].details.tool, 'dibujar');

// un receptor que falla no rompe el registro
setLogSink(() => { throw new Error('boom'); });
log('info', 'x.y', {});
await flushLogs();
assert.equal(Object.values(store)[0].length, 3, 'el registro sigue guardando');

// quitar el receptor
setLogSink(null);
log('info', 'z.z', {});
await flushLogs();
assert.equal(recibidos.length, 2);
console.log('✔ test_audit: todo correcto');

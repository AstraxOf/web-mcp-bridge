// Pruebas del listado unificado de actividad (registro + historial) del popup.
import assert from 'node:assert/strict';
import { categoryOf, mergeActivity, matchesFilter, titleOf, summaryOf, statusOf, fmtMs } from '../shared/activity.js';

assert.equal(categoryOf('call.exec.end'), 'call');
assert.equal(categoryOf('tool.call'), 'call');
assert.equal(categoryOf('ai.no_response'), 'ai');
assert.equal(categoryOf('sync.check'), 'sync');
assert.equal(categoryOf('server.down'), 'server');
assert.equal(categoryOf('algo.raro'), 'system');

const logs = [
  { ts: 1000, level: 'info', source: 'content', event: 'call.detected', platform: 'deepseek', details: { cid: 'ab12', server: 'repo-github', tool: 'git_push', args: '{"branch":"main"}' } },
  { ts: 1100, level: 'warn', source: 'content', event: 'call.skipped', platform: 'deepseek', details: { reason: 'baseline', tool: 'git_push' } },
  { ts: 1200, level: 'info', source: 'background', event: 'tool.call', details: { server: 'repo-github', tool: 'git_push', status: 'ok', ms: 2300 } },
  { ts: 1300, level: 'warn', source: 'content', event: 'ai.no_response', platform: 'deepseek', details: { cid: 'ab12', waitedMs: 45000 } },
  { ts: 1400, level: 'info', source: 'content', event: 'chat.panel', details: { message: 'Resultado enviado a DeepSeek.' } },
];
const history = [
  { ts: 1250, server: 'repo-github', tool: 'git_push', status: 'ok', ms: 2300, args: '{}' },   // duplicada del tool.call → no se repite
  { ts: 500, server: 'autocad', tool: 'dibujar', status: 'error', error: 'COM ocupado', ms: 80 },
];
const items = mergeActivity(logs, history);
assert.equal(items.length, 6, 'la llamada del historial que ya está en el registro no se duplica');
assert.deepEqual(items.map((i) => i.ts), [1400, 1300, 1200, 1100, 1000, 500], 'lo más reciente primero');
assert.equal(items.at(-1).level, 'error');

assert.equal(titleOf(logs[4]), 'Resultado enviado a DeepSeek.');
assert.equal(titleOf(logs[0]), 'Llamada detectada');
assert.match(summaryOf(logs[0]), /repo-github › git_push · args: /);
assert.ok(!summaryOf(logs[0]).includes('cid'), 'el id va en su propia insignia');
assert.deepEqual(statusOf(logs[2]), { tone: 'ok', text: 'OK' });
assert.deepEqual(statusOf(logs[3]), { tone: 'warn', text: 'Aviso' });
assert.equal(statusOf(logs[0]), null);

const f = (filter, query = '') => items.filter((i) => matchesFilter(i, filter, query)).length;
assert.equal(f('all'), 6);
assert.equal(f('ai'), 1);
assert.equal(f('calls'), 4);               // detected + skipped + tool.call + autocad del historial
assert.equal(f('errors'), 3);              // skipped (warn) + no_response (warn) + error del historial
assert.equal(f('all', '#ab12'), 2);        // por id de llamada
assert.equal(f('all', 'baseline'), 1);
assert.equal(f('calls', 'autocad'), 1);

assert.equal(fmtMs(80), '80 ms');
assert.equal(fmtMs(2300), '2.3 s');
assert.equal(fmtMs(45000), '45 s');
console.log('✔ test_activity: todo correcto');

// Las llamadas «descartadas» por duplicado dicen qué pasó de verdad
assert.match(titleOf({ event: 'call.skipped', details: { reason: 'duplicate', seenHere: true } }), /Ya ejecutada/);
assert.match(titleOf({ event: 'call.skipped', details: { reason: 'duplicate', seenHere: false } }), /se te pregunta/);
assert.equal(titleOf({ event: 'call.skipped', details: { reason: 'extra_in_message' } }), 'Llamada descartada');


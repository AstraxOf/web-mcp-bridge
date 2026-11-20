// Pruebas del parser de llamadas MCP y del formateador de resultados (sin navegador).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ console, setTimeout, clearTimeout });
vm.runInContext(readFileSync(new URL('../content_scripts/utils.js', import.meta.url), 'utf8'), context);
const { WMB } = context;

// 1) Bloque de código con texto alrededor
let calls = WMB.extractMcpCalls('Voy a mirar.\n```json\n{\n "mcp_call": {"server":"astrax","name":"leer","arguments":{"ruta":"a.txt"}}\n}\n```');
assert.equal(calls.length, 1);
assert.deepEqual({ ...calls[0], arguments: { ...calls[0].arguments } }, { server: 'astrax', name: 'leer', arguments: { ruta: 'a.txt' } });

// 2) JSON incompleto (streaming) → no se detecta
assert.equal(WMB.extractMcpCalls('{"mcp_call": {"server":"a","name":"b","argum').length, 0);

// 3) Llaves y comillas dentro de strings
calls = WMB.extractMcpCalls('{"mcp_call":{"server":"s","name":"t","arguments":{"code":"if (x) { return \\"}\\"; }"}}}');
assert.equal(calls.length, 1);
assert.equal(calls[0].arguments.code, 'if (x) { return "}"; }');

// 4) Espacios no estándar (NBSP) tras el renderizado
assert.equal(WMB.extractMcpCalls('{\u00a0"mcp_call":\u00a0{"server":"s",\u00a0"name":"t"}}').length, 1);

// 5) Sin llamada
assert.equal(WMB.extractMcpCalls('Hola, el formato mcp_call sirve para herramientas.').length, 0);

// 6) Dos llamadas en el mismo mensaje
assert.equal(WMB.extractMcpCalls('{"mcp_call":{"name":"a"}} y luego {"mcp_call":{"name":"b"}}').length, 2);

// 7) Hash estable y distinto
assert.equal(WMB.hash('x'), WMB.hash('x'));
assert.notEqual(WMB.hash('x'), WMB.hash('y'));

// 8) Comillas tipográficas (algunos renderizadores las usan) y argumentos serializados como texto
assert.equal(WMB.extractMcpCalls('{“mcp_call”:{“server”:“s”,“name”:“t”,“arguments”:{“a”:1}}}').length, 1);
assert.deepEqual({ ...WMB.extractMcpCalls('{"mcp_call":{"name":"t","arguments":"{\\"a\\":1}"}}')[0].arguments }, { a: 1 });

// 8b) Barras invertidas sueltas: el Markdown del chat se come el escape (C:\\Users → C:\Users)
calls = WMB.extractMcpCalls('{"mcp_call":{"server":"fs","name":"leer","arguments":{"ruta":"C:\\Users\\Ana\\doc.txt"}}}');
assert.equal(calls.length, 1, 'ruta de Windows con barras sueltas');
assert.equal(calls[0].arguments.ruta, 'C:\\Users\\Ana\\doc.txt');
// Barra suelta fuera de ruta de Windows: se conservan los escapes válidos y se duplica la inválida
calls = WMB.extractMcpCalls('{"mcp_call":{"name":"t","arguments":{"re":"a\\d+","q":"di \\"hola\\""}}}');
assert.equal(calls.length, 1);
assert.equal(calls[0].arguments.re, 'a\\d+');
assert.equal(calls[0].arguments.q, 'di "hola"');
// Comillas tipográficas + barras sueltas a la vez
calls = WMB.extractMcpCalls('```json\n{“mcp_call”:{“server”:“fs”,“name”:“leer”,“arguments”:{“ruta”:“D:\\x\\y”}}}\n```');
assert.equal(calls.length, 1);
assert.equal(calls[0].arguments.ruta, 'D:\\x\\y');
// JSON correcto: la reparación no altera nada
assert.equal(WMB.repairJsonBackslashes('{"a":"C:\\\\Users"}'), '{"a":"C:\\\\Users"}');

// 8c) Diagnóstico de llamadas ilegibles (antes se ignoraban en silencio)
assert.equal(WMB.diagnoseMcpCall('Hola, el formato mcp_call sirve para herramientas.'), null, 'mencionar la palabra no es un intento');
assert.equal(WMB.diagnoseMcpCall('{"mcp_call":{"server":"a","name":"b","arguments":{}}}'), null, 'una llamada válida no es un problema');
assert.match(WMB.diagnoseMcpCall('{"mcp_call":{"server":"autocad","name":"lisp","arguments":{"expresion":"(progn (setq a 1)"}'), /no está cerrado/);
assert.match(WMB.diagnoseMcpCall('{"mcp_call":{"server":"autocad","name":"lisp","arguments":{"expresion":"(ssget "_X")"}}}'), /JSON inválido/);
assert.match(WMB.diagnoseMcpCall('{"mcp_call":{"server":"autocad","arguments":{}}}'), /falta «name»/);
assert.match(WMB.diagnoseMcpCall('```json\n{ "mcp_call": "estado" }\n```'), /debe ser un objeto/);

// 9) Imágenes: NUNCA se omiten, viajan como archivo adjunto (caso real de astrax_ver_pantalla)
const shot = { content: [{ type: 'image', data: 'QUJD', mimeType: 'image/jpeg' }] };
let plan = WMB.planResult(shot, { server: 'astrax_mcp', name: 'astrax_ver_pantalla', status: 'ok' });
assert.equal(plan.files.length, 1);
assert.equal(plan.files[0].mime, 'image/jpeg');
assert.equal(plan.files[0].b64, 'QUJD');
let message = plan.build(true);
assert.ok(!message.includes('omitida'), 'no debe decir «imagen omitida»');
assert.match(message, /^\[MCP_RESULT server="astrax_mcp" tool="astrax_ver_pantalla" status="ok"\]\n\[imagen adjunta a este mensaje: astrax_mcp_astrax_ver_pantalla_1\.jpg \(image\/jpeg, 1 KB\)\]\n\[\/MCP_RESULT\]$/);
assert.match(plan.build(false), /imagen NO adjuntada/); // si el chat no admite adjuntos, se avisa y se descarga

// 10) Texto + imagen + recurso + structuredContent: se conserva todo
plan = WMB.planResult({
  content: [
    { type: 'text', text: 'hola' },
    { type: 'image', data: 'QUJD', mimeType: 'image/png' },
    { type: 'audio', data: 'QUJD', mimeType: 'audio/wav' },
    { type: 'resource', resource: { uri: 'file:///a.txt', text: 'contenido' } },
    { type: 'resource', resource: { uri: 'file:///b.bin', blob: 'QUJD', mimeType: 'application/pdf' } },
    { type: 'resource_link', uri: 'https://x.test', name: 'X' },
    { type: 'raro', valor: 1 },
  ],
  structuredContent: { total: 3 },
}, { server: 's', name: 't', status: 'ok' });
message = plan.build(true);
assert.equal(plan.files.length, 3);
for (const piece of ['hola', '.png', '.wav', '[recurso file:///a.txt]\ncontenido', 'b.bin', '.pdf', '[enlace: https://x.test · X]', '{"tipo":"raro"', '"total": 3']) {
  if (piece === '{"tipo":"raro"') assert.ok(message.includes('"type":"raro"'));
  else assert.ok(message.includes(piece), `falta: ${piece}`);
}
// structuredContent duplicado en el texto no se repite
plan = WMB.planResult({ content: [{ type: 'text', text: '{"a":1}' }], structuredContent: { a: 1 } }, { server: 's', name: 't', status: 'ok' });
assert.equal(plan.build(true).split('"a"').length - 1, 1);

// structuredContent de FastMCP ({"result": "<mismo texto>"}) tampoco se repite
const estado = '{"version": "25.0s", "capas": 16}';
plan = WMB.planResult({ content: [{ type: 'text', text: estado }], structuredContent: { result: estado } }, { server: 'autocad', name: 'estado', status: 'ok' });
assert.equal(plan.build(true).split('"capas"').length - 1, 1, 'el resultado de AutoCAD no debe llegar duplicado');

// 11) Textos largos: NO se recortan; se adjuntan completos como archivo (o van enteros en línea si falla el adjunto)
const long = 'x'.repeat(5000);
plan = WMB.planResult({ content: [{ type: 'text', text: long }] }, { server: 's', name: 't', status: 'ok', maxChars: 1000 });
assert.equal(plan.files.length, 1);
assert.equal(plan.files[0].text, long);
assert.ok(plan.build(true).length < 2200);
assert.match(plan.build(true), /contenido COMPLETO en el archivo adjunto s_t_completo\.txt/);
assert.ok(plan.build(false).includes(long), 'sin adjunto, el texto completo va en línea');
assert.equal(WMB.planResult({ content: [{ type: 'text', text: 'corto' }] }, { server: 's', name: 't', status: 'ok' }).files.length, 0);

// Ritmo de envío («Messages too frequent»)
{
  const sinAzar = () => 0, maxAzar = () => 1;
  assert.equal(WMB.sendWait([], 100_000, { minSec: 2, maxSec: 5, perMin: 8 }), 0, 'primer envío: sin espera');
  assert.equal(WMB.sendWait([98_000], 100_000, { minSec: 2, maxSec: 5 }, sinAzar), 0, 'pausa de 2 s (mínimo del rango): ya pasaron');
  assert.equal(WMB.sendWait([99_000], 100_000, { minSec: 2, maxSec: 5 }, sinAzar), 1000, 'rango 2–5 con el azar al mínimo: faltan 1 s para los 2 s');
  assert.equal(WMB.sendWait([99_000], 100_000, { minSec: 2, maxSec: 5 }, maxAzar), 4000, 'con el azar al máximo: 5 s desde el último');
  assert.equal(WMB.sendWait([99_000], 100_000, { minSec: 2, maxSec: 5 }, () => 0.5), 2500, 'a mitad del rango: 3,5 s desde el último');
  assert.equal(WMB.sendWait([90_000], 100_000, { minSec: 2, maxSec: 5 }, maxAzar), 0, 'ya pasó el tiempo');
  assert.equal(WMB.sendWait([99_000], 100_000, { minSec: 5 }, maxAzar), 4000, 'sin máximo: pausa fija de 5 s');
  assert.equal(WMB.sendWait([98_000], 100_000, { minSec: 0, maxSec: 0 }), 0, '0 y 0 = sin pausa');
  for (let i = 0; i < 200; i += 1) {                                  // con azar real, siempre dentro del rango (2–5 s desde el último envío)
    const espera = WMB.sendWait([100_000], 100_000, { minSec: 2, maxSec: 5 });
    assert.ok(espera >= 2000 && espera <= 5000, `espera fuera del rango: ${espera}`);
  }
  const ocho = [50_000, 55_000, 60_000, 65_000, 70_000, 75_000, 80_000, 85_000];
  assert.equal(WMB.sendWait(ocho, 100_000, { minSec: 0, perMin: 8 }), 10_500, 'tope por minuto: espera a que salga el más antiguo');
  assert.equal(WMB.sendWait(ocho, 100_000, { minSec: 0, perMin: 0 }), 0, '0 = sin tope');
  assert.equal(WMB.sendWait([10_000, 20_000], 100_000, { minSec: 0, perMin: 2 }), 0, 'los envíos de hace más de un minuto no cuentan');
  const same = (a, e, m) => assert.equal(JSON.stringify(a), JSON.stringify(e), m);   // el objeto viene de otro contexto (vm)
  // Pausa por plataforma: la propia si es un rango válido; si no, la general
  const base = { sendPauseMinSec: 2, sendPauseMaxSec: 5, platformPauses: { aistudio: [5, 8], deepseek: null, mal: [3], raro: ['x', 4], invertido: [9, 4] } };
  same(WMB.pauseFor(base, 'aistudio'), { min: 5, max: 8 });
  same(WMB.pauseFor(base, 'deepseek'), { min: 2, max: 5 }, 'null = la general');
  same(WMB.pauseFor(base, 'gemini'), { min: 2, max: 5 }, 'sin entrada = la general');
  same(WMB.pauseFor(base, 'mal'), { min: 2, max: 5 }, 'rango incompleto = la general');
  same(WMB.pauseFor(base, 'raro'), { min: 2, max: 5 }, 'valores no numéricos = la general');
  same(WMB.pauseFor(base, 'invertido'), { min: 9, max: 9 }, 'el máximo nunca baja del mínimo');
  same(WMB.pauseFor({}, 'x'), { min: 2, max: 5 }, 'sin ajustes: 2 a 5');
  assert.equal(WMB.backoffMs(0, sinAzar), 20_000);
  assert.equal(WMB.backoffMs(2, sinAzar), 80_000);
  assert.ok(WMB.backoffMs(1, maxAzar) === 52_000);
  for (const aviso of ['Messages too frequent. Try again later.', 'Too many requests', 'Demasiados mensajes, inténtalo más tarde', 'Rate limit exceeded']) {
    assert.ok(WMB.RATE_LIMIT_RE.test(aviso), aviso);
  }
  for (const normal of ['Mensaje enviado', 'El servidor respondió OK', 'frequently asked questions']) assert.ok(!WMB.RATE_LIMIT_RE.test(normal), normal);
}

// Mensaje al reintentar un bloque ilegible: corto = problema de formato; largo = trocear
{
  const corto = WMB.unreadableCallMessage('el bloque JSON no está cerrado', 202, 1, 3, 3000);
  assert.match(corto, /NO es el tamaño/); assert.match(corto, /escapadas/); assert.doesNotMatch(corto, /append_file|trozos/);
  const largo = WMB.unreadableCallMessage('el bloque JSON no está cerrado', 5000, 1, 3, 3000);
  assert.match(largo, /append_file/); assert.match(largo, /demasiado largo/); assert.doesNotMatch(largo, /NO es el tamaño/);
  const arroba = WMB.unreadableCallMessage('falta el @@@ de cierre del contenido', 300, 2, 3, 1500);
  assert.match(arroba, /append_file/, 'con @@@ sin cerrar se trocea aunque sea corto');
}
console.log('✔ test_utils: todo correcto');

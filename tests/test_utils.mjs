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

// 11) Textos largos: NO se recortan; se adjuntan completos como archivo (o van enteros en línea si falla el adjunto)
const long = 'x'.repeat(5000);
plan = WMB.planResult({ content: [{ type: 'text', text: long }] }, { server: 's', name: 't', status: 'ok', maxChars: 1000 });
assert.equal(plan.files.length, 1);
assert.equal(plan.files[0].text, long);
assert.ok(plan.build(true).length < 2200);
assert.match(plan.build(true), /contenido COMPLETO en el archivo adjunto s_t_completo\.txt/);
assert.ok(plan.build(false).includes(long), 'sin adjunto, el texto completo va en línea');
assert.equal(WMB.planResult({ content: [{ type: 'text', text: 'corto' }] }, { server: 's', name: 't', status: 'ok' }).files.length, 0);

console.log('✔ test_utils: todo correcto');

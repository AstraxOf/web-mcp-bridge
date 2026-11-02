// Pruebas del parser tolerante (mcp_parser.js): JSON reparado, banderas y avisos de formato.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ console, setTimeout, clearTimeout });
for (const f of ['utils.js', 'mcp_parser.js']) vm.runInContext(readFileSync(new URL(`../content_scripts/${f}`, import.meta.url), 'utf8'), context);
const { WMB } = context;

WMB.tools = [
  { server: 'windows_management', serverLabel: 'windows-management', name: 'execute_powershell', inputSchema: { type: 'object', properties: { script: { type: 'string' }, require_admin: { type: 'boolean' } } } },
  { server: 'v380_camara', serverLabel: 'v380-camara', name: 'ptz_move', inputSchema: { type: 'object', properties: { direction: { type: 'string' }, duration: { type: 'number' } } } },
];
const one = (text) => { const calls = WMB.extractMcpCalls(text); assert.equal(calls.length, 1, `esperaba 1 llamada en: ${text}`); return calls[0]; };

// 1) JSON valido: la capa estricta sigue funcionando igual
assert.equal(one('{"mcp_call":{"server":"v380_camara","name":"ptz_move","arguments":{"direction":"LEFT","duration":5.0}}}').arguments.duration, 5);

// 2) Ruta de Windows con barras sueltas (el fallo mas comun)
let call = one(String.raw`{"mcp_call":{"server":"windows_management","name":"execute_powershell","arguments":{"script":"Get-Content -LiteralPath 'C:\Users\user\_ptz.out' -Raw"}}}`);
assert.equal(call.arguments.script, String.raw`Get-Content -LiteralPath 'C:\Users\user\_ptz.out' -Raw`);

// 3) Salto de linea real dentro de un texto
call = one('{"mcp_call":{"server":"windows_management","name":"execute_powershell","arguments":{"script":"$a=1\n$b=2"}}}');
assert.equal(call.arguments.script, '$a=1\n$b=2');

// 4) Comillas internas sin escapar
call = one('{"mcp_call":{"server":"windows_management","name":"execute_powershell","arguments":{"script":"Write-Output "hola" ; ok"}}}');
assert.equal(call.arguments.script, 'Write-Output "hola" ; ok');

// 5) Coma final + comillas tipograficas
call = one('{\u201cmcp_call\u201d:{\u201cserver\u201d:\u201cv380_camara\u201d,\u201cname\u201d:\u201cptz_move\u201d,\u201carguments\u201d:{\u201cdirection\u201d:\u201cLEFT\u201d,}}}');
assert.equal(call.arguments.direction, 'LEFT');

// 6) Banderas: JSON irreparable, pero server/name/arguments se leen por separado con el schema
call = one('```json\n{"mcp_call":{"server":"windows-management","name":"execute_powershell","arguments":{"script":"echo "a", "b" ok","require_admin":false}}}\n```');
assert.equal(call.server, 'windows_management');
assert.equal(call.arguments.script, 'echo "a", "b" ok');
assert.equal(call.arguments.require_admin, false);

// 7) Sin falso positivo: servidor o herramienta que no existen
assert.equal(WMB.extractMcpCalls('{"mcp_call": broken {"server":"otro","name":"nada","arguments":{x}}}').length, 0);

// 8) Mensaje cortado: no es una llamada, pero hay intencion -> se avisa a la IA
const cut = '{"mcp_call":{"server":"v380_camara","name":"ptz_move","arguments":{"direction":"LE';
assert.equal(WMB.extractMcpCalls(cut).length, 0);
assert.equal(WMB.looksMalformed(cut), true);
assert.match(WMB.diagnoseMcp(cut), /incompleto/);

// 9) Diagnosticos concretos
const bad = String.raw`{"mcp_call":{"server":"x","name":"y","arguments":{"p":"C:\Users\a", }}}`;
assert.match(WMB.diagnoseMcp(bad), /escape/);
assert.match(WMB.formatCallError(bad), /status="format_error"/);

// 10) Texto normal sin intencion: no se avisa
assert.equal(WMB.looksMalformed('Hola, no necesito herramientas.'), false);
assert.equal(WMB.looksMalformed('Usa el formato mcp_call cuando quieras.'), false);

console.log('ok test_parser: todo correcto');
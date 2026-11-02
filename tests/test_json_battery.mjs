// Bateria de JSON "sucio": lo que de verdad escriben las IA. Ninguno debe escaparse ni ejecutarse mal.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ console, setTimeout, clearTimeout });
for (const f of ['utils.js', 'mcp_parser.js']) vm.runInContext(readFileSync(new URL(`../content_scripts/${f}`, import.meta.url), 'utf8'), context);
const { WMB } = context;
WMB.tools = [
  { server: 'win', serverLabel: 'windows-management', name: 'run', inputSchema: { type: 'object', properties: { script: { type: 'string' }, admin: { type: 'boolean' }, n: { type: 'number' }, list: { type: 'array' } } } },
  { server: 'cam', serverLabel: 'camara', name: 'move', inputSchema: { type: 'object', properties: { dir: { type: 'string' }, secs: { type: 'number' } } } },
];

const S = String.raw;
const cases = [
  ['valido en bloque', '```json\n{"mcp_call":{"server":"cam","name":"move","arguments":{"dir":"UP","secs":2}}}\n```', { name: 'move', arguments: { dir: 'UP', secs: 2 } }],
  ['con prosa alrededor', 'Voy a mover.\n{"mcp_call":{"server":"cam","name":"move","arguments":{"dir":"UP"}}}\nListo }', { name: 'move', arguments: { dir: 'UP' } }],
  ['comillas simples estilo Python', "{'mcp_call': {'server': 'cam', 'name': 'move', 'arguments': {'dir': 'UP', 'secs': 3}}}", { name: 'move', arguments: { dir: 'UP', secs: 3 } }],
  ['True/False/None', "{'mcp_call': {'server': 'win', 'name': 'run', 'arguments': {'script': 'ls', 'admin': False}}}", { name: 'run', arguments: { script: 'ls', admin: false } }],
  ['claves sin comillas', '{mcp_call:{server:"cam",name:"move",arguments:{dir:"UP",secs:1}}}', { name: 'move', arguments: { dir: 'UP', secs: 1 } }],
  ['entidades HTML', '{&quot;mcp_call&quot;:{&quot;server&quot;:&quot;cam&quot;,&quot;name&quot;:&quot;move&quot;,&quot;arguments&quot;:{&quot;dir&quot;:&quot;UP&quot;}}}', { name: 'move', arguments: { dir: 'UP' } }],
  ['argumentos como texto JSON', '{"mcp_call":{"server":"cam","name":"move","arguments":"{\\"dir\\":\\"UP\\"}"}}', { name: 'move', arguments: { dir: 'UP' } }],
  ['ruta con barras sueltas', S`{"mcp_call":{"server":"win","name":"run","arguments":{"script":"dir C:\Users\Ana\Desktop"}}}`, { name: 'run', arguments: { script: S`dir C:\Users\Ana\Desktop` } }],
  ['ruta con \\n que NO es salto', S`{"mcp_call":{"server":"win","name":"run","arguments":{"script":"type C:\nueva\texto.txt"}}}`, null],
  ['salto real dentro del texto', '{"mcp_call":{"server":"win","name":"run","arguments":{"script":"a=1\nb=2"}}}', { name: 'run', arguments: { script: 'a=1\nb=2' } }],
  ['JSON bonito multilinea', '{\n  "mcp_call": {\n    "server": "cam",\n    "name": "move",\n    "arguments": {\n      "dir": "UP"\n    }\n  }\n}', { name: 'move', arguments: { dir: 'UP' } }],
  ['unicode escapado', '{"mcp_call":{"server":"win","name":"run","arguments":{"script":"echo \\u00f1"}}}', { name: 'run', arguments: { script: 'echo \u00f1' } }],
  ['llaves dentro del texto', '{"mcp_call":{"server":"win","name":"run","arguments":{"script":"if($a){ \\"x}\\" }"}}}', { name: 'run', arguments: { script: 'if($a){ "x}" }' } }],
  ['anidado con arrays', '{"mcp_call":{"server":"win","name":"run","arguments":{"list":[1,2,{"a":"b"}],"script":"x"}}}', { name: 'run', arguments: { list: [1, 2, { a: 'b' }], script: 'x' } }],
  ['espacio de ancho cero dentro de la clave', '{"mcp\u200b_call":{"server":"cam","name":"move","arguments":{"dir":"UP"}}}', { name: 'move', arguments: { dir: 'UP' } }],
  ['nbsp y tabuladores', '{\u00a0"mcp_call":\t{"server":"cam",\u00a0"name":"move","arguments":{"dir":"UP"}}}', { name: 'move', arguments: { dir: 'UP' } }],
  ['dentro de un array', '[{"mcp_call":{"server":"cam","name":"move","arguments":{"dir":"UP"}}}]', { name: 'move', arguments: { dir: 'UP' } }],
  ['comentario // dentro', '{"mcp_call":{"server":"cam", // camara\n"name":"move","arguments":{"dir":"UP"}}}', { name: 'move', arguments: { dir: 'UP' } }],
  ['coma final en arguments', '{"mcp_call":{"server":"cam","name":"move","arguments":{"dir":"UP",},}}', { name: 'move', arguments: { dir: 'UP' } }],
  ['cierre de llaves de menos pero el texto sigue', '{"mcp_call":{"server":"cam","name":"move","arguments":{"dir":"UP"}}', null],
  ['numero como texto en schema number', '{"mcp_call":{"server":"cam","name":"move","arguments":{"dir":"UP","secs":"4"}}}', { name: 'move', arguments: { dir: 'UP', secs: '4' } }],
];

let failed = 0;
for (const [label, text, expected] of cases) {
  const calls = WMB.extractMcpCalls(text);
  if (expected === null) {
    // No hay que ejecutar nada raro: o ninguna llamada, o la IA recibe aviso (looksMalformed)
    const okNone = calls.length === 0 ? WMB.looksMalformed(text) : calls.length === 1;
    if (!okNone) { failed += 1; console.error(`FALLA [${label}] esperaba ninguna/segura, obtuve`, JSON.stringify(calls)); }
    continue;
  }
  try {
    assert.equal(calls.length, 1, `llamadas: ${calls.length}`);
    assert.equal(calls[0].name, expected.name);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0].arguments)), expected.arguments);
  } catch (e) { failed += 1; console.error(`FALLA [${label}]: ${e.message.split('\n')[0]}`); }
}
if (failed) { console.error(`${failed}/${cases.length} casos fallan`); process.exit(1); }
console.log(`ok test_json_battery: ${cases.length} casos`);
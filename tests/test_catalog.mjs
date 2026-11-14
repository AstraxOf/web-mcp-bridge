// Pruebas del catálogo paginado de herramientas (v1.7.2): wmb.list_tools y el prompt compacto con muchas herramientas.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ console, setTimeout, clearTimeout });
for (const file of ['utils.js', 'mcp_parser.js', 'prompt_builder.js', 'tool_catalog.js']) {
  vm.runInContext(readFileSync(new URL(`../content_scripts/${file}`, import.meta.url), 'utf8'), context);
}
const { WMB } = context;

const make = (server, label, n, prefixes) => Array.from({ length: n }, (_, i) => ({
  server, serverLabel: label,
  name: `${prefixes[i % prefixes.length]}_${server}_${i + 1}`,
  description: `Herramienta número ${i + 1} de ${label} que hace ${prefixes[i % prefixes.length]} cosas.`,
  inputSchema: { type: 'object', required: ['a'], properties: { a: { type: 'string', description: `Parametro a de ${i + 1}` }, b: { type: 'number' } } },
}));

const rea = make('rea', 'rea', 229, ['get', 'list', 'set']);
const win = make('windows_management', 'windows-management', 100, ['get', 'kill', 'list']);
const small = make('astrax', 'astrax', 5, ['ver']);
const all = [...rea, ...win];

// ── Pocas herramientas: todo igual que antes (lista completa, sin catálogo) ──
assert.equal(WMB.catalog.isActive(small), false);
const fullSmall = WMB.buildSystemPrompt(small);
assert.match(fullSmall, /- ver_astrax_1\(a: string, b\?: number\)/);
assert.ok(!fullSmall.includes('list_tools'), 'sin catálogo no se menciona list_tools');
assert.ok(!WMB.reminderLine(small).includes('list_tools'));

// ── Muchas herramientas: prompt compacto con los servidores y sin volcar las 329 ──
assert.equal(WMB.catalog.isActive(all), true);
const prompt = WMB.buildSystemPrompt(all);
assert.ok(prompt.length < 4500, `el prompt del catálogo debe ser pequeño (fue ${prompt.length})`);
assert.match(prompt, /`rea`: 229 herramientas · 5 página\(s\)/);
assert.match(prompt, /`windows_management` \(windows-management\): 100 herramientas · 2 página\(s\)/);
assert.match(prompt, /"server":"wmb","name":"list_tools"/);
assert.ok(!prompt.includes('get_rea_1('), 'no se listan las herramientas de los servidores grandes');
assert.ok(prompt.startsWith(`[WMB:${WMB.toolsSignature(all)}]`));
assert.notEqual(WMB.toolsSignature(all), WMB.hash(all.map((t) => `${t.server}.${t.name}`).sort().join('|')), 'el modo catálogo cambia la firma');

// Servidores pequeños junto a los grandes: se siguen listando completos
const mixed = WMB.buildSystemPrompt([...all, ...small]);
assert.match(mixed, /Servidores pequeños/);
assert.match(mixed, /### `astrax`/);
assert.match(mixed, /- ver_astrax_1\(/);
assert.ok(!mixed.includes('get_rea_1('));

// Recordatorio de una línea también en modo catálogo
const line = WMB.reminderLine(all);
assert.ok(!line.includes('\n') && line.includes('list_tools'));
assert.ok(!line.includes('[WMB:'));

// ── wmb.list_tools ──
const run = (args, tools = all) => WMB.catalog.run(args, tools);

let r = run({});
assert.equal(r.ok, true);
assert.match(r.text, /329 herramientas en 2 servidor/);
assert.match(r.text, /rea: 229 herramientas · páginas 1-5/);

r = run({ server: 'rea', page: 1 });
assert.match(r.text, /página 1\/5 · herramientas 1-50 de 229/);
assert.equal(r.text.split('\n').filter((l) => l.startsWith('- ')).length, 50);
assert.match(r.text, /Siguiente: arguments \{"server":"rea","page":2\}/);
assert.ok(r.text.length < 12000, 'una página debe caber en un mensaje');

r = run({ server: 'rea', page: '5' }); // la IA a veces manda números como texto
assert.match(r.text, /herramientas 201-229 de 229/);
assert.match(r.text, /Fin de la lista/);

r = run({ server: 'rea', page: 6 });
assert.equal(r.ok, false);
assert.match(r.text, /tiene 5 página/);

r = run({ server: 'windows-management', page: 2 }); // por etiqueta
assert.match(r.text, /`windows_management` · página 2\/2 · herramientas 51-100 de 100/);

r = run({ server: 'nada' });
assert.equal(r.ok, false);
assert.match(r.text, /rea, windows_management/);

r = run({ query: 'kill', limit: 10 });
assert.match(r.text, /Búsqueda «kill» · 33 resultado\(s\) · página 1\/4/);
assert.match(r.text, /\[windows_management\] kill_windows_management_/);
assert.match(r.text, /"query":"kill"/);

r = run({ server: 'rea', query: 'get list' });
assert.match(r.text, /Búsqueda «get list» en `rea`: 0 resultados/); // todas las palabras deben coincidir

r = run({ server: 'rea', tool: 'get_rea_1' });
assert.match(r.text, /firma: get_rea_1\(a: string, b\?: number\)/);
assert.match(r.text, /· a: Parametro a de 1/);

r = run({ server: 'rea', tool: 'inexistente' });
assert.equal(r.ok, false);

r = run({ server: 'rea', page: 1, limit: 20 });
assert.equal(r.text.split('\n').filter((l) => l.startsWith('- ')).length, 20);
assert.match(r.text, /"limit":20/);

assert.equal(run({}, []).ok, false);
const one = run({}, rea); // un solo servidor: sin server devuelve su primera página
assert.match(one.text, /`rea` · página 1\/5/);

// Descripciones enormes: la página se acorta y sigue cabiendo
const heavy = make('big', 'big', 50, ['x']).map((t) => ({ ...t, description: 'z'.repeat(900) }));
r = run({ server: 'big', page: 1 }, heavy);
assert.ok(r.text.length < 12000);

// ── Reconocer la llamada ──
assert.equal(WMB.catalog.isMeta({ server: 'wmb', name: 'list_tools' }, all, []), true);
assert.equal(WMB.catalog.isMeta({ server: 'WMB', name: 'list_tools' }, all, []), true);
assert.equal(WMB.catalog.isMeta({ server: null, name: 'list_tools' }, all, []), true);
assert.equal(WMB.catalog.isMeta({ server: 'rea', name: 'get_rea_1' }, all, []), false);
assert.equal(WMB.catalog.isMeta({ server: 'wmb', name: 'list_tools' }, all, [{ slug: 'wmb' }]), false, 'un MCP real llamado wmb manda');

// El parser tolerante rescata una llamada mal formada a list_tools (usa metaTools)
WMB.tools = all.concat(WMB.catalog.metaTools);
const broken = WMB.extractMcpCalls('```json\n{"mcp_call": {"server": "wmb", "name": "list_tools", "arguments": {"server": "rea", "page": 2,}}}\n```');
assert.equal(broken.length, 1);
assert.equal(broken[0].name, 'list_tools');
assert.equal(broken[0].arguments.page, 2);

// Llamada a una herramienta inexistente: no se vuelcan cientos de nombres
const hint = WMB.catalog.unknownToolHint(all, 'rea', 'kill process');
assert.ok(hint.length < 400 && hint.includes('list_tools'));
assert.equal(WMB.catalog.unknownToolHint(small, 'astrax', 'x'), small.map((t) => t.name).join(', '));

// Ajustes
WMB.catalog.configure({ catalogThreshold: 500, catalogPageSize: 20 });
assert.equal(WMB.catalog.isActive(all), false);
assert.equal(WMB.catalog.cfg.pageSize, 20);
WMB.catalog.configure({ catalogThreshold: 40, catalogPageSize: 999 });
assert.equal(WMB.catalog.cfg.pageSize, 50);

console.log('✔ test_catalog: todo correcto');

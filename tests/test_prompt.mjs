// Pruebas del generador del System Prompt.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ console, setTimeout, clearTimeout });
for (const file of ['utils.js', 'prompt_builder.js']) {
  vm.runInContext(readFileSync(new URL(`../content_scripts/${file}`, import.meta.url), 'utf8'), context);
}
const { WMB } = context;

const tools = [
  {
    server: 'demo', serverLabel: 'Demo', name: 'sumar', description: 'Suma\n dos   números.',
    inputSchema: {
      $schema: 'x', type: 'object', title: 'sumarArguments', required: ['a'],
      properties: { a: { type: 'number', title: 'A', description: 'Primer sumando' }, modo: { enum: ['x', 'y'] }, extra: { type: 'array', items: { type: 'string' }, default: [] } },
    },
  },
];
const prompt = WMB.buildSystemPrompt(tools);
assert.match(prompt, /### `demo` \(Demo\)/);
assert.match(prompt, /- sumar\(a: number, modo\?: "x"\|"y", extra\?: string\[\] = \[\]\): Suma dos números\./);
assert.ok(!prompt.includes('Primer sumando'), 'el detalle de cada parámetro no va en el catálogo: lo da `ayuda`');
assert.match(prompt, /"ayuda"/, 'el prompt explica cómo pedir la ficha completa');
assert.ok(!prompt.includes('$schema') && !prompt.includes('sumarArguments'), 'las herramientas van como firmas compactas, no como JSON Schema');
assert.match(prompt, /"mcp_call"/);
assert.ok(prompt.startsWith(`[WMB:${WMB.toolsSignature(tools)}]`), 'debe empezar con el marcador');
assert.match(prompt, /SÍ tienes acceso/);
assert.ok(prompt.length < 1700, 'el prompt base debe ser compacto');
assert.notEqual(WMB.toolsSignature(tools), WMB.toolsSignature([]));
assert.match(WMB.buildSystemPrompt([]), /Ningún servidor MCP activo/);

// Por niveles: catálogo con la primera frase; guía y ficha completa con `wmb.ayuda`
assert.equal(WMB.firstSentence('Hace A. Luego B y C.'), 'Hace A.');
assert.equal(WMB.firstSentence('Sin punto final'), 'Sin punto final');
assert.ok(WMB.firstSentence('x'.repeat(500)).length <= 170);
assert.equal(WMB.firstSentence('Usa p. ej. esto. Luego otra.'), 'Usa p. ej. esto.', '«p. ej.» no corta la frase');
assert.equal(WMB.firstSentence('Busca un texto en los archivos (máx. 200 resultados). Más detalle.'), 'Busca un texto en los archivos (máx. 200 resultados).');
assert.equal(WMB.firstSentence('¿Hace algo? Sí. Otra.'), '¿Hace algo?');
assert.equal(WMB.firstSentence('Versión 1.2 estable. Otra.'), 'Versión 1.2 estable.');
assert.equal(WMB.firstSentence('Modifica entidades (por handle).\n\naccion:\n- "mover"'), 'Modifica entidades (por handle).', 'la frase puede seguir en minúscula');
assert.match(WMB.buildSystemPrompt(tools), /NO digas que no se puede/, 'la regla 6 manda pedir ayuda antes de rendirse');
const cad = [
  { server: 'autocad-mcp', name: 'panorama', description: 'EMPIEZA AQUÍ: qué hay y dónde. Devuelve capas, rejilla y textos con su celda.',
    serverInstructions: 'Control de AutoCAD. Empieza siempre con panorama y trabaja por zonas.',
    inputSchema: { type: 'object', properties: { zona: { type: 'array', description: 'Rectángulo [[x1,y1],[x2,y2]]' } } } },
  { server: 'autocad-mcp', name: 'lisp', description: 'Último recurso, solo expresiones cortas. Detalle muy largo que no debe ir al catálogo.',
    serverInstructions: 'Control de AutoCAD. Empieza siempre con panorama y trabaja por zonas.',
    inputSchema: { type: 'object', required: ['expresion'], properties: { expresion: { type: 'string', description: 'Código AutoLISP' } } } },
];
const catalogo = WMB.buildSystemPrompt(cad);
assert.match(catalogo, /Guía: Control de AutoCAD\. \(completa: ayuda "autocad-mcp"\)/);
assert.match(catalogo, /- lisp\(expresion: string\): Último recurso, solo expresiones cortas\./);
assert.ok(!catalogo.includes('Detalle muy largo') && !catalogo.includes('Código AutoLISP'));
// Firmas del catálogo compactas (sin «|null = null» en opcionales); la ficha conserva la firma completa
const capa = [{ server: 's', name: 'capa', description: 'Cambia una capa.', inputSchema: { type: 'object', required: ['nombre'],
  properties: { nombre: { type: 'string' }, color: { anyOf: [{ type: 'integer' }, { type: 'null' }], default: null }, activar: { type: 'boolean', default: false } } } }];
assert.match(WMB.buildSystemPrompt(capa), /- capa\(nombre: string, color\?: number, activar\?: boolean = false\): Cambia una capa\./);
assert.match(WMB.toolHelp(capa, 's', 'capa'), /color\?: integer\|null = null/);
const guia = WMB.toolHelp(cad, 'autocad-mcp');
assert.match(guia, /Empieza siempre con panorama y trabaja por zonas/);
assert.match(guia, /- lisp: Último recurso/);
const ficha = WMB.toolHelp(cad, 'AutoCAD_MCP', 'LISP');                       // sin distinguir mayúsculas ni guiones
assert.match(ficha, /Detalle muy largo/);
assert.match(ficha, /- expresion \(obligatorio\): string — Código AutoLISP/);
assert.match(WMB.toolHelp(cad, 'otro'), /Servidores: autocad-mcp/);
assert.match(WMB.toolHelp(cad, 'autocad-mcp', 'nada'), /Tiene: panorama, lisp/);
assert.match(WMB.helpOnError(cad, 'autocad-mcp', 'lisp'), /Ficha de autocad-mcp\.lisp/);
assert.equal(WMB.helpOnError(cad, 'autocad-mcp', 'nada'), '');

// Recordatorio de una línea para que la IA no olvide sus herramientas
const line = WMB.reminderLine([{ server: 'astrax_mcp' }, { server: 'astrax_mcp' }]);
assert.ok(!line.includes('\n') && line.length < 260, 'una sola línea corta');
assert.match(line, /Tienes herramientas MCP locales reales \(astrax_mcp: 2\)/);
assert.match(line, /mcp_call/);
assert.match(WMB.reminderLine([{ server: 's' }], 'result'), /Continúa la tarea/);
assert.ok(!line.includes('[WMB:'), 'no debe confundirse con el marcador de instrucciones');

// Índice por grupos: un servidor grande que declara `_meta.grupo` se describe por grupos; los nombres, no las firmas
const grandes = Array.from({ length: 14 }, (_, i) => ({
  server: 'cad', serverLabel: 'CAD', name: `herr${i}`, description: `Hace la cosa ${i}. ${'Detalle largo. '.repeat(20)}`,
  grupo: i < 5 ? 'consultar' : i < 10 ? 'editar' : 'archivos', nucleo: i === 0, serverInstructions: 'Control de CAD. Empieza con herr0.',
  inputSchema: { type: 'object', required: ['a'], properties: { a: { type: 'string' }, b: { type: 'number' } } },
}));
const indice = WMB.buildSystemPrompt(grandes);
assert.match(indice, /Grupos \(las firmas de un grupo: ayuda "cad" con "grupo"\):/);
assert.match(indice, /- consultar: herr1, herr2, herr3, herr4\n/, 'las del núcleo no se repiten en su grupo');
assert.match(indice, /- editar: herr5, herr6, herr7, herr8, herr9\n- archivos: herr10, herr11, herr12, herr13/);
assert.match(indice, /Más usadas:\n- herr0\(a: string, b\?: number\): Hace la cosa 0\./);
assert.ok(!indice.includes('herr7(') && !indice.includes('Hace la cosa 7'), 'del resto solo los nombres');
const plano = WMB.buildSystemPrompt(grandes.map(({ grupo, nucleo, ...r }) => r));
assert.ok(plano.includes('- herr7(a: string, b?: number): Hace la cosa 7.') && !plano.includes('Grupos ('), 'sin grupos se queda como siempre');
assert.ok(!WMB.buildSystemPrompt(grandes.slice(0, 5)).includes('Grupos ('), 'un servidor pequeño no usa índice aunque declare grupos');
const base0 = WMB.buildSystemPrompt([]).length;
assert.ok(indice.length - base0 < (plano.length - base0) * 0.6, `el catálogo por índice debe ahorrar mucho (${indice.length - base0} vs ${plano.length - base0})`);
const hg = WMB.toolHelp(grandes, 'cad', undefined, 'EDITAR');                    // sin distinguir mayúsculas
assert.match(hg, /# cad: grupo «editar»/);
assert.match(hg, /- herr5\(a: string, b\?: number\): Hace la cosa 5\./);
assert.ok(!hg.includes('herr0') && !hg.includes('herr10'));
assert.match(WMB.toolHelp(grandes, 'cad', undefined, 'nada'), /no tiene el grupo «nada»\. Grupos: consultar, editar, archivos/);
assert.match(WMB.toolHelp(grandes, 'cad'), /## Grupos\n- consultar \(5\): herr0, herr1, herr2, herr3, herr4\n- editar \(5\)/);
assert.match(WMB.toolHelp(grandes, 'cad', 'herr3'), /# cad\.herr3/, 'la ficha de una herramienta sigue funcionando');
assert.match(WMB.toolHelp(grandes.map(({ grupo, ...r }) => r), 'cad', undefined, 'x'), /no agrupa sus herramientas/);
console.log('✔ test_prompt: todo correcto');

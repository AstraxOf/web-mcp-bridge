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
assert.match(prompt, /· a: Primer sumando/);
assert.ok(!prompt.includes('$schema') && !prompt.includes('sumarArguments'), 'las herramientas van como firmas compactas, no como JSON Schema');
assert.match(prompt, /"mcp_call"/);
assert.ok(prompt.startsWith(`[WMB:${WMB.toolsSignature(tools)}]`), 'debe empezar con el marcador');
assert.match(prompt, /SÍ tienes acceso/);
assert.ok(prompt.length < 1700, 'el prompt base debe ser compacto');
assert.notEqual(WMB.toolsSignature(tools), WMB.toolsSignature([]));
assert.match(WMB.buildSystemPrompt([]), /Ningún servidor MCP activo/);

// Recordatorio de una línea para que la IA no olvide sus herramientas
const line = WMB.reminderLine([{ server: 'astrax_mcp' }, { server: 'astrax_mcp' }]);
assert.ok(!line.includes('\n') && line.length < 260, 'una sola línea corta');
assert.match(line, /Tienes herramientas MCP locales reales \(astrax_mcp: 2\)/);
assert.match(line, /mcp_call/);
assert.match(WMB.reminderLine([{ server: 's' }], 'result'), /Continúa la tarea/);
assert.ok(!line.includes('[WMB:'), 'no debe confundirse con el marcador de instrucciones');

console.log('✔ test_prompt: todo correcto');

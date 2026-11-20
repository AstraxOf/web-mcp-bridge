// Varias llamadas por mensaje (Chromium + DOM simulado de DeepSeek): con `maxCallsPerMessage` = 3 se ejecutan EN ORDEN y sus
// resultados vuelven JUNTOS en un solo mensaje; si una falla, las siguientes no se ejecutan; con 1 (por defecto) solo la primera.
// Uso: node tests/browser/test_lote.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('⚠ test_lote: Playwright no está instalado, prueba omitida.'); process.exit(0); }

const root = new URL('../../', import.meta.url);
const files = ['utils.js', 'prompt_builder.js', 'ui_widget.js', 'adapters/base_adapter.js', 'adapters/deepseek.js', 'core_bridge.js']
  .map((f) => readFileSync(new URL(`content_scripts/${f}`, root), 'utf8'));

const FAKE_CHROME = (maxCalls, failTool) => `
  window.calls = [];
  window.chrome = { runtime: { id: 'test', onMessage: { addListener() {} }, sendMessage: async (m) => {
    if (m.type === 'GET_STATE') return { ok: true, settings: { bridgeEnabled: true, autoSend: false, autoInject: false, reminder: false, toolTimeoutSec: 30, maxResultChars: 12000, maxCallsPerMessage: ${maxCalls} },
      servers: [{ id: 's1', name: 'autocad', slug: 'autocad', url: 'http://x', enabled: true, permission: 'allow' }] };
    if (m.type === 'GET_ACTIVE_TOOLS') return { ok: true, tools: ['panorama', 'textos', 'buscar'].map((name) => ({ server: 'autocad', serverLabel: 'autocad', name, description: '', inputSchema: { type: 'object', properties: {} } })) };
    if (m.type === 'CALL_TOOL') {
      window.calls.push(m.name);
      if (m.name === ${JSON.stringify(failTool)}) return { ok: true, result: { isError: true, content: [{ type: 'text', text: 'FALLO_' + m.name }] } };
      return { ok: true, result: { content: [{ type: 'text', text: 'RESULTADO_' + m.name }] } };
    }
    if (m.type === 'SLEEP') { await new Promise((r) => setTimeout(r, m.ms)); return { ok: true }; }
    return { ok: true };
  } } };`;

const bloque = (name) => `{"mcp_call":{"server":"autocad","name":"${name}","arguments":{}}}`;
const browser = await chromium.launch();

async function escenario(maxCalls, failTool, nombres) {
  const page = await browser.newPage();
  await page.route('https://chat.deepseek.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body><div id="chat"></div><textarea id="chat-input"></textarea></body>' }));
  await page.goto(`https://chat.deepseek.com/a/chat/s/lote${maxCalls}${failTool ?? ''}`);
  await page.addScriptTag({ content: FAKE_CHROME(maxCalls, failTool) });
  for (const code of files) await page.addScriptTag({ content: code });
  await page.waitForTimeout(3200); // fin de la línea base
  await page.evaluate((texto) => {
    const div = document.createElement('div');
    div.innerHTML = `<div class="ds-markdown">${texto}</div>`;
    document.getElementById('chat').appendChild(div);
  }, nombres.map(bloque).join('\n'));
  await page.waitForTimeout(6000);
  const out = { calls: await page.evaluate(() => window.calls), chat: await page.inputValue('#chat-input') };
  await page.close();
  return out;
}

try {
  // 1) Por defecto (1 llamada por mensaje): solo se ejecuta la primera, como siempre
  let r = await escenario(1, null, ['panorama', 'textos', 'buscar']);
  assert.deepEqual(r.calls, ['panorama'], 'con 1 solo se ejecuta la primera');
  assert.match(r.chat, /RESULTADO_panorama/); assert.doesNotMatch(r.chat, /RESULTADO_textos/);

  // 2) Con 3: las tres, en orden, y los resultados en UN solo mensaje y en el mismo orden
  r = await escenario(3, null, ['panorama', 'textos', 'buscar']);
  assert.deepEqual(r.calls, ['panorama', 'textos', 'buscar'], 'se ejecutan en el orden pedido');
  const i1 = r.chat.indexOf('RESULTADO_panorama'), i2 = r.chat.indexOf('RESULTADO_textos'), i3 = r.chat.indexOf('RESULTADO_buscar');
  assert.ok(i1 >= 0 && i2 > i1 && i3 > i2, `los 3 resultados juntos y en orden: ${r.chat}`);
  assert.equal((r.chat.match(/\[MCP_RESULT /g) ?? []).length, 3, 'un bloque MCP_RESULT por llamada');

  // 3) Máximo 2 aunque pida 3
  r = await escenario(2, null, ['panorama', 'textos', 'buscar']);
  assert.deepEqual(r.calls, ['panorama', 'textos'], 'el tope manda');
  assert.doesNotMatch(r.chat, /RESULTADO_buscar/);

  // 4) Si una falla, las siguientes NO se ejecutan y la IA lo sabe
  r = await escenario(3, 'textos', ['panorama', 'textos', 'buscar']);
  assert.deepEqual(r.calls, ['panorama', 'textos'], 'tras el fallo no se ejecuta la tercera');
  assert.match(r.chat, /RESULTADO_panorama/); assert.match(r.chat, /FALLO_textos/);
  assert.match(r.chat, /No se ejecutó: la llamada anterior/, 'la tercera aparece como no ejecutada');
  assert.equal((r.chat.match(/\[MCP_RESULT /g) ?? []).length, 3);

  // 5) Una sola llamada con el tope en 3: igual que siempre (un resultado)
  r = await escenario(3, null, ['textos']);
  assert.deepEqual(r.calls, ['textos']);
  assert.equal((r.chat.match(/\[MCP_RESULT /g) ?? []).length, 1);
  console.log('✔ test_lote: todo correcto');
} finally {
  await browser.close();
}

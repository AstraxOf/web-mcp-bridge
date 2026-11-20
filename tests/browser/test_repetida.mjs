// Llamada idéntica a una ya ejecutada (Chromium + DOM simulado de DeepSeek): no se descarta en silencio,
// se pregunta en el panel y el usuario decide. Uso: node tests/browser/test_repetida.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('⚠ test_repetida: Playwright no está instalado, prueba omitida.'); process.exit(0); }

const root = new URL('../../', import.meta.url);
const files = ['utils.js', 'prompt_builder.js', 'ui_widget.js', 'adapters/base_adapter.js', 'adapters/deepseek.js', 'core_bridge.js']
  .map((f) => readFileSync(new URL(`content_scripts/${f}`, root), 'utf8'));

const FAKE_CHROME = `
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (o) { return attach.call(this, { ...o, mode: 'open' }); };
  window.calls = [];
  window.chrome = { runtime: { id: 'test', onMessage: { addListener() {} }, sendMessage: async (m) => {
    if (m.type === 'GET_STATE') return { ok: true, settings: { platforms: { deepseek: true }, bridgeEnabled: true, autoSend: false, autoInject: false, reminder: false, toolTimeoutSec: 30, maxResultChars: 12000 },
      servers: [{ id: 's1', name: 'autocad', slug: 'autocad', url: 'http://x', enabled: true, permission: 'allow' }] };
    if (m.type === 'GET_ACTIVE_TOOLS') return { ok: true, tools: [{ server: 'autocad', serverLabel: 'autocad', name: 'textos', description: '', inputSchema: { type: 'object', properties: {} } }] };
    if (m.type === 'CALL_TOOL') { window.calls.push(m.arguments.n); return { ok: true, result: { content: [{ type: 'text', text: 'ok' }] } }; }
    if (m.type === 'SLEEP') { await new Promise((r) => setTimeout(r, m.ms)); return { ok: true }; }
    return { ok: true };
  } } };`;
const CALL = '{"mcp_call":{"server":"autocad","name":"textos","arguments":{"n":1}}}';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.route('https://chat.deepseek.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body><div id="chat"></div><textarea id="chat-input"></textarea></body>' }));
  await page.goto('https://chat.deepseek.com/a/chat/s/repetida');
  await page.addScriptTag({ content: FAKE_CHROME });
  for (const code of files) await page.addScriptTag({ content: code });
  await page.waitForTimeout(3200);
  const tarjeta = () => page.evaluate(() => {
    const host = [...document.querySelectorAll('*')].find((e) => e.shadowRoot);
    return host?.shadowRoot.querySelector('.card')?.innerText ?? null;
  });
  const pulsar = (texto) => page.evaluate((texto) => {
    const host = [...document.querySelectorAll('*')].find((e) => e.shadowRoot);
    [...host.shadowRoot.querySelectorAll('.card button')].find((b) => b.innerText.trim() === texto).click();
  }, texto);
  // La web vuelve a pintar el último mensaje como un elemento nuevo con el mismo texto y en la misma posición.
  const repintar = () => page.evaluate((c) => {
    document.getElementById('chat').innerHTML = `<div><div class="ds-markdown">${c}</div></div>`;
  }, CALL);

  await repintar();
  await page.waitForTimeout(4000);
  assert.deepEqual(await page.evaluate(() => window.calls), [1], 'la primera vez se ejecuta sola');
  assert.equal(await tarjeta(), null);

  // 1) Idéntica en otro elemento: se pregunta, no se ejecuta sola.
  await repintar();
  await page.waitForTimeout(3000);
  const t = await tarjeta();
  assert.ok(t && /idéntica a una ya ejecutada/.test(t) && /textos/.test(t), `debe preguntar: ${t}`);
  assert.deepEqual(await page.evaluate(() => window.calls), [1], 'no se repite sin permiso');
  await pulsar('Ejecutar');
  await page.waitForTimeout(3000);
  assert.deepEqual(await page.evaluate(() => window.calls), [1, 1], 'con «Ejecutar» se repite');
  assert.equal(await tarjeta(), null);

  // 2) Mismo mensaje que ya se lanzó (solo cambia el texto alrededor): no se pregunta.
  await page.evaluate(() => { document.querySelector('.ds-markdown').append(' '); });
  await page.waitForTimeout(3000);
  assert.equal(await tarjeta(), null, 'un repintado del mismo mensaje no pregunta');

  // 3) «Ignorar»: no se ejecuta.
  await repintar();
  await page.waitForTimeout(3000);
  assert.ok(/idéntica/.test(await tarjeta() ?? ''), 'vuelve a preguntar en un elemento nuevo');
  await pulsar('Ignorar');
  await page.waitForTimeout(2000);
  assert.deepEqual(await page.evaluate(() => window.calls), [1, 1], 'con «Ignorar» no se ejecuta');
  console.log('✔ test_repetida: todo correcto');
} finally {
  await browser.close();
}

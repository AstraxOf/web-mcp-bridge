// Freno de seguridad en la terminal: si el usuario lo acepta, no vuelve a salir para ese MCP en 30 min
// (leer la terminal varias veces seguidas es normal). En otros MCP sigue saliendo cada vez.
// Uso: node tests/browser/test_freno_terminal.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('⚠ test_freno_terminal: Playwright no está instalado, prueba omitida.'); process.exit(0); }

const root = new URL('../../', import.meta.url);
const files = ['utils.js', 'prompt_builder.js', 'ui_widget.js', 'adapters/base_adapter.js', 'adapters/deepseek.js', 'core_bridge.js']
  .map((f) => readFileSync(new URL(`content_scripts/${f}`, root), 'utf8'));

// Dos MCP en «Permitir siempre» cuyas herramientas siempre fallan: «terminal-mcp» y «autocad».
const FAKE_CHROME = `
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (o) { return attach.call(this, { ...o, mode: 'open' }); };
  window.calls = [];
  window.chrome = { runtime: { id: 'test', onMessage: { addListener() {} }, sendMessage: async (m) => {
    if (m.type === 'GET_STATE') return { ok: true, settings: { platforms: { deepseek: true }, bridgeEnabled: true, autoSend: false, autoInject: false, reminder: false, toolTimeoutSec: 30, maxResultChars: 12000 },
      servers: [{ id: 's1', name: 'terminal-mcp', slug: 'terminal_mcp', url: 'http://x', enabled: true, permission: 'allow' },
                { id: 's2', name: 'autocad', slug: 'autocad', url: 'http://y', enabled: true, permission: 'allow' }] };
    if (m.type === 'GET_ACTIVE_TOOLS') return { ok: true, tools: [
      { server: 'terminal_mcp', serverLabel: 'terminal-mcp', name: 'terminal_leer', description: '', inputSchema: { type: 'object', properties: {} } },
      { server: 'autocad', serverLabel: 'autocad', name: 'lisp', description: '', inputSchema: { type: 'object', properties: {} } }] };
    if (m.type === 'CALL_TOOL') { window.calls.push(m.server + ':' + m.arguments.n); return { ok: false, error: 'ocupado' }; }
    if (m.type === 'SLEEP') { await new Promise((r) => setTimeout(r, m.ms)); return { ok: true }; }
    return { ok: true };
  } } };`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.route('https://chat.deepseek.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body><div id="chat"></div><textarea id="chat-input"></textarea></body>' }));
  await page.goto('https://chat.deepseek.com/a/chat/s/freno-terminal');
  await page.addScriptTag({ content: FAKE_CHROME });
  for (const code of files) await page.addScriptTag({ content: code });
  await page.waitForTimeout(3200);

  const llamar = (server, name, n) => page.evaluate(([server, name, n]) => {
    const div = document.createElement('div');
    div.innerHTML = `<div class="ds-markdown">{"mcp_call":{"server":"${server}","name":"${name}","arguments":{"n":${n}}}}</div>`;
    document.getElementById('chat').appendChild(div);
  }, [server, name, n]);
  const tarjeta = () => page.evaluate(() => {
    const host = [...document.querySelectorAll('*')].find((e) => e.shadowRoot);
    return host?.shadowRoot.querySelector('.card')?.innerText ?? null;
  });
  const pulsar = (texto) => page.evaluate((texto) => {
    const host = [...document.querySelectorAll('*')].find((e) => e.shadowRoot);
    [...host.shadowRoot.querySelectorAll('.card button')].find((b) => b.innerText.trim() === texto).click();
  }, texto);
  const calls = () => page.evaluate(() => window.calls);

  // Terminal: 3 fallos → el 4.º pide confirmación; se acepta.
  for (let n = 1; n <= 3; n += 1) { await llamar('terminal_mcp', 'terminal_leer', n); await page.waitForTimeout(4000); }
  await llamar('terminal_mcp', 'terminal_leer', 4);
  await page.waitForTimeout(4000);
  assert.match(String(await tarjeta()), /Freno de seguridad/, 'la terminal pide confirmación tras 3 fallos');
  await pulsar('Ejecutar');
  await page.waitForTimeout(3000);
  assert.deepEqual((await calls()).filter((c) => c.startsWith('terminal')), ['terminal_mcp:1', 'terminal_mcp:2', 'terminal_mcp:3', 'terminal_mcp:4']);

  // Aceptado: los siguientes fallos de la terminal ya no paran (30 min de silencio).
  for (let n = 5; n <= 6; n += 1) { await llamar('terminal_mcp', 'terminal_leer', n); await page.waitForTimeout(4000); }
  assert.equal(await tarjeta(), null, 'no vuelve a salir el freno en la terminal');
  assert.deepEqual((await calls()).filter((c) => c.startsWith('terminal')).slice(-2), ['terminal_mcp:5', 'terminal_mcp:6']);

  // AutoCAD no se beneficia: tras aceptar su freno, vuelve a salir en el siguiente fallo.
  for (let n = 1; n <= 3; n += 1) { await llamar('autocad', 'lisp', n); await page.waitForTimeout(4000); }
  await llamar('autocad', 'lisp', 4);
  await page.waitForTimeout(4000);
  assert.match(String(await tarjeta()), /Freno de seguridad/);
  await pulsar('Ejecutar');
  await page.waitForTimeout(3000);
  await llamar('autocad', 'lisp', 5);
  await page.waitForTimeout(4000);
  assert.match(String(await tarjeta()), /Freno de seguridad/, 'en AutoCAD el freno sigue saliendo cada vez');

  console.log('✔ test_freno_terminal: todo correcto');
} finally {
  await browser.close();
}

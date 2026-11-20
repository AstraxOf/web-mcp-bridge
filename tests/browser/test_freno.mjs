// Freno de seguridad (Chromium + DOM simulado de DeepSeek): un MCP en «Permitir siempre» que falla 3 veces
// seguidas deja de ejecutarse solo y pide confirmación. Uso: node tests/browser/test_freno.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('⚠ test_freno: Playwright no está instalado, prueba omitida.'); process.exit(0); }

const root = new URL('../../', import.meta.url);
const files = ['utils.js', 'prompt_builder.js', 'ui_widget.js', 'adapters/base_adapter.js', 'adapters/deepseek.js', 'core_bridge.js']
  .map((f) => readFileSync(new URL(`content_scripts/${f}`, root), 'utf8'));

// API de la extensión simulada: un MCP «autocad» en Permitir siempre cuya herramienta siempre falla.
const FAKE_CHROME = `
  const attach = Element.prototype.attachShadow; // solo en la prueba: Shadow DOM abierto para poder leer el panel
  Element.prototype.attachShadow = function (o) { return attach.call(this, { ...o, mode: 'open' }); };
  window.calls = [];
  window.chrome = { runtime: { id: 'test', onMessage: { addListener() {} }, sendMessage: async (m) => {
    if (m.type === 'GET_STATE') return { ok: true, settings: { platforms: { deepseek: true }, bridgeEnabled: true, autoSend: false, autoInject: false, reminder: false, toolTimeoutSec: 30, maxResultChars: 12000 },
      servers: [{ id: 's1', name: 'autocad', slug: 'autocad', url: 'http://x', enabled: true, permission: 'allow' }] };
    if (m.type === 'GET_ACTIVE_TOOLS') return { ok: true, tools: [{ server: 'autocad', serverLabel: 'autocad', name: 'lisp', description: '', inputSchema: { type: 'object', properties: {} } }] };
    if (m.type === 'CALL_TOOL') { window.calls.push(m.arguments.n); return { ok: false, error: 'AutoCAD está ocupado' }; }
    if (m.type === 'SLEEP') { await new Promise((r) => setTimeout(r, m.ms)); return { ok: true }; }
    return { ok: true };
  } } };`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.route('https://chat.deepseek.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body><div id="chat"></div><textarea id="chat-input"></textarea></body>' }));
  await page.goto('https://chat.deepseek.com/a/chat/s/freno');
  await page.addScriptTag({ content: FAKE_CHROME });
  for (const code of files) await page.addScriptTag({ content: code });
  await page.waitForTimeout(3200); // fin de la línea base

  const responder = (n) => page.evaluate((n) => {
    const div = document.createElement('div');
    div.innerHTML = `<div class="ds-markdown">{"mcp_call":{"server":"autocad","name":"lisp","arguments":{"n":${n}}}}</div>`;
    document.getElementById('chat').appendChild(div);
  }, n);
  const tarjeta = () => page.evaluate(() => {
    const host = [...document.querySelectorAll('*')].find((e) => e.shadowRoot);
    return host?.shadowRoot.querySelector('.card')?.innerText ?? null;
  });

  for (let n = 1; n <= 3; n += 1) {
    await responder(n);
    await page.waitForTimeout(4000);
  }
  assert.deepEqual(await page.evaluate(() => window.calls), [1, 2, 3], 'las 3 primeras se ejecutan solas (Permitir siempre)');
  assert.equal(await tarjeta(), null, 'sin tarjeta de aprobación hasta ahora');

  await responder(4);
  await page.waitForTimeout(4000);
  const texto = await tarjeta();
  assert.ok(texto && /Freno de seguridad/.test(texto) && /3 veces seguidas/.test(texto), `debe pedir confirmación: ${texto}`);
  assert.deepEqual(await page.evaluate(() => window.calls), [1, 2, 3], 'la 4.ª no se ejecuta sin confirmar');

  // Llamada ilegible (JSON roto): antes se ignoraba en silencio; ahora se avisa a la IA en el chat
  const page2 = await browser.newPage();
  await page2.route('https://chat.deepseek.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body><div id="chat"></div><textarea id="chat-input"></textarea></body>' }));
  await page2.goto('https://chat.deepseek.com/a/chat/s/roto');
  await page2.addScriptTag({ content: FAKE_CHROME });
  for (const code of files) await page2.addScriptTag({ content: code });
  await page2.waitForTimeout(3200);
  // a) Bloque a medio escribir (DeepSeek hace una pausa) que se completa 4 s después: NO es un error
  await page2.evaluate(() => {
    const div = document.createElement('div');
    div.innerHTML = '<div class="ds-markdown">{"mcp_call":{"server":"autocad","name":"lisp","arguments":{"n</div>';
    document.getElementById('chat').appendChild(div);
  });
  await page2.waitForTimeout(4000);
  await page2.evaluate(() => { [...document.querySelectorAll('.ds-markdown')].at(-1).textContent += '":1000}}}'; });
  await page2.waitForTimeout(10000);
  assert.doesNotMatch(await page2.inputValue('#chat-input'), /No se pudo leer/, 'un bloque que se estaba escribiendo no debe dar falsa alarma');
  assert.deepEqual(await page2.evaluate(() => window.calls), [1000], 'la llamada completa se ejecuta');
  await page2.fill('#chat-input', '');

  // b) Bloque roto de verdad (comillas sin escapar): se avisa a la IA cuando lleva unos segundos sin cambiar
  await page2.evaluate(() => {
    const div = document.createElement('div');
    div.innerHTML = '<div class="ds-markdown">Voy a trocear: {"mcp_call":{"server":"autocad","name":"lisp","arguments":{"expresion":"(ssget "_X")"}}}</div>';
    document.getElementById('chat').appendChild(div);
  });
  await page2.waitForTimeout(13000);
  const aviso = await page2.inputValue('#chat-input');
  assert.match(aviso, /No se pudo leer tu bloque mcp_call: JSON inválido/, `debe avisar a la IA: ${aviso}`);
  assert.equal(await page2.evaluate(() => window.calls.length), 1, 'el bloque roto no ejecuta nada');

  // Captura de pantalla en DeepSeek: no se adjunta (no aporta y puede atascar el envío); va una nota de texto
  const page3 = await browser.newPage();
  await page3.route('https://chat.deepseek.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body><div id="chat"></div><textarea id="chat-input"></textarea></body>' }));
  await page3.goto('https://chat.deepseek.com/a/chat/s/captura');
  await page3.addScriptTag({ content: FAKE_CHROME.replace("window.calls.push(m.arguments.n); return { ok: false, error: 'AutoCAD está ocupado' };",
    "window.calls.push(m.arguments.n); return { ok: true, result: { content: [{ type: 'text', text: 'Captura tomada' }, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }] } };") });
  for (const code of files) await page3.addScriptTag({ content: code });
  await page3.waitForTimeout(3200);
  await page3.evaluate(() => {
    const div = document.createElement('div');
    div.innerHTML = '<div class="ds-markdown">{"mcp_call":{"server":"autocad","name":"lisp","arguments":{"n":7}}}</div>';
    document.getElementById('chat').appendChild(div);
  });
  await page3.waitForTimeout(5000);
  const enviado = await page3.inputValue('#chat-input');
  assert.match(enviado, /Captura tomada/);
  assert.match(enviado, /Imagen no adjuntada: DeepSeek/);
  assert.doesNotMatch(enviado, /imagen adjunta/i);

  console.log('✔ test_freno: todo correcto');
} finally {
  await browser.close();
}

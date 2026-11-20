// Ritmo de envío (Chromium + DOM simulado de DeepSeek): pausa mínima entre envíos y reintento cuando el chat
// responde «Messages too frequent. Try again later.». Uso: node tests/browser/test_ritmo.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log('⚠ test_ritmo: Playwright no está instalado, prueba omitida.');
  process.exit(0);
}
const root = new URL('../../', import.meta.url);
const scripts = ['content_scripts/utils.js', 'content_scripts/adapters/base_adapter.js', 'content_scripts/adapters/deepseek.js']
  .map((f) => readFileSync(new URL(f, root), 'utf8'));

// Chat simulado como DeepSeek: el mensaje SIEMPRE se acepta (se vacía el cuadro y se pinta en el chat); si
// window.limitar > 0, la IA no responde y DEBAJO queda el aviso «Messages too frequent…» (permanente).
const HTML = `<!doctype html><html><body><div id="chat"></div>
<div class="barra"><textarea id="chat-input"></textarea>
<div role="button" class="ds-icon-button" id="enviar"><svg width="10" height="10"></svg></div></div>
<script>
  window.limitar = 0; window.enviados = [];
  document.getElementById('enviar').addEventListener('click', () => {
    const box = document.getElementById('chat-input');
    window.enviados.push(box.value);
    const m = document.createElement('div'); m.className = 'user'; m.textContent = box.value; box.value = '';
    document.getElementById('chat').appendChild(m);
    if (window.limitar > 0) {
      window.limitar -= 1;
      const t = document.createElement('div'); t.className = 'aviso'; t.textContent = 'Messages too frequent. Try again later.';
      document.getElementById('chat').appendChild(t);
    }
  });
  window.repintar = () => { const c = document.getElementById('chat'); c.replaceWith(c.cloneNode(true)); };
</script></body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.route('https://chat.deepseek.com/**', (route) => route.fulfill({ contentType: 'text/html', body: HTML }));
  await page.goto('https://chat.deepseek.com/a/chat/s/ritmo');
  for (const code of scripts) await page.addScriptTag({ content: code });
  await page.evaluate(() => {
    window.a = WMB.findAdapter('chat.deepseek.com');
    window.a.configure({ sendPauseMinSec: 1, sendPauseMaxSec: 1, maxSendsPerMinute: 0 });
    window.registro = []; window.a.debug = (k, m) => window.registro.push(m);
    WMB.backoffMs = () => 400; // en la prueba no se esperan 20 s
  });

  // 1) Aviso una vez: espera, vuelve a escribir el mensaje descartado y lo envía
  let r = await page.evaluate(async () => { window.limitar = 1; return window.a.sendToolResult('RESULTADO 1'); });
  assert.deepEqual(r, { ok: true, reintentos: 1 }, JSON.stringify(r));
  assert.deepEqual(await page.evaluate(() => window.enviados), ['RESULTADO 1', 'RESULTADO 1'], 'se reenvía una vez');
  assert.ok((await page.evaluate(() => window.registro.join(' | '))).includes('Reintento 1/3'));

  // 2) Pausa mínima: el siguiente envío espera al menos 1 s desde el anterior
  // (el envío anterior acabó hace ~2,5 s: con una pausa mínima de 4 s todavía hay que esperar ≥ 1,5 s)
  r = await page.evaluate(async () => {
    window.a.configure({ sendPauseMinSec: 4, sendPauseMaxSec: 4 });
    const t0 = Date.now(); const res = await window.a.sendToolResult('RESULTADO 2');
    window.a.configure({ sendPauseMinSec: 1, sendPauseMaxSec: 1 });
    return { ...res, ms: Date.now() - t0 };
  });
  assert.ok(r.ok && !r.reintentos && r.ms >= 1300, JSON.stringify(r));
  assert.ok((await page.evaluate(() => window.registro.join(' | '))).includes('Esperando'));

  // 3) Un resultado que CONTIENE «inténtalo más tarde» no se confunde con el aviso del chat
  r = await page.evaluate(async () => window.a.sendToolResult('Error del MCP: inténtalo más tarde'));
  assert.deepEqual(r, { ok: true }, JSON.stringify(r));
  assert.equal(await page.evaluate(() => window.enviados.length), 4);

  // 3b) DeepSeek repinta el chat (los avisos antiguos vuelven a crearse): no es un aviso nuevo, no se reenvía
  r = await page.evaluate(async () => { setTimeout(() => window.repintar(), 300); return window.a.sendToolResult('RESULTADO REPINTADO'); });
  assert.deepEqual(r, { ok: true }, JSON.stringify(r));
  assert.equal(await page.evaluate(() => window.enviados.filter((t) => t === 'RESULTADO REPINTADO').length), 1);

  // 4) Aviso persistente: tras 3 reintentos se rinde y lo dice
  r = await page.evaluate(async () => { window.limitar = 99; return window.a.sendToolResult('RESULTADO 4'); });
  assert.ok(!r.ok && /demasiados mensajes/.test(r.error), JSON.stringify(r));
  console.log('✔ test_ritmo: todo correcto');
} finally {
  await browser.close();
}

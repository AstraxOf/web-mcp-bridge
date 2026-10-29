/**
 * utils.js — Utilidades compartidas por todos los content scripts.
 * Define el espacio de nombres global `WMB` (Web MCP Bridge).
 */
(() => {
  'use strict';
  const WMB = (globalThis.WMB = globalThis.WMB || {});
  WMB.VERSION = '1.2.0';

  const nativeSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Mensaje al service worker (nunca lanza excepción). */
  WMB.bg = async (message) => {
    try { return await globalThis.chrome?.runtime?.sendMessage(message); } catch { return null; }
  };

  /** ¿La pestaña está oculta, tapada por otra ventana o sin foco? Ahí Chrome/Brave frenan los temporizadores de la página. */
  WMB.isBackground = () => typeof document !== 'undefined' && (document.hidden || !document.hasFocus());

  /**
   * Pausa que NO se congela en segundo plano: con la pestaña oculta, el temporizador lo cuenta el service worker
   * (los setTimeout de una pestaña oculta se frenan a 1 s y, tras 5 min, a 1 por minuto). Si falla, usa setTimeout.
   */
  WMB.sleep = async (ms) => {
    if (!WMB.isBackground() || !globalThis.chrome?.runtime?.sendMessage) return nativeSleep(ms);
    const started = Date.now();
    await Promise.race([
      WMB.bg({ type: 'SLEEP', ms }),
      nativeSleep(ms + 3000), // red de seguridad si el service worker no contesta
    ]);
    // Garantía: una pausa siempre dura (casi) lo pedido. Si el service worker contestó de golpe (extensión recargada,
    // error…) se completa con setTimeout, para que ningún bucle pueda girar sin freno y colgar la pestaña.
    const left = ms - (Date.now() - started);
    if (left > 20) await nativeSleep(left);
  };

  /** ¿Sigue viva la extensión para este content script? (tras recargarla, el script viejo queda huérfano). */
  WMB.extensionAlive = () => !globalThis.chrome?.runtime || Boolean(globalThis.chrome.runtime.id);

  /** Reintenta `fn` hasta que devuelva un valor «truthy» o venza el timeout. */
  WMB.waitFor = async (fn, { timeout = 3000, interval = 100 } = {}) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = fn();
      if (value) return value;
      await WMB.sleep(interval);
    }
    return fn() || null;
  };

  /** Hash rápido (djb2) para generar IDs de llamadas. */
  WMB.hash = (text) => {
    let h = 5381;
    for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  };

  // ───────────────────────── Selectores flexibles ─────────────────────────

  WMB.isVisible = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));

  /** Primer elemento VISIBLE que coincida con cualquiera de los selectores (por orden de prioridad). */
  WMB.firstVisible = (selectors, root = document, { loose = false } = {}) => {
    for (const selector of selectors) {
      try {
        for (const el of root.querySelectorAll(selector)) if (WMB.isVisible(el)) return el;
      } catch { /* selector inválido: se ignora */ }
    }
    // Ventana minimizada o tapada: el navegador puede reportar tamaño 0; con `loose` se acepta el primer coincidente.
    if (loose) {
      for (const selector of selectors) {
        try { const el = root.querySelector(selector); if (el) return el; } catch { /* noop */ }
      }
    }
    return null;
  };

  WMB.exists = (selectors, root = document) => {
    for (const selector of selectors) {
      try { if (root.querySelector(selector)) return true; } catch { /* noop */ }
    }
    return false;
  };

  /** Todos los elementos del PRIMER selector que devuelva resultados. */
  WMB.allMatches = (selectors, root = document) => {
    for (const selector of selectors) {
      try {
        const found = Array.from(root.querySelectorAll(selector));
        if (found.length) return found;
      } catch { /* noop */ }
    }
    return [];
  };

  // ───────────────────────── Parser de llamadas MCP ─────────────────────────

  /** Devuelve el índice de la llave que cierra el objeto JSON que empieza en `start`, o -1. */
  function findBalancedEnd(text, start) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i += 1;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}' && --depth === 0) return i;
    }
    return -1;
  }

  function scanCalls(text) {
    const calls = [];
    const marker = '"mcp_call"';
    let from = 0;
    for (;;) {
      const at = text.indexOf(marker, from);
      if (at === -1) break;
      from = at + marker.length;
      const start = text.lastIndexOf('{', at);
      if (start === -1) continue;
      const end = findBalancedEnd(text, start);
      if (end === -1) continue;
      try {
        const call = JSON.parse(text.slice(start, end + 1))?.mcp_call;
        if (call && typeof call.name === 'string' && call.name) {
          let args = call.arguments;
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } } // algunos modelos serializan los argumentos
          calls.push({
            server: typeof call.server === 'string' ? call.server : null,
            name: call.name,
            arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
          });
          from = end + 1;
        }
      } catch { /* JSON incompleto o inválido */ }
    }
    return calls;
  }

  /**
   * Extrae del texto de un mensaje todas las llamadas `{"mcp_call": {...}}` válidas.
   * Tolera bloques de código, texto alrededor, espacios no estándar y comillas tipográficas.
   * @returns {{server:string|null,name:string,arguments:object}[]}
   */
  WMB.extractMcpCalls = (rawText) => {
    const raw = String(rawText).replace(/[\u00a0\u200b\u2028\u2029]/g, ' ');
    const calls = scanCalls(raw);
    if (calls.length || !raw.includes('mcp_call')) return calls;
    // Último recurso: algunos renderizadores convierten las comillas rectas en tipográficas (“ ”).
    return scanCalls(raw.replace(/[“”„‟″]/g, '"'));
  };

  // ───────────────────────── Resultados MCP (sin omitir nada) ─────────────────────────

  const EXT = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg',
    'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'application/pdf': 'pdf', 'application/json': 'json', 'text/plain': 'txt',
  };
  const kb = (bytes) => `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const cleanB64 = (data) => String(data).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  const sameJson = (a, b) => { try { return JSON.stringify(JSON.parse(a)) === JSON.stringify(b); } catch { return false; } };

  /**
   * Convierte el resultado MCP (`content[]`) en partes de texto + archivos.
   * Texto, recursos y structuredContent van en línea; imágenes, audio y blobs se adjuntan como archivos.
   * @returns {{parts:(string|{file:object,label:string})[], files:{name:string,mime:string,b64:string,bytes:number}[]}}
   */
  WMB.parseResult = (result, base = 'resultado') => {
    const parts = [];
    const files = [];
    const attach = (data, mime, label) => {
      const mimeType = mime || 'application/octet-stream';
      const b64 = cleanB64(data);
      const ext = EXT[mimeType] ?? (mimeType.split('/')[1] ?? 'bin').split(/[+;]/)[0];
      const file = { name: `${base}_${files.length + 1}.${ext}`, mime: mimeType, b64, bytes: Math.floor((b64.length * 3) / 4) };
      files.push(file);
      parts.push({ file, label });
    };

    let textParts = 0;
    for (const item of result?.content ?? []) {
      if (item.type === 'text') { parts.push(item.text ?? ''); textParts += 1; }
      else if ((item.type === 'image' || item.type === 'audio') && typeof item.data === 'string') attach(item.data, item.mimeType, item.type === 'image' ? 'imagen' : 'audio');
      else if (item.type === 'resource' && item.resource) {
        const { uri = '', text, blob, mimeType } = item.resource;
        if (typeof text === 'string') parts.push(`[recurso ${uri}]\n${text}`);
        else if (typeof blob === 'string') attach(blob, mimeType, `recurso ${uri}`.trim());
        else parts.push(JSON.stringify(item));
      } else if (item.type === 'resource_link') {
        parts.push(`[enlace: ${[item.uri, item.name, item.description].filter(Boolean).join(' · ')}]`);
      } else parts.push(JSON.stringify(item)); // tipo desconocido: se conserva tal cual
    }
    const structured = result?.structuredContent;
    if (structured !== undefined && structured !== null) {
      const duplicated = (result.content ?? []).some((c) => c.type === 'text' && sameJson(c.text, structured));
      if (!duplicated) parts.push(JSON.stringify(structured, null, 2));
    }
    return { parts, files, hasText: textParts > 0 };
  };

  /** Une las partes en texto; `attached` indica si los archivos llegaron adjuntos al chat. */
  WMB.renderParts = (parts, attached = true) => parts
    .map((p) => (typeof p === 'string' ? p
      : attached ? `[${p.label} adjunta a este mensaje: ${p.file.name} (${p.file.mime}, ${kb(p.file.bytes)})]`
        : `[${p.label} NO adjuntada (el navegador la descargó): ${p.file.name} (${p.file.mime}, ${kb(p.file.bytes)})]`))
    .join('\n');

  /** Mensaje que se escribe en el chat con el resultado de la herramienta. */
  WMB.formatToolResult = ({ server, name, status, text }) => `[MCP_RESULT server="${server}" tool="${name}" status="${status}"]\n${text ?? ''}\n[/MCP_RESULT]`;

  const PREVIEW_CHARS = 1500;

  /**
   * Plan de entrega de un resultado MCP SIN pérdida de información:
   *  - imágenes/audio/blobs → archivos adjuntos;
   *  - texto que supere `maxChars` → se adjunta COMPLETO como .txt y en línea queda un extracto.
   * Si el adjunto falla, `build(false)` deja TODO el texto en línea.
   * @returns {{files:object[], build:(attached:boolean)=>string}}
   */
  WMB.planResult = (result, { server, name, status, maxChars = 12000 }) => {
    const base = `${server}_${name}`.replace(/[^\w.-]+/g, '_').slice(0, 40);
    const { parts, files } = WMB.parseResult(result, base);
    const full = WMB.renderParts(parts, true);
    let overflow = null;
    if (full.length > maxChars) {
      overflow = { name: `${base}_completo.txt`, mime: 'text/plain', text: full, bytes: full.length, overflow: true };
      files.push(overflow);
    }
    const build = (attached) => {
      let text = WMB.renderParts(parts, attached);
      if (overflow && attached) {
        text = `${text.slice(0, PREVIEW_CHARS)}\n…\n[resultado de ${full.length} caracteres: contenido COMPLETO en el archivo adjunto ${overflow.name}]`;
      }
      return WMB.formatToolResult({ server, name, status, text });
    };
    return { files, build };
  };

  // ───────────────────────── Escritura en el cuadro de texto ─────────────────────────

  const dom = (WMB.dom = {});

  dom.getText = (el) => ('value' in el ? el.value : (el.innerText || el.textContent || ''));

  /** Construye un `File` a partir de `{name, mime, b64}` o `{name, mime, text}`. */
  dom.fileFrom = ({ name, mime, b64, text }) => {
    if (b64 === undefined) return new File([text ?? ''], name, { type: mime });
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: mime });
  };

  /** Descarga un archivo (último recurso cuando no se puede adjuntar al chat: así nada se pierde). */
  dom.download = (file) => {
    const url = URL.createObjectURL(file);
    const link = Object.assign(document.createElement('a'), { href: url, download: file.name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  /**
   * Escribe texto en un <textarea> o en un editor contenteditable (ProseMirror, Quill, Lexical…)
   * de forma que el framework de la página detecte el cambio.
   * Estrategia: execCommand → evento paste → asignación directa.
   */
  dom.setText = async (el, text, { append = true } = {}) => {
    el.focus();

    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      const previous = append ? el.value : '';
      setter.call(el, previous ? `${previous}\n\n${text}` : text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.setSelectionRange?.(el.value.length, el.value.length);
      return true;
    }

    const selection = getSelection();
    const selectAll = () => {
      const range = document.createRange();
      range.selectNodeContents(el);
      if (append) range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    };

    selectAll();
    if (!append) document.execCommand('delete');
    const hadText = dom.getText(el).trim().length > 0;
    const before = dom.getText(el).length;

    if (append && hadText) {
      document.execCommand('insertLineBreak');
      document.execCommand('insertLineBreak');
    }
    text.split('\n').forEach((line, i) => {
      if (i > 0) document.execCommand('insertLineBreak');
      if (line) document.execCommand('insertText', false, line);
    });
    await WMB.sleep(50);
    if (dom.getText(el).length > before) return true;

    // Fallback 1: simular un «pegar»
    try {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      await WMB.sleep(80);
      if (dom.getText(el).length > before) return true;
    } catch { /* noop */ }

    // Fallback 2: asignación directa
    el.textContent = append && hadText ? `${dom.getText(el)}\n\n${text}` : text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return dom.getText(el).length > before;
  };
})();

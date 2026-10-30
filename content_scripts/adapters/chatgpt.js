/**
 * chatgpt.js — Adaptador para ChatGPT (chatgpt.com).
 *
 * Este adaptador usa su PROPIO observador (no el del adaptador base): la UI de ChatGPT cambia el contenedor de
 * los mensajes (visor de código) y la llamada `mcp_call` puede estar en un bloque de código, fuera del mensaje,
 * o en texto normal. Por eso se localiza por su TEXTO, no por selectores de mensaje.
 *
 *  - Cuando ChatGPT responde con texto normal, su Markdown se come las barras invertidas
 *    (`C:\\Users` → `C:\Users`) y el JSON deja de ser válido: se repara antes de parsearlo.
 *  - Anti-repetición SIN memoria persistente: una llamada se ejecuta una sola vez mientras siga visible en la
 *    página; cuando desaparece (otro chat, regenerar…) se olvida. Nada se guarda entre recargas, así que nunca
 *    bloquea una tarea nueva con un «ya se ejecutó».
 *  - Historial: si no ha habido actividad reciente (envío tuyo o generación en vivo), lo que hay en la página es
 *    antiguo y nunca se ejecuta, tarde lo que tarde en cargar.
 *
 * Si OpenAI cambia su interfaz, normalmente solo hay que añadir un selector a la lista correspondiente.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  const USER_SEL = '[data-message-author-role="user"], [data-turn="user"]';
  const CACHE_MS = 300;
  const STABLE_MS = 1200;     // el bloque debe quedar sin cambios este tiempo
  const STUCK_MS = 2500;      // «generando» pegado: se da por terminado tras este tiempo estable
  const POLL_MS = 700;
  const ACTIVE_MS = 180_000;  // una llamada solo es «nueva» si hubo actividad hace menos de esto
  const FORGET_MS = 8000;     // una llamada ejecutada se olvida cuando lleva este tiempo sin estar en la página

  const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'PRE', 'TR', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE']);
  const SKIP_TAGS = new Set(['BUTTON', 'SVG', 'STYLE', 'SCRIPT', 'NOSCRIPT']);

  /** Texto «visible» de un nodo con saltos de línea por bloque / línea de código. */
  function extractText(root) {
    let out = '';
    const newline = () => { if (out && !out.endsWith('\n')) out += '\n'; };
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) { out += node.nodeValue; return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toUpperCase();
      if (SKIP_TAGS.has(tag)) return;
      if (tag === 'BR') { out += '\n'; return; }
      const isBlock = BLOCK_TAGS.has(tag) || node.classList.contains('cm-line');
      if (isBlock) newline();
      for (const child of node.childNodes) walk(child);
      if (isBlock) newline();
    };
    walk(root);
    return out;
  }

  /** Objetos JSON completos y válidos dentro de un texto (ignora lo que rodea al JSON). */
  function findJsonObjects(text) {
    const found = [];
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] !== '{') continue;
      let depth = 0; let inString = false; let escaped = false;
      for (let j = i; j < text.length; j += 1) {
        const ch = text[j];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            try { found.push(JSON.parse(text.slice(i, j + 1))); i = j; } catch { /* no era JSON válido */ }
            break;
          }
        }
      }
    }
    return found;
  }

  /** Arregla barras invertidas que el Markdown dejó sueltas dentro de strings JSON. */
  function fixString(raw) {
    // Ruta de Windows (C:\...): todas las barras son separadores literales.
    if (/^[A-Za-z]:\\/.test(raw)) return raw.replace(/\\+/g, '\\\\');
    // Resto: duplica solo las barras que no forman un escape JSON válido.
    return raw.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})|\\/g, (m, valid) => (valid ? m : '\\\\'));
  }

  function repairBackslashes(text) {
    let out = ''; let i = 0;
    while (i < text.length) {
      if (text[i] !== '"') { out += text[i]; i += 1; continue; }
      let j = i + 1; let raw = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) { raw += text[j] + text[j + 1]; j += 2; }
        else { raw += text[j]; j += 1; }
      }
      out += '"' + fixString(raw) + '"';
      i = j + 1;
    }
    return out;
  }

  /** Llamadas MCP de un texto: parser de la extensión; si falla, se reparan comillas/barras y se reintenta. */
  function parseCalls(text) {
    try {
      const direct = WMB.extractMcpCalls(text);
      if (direct?.length) return direct;
    } catch { /* se prueban las variantes */ }

    const clean = text.replace(/[“”]/g, '"').replace(/\u00a0/g, ' ');
    for (const variant of [text, repairBackslashes(clean)]) {
      for (const obj of findJsonObjects(variant)) {
        if (!obj || typeof obj !== 'object' || !('mcp_call' in obj)) continue;
        try {
          const normalized = WMB.extractMcpCalls('```json\n' + JSON.stringify(obj) + '\n```');
          if (normalized?.length) return normalized;
        } catch { /* siguiente candidato */ }
      }
    }
    return [];
  }

  /**
   * Texto que verá el observador base: el del mensaje y, si su JSON estaba roto por el Markdown,
   * la llamada reparada añadida al final (determinista: el mismo mensaje da siempre el mismo texto).
   */
  function messageText(element) {
    const text = extractText(element);
    if (!text.includes('mcp_call')) return text;
    try { if (WMB.extractMcpCalls(text).length) return text; } catch { /* se intenta reparar */ }
    const calls = parseCalls(text);
    if (!calls.length) return text;
    return `${text}\n${calls.map((call) => '```json\n' + JSON.stringify({ mcp_call: call }) + '\n```').join('\n')}`;
  }

  /** Envuelve el elemento para que `textContent` devuelva el texto reconstruido (el resto se delega tal cual). */
  function wrap(element) {
    return new Proxy(element, {
      get(target, prop) {
        if (prop === 'textContent') return messageText(target);
        if (prop === '__raw') return target;
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  /** ¿Es un elemento del asistente (ni del usuario, ni del formulario) con una llamada MCP real (no la plantilla del prompt)? */
  function isCallElement(el) {
    const raw = el.textContent || '';
    return raw.includes('mcp_call') && !raw.includes('<servidor>')
      && !el.closest(USER_SEL) && !el.querySelector(USER_SEL) && !el.closest('form');
  }

  const inDocumentOrder = (a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

  class ChatGPTAdapter extends WMB.BaseAdapter {
    #cache = null;

    constructor() {
      super({
        id: 'chatgpt',
        name: 'ChatGPT',
        selectors: {
          composer: [
            '#prompt-textarea',
            'div.ProseMirror[contenteditable="true"]',
            'form div[contenteditable="true"]',
            'textarea[name="prompt-textarea"]',
            'textarea[data-id="root"]',
            'form textarea',
          ],
          sendButton: [
            'button[data-testid="send-button"]',
            'button[aria-label*="Send" i]',
            'button[aria-label*="Enviar" i]',
            'form button[type="submit"]',
          ],
          // Se usan TODOS los que devuelvan elementos (no solo el primero).
          assistantMessages: [
            '[data-message-author-role="assistant"]',
            'article[data-turn="assistant"]',
            '[data-turn="assistant"]',
            'div.agent-turn',
          ],
          // Solo el botón de «detener generación» (no el de dictado).
          stopButton: [
            'button[data-testid="stop-button"]',
            'button[aria-label*="Stop streaming" i]',
            'button[aria-label*="Stop generating" i]',
            'button[aria-label*="Detener la transm" i]',
            'button[aria-label*="Detener generaci" i]',
          ],
          fileInput: ['input[type="file"]'],
        },
      });
    }

    matches(hostname) {
      return hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com') || hostname === 'chat.openai.com';
    }

    /**
     * Mensajes del asistente en orden de documento, sin anidados (se queda el contenedor más externo),
     * con el texto reconstruido y reparado. Incluye los bloques/textos con `mcp_call` que queden fuera de
     * los contenedores conocidos.
     */
    getAssistantMessages() {
      const now = Date.now();
      if (this.#cache && now - this.#cache.time < CACHE_MS) return this.#cache.list;

      const containers = new Set();
      for (const selector of this.selectors.assistantMessages) {
        try { document.querySelectorAll(selector).forEach((el) => containers.add(el)); } catch { /* selector inválido */ }
      }
      const known = [...containers].filter((el) => !el.closest(USER_SEL) && !el.querySelector(USER_SEL));
      const extras = this.#callElements().filter((el) => !known.some((c) => c.contains(el)));

      const all = [...known, ...extras];
      const list = all
        .filter((el) => !all.some((other) => other !== el && other.contains(el)))
        .sort(inDocumentOrder)
        .map(wrap);
      this.#cache = { time: now, list };
      return list;
    }

    /**
     * Observa las respuestas. Misma interfaz que el adaptador base:
     * `callback({id, call, element})` por cada llamada MCP nueva; `onDone({text, element})` por respuesta sin llamada.
     * @returns {() => void} detiene la observación
     */
    observeResponses(callback, { onDone } = {}) {
      let alive = true;
      let scheduled = false;
      let lastDone = '';
      const done = new Map();       // id de llamada ya tratada → {absentSince}
      const seen = new WeakMap();   // elemento → {text, since}
      const say = (message) => { try { this.debug?.('ok', `ChatGPT · ${message}`); } catch { /* sin panel */ } };
      const convOf = () => (location.pathname.match(/\/c\/([^/?#]+)/) || [])[1] || null;
      let conv = convOf();

      const scan = () => {
        const now = Date.now();

        // Cambio de conversación (a otra o a «chat nuevo»): se empieza de cero. Un chat nuevo que recibe su URL
        // (/ → /c/<id>) NO cuenta como cambio.
        const nowConv = convOf();
        if (nowConv !== conv) {
          if (conv !== null) { done.clear(); this.lastActivity = 0; lastDone = ''; }
          conv = nowConv;
        }

        const streaming = this.isStreaming();
        if (streaming) this.lastActivity = now;
        const baseline = now - this.lastActivity >= ACTIVE_MS;

        const tally = new Map();
        const present = new Set();
        const blocks = this.#callElements().sort(inDocumentOrder);
        for (const el of blocks) {
          const text = extractText(el);
          let state = seen.get(el);
          if (!state || state.text !== text) { state = { text, since: now }; seen.set(el, state); }
          const calls = parseCalls(text);
          if (!calls.length) continue;
          const stableFor = now - state.since;
          const ready = baseline || (stableFor >= STABLE_MS && (!streaming || stableFor >= STUCK_MS));

          calls.forEach((call, n) => {
            // ID = la llamada + cuántas idénticas hay antes en la página (no depende de URL ni de IDs de mensaje).
            const hash = WMB.hash(JSON.stringify(call));
            const occurrence = tally.get(hash) ?? 0;
            tally.set(hash, occurrence + 1);
            const id = `${hash}:${occurrence}`;
            present.add(id);
            if (!ready || done.has(id)) return;
            done.set(id, { absentSince: 0 });
            // Protocolo: una llamada por mensaje → solo se ejecuta la primera. En línea base solo se memoriza.
            if (!baseline && n === 0) { say('llamada detectada, ejecutando…'); callback({ id, call, element: wrap(el) }); }
          });
        }

        // Se olvidan las llamadas que ya no están en la página (así repetir una tarea nunca queda bloqueado).
        for (const [id, entry] of done) {
          if (present.has(id)) entry.absentSince = 0;
          else if (!entry.absentSince) entry.absentSince = now;
          else if (now - entry.absentSince >= FORGET_MS) done.delete(id);
        }

        // Respuesta terminada SIN llamada MCP.
        if (!baseline && !streaming && onDone) {
          const messages = this.getAssistantMessages();
          let last = -1;
          for (let i = messages.length - 1; i >= 0 && last < 0; i -= 1) if ((messages[i].textContent || '').trim()) last = i;
          if (last >= 0) {
            const text = messages[last].textContent;
            const key = `${conv}:${messages.length}:${text.length}`;
            const probe = seen.get(messages[last].__raw) ?? { text: '', since: now };
            if (probe.text !== text) seen.set(messages[last].__raw, { text, since: now });
            else if (now - probe.since >= STABLE_MS && key !== lastDone && !parseCalls(text).length) {
              lastDone = key; onDone({ text, element: messages[last] });
            }
          }
        }
      };
      this.rescan = () => { lastDone = ''; scan(); };

      const schedule = (delay = 400) => {
        if (scheduled) return;
        scheduled = true;
        WMB.sleep(delay).then(() => { scheduled = false; if (alive) scan(); });
      };
      const observer = new MutationObserver(() => schedule());
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });

      const wake = () => { if (!document.hidden) this.rescan(); };
      document.addEventListener('visibilitychange', wake);
      window.addEventListener('focus', wake);

      (async () => {
        while (alive) {
          await WMB.sleep(POLL_MS);
          if (!WMB.extensionAlive()) alive = false;
          if (!alive) break;
          scan();
        }
      })();

      return () => {
        alive = false;
        observer.disconnect();
        document.removeEventListener('visibilitychange', wake);
        window.removeEventListener('focus', wake);
      };
    }

    /** Elementos con una llamada MCP localizados por su texto: bloques <pre> y, si no, el texto normal. */
    #callElements() {
      const found = Array.from(document.querySelectorAll('pre')).filter(isCallElement);

      // Texto normal: se busca el nodo de texto con «mcp_call» y se sube hasta el elemento cuyo texto contiene una llamada válida.
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!/mcp_call|"server"\s*:/.test(node.nodeValue) || node.nodeValue.includes('<servidor>')) continue;
        let el = node.parentElement;
        if (!el || el.closest(USER_SEL) || el.closest('form') || el.closest('[contenteditable="true"]')) continue;
        for (let depth = 0; el && depth < 10 && el !== document.body && el.tagName !== 'MAIN'; depth += 1, el = el.parentElement) {
          if (el.querySelector(USER_SEL)) break;
          if (!isCallElement(el)) continue;
          if (parseCalls(extractText(el)).length) {
            if (!found.some((f) => f === el || f.contains(el))) found.push(el);
            break;
          }
        }
      }
      return found.filter((el) => !found.some((other) => other !== el && el.contains(other) && !other.matches('pre')));
    }
  }

  WMB.registerAdapter(new ChatGPTAdapter());
})();
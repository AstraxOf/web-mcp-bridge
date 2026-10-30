/**
 * chatgpt.js — Adaptador para ChatGPT (chatgpt.com).
 *
 * Si OpenAI cambia su interfaz, normalmente solo hay que añadir un selector
 * a la lista correspondiente (los primeros tienen prioridad).
 *
 * Este adaptador NO usa el observador del adaptador base: la UI de ChatGPT cambia el
 * contenedor de los mensajes (visor de código `InlineCodePane`) y el bloque con el
 * `mcp_call` puede quedar fuera de `[data-message-author-role="assistant"]`.
 * Aquí se leen directamente los <pre> que contienen «mcp_call» y, si la respuesta es
 * texto normal (sin bloque de código), los párrafos del mensaje del asistente
 * (fuera de mensajes del usuario). Se espera a que el texto quede estable, se parsea
 * el JSON (reparando barras invertidas que el Markdown haya comido) y se avisa a la extensión.
 *
 * Depuración: `DEBUG = true` escribe en consola líneas «[WMB chatgpt] …».
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;
  const DEBUG = true;

  const ACTIVE_MS = 180_000;  // una llamada solo es «nueva» si hubo actividad (envío / generación) hace menos de esto
  const STABLE_MS = 1200;     // el bloque debe quedar sin cambios este tiempo
  const STUCK_MS = 2500;      // «generando» pegado: se da por terminado tras este tiempo estable
  const POLL_MS = 700;
  const STORE_KEY = 'wmb:executed';
  const STORE_LIMIT = 500;

  const USER_SEL = '[data-message-author-role="user"], [data-turn="user"]';
  const TURN_SEL = '[data-message-author-role], [data-turn], [data-testid^="conversation-turn"], article';
  const TEXT_SEL = '.markdown, .prose, [data-message-author-role="assistant"], [data-turn="assistant"], [data-testid^="conversation-turn"], article';

  const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'PRE', 'TR', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE']);
  const SKIP_TAGS = new Set(['BUTTON', 'SVG', 'STYLE', 'SCRIPT', 'NOSCRIPT']);

  const log = (...args) => { if (DEBUG) console.log('[WMB chatgpt]', ...args); };
  console.log('[WMB chatgpt] adaptador cargado');

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

  /** Envuelve el elemento para que `textContent` devuelva el texto reconstruido (el resto se delega tal cual). */
  function wrap(element) {
    return new Proxy(element, {
      get(target, prop) {
        if (prop === 'textContent') return extractText(target);
        if (prop === '__raw') return target;
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
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
    const variants = [text, repairBackslashes(clean)];
    for (const variant of variants) {
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

  class ChatGPTAdapter extends WMB.BaseAdapter {
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
          // Orden de prioridad: se usa SOLO el primero que devuelva elementos.
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

    /** Mensajes del asistente en orden de documento, sin anidados, con texto reconstruido. */
    getAssistantMessages() {
      let found = [];
      for (const selector of this.selectors.assistantMessages) {
        try { found = Array.from(document.querySelectorAll(selector)); } catch { found = []; }
        if (found.length) break;
      }
      const set = new Set(found);
      return found
        .filter((el) => !found.some((other) => other !== el && el.contains(other) && set.has(other)))
        .map(wrap);
    }

    /**
     * Elementos con una llamada MCP del asistente: bloques <pre> y, además,
     * el texto normal del mensaje (cuando ChatGPT responde sin bloque de código).
     * Nunca los del usuario ni el cuadro de texto.
     */
    #callBlocks() {
      const ok = (el) => {
        const raw = el.textContent || '';
        return raw.includes('mcp_call') && !raw.includes('<servidor>')
          && !el.closest(USER_SEL) && !el.querySelector(USER_SEL) && !el.closest('form');
      };
      const pres = Array.from(document.querySelectorAll('pre')).filter(ok);

      const texts = Array.from(document.querySelectorAll(TEXT_SEL))
        .filter((el) => ok(el) && !pres.some((p) => el.contains(p) || p.contains(el)));
      // Solo el más interno, para no contar dos veces el mismo texto.
      const innermost = texts.filter((el) => !texts.some((o) => o !== el && el.contains(o)));

      const result = [...pres, ...innermost]
        .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      // Último recurso, independiente de la estructura del DOM: se buscan los nodos de texto con «mcp_call».
      if (!result.length) result.push(...this.#byTextNodes(ok, pres));
      return result;
    }

    /** ¿Es un nodo de texto candidato (fuera de mensajes del usuario, formularios y editores)? */
    #candidateNodes() {
      const nodes = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!/mcp_call|"server"\s*:/.test(n.nodeValue) || n.nodeValue.includes('<servidor>')) continue;
        const el = n.parentElement;
        if (!el || el.closest(USER_SEL) || el.closest('form') || el.closest('[contenteditable="true"]')) continue;
        nodes.push(n);
      }
      return nodes;
    }

    /** Sube desde cada nodo de texto hasta el primer ancestro cuyo texto contiene una llamada MCP válida. */
    #byTextNodes(ok, pres) {
      const found = [];
      for (const node of this.#candidateNodes()) {
        let el = node.parentElement;
        for (let depth = 0; el && depth < 10 && el !== document.body && el.tagName !== 'MAIN'; depth += 1, el = el.parentElement) {
          if (el.querySelector(USER_SEL)) break;
          if (!ok(el)) continue;
          if (parseCalls(extractText(el)).length) {
            if (!found.includes(el) && !pres.some((p) => p.contains(el))) found.push(el);
            break;
          }
        }
      }
      return found.filter((el) => !found.some((o) => o !== el && el.contains(o)));
    }

    /** Descripción corta de dónde está el texto «mcp_call» en la página (para el panel de depuración). */
    #describeCandidate() {
      const node = this.#candidateNodes()[0];
      if (!node) return 'no hay ningún texto «mcp_call» fuera de tus mensajes en el DOM principal (¿iframe, shadow DOM o texto partido?)';
      const chain = [];
      for (let el = node.parentElement, i = 0; el && i < 6 && el !== document.body; el = el.parentElement, i += 1) {
        const attrs = Array.from(el.attributes).filter((a) => /^(data-|class|id|role)/.test(a.name)).slice(0, 3)
          .map((a) => `${a.name}="${String(a.value).slice(0, 24)}"`).join(' ');
        chain.push(`${el.tagName.toLowerCase()}${attrs ? `[${attrs}]` : ''}`);
      }
      return `texto en: ${chain.join(' < ')} · «${node.nodeValue.trim().slice(0, 80)}»`;
    }

    #remember(id) {
      this.executed.add(id);
      try { sessionStorage.setItem(STORE_KEY, JSON.stringify(Array.from(this.executed).slice(-STORE_LIMIT))); } catch { /* sin almacenamiento */ }
    }

    /**
     * Observa las respuestas. Misma interfaz que el adaptador base:
     * `callback({id, call, element})` por cada llamada MCP nueva; `onDone({text, element})` por respuesta sin llamada.
     * @returns {() => void} detiene la observación
     */
    observeResponses(callback, { onDone } = {}) {
      let alive = true;
      let scheduled = false;
      let lastDebug = '';
      let lastBlocks = 0;
      let lastDiag = 0;
      let lastWhere = '';
      // Consola + panel flotante de la extensión (core_bridge conecta `adapter.debug`).
      const say = (kind, message) => { log(message); try { this.debug?.(kind, `ChatGPT · ${message}`); } catch { /* sin panel */ } };
      say('ok', 'observador activo');
      let lastDone = '';
      const seen = new WeakMap();            // elemento → {text, since}

      const scan = () => {
        const now = Date.now();
        const streaming = this.isStreaming();
        if (streaming) this.lastActivity = now;
        // Línea base: sin actividad reciente (envío del usuario o generación en vivo) todo lo que hay en la página es
        // historial antiguo: se memoriza pero NUNCA se ejecuta, tarde lo que tarde en cargar la conversación.
        const baseline = now - this.lastActivity >= ACTIVE_MS;

        const blocks = this.#callBlocks();
        if (blocks.length > lastBlocks && !baseline) say('ok', `veo ${blocks.length} bloque(s) mcp_call en la página`);
        lastBlocks = blocks.length;
        if (!blocks.length && !baseline && now - lastDiag > 4000) {
          lastDiag = now;
          const where = this.#describeCandidate();
          if (where !== lastWhere && !where.startsWith('no hay')) say('err', `sin bloques: ${where}`);
          lastWhere = where;
        }
        let pending = 0;
        const tally = new Map();
        blocks.forEach((pre) => {
          const text = extractText(pre);
          let state = seen.get(pre);
          if (!state || state.text !== text) { state = { text, since: now }; seen.set(pre, state); this.awaitingSince = 0; }
          const stableFor = now - state.since;
          const ready = baseline || (stableFor >= STABLE_MS && (!streaming || stableFor >= STUCK_MS));
          const calls = parseCalls(text);
          if (!calls.length) {
            if (stableFor < STUCK_MS) pending += 1;
            else if (!state.warned) { state.warned = true; say('err', `bloque mcp_call que el parser NO reconoce: ${JSON.stringify(text.slice(0, 120))}`); }
            return;
          }
          if (!ready) { pending += 1; return; }

          const holder = pre.closest(TURN_SEL) ?? pre;
          calls.forEach((call, n) => {
            // ID estable: solo depende de la llamada y de cuántas idénticas hay antes en la página (no de la URL,
            // del ID del mensaje —que ChatGPT cambia al terminar de generar— ni de la posición del bloque).
            const hash = WMB.hash(JSON.stringify(call));
            const occurrence = tally.get(hash) ?? 0;
            tally.set(hash, occurrence + 1);
            const id = `call:${hash}:${occurrence}`;
            if (this.executed.has(id)) { if (!state.skipLogged && !state.fired) { state.skipLogged = true; say('err', 'llamada descartada: ya se ejecutó antes (mismo ID)'); } return; }
            this.#remember(id);
            if (baseline) { say('err', 'llamada tomada como ANTIGUA (línea base), no se ejecuta'); return; }
            // Protocolo: una llamada por mensaje → solo se ejecuta la primera.
            if (n === 0) { state.fired = true; say('ok', 'llamada detectada, ejecutando…'); callback({ id, call, element: wrap(holder) }); }
          });
        });

        // Respuesta terminada SIN llamada MCP.
        if (!baseline && !streaming && onDone && !blocks.length) {
          const messages = this.getAssistantMessages();
          let last = -1;
          for (let i = messages.length - 1; i >= 0 && last < 0; i -= 1) if ((messages[i].textContent || '').trim()) last = i;
          if (last >= 0) {
            const text = messages[last].textContent;
            const key = `${location.pathname}:${messages.length}:${text.length}`;
            const probe = seen.get(messages[last].__raw) ?? { text: '', since: now };
            if (probe.text !== text) seen.set(messages[last].__raw, { text, since: now });
            else if (now - probe.since >= STABLE_MS && key !== lastDone && !parseCalls(text).length) {
              lastDone = key; onDone({ text, element: messages[last] });
            }
          }
        }

        const summary = `blocks=${blocks.length} pending=${pending} streaming=${streaming} baseline=${baseline}`;
        if (summary !== lastDebug) { lastDebug = summary; log(summary); }
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
  }

  WMB.registerAdapter(new ChatGPTAdapter());
})();
/**
 * deepseek.js — Adaptador para DeepSeek (chat.deepseek.com).
 *
 * Particularidades de la interfaz de DeepSeek:
 *   - El cuadro de texto es un <textarea id="chat-input"> normal (React): `dom.setText` ya lo maneja.
 *   - El botón de enviar NO tiene aria-label ni clase estable: es un icono (`ds-icon-button`) al final de la barra.
 *     Mientras se genera, ESE MISMO botón pasa a ser «detener»: por eso aquí se envía con Enter y el botón solo se
 *     pulsa si se sabe que no se está generando (si no, un clic CANCELARÍA la respuesta).
 *   - Las respuestas se renderizan en `.ds-markdown`. Con «DeepThink» el razonamiento también usa Markdown y a veces
 *     contiene un borrador de la llamada `mcp_call`: se excluye para no ejecutarla dos veces.
 *   - No hay un ID estable por mensaje.
 *
 * Anti-bucle (el mismo resultado se enviaba una y otra vez):
 *   1. ID de llamada por CONTENIDO (conversación + cuántos mensajes anteriores traen la misma llamada), no por la
 *      posición del mensaje: si DeepSeek repinta o cambia el nº de bloques `.ds-markdown`, la llamada no se «renueva».
 *   2. Cerrojo: tras ejecutar una llamada, otra IDÉNTICA se ignora hasta que el resultado se envíe y la IA vuelva
 *      a responder.
 *   3. Envío seguro: no se pulsa «enviar» si hay una generación en curso, ni si el cuadro ya está vacío (ya salió).
 *
 * Si DeepSeek cambia su interfaz, normalmente solo hay que añadir un selector a la lista correspondiente.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  /** Bloques de «razonamiento» (DeepThink): su texto no cuenta como respuesta. */
  const THINK_SEL = '.ds-think-content, [class*="think" i], [class*="reasoning" i]';
  /** Cabecera corta que precede al razonamiento («Thought for 5 seconds», «Pensó durante 5 segundos»…). */
  const THINK_HEADER = /^(thought|thinking|deepthink|pens[óo]|pensando|razon|reasoning)/i;
  /** Botones de icono (enviar, adjuntar, detener) y, como alternativa, cualquier botón ARIA. */
  const ICON_BUTTONS = ['div[role="button"].ds-icon-button', 'button.ds-icon-button', '.ds-icon-button'];
  const ANY_BUTTONS = ['div[role="button"]', 'button'];

  const GROW_MS = 2000;          // el último mensaje creció hace menos de esto → se está generando
  const FRESH_CHAT_MS = 120_000; // un chat nuevo recibe su URL poco después del primer envío
  const LOCK_SENT_MS = 90_000;   // cerrojo: tras enviar el resultado, máximo este tiempo
  const LOCK_MAX_MS = 240_000;   // …y si el resultado nunca se envía, máximo este otro

  const convId = () => (location.pathname.match(/\/s\/([^/?#]+)/) || [])[1] || null;
  const hashOf = (call) => WMB.hash(JSON.stringify(call));

  /** ¿Es un bloque de razonamiento (no la respuesta)? */
  function isThinking(el) {
    if (el.closest(THINK_SEL) || el.querySelector(THINK_SEL)) return true;
    for (let node = el, depth = 0; node && depth < 3; node = node.parentElement, depth += 1) {
      const head = (node.previousElementSibling?.textContent || '').trim();
      if (head && head.length < 45 && THINK_HEADER.test(head)) return true;
    }
    return false;
  }

  class DeepSeekAdapter extends WMB.BaseAdapter {
    #conv = convId();                            // conversación actual (null = chat nuevo sin URL)
    #tag = this.#conv ?? `h${Date.now()}`;       // etiqueta de conversación para los IDs
    #hashCache = new WeakMap();                  // elemento → {text, set} (hashes de sus llamadas)
    #lock = null;                                // { hash, firedAt, sentAt, newGen }
    #grow = { el: null, len: 0, at: 0 };         // seguimiento del crecimiento del último mensaje

    constructor() {
      super({
        id: 'deepseek',
        name: 'DeepSeek',
        selectors: {
          composer: [
            'textarea#chat-input',
            'textarea[placeholder*="DeepSeek" i]',
            'textarea[placeholder*="Message" i]',
            'textarea[placeholder*="Mensaje" i]',
            'div[role="textbox"][contenteditable="true"]',
            'textarea',
          ],
          sendButton: [
            // Candidatos con etiqueta explícita; la búsqueda real la hace getSendButton().
            'div[role="button"][aria-label*="Send" i]',
            'button[aria-label*="Send" i]',
            'div[role="button"][aria-label*="Enviar" i]',
            'button[aria-label*="Enviar" i]',
          ],
          assistantMessages: ['.ds-markdown'],
          stopButton: [
            'div[role="button"][aria-label*="Stop" i]',
            'button[aria-label*="Stop" i]',
            'div[role="button"][aria-label*="Detener" i]',
            'button[aria-label*="Detener" i]',
            'div[role="button"][aria-label*="Parar" i]',
            'button[aria-label*="Parar" i]',
          ],
          fileInput: ['input[type="file"]'],
        },
      });
    }

    matches(hostname) {
      return hostname === 'deepseek.com' || hostname.endsWith('.deepseek.com');
    }

    // ───────────── Conversación ─────────────

    /** Etiqueta estable de la conversación. Un chat nuevo que recibe su URL (/ → /a/chat/s/<id>) conserva su etiqueta. */
    #syncConversation() {
      const id = convId();
      if (id === this.#conv) return;
      const freshChatGotUrl = this.#conv === null && id !== null && Date.now() - this.lastActivity < FRESH_CHAT_MS;
      this.#conv = id;
      if (!freshChatGotUrl) this.#tag = id ?? `h${Date.now()}`;
    }

    // ───────────── Mensajes del asistente (sin el razonamiento) ─────────────

    getAssistantMessages() {
      this.#syncConversation();
      const found = super.getAssistantMessages();
      const answers = found.filter((el) => !isThinking(el));
      // Si el filtro lo quitara todo, es mejor no filtrar que quedarse ciego.
      const list = answers.length || !found.length ? answers : found;
      // Sin contenedores anidados (evita duplicados con selectores amplios).
      return list.filter((el) => !list.some((other) => other !== el && el.contains(other)));
    }

    /** Hashes de las llamadas MCP de un mensaje (con caché por texto). */
    #callHashes(el) {
      const text = el.textContent || '';
      const hit = this.#hashCache.get(el);
      if (hit && hit.text === text) return hit.set;
      const set = new Set(WMB.extractMcpCalls(text).map(hashOf));
      this.#hashCache.set(el, { text, set });
      return set;
    }

    /**
     * Clave por CONTENIDO: conversación + nº de mensajes anteriores que traen la misma llamada.
     * No depende de la posición del mensaje, así que repintados de la página no «renuevan» una llamada ya ejecutada.
     */
    getMessageKey(element, index) {
      const mine = this.#callHashes(element);
      if (!mine.size) return super.getMessageKey(element, index);
      this.#syncConversation();
      let before = 0;
      for (const other of this.getAssistantMessages()) {
        if (other === element) break;
        for (const hash of this.#callHashes(other)) if (mine.has(hash)) { before += 1; break; }
      }
      return `${this.#tag}|${before}`;
    }

    // ───────────── Generación en curso ─────────────

    /**
     * ¿La IA está generando? Botón «detener» (si tiene etiqueta) o el último mensaje creció hace instantes.
     * No se mira el icono del botón: si falla, haría pasar una conversación antigua por «en vivo».
     */
    isStreaming() {
      let streaming = WMB.exists(this.selectors.stopButton);
      if (!streaming) {
        const messages = this.getAssistantMessages();
        const last = messages[messages.length - 1] ?? null;
        const len = last ? (last.textContent || '').length : 0;
        const now = Date.now();
        if (last && last === this.#grow.el && len > this.#grow.len) this.#grow.at = now; // creció el MISMO mensaje
        this.#grow.el = last;
        this.#grow.len = len;
        streaming = now - this.#grow.at < GROW_MS;
      }
      if (streaming && this.#lock?.sentAt) this.#lock.newGen = true; // la IA volvió a responder tras enviar el resultado
      return streaming;
    }

    // ───────────── Cerrojo anti-duplicado ─────────────

    #locked(hash) {
      const lock = this.#lock;
      if (!lock || lock.hash !== hash) return false;
      const now = Date.now();
      const expired = lock.sentAt ? (lock.newGen || now - lock.sentAt > LOCK_SENT_MS) : now - lock.firedAt > LOCK_MAX_MS;
      if (expired) { this.#lock = null; return false; }
      return true;
    }

    observeResponses(callback, options) {
      return super.observeResponses((detected) => {
        const hash = hashOf(detected.call);
        if (this.#locked(hash)) { this.debug?.('ok', 'DeepSeek · llamada idéntica ya en curso: ignorada'); return; }
        this.#lock = { hash, firedAt: Date.now(), sentAt: 0, newGen: false };
        callback(detected);
      }, options);
    }

    async sendToolResult(text, options) {
      try {
        return await super.sendToolResult(text, options);
      } finally {
        if (this.#lock && !this.#lock.sentAt) this.#lock.sentAt = Date.now();
      }
    }

    // ───────────── Enviar ─────────────

    /** Botón de icono (sin texto) más a la derecha de la barra del cuadro de texto. */
    #composerButtons() {
      const composer = this.getComposer();
      if (!composer) return [];
      let node = composer.parentElement;
      for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
        for (const group of [ICON_BUTTONS, ANY_BUTTONS]) {
          const buttons = [];
          for (const selector of group) {
            try { node.querySelectorAll(selector).forEach((b) => { if (!buttons.includes(b)) buttons.push(b); }); } catch { /* noop */ }
          }
          const icons = buttons
            .filter((b) => !b.closest('.ds-toggle-button') && !(b.textContent || '').trim() && b.querySelector('svg, img, i'))
            .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
          if (icons.length) return icons;
        }
      }
      return [];
    }

    getSendButton() {
      const labelled = WMB.firstVisible(this.selectors.sendButton, document, { loose: true });
      if (labelled) return labelled;
      const buttons = this.#composerButtons();
      return buttons.length ? buttons[buttons.length - 1] : null;
    }

    /**
     * Envía con Enter (durante una generación no hace nada, así que es seguro) y solo si no sale pulsa el botón,
     * que durante una generación es «detener». Si el cuadro ya está vacío no hace nada (ya se envió).
     */
    async submit(timeout = 4000) {
      const composer = this.getComposer();
      if (!composer) return false;
      const hasText = () => WMB.dom.getText(composer).trim().length > 0;
      if (!hasText()) return true;

      if (this.isStreaming()) {
        const idle = await WMB.waitFor(() => !this.isStreaming(), { timeout, interval: 200 });
        if (!idle) return false;
      }
      const gone = () => !hasText() || this.isStreaming();

      composer.focus();
      const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      composer.dispatchEvent(new KeyboardEvent('keydown', init));
      composer.dispatchEvent(new KeyboardEvent('keypress', init));
      composer.dispatchEvent(new KeyboardEvent('keyup', init));
      if (await WMB.waitFor(gone, { timeout: 1500, interval: 150 })) return true;

      const button = await WMB.waitFor(() => {
        const b = this.getSendButton();
        return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
      }, { timeout, interval: 150 });
      if (button && hasText() && !this.isStreaming()) { button.click(); return true; }
      return !hasText();
    }
  }

  WMB.registerAdapter(new DeepSeekAdapter());
})();
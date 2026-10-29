/**
 * base_adapter.js — Clase base del patrón Adaptador.
 *
 * Cada plataforma (ChatGPT, Gemini, Claude) hereda de `BaseAdapter` y SOLO declara:
 *   - `matches(hostname)`
 *   - los selectores DOM (varios candidatos por elemento, en orden de prioridad)
 *   - opcionalmente `getMessageKey()` si la web expone un ID estable por mensaje.
 *
 * Interfaz que implementa cada adaptador (heredada de esta clase):
 *   - injectSystemPrompt(activeToolsList)  → escribe las instrucciones en el chat.
 *   - observeResponses(callback)           → detecta llamadas `mcp_call` en las respuestas.
 *   - attachFiles(files)                   → adjunta imágenes/archivos al cuadro de texto.
 *   - sendToolResult(text)                 → escribe el resultado y simula el envío.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  const BASELINE_MS = 2500;     // ventana tras cargar/navegar en la que solo se «memorizan» llamadas antiguas
  const DEBOUNCE_MS = 800;      // el mensaje debe quedar estable este tiempo antes de analizarlo
  const POLL_MS = 1000;         // latido: red de seguridad por si el MutationObserver se pierde un cambio
  const WAKE_MS = 30_000;       // pestaña oculta esperando respuesta sin cambios en el DOM → se «despierta» un instante
  const STUCK_MS = 2500;        // texto estable con el indicador «generando» pegado → se da por terminado
  const FRESH_CHAT_MS = 120_000;
  const STORE_KEY = 'wmb:executed';
  const STORE_LIMIT = 500;

  class BaseAdapter {
    /**
     * @param {{id:string,name:string,selectors:{composer:string[],sendButton:string[],assistantMessages:string[],stopButton:string[],fileInput?:string[]}}} config
     */
    constructor({ id, name, selectors }) {
      this.id = id;
      this.name = name;
      this.selectors = selectors;
      this.executed = this.#loadExecuted();
      this.baselineUntil = 0;
      this.lastActivity = 0;
      this.freshChat = false;
      this.awaitingSince = 0;   // momento en que se envió algo y se espera una respuesta nueva
      this.options = { focusFallback: true };
      this.rescan = () => {};
    }

    /** Ajustes que llegan desde la extensión (p. ej. `focusFallback`). */
    configure(options) { Object.assign(this.options, options); }

    /** @param {string} hostname */
    matches(_hostname) { return false; }

    // ───────────── Acceso al DOM ─────────────

    getComposer() { return WMB.firstVisible(this.selectors.composer, document, { loose: true }); }
    getSendButton() { return WMB.firstVisible(this.selectors.sendButton, document, { loose: true }); }
    getAssistantMessages() { return WMB.allMatches(this.selectors.assistantMessages); }
    isStreaming() { return WMB.exists(this.selectors.stopButton); }

    /** Clave estable de un mensaje; se usa para no repetir llamadas. */
    getMessageKey(element, index) {
      const holder = element.closest('[data-message-id], [data-turn-id]') ?? element;
      return holder.getAttribute('data-message-id') || holder.getAttribute('data-turn-id') || `${location.pathname}:${index}`;
    }

    /** El usuario acaba de enviar un mensaje (lo llama core_bridge con eventos reales). */
    markActivity() {
      this.lastActivity = Date.now();
      this.awaitingSince = this.lastActivity;
      this.freshChat = this.getAssistantMessages().length === 0; // primer mensaje de un chat nuevo
    }

    // ───────────── Interfaz pública ─────────────

    /**
     * Escribe en el chat las instrucciones con las herramientas de los MCP habilitados.
     * No las envía: el usuario puede añadir su petición y enviarlo todo junto.
     * @returns {Promise<{ok:boolean,error?:string}>}
     */
    async injectSystemPrompt(activeToolsList) {
      const composer = await WMB.waitFor(() => this.getComposer(), { timeout: 4000 });
      if (!composer) return { ok: false, error: 'No se encontró el cuadro de texto del chat.' };
      const ok = await WMB.dom.setText(composer, WMB.buildSystemPrompt(activeToolsList), { append: true });
      return ok ? { ok: true } : { ok: false, error: 'No se pudo escribir en el cuadro de texto.' };
    }

    /**
     * Observa el DOM y llama a `callback({id, call, element})` cuando el asistente
     * termina de escribir un mensaje que contiene una llamada MCP NUEVA.
     * `onDone({text, element})` se llama una vez por cada respuesta terminada SIN llamada MCP.
     * Todos los temporizadores usan `WMB.sleep`: siguen funcionando con la pestaña oculta o la ventana tapada.
     * @returns {() => void} función para detener la observación
     */
    observeResponses(callback, { onDone } = {}) {
      let alive = true;
      let scheduled = false;
      let lastTick = 0;
      let lastSig = '';
      let lastText = '';
      let lastDone = '';
      let stableSince = Date.now();
      this.baselineUntil = Date.now() + BASELINE_MS;

      // Como mucho un análisis cada `delay` ms mientras haya cambios (sin acumular temporizadores).
      const schedule = (delay = DEBOUNCE_MS) => {
        if (scheduled) return;
        scheduled = true;
        WMB.sleep(delay).then(() => { scheduled = false; if (alive) scan(); });
      };

      const scan = () => {
        const now = Date.now();
        const streaming = this.isStreaming();
        const messages = this.getAssistantMessages();
        if (streaming) {
          this.lastActivity = now;
          this.baselineUntil = 0;                              // hay generación en vivo: la conversación no es «antigua»
          if (messages.length <= 1) this.freshChat = true;     // primera respuesta de un chat nuevo
        } else if (messages.length > 2) this.freshChat = false;
        if (!messages.length) return;

        let last = -1;
        for (let i = messages.length - 1; i >= 0 && last < 0; i -= 1) if ((messages[i].textContent || '').trim()) last = i;
        const text = last >= 0 ? messages[last].textContent : '';
        if (text !== lastText) { lastText = text; stableSince = now; this.awaitingSince = 0; } // llegó contenido nuevo

        // Con «generando» activo se espera, salvo que el texto lleve un rato estable (indicador pegado).
        if (streaming && now - stableSince < STUCK_MS) { schedule(1000); return; }

        const baseline = now < this.baselineUntil;
        const sig = `${location.pathname}|${messages.length}|${last}|${text.length}`;
        if (!baseline && sig === lastSig) return;
        lastSig = sig;

        // Línea base: memorizar todo lo antiguo. Funcionamiento normal: solo el último mensaje con texto.
        const indexes = baseline ? messages.map((_, i) => i) : (last >= 0 ? [last] : []);
        for (const i of indexes) {
          const element = messages[i];
          const calls = WMB.extractMcpCalls(i === last ? text : element.textContent || '');
          calls.forEach((call, n) => {
            const id = `${this.getMessageKey(element, i)}#${n}:${WMB.hash(JSON.stringify(call))}`;
            if (this.executed.has(id)) return;
            this.#remember(id);
            // Protocolo: una llamada por mensaje → solo se ejecuta la primera.
            if (!baseline && n === 0) callback({ id, call, element });
          });
          if (!baseline && i === last && !calls.length && !streaming && onDone) {
            const doneKey = `${this.getMessageKey(element, i)}:${text.length}`;
            if (doneKey !== lastDone) { lastDone = doneKey; onDone({ text, element }); }
          }
        }
      };
      this.rescan = () => { lastSig = ''; lastDone = ''; scan(); };

      const observer = new MutationObserver(() => {
        const now = Date.now();
        if (now - lastTick > 300) {
          lastTick = now;
          if (this.isStreaming()) { this.lastActivity = now; this.baselineUntil = 0; }
        }
        schedule();
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });

      // Al volver a la pestaña / recuperar el foco: análisis inmediato (por si algo ocurrió mientras estaba oculta).
      const wake = () => { if (!document.hidden) this.rescan(); };
      document.addEventListener('visibilitychange', wake);
      window.addEventListener('focus', wake);

      // Latido cada segundo (reemplaza a setInterval, que se congela en segundo plano): navegación SPA, análisis y «despertar».
      let href = location.href;
      (async () => {
        while (alive) {
          const idle = !this.awaitingSince && Date.now() - this.lastActivity > 60_000; // sin actividad: latido más espaciado
          await WMB.sleep(idle ? POLL_MS * 3 : POLL_MS);
          if (!WMB.extensionAlive()) alive = false; // la extensión se recargó: este script queda huérfano y se detiene
          if (!alive) break;
          if (location.href !== href) {
            href = location.href;
            // Un chat NUEVO recibe su URL (/c/<id>) cuando ya hay respuesta: no es otra conversación y NO hay que memorizarla.
            if (this.freshChat && Date.now() - this.lastActivity < FRESH_CHAT_MS) this.freshChat = false;
            else this.baselineUntil = Date.now() + BASELINE_MS;
          }
          scan();
          await this.#wakeIfStale();
        }
      })();

      return () => {
        alive = false;
        observer.disconnect();
        document.removeEventListener('visibilitychange', wake);
        window.removeEventListener('focus', wake);
      };
    }

    /**
     * Pestaña OCULTA que espera una respuesta y lleva 30 s sin ningún cambio ni indicador de «generando»:
     * algunos sitios no pintan en segundo plano. Se trae la pestaña al frente un instante y se vuelve a la anterior.
     */
    async #wakeIfStale() {
      if (!this.awaitingSince || !this.options.focusFallback || !document.hidden || this.isStreaming()) return;
      if (Date.now() - this.awaitingSince < WAKE_MS || this.wokeFor === this.awaitingSince) return;
      this.wokeFor = this.awaitingSince;
      const token = await WMB.bg({ type: 'FOCUS_TAB' });
      await WMB.sleep(1500);
      this.rescan();
      if (token?.prev) WMB.bg({ type: 'RESTORE_FOCUS', prev: token.prev });
    }

    /**
     * Adjunta archivos (imágenes, audio, texto largo…) al cuadro de texto del chat.
     * Prueba, en orden: pegar → soltar (drag & drop) → <input type="file">.
     * @param {{name:string,mime:string,b64?:string,text?:string}[]} files
     * @returns {Promise<boolean>} true si apareció el adjunto en la interfaz
     */
    async attachFiles(files) {
      const composer = await WMB.waitFor(() => this.getComposer(), { timeout: 5000 });
      if (!composer) return false;
      let list;
      try { list = files.map(WMB.dom.fileFrom); } catch { return false; }

      const root = composer.closest('form, fieldset') ?? composer.parentElement?.parentElement?.parentElement ?? composer;
      const before = root.getElementsByTagName('*').length;
      const grew = async () => {
        for (let i = 0; i < 10; i += 1) {
          await WMB.sleep(300);
          if (root.getElementsByTagName('*').length - before >= 3) return true; // apareció la miniatura/chip del adjunto
        }
        return false;
      };
      const transfer = () => {
        const dt = new DataTransfer();
        list.forEach((file) => dt.items.add(file));
        return dt;
      };

      this.lastActivity = Date.now();
      composer.focus();
      try {
        composer.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer(), bubbles: true, cancelable: true }));
        if (await grew()) return true;
      } catch { /* siguiente método */ }
      try {
        const dataTransfer = transfer();
        for (const type of ['dragenter', 'dragover', 'drop']) {
          composer.dispatchEvent(new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true }));
        }
        if (await grew()) return true;
      } catch { /* siguiente método */ }
      try {
        const inputs = Array.from(document.querySelectorAll(this.selectors.fileInput?.join(',') || 'input[type="file"]'));
        const input = inputs.find((el) => !el.webkitdirectory && (!el.accept || /image|\*/.test(el.accept))) ?? inputs[0];
        if (input) {
          input.files = transfer().files;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          if (await grew()) return true;
        }
      } catch { /* sin más métodos */ }
      return false;
    }

    /**
     * Escribe el resultado de la herramienta en el chat y (opcionalmente) lo envía, COMPROBANDO que el chat lo aceptó:
     * reintenta el envío y, si la pestaña está oculta y sigue sin salir, la trae al frente un instante.
     * @param {string} text mensaje ya formateado
     * @param {{autoSend?:boolean, settleMs?:number}} options `settleMs`: espera a que termine de subirse un adjunto
     */
    async sendToolResult(text, { autoSend = true, settleMs = 0 } = {}) {
      const composer = await WMB.waitFor(() => this.getComposer(), { timeout: 5000 });
      if (!composer) return { ok: false, error: 'No se encontró el cuadro de texto del chat.' };
      this.lastActivity = Date.now();
      if (!(await WMB.dom.setText(composer, text, { append: true }))) {
        return { ok: false, error: 'No se pudo escribir en el cuadro de texto.' };
      }
      if (!autoSend) return { ok: true };
      if (settleMs) await WMB.sleep(settleMs);

      const attempt = async (timeout) => (await this.submit(timeout)) && (await this.#confirmSent());
      let sent = await attempt(settleMs ? 30_000 : 4000);
      if (!sent) sent = await attempt(4000); // segundo intento (botón / Enter)
      if (!sent && this.options.focusFallback && WMB.isBackground()) {
        const token = await WMB.bg({ type: 'FOCUS_TAB' });
        await WMB.sleep(800);
        sent = await attempt(4000);
        if (token?.prev) WMB.bg({ type: 'RESTORE_FOCUS', prev: token.prev });
      }
      if (sent) this.awaitingSince = Date.now();
      return sent ? { ok: true } : { ok: false, error: 'No se pudo confirmar el envío al chat. Pulsa Enter en el chat.' };
    }

    /** El chat aceptó el mensaje: el cuadro de texto se vació o ya está generando la respuesta. */
    async #confirmSent() {
      return Boolean(await WMB.waitFor(() => {
        if (this.isStreaming()) return true;
        const composer = this.getComposer();
        return composer ? WMB.dom.getText(composer).trim().length < 10 : false;
      }, { timeout: 8000, interval: 250 }));
    }

    /** Pulsa el botón de enviar (cuando se habilita) o simula Enter. */
    async submit(timeout = 4000) {
      const button = await WMB.waitFor(() => {
        const b = this.getSendButton();
        return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
      }, { timeout, interval: 120 });
      if (button) { button.click(); return true; }

      const composer = this.getComposer();
      if (!composer) return false;
      const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      composer.dispatchEvent(new KeyboardEvent('keydown', init));
      composer.dispatchEvent(new KeyboardEvent('keyup', init));
      return true;
    }

    // ───────────── Registro de IDs ejecutados (persiste en la pestaña) ─────────────

    #loadExecuted() {
      try { return new Set(JSON.parse(sessionStorage.getItem(STORE_KEY) || '[]')); } catch { return new Set(); }
    }

    #remember(id) {
      this.executed.add(id);
      try {
        sessionStorage.setItem(STORE_KEY, JSON.stringify(Array.from(this.executed).slice(-STORE_LIMIT)));
      } catch { /* almacenamiento no disponible */ }
    }
  }

  WMB.BaseAdapter = BaseAdapter;
  WMB.adapters = [];
  WMB.registerAdapter = (adapter) => { WMB.adapters.push(adapter); };
  WMB.findAdapter = (hostname) => WMB.adapters.find((a) => a.matches(hostname)) ?? null;
})();

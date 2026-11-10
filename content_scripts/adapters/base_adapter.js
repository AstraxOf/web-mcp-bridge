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
  const FRESH_CHAT_MS = 300_000;   // v1.7.0: 120 s -> 300 s (Gemini/DeepSeek lentos tardan en recibir la URL del chat nuevo)
  const STORE_KEY = 'wmb:executed';
  const STORE_LIMIT = 500;
  const MALFORMED_STABLE_MS = 6000; // v1.7.1: un bloque a medias solo es 'ilegible' si el texto lleva TODO este tiempo sin cambiar (DeepSeek escribe a rafagas)

  class BaseAdapter {
    /**
     * @param {{id:string,name:string,selectors:{composer:string[],sendButton:string[],assistantMessages:string[],stopButton:string[],fileInput?:string[]}}} config
     */
    constructor({ id, name, selectors }) {
      this.id = id;
      this.name = name;
      this.selectors = selectors;
      this.executed = this.#loadExecuted();
      this.deliveries = 0;            // resultados entregados a la IA (para distinguir repeticiones reales de repintados)
      this.lastDeliveryAt = 0;
      this.genSinceDelivery = false;  // la IA ya contesto despues del ultimo resultado entregado
      this.msgsAtDelivery = 0;
      this.baselineUntil = 0;
      this.lastActivity = 0;
      this.freshChat = false;
      this.awaitingSince = 0;   // momento en que se envió algo y se espera una respuesta nueva
      this.options = { focusFallback: true };
      this.pendingReply = false;  // v1.7.0: se envió algo y aún no ha llegado/terminado la respuesta
      this.msgsAtSend = 0;        // nº de mensajes del asistente cuando se envió
      this.pathAtSend = '';
      this.lastSendAt = 0;
      this.rescan = () => {};
      this.malformedStableMs = MALFORMED_STABLE_MS;
      this.sendSnap = null;       // v1.7.1: foto de los mensajes del asistente en el ultimo envio (usuario o resultado)
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
      this.#expectReply();
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
        if (this.lastDeliveryAt && (streaming || messages.length > this.msgsAtDelivery)) this.genSinceDelivery = true;
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

        // v1.7.0: la ventana «baseline» solo memoriza llamadas ANTIGUAS. Si el usuario acaba de enviar algo (o la extensión
        // acaba de entregar un resultado) y ya llegó un mensaje nuevo, esa respuesta NO es antigua: antes, en pestañas lentas
        // (Gemini), la respuesta caía dentro de la ventana y se memorizaba sin ejecutarse (hasta recargar la página).
        const expecting = this.pendingReply && now - this.lastSendAt < 300_000 && messages.length > this.msgsAtSend
          && (location.pathname === this.pathAtSend || this.freshChat);
        const baseline = now < this.baselineUntil && !expecting;
        const sig = `${location.pathname}|${messages.length}|${last}|${text.length}`;
        if (!baseline && sig === lastSig) return;
        lastSig = sig;

        if (!baseline && !streaming && this.pendingReply && messages.length > this.msgsAtSend && now - stableSince >= STUCK_MS) this.pendingReply = false;

        // Línea base: memorizar todo lo antiguo. Funcionamiento normal: solo el último mensaje con texto.
        const indexes = baseline ? messages.map((_, i) => i) : (last >= 0 ? [last] : []);
        for (const i of indexes) {
          const element = messages[i];
          const calls = WMB.extractMcpCalls(i === last ? text : element.textContent || '');
          calls.forEach((call, n) => {
            if (!baseline && !this.#isFresh(messages, text)) { this.debug?.('err', 'Llamada ignorada: el mensaje es el mismo de antes (no hay respuesta nueva de la IA).'); return; }
            let id = `${this.getMessageKey(element, i)}#${n}:${WMB.hash(JSON.stringify(call))}`;
            if (this.executed.has(id)) {
              // Misma llamada ya ejecutada. Solo es una REPETICION real (la IA espera respuesta otra vez) si contesto despues de
              // recibir el resultado y esta es su ultima respuesta; si no, es un repintado de la pagina y se ignora.
              if (baseline || i !== last || streaming || n !== 0 || !this.genSinceDelivery) return;
              id = `${id}~r${this.deliveries}`;
              if (this.executed.has(id)) return;
            }
            this.#remember(id);
            // Protocolo: una llamada por mensaje → solo se ejecuta la primera.
            if (!baseline && n === 0) callback({ id, call, element, extra: calls.length - 1 });
          });
          const looksBad = !baseline && i === last && !calls.length && !streaming && Boolean(WMB.looksMalformed?.(text));
          const quiet = now - stableSince >= this.malformedStableMs;
          if (looksBad && !quiet) lastSig = ''; // aun puede estar escribiendo: se vuelve a evaluar en el siguiente latido
          if (looksBad && quiet) {
            // Hay intencion de llamada MCP pero el bloque no se pudo leer: se avisa a la IA (antes se quedaba esperando).
            const badId = `${this.getMessageKey(element, i)}#bad:${WMB.hash(text)}`;
            if (!this.executed.has(badId)) { this.#remember(badId); callback({ id: badId, malformed: true, text, element }); }
          }
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
      this.deliveries += 1;
      this.lastDeliveryAt = Date.now();
      this.genSinceDelivery = false;
      this.msgsAtDelivery = this.getAssistantMessages().length;
      this.#expectReply();
      // v1.7.0: NUNCA acumular. Si quedó un resultado/aviso viejo en el cuadro (un envío anterior que no salió), se quita ahora.
      try {
        if (await WMB.dom.purgeStale(composer)) this.debug?.('err', 'Había un resultado viejo sin enviar en el cuadro de texto: lo quité para no repetirlo.');
      } catch { /* si no se puede limpiar, se sigue como antes */ }
      if (!(await WMB.dom.setText(composer, text, { append: true }))) {
        return { ok: false, error: 'No se pudo escribir en el cuadro de texto.' };
      }
      if (!autoSend) return { ok: true };
      if (settleMs) await WMB.sleep(settleMs);

      // v1.7.0: hasta 3 envíos automáticos, cada uno con un método distinto (botón -> Enter + botón -> Ctrl+Enter / formulario).
      // En cada intento se comprueba que el texto SALIÓ del cuadro; si ya no está, el chat lo consumió y no se reenvía.
      const marker = this.#marker(text);
      let sent = false;
      for (let n = 1; n <= 3 && !sent; n += 1) {
        if (n > 1) {
          await WMB.sleep(1200); // v1.7.1: margen para chats lentos; reenviar sin esperar duplicaba el mensaje (otro eco)
          const now = this.getComposer();
          if (!now || (marker && !this.#norm(WMB.dom.getText(now)).includes(marker))) { sent = true; break; }
          this.debug?.('err', `Envío ${n}/3: el chat no aceptó el mensaje; pruebo otro método…`);
        }
        const token = n === 3 && this.options.focusFallback && WMB.isBackground() ? await WMB.bg({ type: 'FOCUS_TAB' }) : null;
        if (token) await WMB.sleep(800);
        sent = (await this.#attemptSend(n, n === 1 && settleMs ? 30_000 : 4000)) && (await this.#confirmSent(text));
        if (token?.prev) WMB.bg({ type: 'RESTORE_FOCUS', prev: token.prev });
      }
      if (sent) this.awaitingSince = Date.now();
      return sent ? { ok: true } : { ok: false, error: 'No se pudo enviar al chat tras 3 intentos automáticos.' };
    }

    /**
     * El chat aceptó el mensaje: el texto SALIÓ del cuadro.
     * v1.7.0: «está generando» ya NO basta (podía ser la respuesta anterior); si el resultado seguía dentro del cuadro,
     * se daba por enviado y el siguiente resultado se pegaba a continuación (acumulación).
     */
    async #confirmSent(text) {
      const marker = this.#marker(text);
      return Boolean(await WMB.waitFor(() => {
        const composer = this.getComposer();
        if (!composer) return true; // el cuadro se recreó: el chat ya lo consumió
        const current = this.#norm(WMB.dom.getText(composer));
        return current.trim().length < 10 || !marker || !current.includes(marker);
      }, { timeout: 8000, interval: 250 }));
    }

    #norm(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
    #marker(text) { return this.#norm(text).slice(0, 60); }

    /** ¿La IA ya reaccionó al último resultado entregado? (empezó a generar o apareció un mensaje nuevo). */
    hasReacted() {
      return this.genSinceDelivery || this.isStreaming() || this.getAssistantMessages().length > this.msgsAtDelivery;
    }

    /** Un intento de envío. 1 = botón (o Enter); 2 = Enter completo + botón; 3 = Ctrl+Enter + formulario + botón. */
    async #attemptSend(n, timeout) {
      if (n === 1) return this.submit(timeout); // DeepSeek trae su propio submit()
      const composer = this.getComposer();
      if (!composer) return false;
      composer.focus();
      // «Empujón»: algunos chats (React) solo habilitan el botón tras un evento de entrada.
      try { composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '' })); } catch { /* noop */ }
      await WMB.sleep(250);
      const press = (extra = {}) => {
        const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, ...extra };
        for (const type of ['keydown', 'keypress', 'keyup']) composer.dispatchEvent(new KeyboardEvent(type, init));
      };
      const consumed = () => { const c = this.getComposer(); return !c || !WMB.dom.getText(c).trim(); };
      const clickButton = () => {
        const b = this.getSendButton();
        if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') b.click();
      };
      if (n === 2) {
        press();
        if (await WMB.waitFor(consumed, { timeout: 900, interval: 150 })) return true;
        clickButton();
        return true;
      }
      press({ ctrlKey: true });
      if (await WMB.waitFor(consumed, { timeout: 900, interval: 150 })) return true;
      try { composer.closest('form')?.requestSubmit?.(); } catch { /* noop */ }
      if (await WMB.waitFor(consumed, { timeout: 900, interval: 150 })) return true;
      clickButton();
      return true;
    }
    /** Marca que se espera una respuesta nueva (tras enviar el usuario o tras entregar un resultado). */
    #expectReply() {
      this.pendingReply = true;
      this.lastSendAt = Date.now();
      this.msgsAtSend = this.getAssistantMessages().length;
      this.pathAtSend = location.pathname;
      this.sendSnap = this.#snapshot();
    }

    /**
     * v1.7.1 · ANTI-ECO. Foto de los mensajes del asistente en el momento de enviar (el usuario o la extension).
     * Lo que ya estaba en pantalla NO puede volver a disparar una llamada: si la IA aun no escribio nada nuevo, una llamada
     * vieja (repintado, mensaje remontado, «ya contesto» mal detectado) se re-ejecutaba y su resultado viejo llegaba como «eco».
     */
    #snapshot() {
      const messages = this.getAssistantMessages();
      const hashes = new Set();
      for (const el of messages) { const t = (el.textContent || '').trim(); if (t) hashes.add(WMB.hash(t)); }
      return { count: messages.length, hashes, path: location.pathname };
    }

    /** ¿El ultimo mensaje es NUEVO desde el ultimo envio? (un mensaje viejo repintado o remontado NO lo es). */
    #isFresh(messages, text) {
      const s = this.sendSnap;
      if (!s || s.path !== location.pathname) return true;
      if (!s.hashes.has(WMB.hash(String(text).trim()))) return true;
      return messages.length === s.count + 1; // texto identico pero llego UN mensaje mas: repeticion real de la IA
    }

    /** Texto del ultimo mensaje del asistente con contenido. */
    getLastText() {
      const messages = this.getAssistantMessages();
      for (let i = messages.length - 1; i >= 0; i -= 1) if ((messages[i].textContent || '').trim()) return messages[i].textContent;
      return '';
    }

    /** Olvida un id ejecutado (permite volver a procesar esa llamada). */
    forget(id) {
      this.executed.delete(id);
      try { sessionStorage.setItem(STORE_KEY, JSON.stringify(Array.from(this.executed).slice(-STORE_LIMIT))); } catch { /* noop */ }
    }

    /**
     * «Reescanear» (botón del panel): vuelve a analizar el último mensaje como si acabara de llegar. Para cuando la
     * pestaña iba lenta y la extensión no tomó la respuesta. Solo actúa a petición del usuario.
     */
    forceRescan() {
      this.baselineUntil = 0;
      this.genSinceDelivery = true;
      this.sendSnap = null; // el usuario pide reescanear: sin filtro anti-eco
      this.rescan();
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

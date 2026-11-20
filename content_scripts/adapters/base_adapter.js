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
      this.rememberedInfo = new Map(); // id → { count, text }: dónde estaba la conversación cuando se lanzó cada llamada
      this.elementIds = new WeakMap(); this.elementSeq = 0;
      this.lastSendAt = 0;             // último envío al chat (usuario o resultado de herramienta)
      this.firstSeen = new WeakMap();  // elemento → cuándo lo vimos por primera vez
      this.retries = new Map();        // id → reintentos de una llamada que no llegó a ejecutarse
      this.liveEls = new WeakSet();    // respuestas que vimos generarse en vivo en esta pestaña (no son un repintado)
      this.seenOn = new WeakMap();     // mensaje (elemento) → ids que ya lanzó
      this.askedOn = new WeakMap();    // mensaje (elemento) → ids repetidos por los que ya se preguntó al usuario
      this.trace = () => {}; // core_bridge lo conecta al registro de auditoría: trace(evento, detalles, nivel)
      this.lastActivity = 0;
      this.freshChat = false;
      this.awaitingSince = 0;   // momento en que se envió algo y se espera una respuesta nueva
      this.options = { focusFallback: true, sendPauseMinSec: 2, sendPauseMaxSec: 5, maxSendsPerMinute: 8, maxCallsPerMessage: 1 };
      this.sendTimes = [];              // envíos automáticos recientes (ritmo de envío)
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
      this.lastSendAt = this.lastActivity;
      this.awaitingSince = this.lastActivity;
      this.freshChat = this.getAssistantMessages().length === 0; // primer mensaje de un chat nuevo
    }

    // ───────────── Interfaz pública ─────────────

    /**
     * Escribe en el chat las instrucciones con las herramientas de los MCP habilitados.
     * No las envía: el usuario puede añadir su petición y enviarlo todo junto.
     * @returns {Promise<{ok:boolean,error?:string}>}
     */
    async injectSystemPrompt(activeToolsList, promptOptions = {}) {
      const composer = await WMB.waitFor(() => this.getComposer(), { timeout: 4000 });
      if (!composer) return { ok: false, error: 'No se encontró el cuadro de texto del chat.' };
      const ok = await WMB.dom.setText(composer, WMB.buildSystemPrompt(activeToolsList, promptOptions), { append: true });
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
      let wasStreaming = false;
      const traced = new Set(); // eventos ya registrados (evita repetir el mismo aviso en cada análisis)
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
        if (streaming !== wasStreaming) {
          wasStreaming = streaming;
          if (streaming) this.trace('ai.streaming', { messages: messages.length });
        }
        if (streaming) {
          lastSig = '';                                        // al terminar de generar, volver a analizar aunque el texto mida igual
          this.lastActivity = now;
          this.baselineUntil = 0;                              // hay generación en vivo: la conversación no es «antigua»
          if (messages.length <= 1) this.freshChat = true;     // primera respuesta de un chat nuevo
        } else if (messages.length > 2) this.freshChat = false;
        if (!messages.length) return;

        let last = -1;
        for (let i = messages.length - 1; i >= 0 && last < 0; i -= 1) if ((messages[i].textContent || '').trim()) last = i;
        const text = last >= 0 ? messages[last].textContent : '';
        if (last >= 0 && !this.firstSeen.has(messages[last])) this.firstSeen.set(messages[last], now);
        if (streaming && last >= 0) this.liveEls.add(messages[last]);
        if (text !== lastText) { lastText = text; stableSince = now; this.awaitingSince = 0; } // llegó contenido nuevo

        // Con «generando» activo se espera, salvo que el texto lleve un rato estable (indicador pegado).
        if (streaming && now - stableSince < STUCK_MS) { schedule(1000); return; }
        if (streaming && !traced.has(`stuck${text.length}`)) {
          traced.add(`stuck${text.length}`);
          this.trace('ai.stuck_indicator', { stableS: Math.round((now - stableSince) / 1000) }); // la IA «pensando» también lo provoca
        }

        const baseline = now < this.baselineUntil;
        if (last >= 0 && !this.elementIds.has(messages[last])) this.elementIds.set(messages[last], ++this.elementSeq);
        const sig = `${location.pathname}|${messages.length}|${last}|${text.length}|${last >= 0 ? this.elementIds.get(messages[last]) : 0}`; // incluye el elemento: un mensaje nuevo con el mismo texto también se analiza
        if (!baseline && sig === lastSig) return;
        lastSig = sig;

        // Línea base: memorizar todo lo antiguo. Funcionamiento normal: solo el último mensaje con texto.
        const indexes = baseline ? messages.map((_, i) => i) : (last >= 0 ? [last] : []);
        for (const i of indexes) {
          const element = messages[i];
          const calls = WMB.extractMcpCalls(i === last ? text : element.textContent || '');
          let fire = null; // llamada que se lanza + las extra (hasta maxCallsPerMessage) del MISMO mensaje, como un solo lote
          const maxCalls = Math.min(3, Math.max(1, Number(this.options.maxCallsPerMessage) || 1));
          calls.forEach((call, n) => {
            const id = `${this.getMessageKey(element, i)}#${n}:${WMB.hash(JSON.stringify(call))}`;
            let known = this.executed.has(id);
            if (known && !baseline && i === last && n === 0) {
              // La clave depende del contenido: un git_push idéntico a uno anterior choca con él. Si es OTRA respuesta de la IA
              // (otro elemento y más mensajes o texto distinto) es una llamada nueva y legítima; un repintado del mismo mensaje no.
              const info = this.rememberedInfo.get(id);
              const fresh = info ? (messages.length > info.count || text !== info.text) : false;
              // Sin memoria previa (p. ej. tras recargar) o misma posición («regenerar»): si la vimos generarse en vivo, es una respuesta nueva.
              const status = this.callStatus ? this.callStatus(id) : null;
              const lost = status === 'failed' && (this.retries.get(id) ?? 0) < 2; // la lanzó pero nunca se ejecutó
              if (lost) {
                this.retries.set(id, (this.retries.get(id) ?? 0) + 1);
                known = false;
                this.trace('call.retry_unexecuted', { server: call.server, tool: call.name, attempt: this.retries.get(id) }, 'warn');
              }
              // Una llamada idéntica en una respuesta NUEVA siempre se ejecuta (git push las veces que haga falta). Señales de «respuesta nueva»:
              const born = this.firstSeen.get(element) ?? 0;
              const afterSend = this.lastSendAt > 0 && born >= this.lastSendAt - 500;                 // el elemento apareció tras un envío
              const otherAlive = Boolean(info?.el && info.el !== element && info.el.isConnected);     // la anterior sigue en pantalla: es otro mensaje
              const turn = info ? (info.el !== element && this.lastSendAt > info.at && afterSend && Date.now() - info.at > 6000) : afterSend;
              if (!lost && !this.seenOn.get(element)?.has(id) && (fresh || this.liveEls.has(element) || otherAlive || turn)) {
                known = false;
                this.trace('call.repeated', { server: call.server, tool: call.name, reason: 'llamada idéntica a una anterior, en una respuesta nueva' });
              }
            }
            if (known) {
              const seenHere = Boolean(this.seenOn.get(element)?.has(id));
              if (!baseline && !traced.has(id)) {
                traced.add(id);
                this.trace('call.skipped', {
                  reason: 'duplicate', server: call.server, tool: call.name, lastMessage: i === last,
                  seenHere, knownBefore: this.rememberedInfo.has(id),
                });
              }
              // Idéntica a una ya ejecutada pero NO es un repintado del mensaje que la lanzó: decide el usuario, no la extensión
              // (una sola pregunta por mensaje).
              const asked = this.askedOn.get(element) ?? new Set();
              if (!baseline && i === last && n === 0 && !seenHere && !asked.has(id) && this.onDuplicate) {
                asked.add(id);
                this.askedOn.set(element, asked);
                this.onDuplicate({ id, call }).then((run) => {
                  if (!run) return;
                  const launched = this.seenOn.get(element) ?? new Set();
                  launched.add(id);
                  this.seenOn.set(element, launched);
                  this.rememberedInfo.set(id, { count: messages.length, text, at: Date.now(), el: element });
                  this.trace('call.repeated', { server: call.server, tool: call.name, reason: 'el usuario eligió ejecutarla de nuevo' });
                  callback({ id, call, element, forced: true });
                });
              }
              return;
            }
            this.#remember(id);
            this.rememberedInfo.set(id, { count: messages.length, text, at: Date.now(), el: element });
            if (this.rememberedInfo.size > 300) this.rememberedInfo.delete(this.rememberedInfo.keys().next().value);
            const launched = this.seenOn.get(element) ?? new Set();
            launched.add(id);
            this.seenOn.set(element, launched);
            // Protocolo: por defecto una llamada por mensaje (solo la primera). Con `maxCallsPerMessage` > 1, las siguientes nuevas entran en el lote.
            if (!baseline && n === 0) fire = { id, call, element, extra: [] };
            else if (!baseline && fire && n < maxCalls) fire.extra.push({ id, call });
            else this.trace('call.skipped', { reason: baseline ? 'baseline' : 'extra_in_message', server: call.server, tool: call.name, n }, baseline ? 'info' : 'warn'); // al recargar la pestaña es normal memorizar las llamadas viejas
          });
          if (fire) callback(fire);
          if (!baseline && i === last && !calls.length && !streaming && onDone) {
            const doneKey = `${this.getMessageKey(element, i)}:${text.length}`;
            if (doneKey !== lastDone) { lastDone = doneKey; this.trace('ai.done', { chars: text.length, calls: 0, mentionsCall: text.includes('mcp_call') }); onDone({ text, element }); }
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
      // Ritmo: los chats rechazan mensajes muy seguidos («Messages too frequent. Try again later.»).
      const wait = autoSend ? WMB.sendWait([...this.sendTimes, this.lastSendAt].filter(Boolean), Date.now(), {
        minSec: this.options.sendPauseMinSec, maxSec: this.options.sendPauseMaxSec, perMin: this.options.maxSendsPerMinute }) : 0;
      if (wait > 0) {
        this.debug?.('ok', `Esperando ${Math.ceil(wait / 1000)} s antes de enviar (para no mandar mensajes demasiado seguidos).`);
        await WMB.sleep(wait);
      }
      // En DeepSeek el aviso queda en el chat, debajo de nuestro mensaje, y la página se repinta a menudo: se cuenta
      // CUÁNTOS avisos hay (un repintado no cambia la cantidad; un aviso nuevo, sí).
      let avisos = this.rateLimitNotices(text).length;
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
      if (sent) { this.awaitingSince = Date.now(); this.lastSendAt = this.awaitingSince; }
      let reintentos = 0;
      // Si el chat ya empezó a responder, aceptó el mensaje: no hace falta esperar un aviso de «demasiados mensajes» (que llega en vez
      // de la respuesta). Antes se esperaban 2,5 s fijos después de CADA envío.
      const textoAntes = this.#lastAssistantText();
      const cuantosAntes = this.getAssistantMessages().length;
      const enviadoEn = Date.now();
      const respuestaEmpezo = () => Date.now() - enviadoEn > 700
        && (this.isStreaming() || this.getAssistantMessages().length > cuantosAntes || this.#lastAssistantText() !== textoAntes);
      // Si el chat responde «demasiados mensajes», se espera cada vez más y se reenvía (hasta 3 veces).
      while (sent && reintentos < 3) {
        const aviso = await WMB.waitFor(() => {
          const v = this.rateLimitNotices(text);
          if (v.length > avisos) return v.at(-1);
          return reintentos === 0 && respuestaEmpezo() ? 'respuesta' : null;       // sale ya: el chat está respondiendo
        }, { timeout: 2500, interval: 150 });
        if (!aviso || aviso === 'respuesta') break;
        avisos = this.rateLimitNotices(text).length;
        const pausa = WMB.backoffMs(reintentos);
        reintentos += 1;
        this.debug?.('err', `${this.name}: «${(aviso.textContent || '').trim().slice(0, 80)}». Reintento ${reintentos}/3 en ${Math.round(pausa / 1000)} s.`);
        await WMB.sleep(pausa);
        const box = this.getComposer();
        if (box && WMB.dom.getText(box).trim().length < 10) await WMB.dom.setText(box, text, { append: true }); // el mensaje se perdió: se vuelve a escribir
        sent = await attempt(4000);
        if (sent) { this.awaitingSince = Date.now(); this.lastSendAt = this.awaitingSince; }
      }
      if (sent) this.sendTimes = [...this.sendTimes.filter((t) => Date.now() - t < 60_000), Date.now()];
      if (sent && reintentos && await WMB.waitFor(() => this.rateLimitNotices(text).length > avisos, { timeout: 2500, interval: 300 })) {
        return { ok: false, error: `${this.name} sigue diciendo que hay demasiados mensajes. Espera un minuto y pulsa Enter en el chat.` };
      }
      return sent
        ? { ok: true, ...(reintentos ? { reintentos } : {}) }
        : { ok: false, error: 'No se pudo confirmar el envío al chat. Pulsa Enter en el chat.' };
    }

    /** Texto de la última respuesta del asistente (para saber si el chat ya empezó a responder). */
    #lastAssistantText() {
      const list = this.getAssistantMessages();
      return list.length ? (list[list.length - 1].textContent || '') : '';
    }

    /**
     * Avisos visibles de «demasiados mensajes» (notificación flotante o mensaje de error en el chat). Recorre solo
     * los nodos de texto (rápido) y devuelve el elemento corto que contiene cada aviso.
     */
    rateLimitNotices(ownText = '') {
      const found = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = (node.nodeValue || '').trim();
        // Solo avisos cortos y sueltos (una notificación o un error de una línea), nunca frases dentro de un texto
        // largo ni el propio resultado que acabamos de enviar (podría contener «inténtalo más tarde»).
        if (!value || value.length > 120 || !WMB.RATE_LIMIT_RE.test(value)) continue;
        if (ownText && ownText.includes(value)) continue;
        const el = node.parentElement;
        if (!el || (el.textContent || '').length > 160 || el.offsetParent === null) continue;
        if (el.closest('[contenteditable="true"], textarea') || found.includes(el)) continue;
        found.push(el);
      }
      return found;
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

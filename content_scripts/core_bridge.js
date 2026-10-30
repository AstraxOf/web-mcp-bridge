/**
 * core_bridge.js — Controlador principal en cada pestaña de chat.
 *
 * Flujo:
 *   1. Detecta la plataforma (adaptador) y consulta al background los MCP activos.
 *   2. Muestra el widget flotante para inyectar las instrucciones y elegir el permiso de cada MCP.
 *   3. Observa las respuestas de la IA; al detectar un `mcp_call` nuevo:
 *        permiso del MCP (allow / ask / deny) → ejecutar vía background → entregar el resultado COMPLETO al chat
 *        (texto en línea; imágenes, audio y textos largos como archivos adjuntos) → comprobar que el chat lo aceptó.
 *   4. Mantiene a la IA al tanto: una línea de recordatorio en cada mensaje y reenvío periódico de las instrucciones.
 *
 * Robustez con la pestaña en segundo plano: ningún paso depende de setTimeout/setInterval de la página
 * (se usa WMB.sleep, que cuenta el service worker), hay un latido que refresca el estado y un vigilante que
 * impide que una llamada atascada bloquee la cola.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;
  if (!WMB || WMB.started) return;
  const adapter = WMB.findAdapter(location.hostname);
  if (!adapter) return;
  WMB.started = true;

  const INJECT_KEY = 'wmb:injected-signature';
  const TURNS_KEY = 'wmb:turns-since-full';
  const HEARTBEAT_MS = 10_000;
  const TOOL_TIMEOUT_MS = 150_000;
  const DELIVER_TIMEOUT_MS = 120_000;
  // La IA dice que no tiene acceso a nada local: señal de que perdió el contexto de las instrucciones.
  const DENIAL = /no tengo acceso|no puedo acceder|no tengo (la )?capacidad de (acceder|ejecutar|controlar)|no puedo (ejecutar|controlar|ver tu|abrir)|no dispongo de (acceso|herramientas)|no tengo herramientas|i (don'?t|do not) have (access|tools)|i (can'?t|cannot|am unable to) (access|control|run|execute|see your)/i;

  const slugKey = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const guarded = (promise, ms, message) => Promise.race([promise, WMB.sleep(ms).then(() => { throw new Error(message); })]);

  const state = { servers: [], tools: [], settings: { autoSend: true, maxResultChars: 12000 }, forceFull: false };
  let queue = Promise.resolve();
  let lastRefreshError = '';

  // Best-effort: un Web Lock abierto reduce que el navegador «congele» la pestaña en segundo plano.
  try { navigator.locks?.request('wmb-alive', () => new Promise(() => {})).catch(() => {}); } catch { /* noop */ }

  /** Mensajería segura: si la extensión se recarga, el contexto queda invalidado. */
  async function send(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      return { ok: false, error: /context invalidated/i.test(err.message) ? 'La extensión se actualizó: recarga la pestaña.' : err.message };
    }
  }

  const widget = new WMB.Widget({
    onInject: () => injectInstructions(),
    onRefresh: () => { adapter.rescan(); return refresh(true); },
    onToggleBridge: async (value) => {
      await send({ type: 'UPDATE_SETTINGS', settings: { bridgeEnabled: value } });
      await refresh();
    },
    /** `id` = un MCP; `null` = todos los MCP a la vez. */
    onSetPermission: async (id, permission) => {
      await send(id ? { type: 'SET_PERMISSION', id, permission } : { type: 'SET_ALL_PERMISSIONS', permission });
      await refresh();
    },
  });

  // Los adaptadores pueden escribir mensajes de depuración en el panel flotante (p. ej. ChatGPT).
  adapter.debug = (kind, message) => widget.log(kind, message);

  function injectionStatus() {
    if (document.body.textContent.includes(`[WMB:${WMB.toolsSignature(state.tools)}]`)) return 'ok';
    return sessionStorage.getItem(INJECT_KEY) ? 'stale' : 'none';
  }

  async function refresh(announce = false) {
    const [snapshot, active] = await Promise.all([send({ type: 'GET_STATE' }), send({ type: 'GET_ACTIVE_TOOLS' })]);
    if (!snapshot?.ok || !active?.ok) {
      const error = snapshot?.error || active?.error || 'No se pudo contactar con la extensión.';
      if (error !== lastRefreshError) widget.log('err', error); // el latido no repite el mismo error
      lastRefreshError = error;
      return;
    }
    lastRefreshError = '';
    state.settings = snapshot.settings;
    state.servers = snapshot.servers.filter((s) => s.enabled && s.url);
    state.tools = active.tools;
    adapter.configure({ focusFallback: state.settings.focusFallback !== false });
    widget.update({
      adapterName: adapter.name,
      servers: state.servers,
      toolCount: state.tools.length,
      bridgeEnabled: state.settings.bridgeEnabled,
      injection: injectionStatus(),
    });
    if (announce) widget.log('ok', `Actualizado: ${state.tools.length} herramientas activas.`);
  }

  const resetTurns = () => sessionStorage.setItem(TURNS_KEY, '0');

  async function injectInstructions() {
    await refresh();
    if (!state.settings.bridgeEnabled) {
      widget.log('err', 'El bridge está desactivado. Actívalo primero.');
      return;
    }
    if (!state.tools.length) {
      widget.log('err', 'No hay herramientas: añade un MCP en el popup, comprueba que esté conectado y que no esté bloqueado.');
      return;
    }
    const result = await adapter.injectSystemPrompt(state.tools);
    if (result.ok) {
      sessionStorage.setItem(INJECT_KEY, WMB.toolsSignature(state.tools));
      resetTurns();
      state.forceFull = false;
      widget.update({ injection: 'ok' });
      widget.log('ok', 'Instrucciones escritas en el chat. Añade tu petición y envía.');
    } else {
      widget.log('err', result.error);
    }
  }

  /**
   * Entrega el resultado al chat SIN omitir nada: el texto va en línea y las imágenes/audio/blobs
   * (y los textos muy largos) como archivos adjuntos. Si el chat no admite el adjunto, se descarga.
   * Termina con una línea de recordatorio para que la IA no olvide sus herramientas y siga con la tarea.
   */
  async function deliver(srv, call, { status, text, raw }) {
    const { autoSend, maxResultChars, reminder } = state.settings;
    const plan = WMB.planResult(raw ?? { content: [{ type: 'text', text }] }, { server: srv.slug, name: call.name, status, maxChars: maxResultChars });

    let attached = true;
    if (plan.files.length) {
      widget.log('ok', `Adjuntando ${plan.files.length} archivo(s) al chat…`);
      attached = await adapter.attachFiles(plan.files);
      if (!attached) {
        for (const file of plan.files.filter((f) => !f.overflow)) {
          try { WMB.dom.download(WMB.dom.fileFrom(file)); } catch { /* noop */ }
        }
        widget.log('err', 'No se pudo adjuntar al chat: se descargó el archivo (arrástralo al chat).');
      }
    }
    const tail = reminder !== false && state.tools.length ? `\n${WMB.reminderLine(state.tools, 'result')}` : '';
    const sent = await adapter.sendToolResult(`${plan.build(attached)}${tail}`, { autoSend, settleMs: attached && plan.files.length ? 1500 : 0 });
    widget.log(sent.ok ? 'ok' : 'err', sent.ok ? `Resultado enviado a ${adapter.name}.` : sent.error);
  }

  /** Busca el MCP y la herramienta de una llamada; si el estado local pudiera estar viejo, lo refresca una vez. */
  async function resolveCall(call) {
    const find = () => {
      const wanted = slugKey(call.server);
      const srv = call.server
        ? state.servers.find((s) => s.slug === call.server || slugKey(s.slug) === wanted || slugKey(s.name) === wanted)
        : (state.servers.length === 1 ? state.servers[0] : null);
      return { srv, tool: srv ? state.tools.find((t) => t.name === call.name && t.server === srv.slug) : null };
    };
    let found = find();
    if (!found.srv || (!found.tool && found.srv.permission !== 'deny')) {
      await refresh();
      found = find();
    }
    return found;
  }

  /** Procesa una llamada MCP detectada en la respuesta de la IA. */
  async function handleCall({ call }) {
    if (!state.settings.bridgeEnabled) return; // bridge apagado: se ignoran las llamadas
    const { srv, tool } = await resolveCall(call);

    // Llamada que no corresponde a ningún MCP activo (p. ej. la IA explicando el formato): se ignora.
    if (!srv) {
      widget.log('err', `Llamada ignorada: servidor «${call.server ?? '?'}» no activo.`);
      return;
    }

    let result;
    if (srv.permission === 'deny') {
      result = { status: 'rejected', text: 'El usuario no permite usar este MCP.' };
      widget.log('err', `Bloqueada: ${srv.slug} › ${call.name}`);
    } else if (!tool) {
      const available = state.tools.filter((t) => t.server === srv.slug).map((t) => t.name).join(', ');
      result = { status: 'error', text: `La herramienta «${call.name}» no existe en «${srv.slug}». Disponibles: ${available || 'ninguna'}.` };
    } else {
      let approved = true;
      if (srv.permission === 'ask') {
        const answer = await widget.requestApproval({ server: srv.slug, name: call.name, arguments: call.arguments });
        approved = Boolean(answer);
        if (answer === 'always') {
          await send({ type: 'SET_PERMISSION', id: srv.id, permission: 'allow' });
          await refresh();
        }
      } // 'allow': se ejecuta siempre, sin preguntar nunca

      if (!approved) {
        result = { status: 'rejected', text: 'El usuario rechazó la ejecución de esta herramienta.' };
        widget.log('err', `Rechazada: ${srv.slug} › ${call.name}`);
      } else {
        widget.log('ok', `Ejecutando ${srv.slug} › ${call.name}…`);
        let response;
        try {
          response = await guarded(send({ type: 'CALL_TOOL', server: srv.slug, name: call.name, arguments: call.arguments }), TOOL_TIMEOUT_MS, 'La herramienta tardó demasiado en responder.');
        } catch (err) {
          response = { ok: false, error: err.message };
        }
        if (!response?.ok) result = { status: 'error', text: response?.error ?? 'Error desconocido.' };
        else result = { status: response.result?.isError ? 'error' : 'ok', raw: response.result };
        widget.log(result.status === 'ok' ? 'ok' : 'err', `${call.name}: ${result.status}`);
      }
    }
    await guarded(deliver(srv, call, result), DELIVER_TIMEOUT_MS, 'El chat no aceptó el resultado a tiempo.');
  }

  /** Nunca deja que un fallo o una llamada atascada bloquee las siguientes. */
  async function processCall(detected) {
    try {
      await handleCall(detected);
    } catch (err) {
      widget.log('err', `Error: ${err.message}`);
    }
  }

  // ───────────── Instrucciones, recordatorio y reenvío periódico ─────────────

  let injecting = false;

  /** ¿Ya están las instrucciones (con las herramientas actuales) en esta conversación? */
  const hasInstructions = () => document.body.textContent.includes(`[WMB:${WMB.toolsSignature(state.tools)}]`);

  /**
   * Intercepta el envío del usuario (Enter o botón) y le añade, según el caso:
   *   · las instrucciones COMPLETAS (primer mensaje, cada N mensajes, o si la IA dijo que no tiene acceso);
   *   · o una línea de recordatorio (~45 tokens) para que la IA no olvide que tiene herramientas locales.
   * Solo actúa con eventos reales del usuario (isTrusted), nunca con los que genera la extensión.
   */
  function interceptSend(event) {
    if (!event.isTrusted || injecting) return;
    adapter.markActivity(); // el usuario envía algo: la respuesta que llegue es NUEVA (no historial)
    const { bridgeEnabled, autoInject, reminder, reinjectEvery } = state.settings;
    if (!bridgeEnabled || !state.tools.length) return;

    const present = hasInstructions();
    const turns = Number(sessionStorage.getItem(TURNS_KEY) || 0) + 1;
    const full = autoInject && (!present || state.forceFull || (reinjectEvery > 0 && turns >= reinjectEvery));
    const remind = !full && present && reminder !== false;
    if (!full && !remind) { sessionStorage.setItem(TURNS_KEY, String(turns)); return; }

    const composer = adapter.getComposer();
    const userText = composer ? WMB.dom.getText(composer).trim() : '';
    if (!userText) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    injecting = true;
    (async () => {
      const message = full
        ? `${WMB.buildSystemPrompt(state.tools)}\n\n---\n## Petición del usuario\n${userText}`
        : `${userText}\n\n${WMB.reminderLine(state.tools)}`;
      if (await WMB.dom.setText(composer, message, { append: false })) {
        if (full) {
          sessionStorage.setItem(INJECT_KEY, WMB.toolsSignature(state.tools));
          resetTurns();
          state.forceFull = false;
          widget.update({ injection: 'ok' });
          widget.log('ok', present ? 'Instrucciones renovadas en tu mensaje.' : 'Instrucciones añadidas automáticamente a tu mensaje.');
        } else {
          sessionStorage.setItem(TURNS_KEY, String(turns));
        }
        await adapter.submit();
      } else {
        widget.log('err', 'No se pudieron añadir las instrucciones; usa «Inyectar instrucciones».');
      }
    })().finally(() => { injecting = false; });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    const composer = adapter.getComposer();
    if (composer && (composer === e.target || composer.contains(e.target))) interceptSend(e);
  }, true);

  window.addEventListener('click', (e) => {
    const button = adapter.getSendButton();
    if (button && e.target instanceof Node && button.contains(e.target)) interceptSend(e);
  }, true);

  // Cambios en los MCP activos (conexión, herramientas, permisos, ajustes…)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'STATE_CHANGED') refresh();
  });

  // Al volver a la pestaña o recuperar el foco: estado al día al instante.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('focus', () => refresh());

  // Latido: el estado nunca queda viejo ni «pegado» aunque la pestaña lleve horas en segundo plano.
  (async () => {
    while (WMB.extensionAlive()) {
      await WMB.sleep(HEARTBEAT_MS);
      try { await refresh(); } catch { /* el siguiente latido lo reintenta */ }
    }
  })();

  refresh().then(() => {
    adapter.observeResponses(
      (detected) => {
        // Se procesan en serie para no mezclar resultados.
        queue = queue.then(() => processCall(detected));
      },
      {
        onDone: ({ text }) => {
          if (state.settings.bridgeEnabled && state.tools.length && text.length < 1500 && DENIAL.test(text)) {
            state.forceFull = true;
            widget.log('err', 'La IA dice que no tiene acceso: renovaré las instrucciones en tu próximo mensaje.');
          }
        },
      },
    );
  });
})();
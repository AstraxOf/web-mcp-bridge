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

  const state = { servers: [], tools: [], toolsSig: null, settings: { autoSend: true, maxResultChars: 12000 }, forceFull: false };
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
    /** v1.7.0 · Botón GLOBAL: 'start' | 'stop' | 'restart' actúan sobre el PROCESO del puente (no solo sobre el interruptor). */
    onBridgeAction: async (action) => {
      const labels = { start: 'Encendiendo', stop: 'Apagando', restart: 'Reiniciando' };
      widget.update({ bridgeBusy: action });
      widget.log('ok', `${labels[action] ?? 'Procesando'} el puente…`);
      const res = await send({ type: 'BRIDGE_GLOBAL', action });
      widget.update({ bridgeBusy: null });
      if (res?.ok) widget.log('ok', { start: 'Puente encendido.', stop: 'Puente apagado.', restart: 'Puente reiniciado.' }[action] ?? 'Hecho.');
      else widget.log('err', res?.error ?? 'No se pudo completar la acción.');
      await refresh();
    },
    /** v1.7.0 · Tiempo de respuesta configurable (ms) antes de entregar cada resultado a la IA. */
    onSetDelay: async (ms) => {
      await send({ type: 'UPDATE_SETTINGS', settings: { responseDelayMs: ms } });
      await refresh();
    },
    /** v1.7.0 · Vuelve a analizar el último mensaje de la IA (pestaña lenta que no tomó la respuesta). */
    onRescan: () => { adapter.forceRescan(); widget.log('ok', 'Reescaneando la última respuesta de la IA…'); },
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
    const [snapshot, active] = await Promise.all([send({ type: 'GET_STATE' }), send({ type: 'GET_ACTIVE_TOOLS', since: state.toolsSig })]);
    if (!snapshot?.ok || !active?.ok) {
      const error = snapshot?.error || active?.error || 'No se pudo contactar con la extensión.';
      if (error !== lastRefreshError) widget.log('err', error); // el latido no repite el mismo error
      lastRefreshError = error;
      return;
    }
    lastRefreshError = '';
    state.settings = snapshot.settings;
    state.servers = snapshot.servers.filter((s) => s.enabled && s.url);
    WMB.catalog?.configure(state.settings);
    if (!active.unchanged) { // v1.7.2: si nada cambió, el service worker no reenvía cientos de herramientas (ahorra copiar MB cada 10 s)
      state.tools = active.tools ?? [];
      state.toolsSig = active.sig ?? null;
    }
    // El parser tolerante usa los schemas (incluida la herramienta local wmb.list_tools).
    WMB.tools = WMB.catalog ? state.tools.concat(WMB.catalog.metaTools) : state.tools;
    adapter.configure({ focusFallback: state.settings.focusFallback !== false });
    widget.update({
      adapterName: adapter.name,
      servers: state.servers,
      toolCount: state.tools.length,
      bridgeEnabled: state.settings.bridgeEnabled,
      bridge: snapshot.bridge ?? null,
      responseDelayMs: state.settings.responseDelayMs ?? 1500,
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
  // v1.7.0 · Ritmo de respuesta configurable (panel flotante): con preguntas cortas el puente contestaba tan rápido que
  // saturaba a la IA («Too many requests»). Espera `responseDelayMs` y garantiza una separación mínima entre entregas.
  const MIN_GAP_MS = 1200;
  let lastDeliveredAt = 0;
  async function paceDelivery() {
    const wanted = Math.min(60_000, Math.max(0, Number(state.settings.responseDelayMs) || 0));
    const gap = Math.max(0, MIN_GAP_MS - (Date.now() - lastDeliveredAt));
    const wait = Math.max(wanted, gap);
    if (wait < 400) return;
    if (wanted >= 800) widget.log('ok', `Espero ${(wait / 1000).toFixed(1)} s antes de responder (se ajusta en el panel).`);
    await WMB.sleep(wait);
  }

  async function deliver(srv, call, { status, text, raw, note }) {
    const { autoSend, maxResultChars, reminder } = state.settings;
    await paceDelivery();
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
    const message = `${plan.build(attached)}${note ? `\n${note}` : ''}${tail}`;
    const sent = await adapter.sendToolResult(message, { autoSend, settleMs: attached && plan.files.length ? 1500 : 0 });
    lastDeliveredAt = Date.now();
    widget.log(sent.ok ? 'ok' : 'err', sent.ok ? `Resultado enviado a ${adapter.name}.` : sent.error);
    return { ok: sent.ok, message };
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

  // ------------- Llamadas repetidas: la IA vuelve a pedir EXACTAMENTE lo mismo -------------
  // Nunca se ignoran en silencio: se ejecutan de nuevo (el dato puede haber cambiado) y se avisa a la IA en el resultado.
  // Si repite la misma llamada demasiadas veces seguidas se le reenvia el ultimo resultado en vez de ejecutarla otra vez.
  // v1.7.1 · ANTI-COLA: cada llamada detectada recibe un numero; si llega otra (de la IA) o el usuario envia algo, las anteriores\n  // que aun esperan en la cola o se estan ejecutando quedan OBSOLETAS: no se ejecutan y su resultado no se entrega (era el eco).
  let callSeq = 0;
  const REPEAT_WINDOW_MS = 15 * 60 * 1000;
  const MAX_REPEATS = 4;
  const recentCalls = new Map(); // clave de llamada -> { count, at, result }

  /** Procesa una llamada MCP detectada en la respuesta de la IA. */
  async function handleCall(detected) {
    if (detected.malformed) return handleMalformed(detected);
    badStreak = 0;
    const { call } = detected;
    if (!state.settings.bridgeEnabled) return; // bridge apagado: se ignoran las llamadas
    const obsolete = () => detected.seq !== undefined && detected.seq !== callSeq;
    if (obsolete()) { widget.log('err', `Llamada obsoleta descartada (${call.name}): ya hay algo mas nuevo en el chat.`); return; }
    if (WMB.catalog?.isMeta(call, state.tools, state.servers)) return handleMeta(detected); // v1.7.2: catálogo paginado (local)
    const { srv, tool } = await resolveCall(call);

    // Llamada que no corresponde a ningún MCP activo (p. ej. la IA explicando el formato): se ignora.
    if (!srv) {
      widget.log('err', `Llamada ignorada: servidor «${call.server ?? '?'}» no activo.`);
      return;
    }

    const repeatKey = WMB.hash(JSON.stringify([srv.slug, call.name, call.arguments ?? {}]) ?? '');
    const prev = recentCalls.get(repeatKey);
    const repeats = prev && Date.now() - prev.at < REPEAT_WINDOW_MS ? prev.count : 0;
    if (repeats >= MAX_REPEATS && prev.result && tool && srv.permission !== 'deny') {
      const cached = { ...prev.result, note: `[WMB] Llamada IDENTICA repetida ${repeats + 1} veces seguidas: no se ejecuto otra vez. Este es el resultado de la ultima ejecucion; usalo. Si no te sirve, cambia los argumentos o pidele otra cosa al usuario.` };
      widget.log('err', `Llamada identica repetida ${repeats + 1} veces: reenvio el ultimo resultado sin ejecutar.`);
      prev.count += 1;
      prev.at = Date.now();
      await guarded(deliver(srv, call, cached), DELIVER_TIMEOUT_MS, 'El chat no acepto el resultado a tiempo.');
      return;
    }

    let result;
    if (srv.permission === 'deny') {
      result = { status: 'rejected', text: 'El usuario no permite usar este MCP.' };
      widget.log('err', `Bloqueada: ${srv.slug} › ${call.name}`);
    } else if (!tool) {
      const available = WMB.catalog
        ? WMB.catalog.unknownToolHint(state.tools, srv.slug, call.name) // con cientos de herramientas no se vuelcan todos los nombres
        : state.tools.filter((t) => t.server === srv.slug).map((t) => t.name).join(', ');
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
          response = await callWithRetry(srv, call, 'La herramienta tardó demasiado en responder.');
        } catch (err) {
          response = { ok: false, error: err.message };
        }
        if (!response?.ok) result = { status: 'error', text: response?.error ?? 'Error desconocido.' };
        else result = { status: response.result?.isError ? 'error' : 'ok', raw: response.result };
        widget.log(result.status === 'ok' ? 'ok' : 'err', `${call.name}: ${result.status}`);
      }
    }
    if (tool && srv.permission !== 'deny' && result.status !== 'rejected') {
      recentCalls.set(repeatKey, { count: repeats + 1, at: Date.now(), result });
      if (repeats > 0) result.note = `[WMB] Esta llamada es identica a la anterior (ya van ${repeats + 1}). Se ejecuto de nuevo y este es el resultado ACTUAL; si ya tienes el dato, no la repitas.`;
    }
    if (detected.rerun) result.note = '[WMB] Reenvío automático: tu mensaje anterior con el resultado no llegó a procesarse. Este es el resultado ACTUAL de tu llamada; continúa desde aquí.';
    if (detected.extra > 0) result.note = `[WMB] Solo se ejecuto la primera llamada; ${detected.extra} mas se ignoraron. Envia UNA llamada por mensaje y espera el resultado.`;
    if (obsolete()) { widget.log('err', `Resultado de ${call.name} descartado: ya hay algo mas nuevo en el chat (no lo envio para no repetir).`); return; }
    const delivered = await guarded(deliver(srv, call, result), DELIVER_TIMEOUT_MS, 'El chat no aceptó el resultado a tiempo.');
    await superviseDelivery({ detected, message: delivered.message, sentOk: delivered.ok });
  }

  /**
   * v1.7.2 · `wmb.list_tools`: la IA consulta el catálogo de herramientas por páginas (50 por página), por búsqueda o por detalle.
   * Se resuelve aquí, sin pasar por ningún MCP y sin pedir permiso (solo lectura). Se entrega y se vigila igual que cualquier resultado.
   */
  async function handleMeta(detected) {
    const { call } = detected;
    const obsolete = () => detected.seq !== undefined && detected.seq !== callSeq;
    const a = call.arguments ?? {};
    const out = WMB.catalog.run(a, state.tools);
    widget.log('ok', `Catálogo de herramientas${a.server ? ` › ${a.server}` : ''}${a.page ? ` · página ${a.page}` : ''}${a.query ? ` · «${a.query}»` : ''}${a.tool ? ` · ${a.tool}` : ''}`);
    const result = { status: out.ok ? 'ok' : 'error', text: out.text };
    if (detected.rerun) result.note = '[WMB] Reenvío automático: tu mensaje anterior con el resultado no llegó a procesarse. Este es el resultado ACTUAL de tu llamada; continúa desde aquí.';
    if (detected.extra > 0) result.note = `[WMB] Solo se ejecuto la primera llamada; ${detected.extra} mas se ignoraron. Envia UNA llamada por mensaje y espera el resultado.`;
    if (obsolete()) { widget.log('err', 'Resultado del catálogo descartado: ya hay algo mas nuevo en el chat.'); return; }
    const delivered = await guarded(deliver({ slug: WMB.catalog.SERVER }, call, result), DELIVER_TIMEOUT_MS, 'El chat no aceptó el resultado a tiempo.');
    await superviseDelivery({ detected, message: delivered.message, sentOk: delivered.ok });
  }

  // ------------- v1.7.0 · Vigilancia de la entrega: 3 verificaciones y, si hace falta, volver a ejecutar el JSON -------------
  // El envío ya se intenta 3 veces solo (adapter.sendToolResult). Aquí se comprueba que la IA REACCIONÓ al resultado:
  //   · si contestó (aunque sea sin JSON) el trabajo terminó: no se toca nada;
  //   · si tras 3 verificaciones sigue en silencio, se vuelve a ejecutar el JSON que dejó la IA y se entrega el resultado nuevo.
  const REACT_WAIT_MS = 20_000;
  const VERIFY_ROUNDS = 3;
  const MAX_RERUNS = 2;
  let epoch = 0; // sube cuando el usuario envía algo o llega otra llamada: la vigilancia anterior se cancela sola

  async function waitForReaction(ms, mine) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (mine !== epoch || !state.settings.bridgeEnabled) return 'cancelled';
      if (adapter.hasReacted()) return 'replied';
      await WMB.sleep(1000);
    }
    if (mine !== epoch) return 'cancelled';
    return adapter.hasReacted() ? 'replied' : 'timeout';
  }

  async function superviseDelivery({ detected, message, sentOk }) {
    if (!state.settings.autoSend || !message) return;
    const mine = ++epoch;
    let sent = sentOk;
    for (let round = 1; round <= VERIFY_ROUNDS; round += 1) {
      if (sent) {
        if ((await waitForReaction(REACT_WAIT_MS, mine)) !== 'timeout') return;
        widget.log('err', `La IA no reaccionó al resultado (verificación ${round}/${VERIFY_ROUNDS}): lo vuelvo a enviar.`);
      } else {
        widget.log('err', `El resultado no salió al chat (verificación ${round}/${VERIFY_ROUNDS}): lo vuelvo a enviar.`);
      }
      if (mine !== epoch) return;
      sent = (await adapter.sendToolResult(message, { autoSend: true, settleMs: 0 })).ok;
    }
    if (sent && (await waitForReaction(REACT_WAIT_MS, mine)) !== 'timeout') return;
    if (mine !== epoch || !state.settings.bridgeEnabled) return;
    const reruns = detected.reruns ?? 0;
    if (reruns >= MAX_RERUNS) {
      widget.log('err', 'Sigo sin respuesta de la IA tras reenviar y volver a ejecutar. Revisa el chat.');
      return;
    }
    widget.log('err', `Sin reacción tras ${VERIFY_ROUNDS} verificaciones: ejecuto de nuevo el JSON que dejó la IA (${reruns + 1}/${MAX_RERUNS}).`);
    queue = queue.then(() => processCall({ ...detected, rerun: true, reruns: reruns + 1, extra: 0 }));
  }
  // ------------- Formato invalido y reconexion (v1.3.0) -------------

  let badStreak = 0;
  const MAX_BAD_STREAK = 3;
  const CONN_ERR = /no est.{1,2} conectado|desconectado/i;

  /** La IA envio un mcp_call ilegible: se le devuelve el motivo exacto para que lo corrija (maximo 3 avisos seguidos). */
  async function handleMalformed({ text }) {
    if (!state.settings.bridgeEnabled || !state.tools.length) return;
    badStreak += 1;
    if (badStreak > MAX_BAD_STREAK) {
      widget.log('err', 'La IA repite un formato invalido: dejo de avisarle. Revisa el chat.');
      return;
    }
    widget.log('err', `Bloque sin leer (${badStreak}/${MAX_BAD_STREAK}): compruebo que la IA ya termino antes de avisarle.`);
    await paceDelivery();
    // v1.7.1: tras la espera se vuelve a mirar el chat. Si la IA seguia escribiendo (o el bloque ya se lee), NO se le avisa.
    const again = adapter.getLastText();
    if (adapter.isStreaming() || again !== text || WMB.extractMcpCalls(again).length) {
      badStreak = Math.max(0, badStreak - 1);
      widget.log('ok', 'La IA seguia escribiendo el bloque: no la interrumpo con un aviso.');
      return;
    }
    widget.log('err', 'El bloque sigue ilegible: aviso a la IA con el motivo.');
    const sent = await adapter.sendToolResult(WMB.formatCallError(text), { autoSend: state.settings.autoSend });
    if (!sent.ok) widget.log('err', sent.error);
  }

  async function waitConnected(srv, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const snap = await send({ type: 'GET_STATE' });
      if (snap?.servers?.find((s) => s.id === srv.id)?.status === 'connected') return true;
      await WMB.sleep(2000);
    }
    return false;
  }

  /** Ejecuta la herramienta; si el servidor estaba caido ANTES de enviar, espera la reconexion y reintenta (sin duplicar nada). */
  async function callWithRetry(srv, call, timeoutMessage) {
    let response;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await guarded(send({ type: 'CALL_TOOL', server: srv.slug, name: call.name, arguments: call.arguments }), TOOL_TIMEOUT_MS, timeoutMessage);
      if (response?.ok || !CONN_ERR.test(response?.error ?? '') || attempt === 2) break;
      widget.log('err', `${srv.slug} desconectado: espero la reconexion y reintento (${attempt + 1}/2).`);
      await send({ type: 'RECONNECT', id: srv.id });
      await waitConnected(srv, 40_000);
    }
    return response;
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
    adapter.markActivity();
    epoch += 1; // el usuario envía algo: se cancela cualquier vigilancia de entrega anterior
    callSeq += 1; // v1.7.1: lo que esperaba en la cola ya es viejo
    recentCalls.clear(); // mensaje nuevo del usuario: se reinicia el conteo de repeticiones // el usuario envía algo: la respuesta que llegue es NUEVA (no historial)
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
        epoch += 1; // llegó una llamada nueva de la IA: la vigilancia anterior ya no hace falta
        detected.seq = ++callSeq; // v1.7.1
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
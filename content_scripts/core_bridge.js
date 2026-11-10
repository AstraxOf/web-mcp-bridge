/**
 * core_bridge.js - Main controller in each chat tab.
 *
 * Flow:
 *   1. Detects the platform (adapter) and asks the background for active MCPs.
 *   2. Shows the floating widget to inject instructions and choose each MCP's permission.
 *   3. Observes the AI responses; upon detecting a new `mcp_call`:
 *        MCP permission (allow / ask / deny) -> execute via background -> deliver the COMPLETE result to the chat
 *        (text inline; images, audio and long texts as attachments) -> check the chat accepted it.
 *   4. Keeps the AI in the loop: a reminder line in each message and periodic resend of instructions.
 *
 * Robustness with the tab in the background: no step depends on the page's setTimeout/setInterval
 * (WMB.sleep is used, which counts the service worker), there is a heartbeat that refreshes the state and a watchdog that
 * prevents a stuck call from blocking the queue.
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

  // The AI says it has no access to anything local: a sign it lost the context of the instructions.
  const DENIAL = /no tengo acceso|no puedo acceder|no tengo (la )?capacidad de (acceder|ejecutar|controlar)|no puedo (ejecutar|controlar|ver tu|abrir)|no dispongo de (acceso|herramientas)|no tengo herramientas|i (don'?t|do not) have (access|tools)|i (can'?t|cannot|am unable to) (access|control|run|execute|see your)/i;

  const state = { servers: [], tools: [], settings: { autoSend: true, maxResultChars: 12000 }, forceFull: false };
  let queue = Promise.resolve();
  let lastRefreshError = '';

  // Best-effort: an open Web Lock reduces the browser "freezing" the tab in the background.
  try { navigator.locks?.request('wmb-alive', () => new Promise(() => {})).catch(() => {}); } catch { /* noop */ }

  /** Safe messaging: if the extension reloads, the context becomes invalid. */
  async function send(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      return { ok: false, error: /context invalidated/i.test(err.message) ? 'The extension was updated: reload the tab.' : err.message };
    }
  }

  const widget = new WMB.Widget({
    onInject: () => injectInstructions(),
    onRefresh: () => { adapter.rescan(); return refresh(true); },
    onToggleBridge: async (value) => {
      await send({ type: 'UPDATE_SETTINGS', settings: { bridgeEnabled: value } });
      await refresh();
    },
    /** `id` = one MCP; `null` = all MCPs at once. */
    onSetPermission: async (id, permission) => {
      await send(id ? { type: 'SET_PERMISSION', id, permission } : { type: 'SET_ALL_PERMISSIONS', permission });
      await refresh();
    },
  });

  // Adapters can write debug messages to the floating panel (e.g. ChatGPT).
  adapter.debug = (kind, message) => widget.log(kind, message);

  function injectionStatus() {
    if (document.body.textContent.includes(`[WMB:${WMB.toolsSignature(state.tools)}]`)) return 'ok';
    return sessionStorage.getItem(INJECT_KEY) ? 'stale' : 'none';
  }

  async function refresh(announce = false) {
    const [snapshot, active] = await Promise.all([send({ type: 'GET_STATE' }), send({ type: 'GET_ACTIVE_TOOLS' })]);
    if (!snapshot?.ok || !active?.ok) {
      const error = snapshot?.error || active?.error || 'Could not contact the extension.';
      if (error !== lastRefreshError) widget.log('err', error); // the heartbeat does not repeat the same error
      lastRefreshError = error;
      return;
    }
    lastRefreshError = '';
    state.settings = snapshot.settings;
    state.servers = snapshot.servers.filter((s) => s.enabled && s.url);
    state.tools = active.tools;
    WMB.tools = state.tools; // the tolerant parser uses the schemas
    adapter.configure({ focusFallback: state.settings.focusFallback !== false });
    widget.update({
      adapterName: adapter.name,
      servers: state.servers,
      toolCount: state.tools.length,
      bridgeEnabled: state.settings.bridgeEnabled,
      injection: injectionStatus(),
    });
    if (announce) widget.log('ok', `Updated: ${state.tools.length} active tools.`);
  }

  const resetTurns = () => sessionStorage.setItem(TURNS_KEY, '0');

  async function injectInstructions() {
    await refresh();
    if (!state.settings.bridgeEnabled) {
      widget.log('err', 'The bridge is disabled. Enable it first.');
      return;
    }
    if (!state.tools.length) {
      widget.log('err', 'No tools: add an MCP in the popup, check that it is connected and not blocked.');
      return;
    }
    const result = await adapter.injectSystemPrompt(state.tools);
    if (result.ok) {
      sessionStorage.setItem(INJECT_KEY, WMB.toolsSignature(state.tools));
      resetTurns();
      state.forceFull = false;
      widget.update({ injection: 'ok' });
      widget.log('ok', 'Instructions written to the chat. Add your request and send.');
    } else {
      widget.log('err', result.error);
    }
  }

  async function handleCall(detected) {
    try {
      await WMB.coreHandlers.handleCall(adapter, widget, state, send, refresh, detected);
    } catch (err) {
      widget.log('err', `Error: ${err.message}`);
    }
  }

  // ----------------- Instructions, reminder and periodic resend -----------------

  let injecting = false;

  /** Are the instructions (with the current tools) already in this conversation? */
  const hasInstructions = () => document.body.textContent.includes(`[WMB:${WMB.toolsSignature(state.tools)}]`);

  /**
   * Intercepts the user's send (Enter or button) and adds, depending on the case:
   *   - the FULL instructions (first message, every N messages, or if the AI said it has no access);
   *   - or a reminder line (~45 tokens) so the AI does not forget it has local tools.
   * Only acts on real user events (isTrusted), never on those generated by the extension.
   */
  function interceptSend(event) {
    if (!event.isTrusted || injecting) return;
    adapter.markActivity();
    WMB.coreHandlers.clearRecentCalls(); // new user message: the repeat counter is reset
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
        ? `${WMB.buildSystemPrompt(state.tools)}\n\n---\n## User request\n${userText}`
        : `${userText}\n\n${WMB.reminderLine(state.tools)}`;
      if (await WMB.dom.setText(composer, message, { append: false })) {
        if (full) {
          sessionStorage.setItem(INJECT_KEY, WMB.toolsSignature(state.tools));
          resetTurns();
          state.forceFull = false;
          widget.update({ injection: 'ok' });
          widget.log('ok', present ? 'Instructions renewed in your message.' : 'Instructions added automatically to your message.');
        } else {
          sessionStorage.setItem(TURNS_KEY, String(turns));
        }
        await adapter.submit();
      } else {
        widget.log('err', 'Could not add the instructions; use "Inject instructions".');
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

  // Changes in active MCPs (connection, tools, permissions, settings...)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'STATE_CHANGED') refresh();
  });

  // On returning to the tab or regaining focus: state up to date instantly.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('focus', () => refresh());

  // Heartbeat: the state never gets old or "stuck" even if the tab has been in the background for hours.
  (async () => {
    while (WMB.extensionAlive()) {
      await WMB.sleep(HEARTBEAT_MS);
      try { await refresh(); } catch { /* next heartbeat will retry */ }
    }
  })();

  refresh().then(() => {
    adapter.observeResponses(
      (detected) => {
        // Processed serially to avoid mixing results.
        queue = queue.then(() => handleCall(detected));
      },
      {
        onDone: ({ text }) => {
          if (state.settings.bridgeEnabled && state.tools.length && text.length < 1500 && DENIAL.test(text)) {
            state.forceFull = true;
            widget.log('err', 'The AI says it has no access: I will renew the instructions in your next message.');
          }
        },
      },
    );
  });
})();

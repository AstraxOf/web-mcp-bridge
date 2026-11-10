/**
 * core_bridge_handlers.js - Execution logic for MCP tool calls.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;
  if (!WMB) return;

  const TOOL_TIMEOUT_MS = 150_000;
  const DELIVER_TIMEOUT_MS = 120_000;
  const CONN_ERR = /no est.{1,2} conectado|desconectado/i;
  const REPEAT_WINDOW_MS = 15 * 60 * 1000;
  const MAX_REPEATS = 4;
  const MAX_BAD_STREAK = 3;

  let badStreak = 0;
  const recentCalls = new Map();

  const guarded = (promise, ms, message) => Promise.race([promise, WMB.sleep(ms).then(() => { throw new Error(message); })]);

  WMB.coreHandlers = {
    deliver: async function(adapter, widget, state, srv, call, { status, text, raw, note }) {
      const { autoSend, maxResultChars, reminder } = state.settings;
      const plan = WMB.planResult(raw ?? { content: [{ type: 'text', text }] }, { server: srv.slug, name: call.name, status, maxChars: maxResultChars });

      let attached = true;
      if (plan.files.length) {
        widget.log('ok', `Attaching ${plan.files.length} file(s) to the chat...`);
        attached = await adapter.attachFiles(plan.files);
        if (!attached) {
          for (const file of plan.files.filter((f) => !f.overflow)) {
            try { WMB.dom.download(WMB.dom.fileFrom(file)); } catch { /* noop */ }
          }
          widget.log('err', 'Could not attach to the chat: the file was downloaded (drag it into the chat).');
        }
      }
      const tail = reminder !== false && state.tools.length ? `\n${WMB.reminderLine(state.tools, 'result')}` : '';
      const sent = await adapter.sendToolResult(`${plan.build(attached)}${note ? `\n${note}` : ''}${tail}`, { autoSend, settleMs: attached && plan.files.length ? 1500 : 0 });
      widget.log(sent.ok ? 'ok' : 'err', sent.ok ? `Result sent to ${adapter.name}.` : sent.error);
    },

    resolveCall: async function(state, send, call, refresh) {
      const find = () => {
        const slugKey = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
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
    },

    handleMalformed: async function(adapter, widget, state, text) {
      if (!state.settings.bridgeEnabled || !state.tools.length) return;
      badStreak += 1;
      if (badStreak > MAX_BAD_STREAK) {
        widget.log('err', 'The AI keeps using an invalid format: I will stop warning it. Check the chat.');
        return;
      }
      widget.log('err', `Unreadable call (${badStreak}/${MAX_BAD_STREAK}): warning the AI with the reason.`);
      const sent = await adapter.sendToolResult(WMB.formatCallError(text), { autoSend: state.settings.autoSend });
      if (!sent.ok) widget.log('err', sent.error);
    },

    waitConnected: async function(send, srv, timeoutMs) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const snap = await send({ type: 'GET_STATE' });
        if (snap?.servers?.find((s) => s.id === srv.id)?.status === 'connected') return true;
        await WMB.sleep(2000);
      }
      return false;
    },

    callWithRetry: async function(send, widget, srv, call, timeoutMessage) {
      let response;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        response = await guarded(send({ type: 'CALL_TOOL', server: srv.slug, name: call.name, arguments: call.arguments }), TOOL_TIMEOUT_MS, timeoutMessage);
        if (response?.ok || !CONN_ERR.test(response?.error ?? '') || attempt === 2) break;
        widget.log('err', `${srv.slug} disconnected: waiting for reconnection and retrying (${attempt + 1}/2).`);
        await send({ type: 'RECONNECT', id: srv.id });
        await this.waitConnected(send, srv, 40_000);
      }
      return response;
    },

    handleCall: async function(adapter, widget, state, send, refresh, detected) {
      if (detected.malformed) return this.handleMalformed(adapter, widget, state, detected.text);
      badStreak = 0;
      const { call } = detected;
      if (!state.settings.bridgeEnabled) return;
      const { srv, tool } = await this.resolveCall(state, send, call, refresh);

      if (!srv) {
        widget.log('err', `Call ignored: server "${call.server ?? '?'}" not active.`);
        return;
      }

      const repeatKey = WMB.hash(JSON.stringify([srv.slug, call.name, call.arguments ?? {}]) ?? '');
      const prev = recentCalls.get(repeatKey);
      const repeats = prev && Date.now() - prev.at < REPEAT_WINDOW_MS ? prev.count : 0;
      if (repeats >= MAX_REPEATS && prev.result && tool && srv.permission !== 'deny') {
        const cached = { ...prev.result, note: `[WMB] IDENTICAL call repeated ${repeats + 1} times in a row: it was not executed again. This is the result of the last execution; use it. If it doesn't help, change the arguments or ask the user for something else.` };
        widget.log('err', `Identical call repeated ${repeats + 1} times: resending the last result without executing.`);
        prev.count += 1;
        prev.at = Date.now();
        await guarded(this.deliver(adapter, widget, state, srv, call, cached), DELIVER_TIMEOUT_MS, 'The chat did not accept the result in time.');
        return;
      }

      let result;
      if (srv.permission === 'deny') {
        result = { status: 'rejected', text: 'The user does not allow using this MCP.' };
        widget.log('err', `Blocked: ${srv.slug} › ${call.name}`);
      } else if (!tool) {
        const available = state.tools.filter((t) => t.server === srv.slug).map((t) => t.name).join(', ');
        result = { status: 'error', text: `Tool "${call.name}" does not exist in "${srv.slug}". Available: ${available || 'none'}.` };
      } else {
        let approved = true;
        if (srv.permission === 'ask') {
          const answer = await widget.requestApproval({ server: srv.slug, name: call.name, arguments: call.arguments });
          approved = Boolean(answer);
          if (answer === 'always') {
            await send({ type: 'SET_PERMISSION', id: srv.id, permission: 'allow' });
            await refresh();
          }
        }

        if (!approved) {
          result = { status: 'rejected', text: 'The user rejected the execution of this tool.' };
          widget.log('err', `Rejected: ${srv.slug} › ${call.name}`);
        } else {
          widget.log('ok', `Executing ${srv.slug} › ${call.name}...`);
          let response;
          try {
            response = await this.callWithRetry(send, widget, srv, call, 'The tool took too long to respond.');
          } catch (err) {
            response = { ok: false, error: err.message };
          }
          if (!response?.ok) result = { status: 'error', text: response?.error ?? 'Unknown error.' };
          else result = { status: response.result?.isError ? 'error' : 'ok', raw: response.result };
          widget.log(result.status === 'ok' ? 'ok' : 'err', `${call.name}: ${result.status}`);
        }
      }
      if (tool && srv.permission !== 'deny' && result.status !== 'rejected') {
        recentCalls.set(repeatKey, { count: repeats + 1, at: Date.now(), result });
        if (repeats > 0) result.note = `[WMB] This call is identical to the previous one (${repeats + 1} now). It was executed again and this is the CURRENT result; if you already have the data, do not repeat it.`;
      }
      if (detected.extra > 0) result.note = `[WMB] Only the first call was executed; ${detected.extra} more were ignored. Send ONE call per message and wait for the result.`;
      await guarded(this.deliver(adapter, widget, state, srv, call, result), DELIVER_TIMEOUT_MS, 'The chat did not accept the result in time.');
    }
  };
})();

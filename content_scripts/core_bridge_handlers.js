(() => {
  const W = globalThis.WMB;
  if (!W) return;
  const T = 150000, D = 120000, R = 900000, M = 4, B = 3;
  const WT = new Set(['create_or_update_file','delete_file','push_files','create_branch','create_pull_request','merge_pull_request','update_pull_request','update_pull_request_branch','issue_write','add_issue_comment','update_issue_comment','add_comment_to_pending_review','add_reply_to_pull_request_comment','pull_request_review_write','sub_issue_write','assign_copilot_to_issue','request_copilot_review']);
  const iW = (n) => WT.has(n) || Array.from(WT).some(t => n.endsWith(`_${t}`));
  let b = 0; const c = new Map();
  const g = (p, m, e) => Promise.race([p, W.sleep(m).then(() => { throw new Error(e); })]);
  const CONN_ERR = /no est.{1,2} conectado|desconectado/i;

  W.coreHandlers = {
    clearRecentCalls: () => c.clear(),
    deliver: async (a, w, s, v, l, { status, text, raw, note }) => {
      const { autoSend, maxResultChars, reminder } = s.settings;
      const p = W.planResult(raw ?? { content: [{ type: 'text', text }] }, { server: v.slug, name: l.name, status, maxChars: maxResultChars });
      let at = true;
      if (p.files.length) {
        w.log('ok', `Attaching ${p.files.length} file(s) to the chat...`);
        at = await a.attachFiles(p.files);
        if (!at) {
          for (const f of p.files.filter(x => !x.overflow)) { try { W.dom.download(W.dom.fileFrom(f)); } catch {} }
          w.log('err', 'Could not attach to the chat: the file was downloaded (drag it into the chat).');
        }
      }
      const t = reminder !== false && s.tools.length ? `\n${W.reminderLine(s.tools, 'result')}` : '';
      const r = await a.sendToolResult(`${p.build(at)}${note ? `\n${note}` : ''}${t}`, { autoSend, settleMs: at && p.files.length ? 1500 : 0 });
      w.log(r.ok ? 'ok' : 'err', r.ok ? `Result sent to ${a.name}.` : r.error);
    },
    resolveCall: async (s, d, l, f) => {
      const fn = () => {
        const k = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        const w = k(l.server);
        const sv = l.server ? s.servers.find(x => x.slug === l.server || k(x.slug) === w || k(x.name) === w) : (s.servers.length === 1 ? s.servers[0] : null);
        return { srv: sv, tool: sv ? s.tools.find(t => t.name === l.name && t.server === sv.slug) : null };
      };
      let r = fn(); if (!r.srv || (!r.tool && r.srv.permission !== 'deny')) { await f(); r = fn(); } return r;
    },
    handleMalformed: async (a, w, s, text) => {
      if (!s.settings.bridgeEnabled || !s.tools.length) return; b += 1;
      if (b > B) { w.log('err', 'The AI keeps using an invalid format: I will stop warning it. Check the chat.'); return; }
      w.log('err', `Unreadable call (${b}/${B}): warning the AI with the reason.`);
      const r = await a.sendToolResult(W.formatCallError(text), { autoSend: s.settings.autoSend });
      if (!r.ok) w.log('err', r.error);
    },
    waitConnected: async (d, s, m) => {
      const e = Date.now() + m;
      while (Date.now() < e) {
        const sn = await d({ type: 'GET_STATE' });
        if (sn?.servers?.find(x => x.id === s.id)?.status === 'connected') return true;
        await W.sleep(2000);
      }
      return false;
    },
    callWithRetry: async (d, w, s, l, m) => {
      let r;
      for (let a = 0; a < 3; a += 1) {
        r = await g(d({ type: 'CALL_TOOL', server: s.slug, name: l.name, arguments: l.arguments }), T, m);
        if (r?.ok || !CONN_ERR.test(r?.error ?? '') || a === 2) break;
        w.log('err', `${s.slug} disconnected: waiting for reconnection and retrying (${a + 1}/2).`);
        await d({ type: 'RECONNECT', id: s.id });
        await this.waitConnected(d, s, 40000);
      }
      return r;
    },
    handleCall: async (a, w, s, d, f, det) => {
      if (det.malformed) return this.handleMalformed(a, w, s, det.text); b = 0;
      const { call } = det; if (!s.settings.bridgeEnabled) return;
      const { srv, tool } = await this.resolveCall(s, d, call, f);
      if (!srv) { w.log('err', `Call ignored: server "${call.server ?? '?'}" not active.`); return; }

      const k = W.hash(JSON.stringify([srv.slug, call.name, call.arguments ?? {}]) ?? '');
      const p = c.get(k);
      const r = p && Date.now() - p.at < R ? p.count : 0;

      if (iW(call.name) && p && p.result) {
        const ca = { ...p.result, note: `[WMB] IDENTICAL write call repeated ${r + 1} times in a row: it was not executed again. This is the result of the last execution; use it.` };
        w.log('err', `Identical write call repeated ${r + 1} times: resending the last result without executing.`);
        p.count += 1; p.at = Date.now();
        await g(this.deliver(a, w, s, srv, call, ca), D, 'The chat did not accept the result in time.');
        return;
      }

      if (r >= M && p.result && tool && srv.permission !== 'deny') {
        const ca = { ...p.result, note: `[WMB] IDENTICAL call repeated ${r + 1} times in a row: it was not executed again. This is the result of the last execution; use it. If it doesn't help, change the arguments or ask the user for something else.` };
        w.log('err', `Identical call repeated ${r + 1} times: resending the last result without executing.`);
        p.count += 1; p.at = Date.now();
        await g(this.deliver(a, w, s, srv, call, ca), D, 'The chat did not accept the result in time.');
        return;
      }

      let res;
      if (srv.permission === 'deny') {
        res = { status: 'rejected', text: 'The user does not allow using this MCP.' };
        w.log('err', `Blocked: ${srv.slug} › ${call.name}`);
      } else if (!tool) {
        const av = s.tools.filter(t => t.server === srv.slug).map(t => t.name).join(', ');
        res = { status: 'error', text: `Tool "${call.name}" does not exist in "${srv.slug}". Available: ${av || 'none'}.` };
      } else {
        let ap = true;
        if (srv.permission === 'ask') {
          const ans = await w.requestApproval({ server: srv.slug, name: call.name, arguments: call.arguments });
          ap = Boolean(ans);
          if (ans === 'always') { await d({ type: 'SET_PERMISSION', id: srv.id, permission: 'allow' }); await f(); }
        }
        if (!ap) {
          res = { status: 'rejected', text: 'The user rejected the execution of this tool.' };
          w.log('err', `Rejected: ${srv.slug} › ${call.name}`);
        } else {
          w.log('ok', `Executing ${srv.slug} › ${call.name}...`);
          let rp;
          try { rp = await this.callWithRetry(d, w, srv, call, 'The tool took too long to respond.'); } catch (e) { rp = { ok: false, error: e.message }; }
          if (!rp?.ok) res = { status: 'error', text: rp?.error ?? 'Unknown error.' };
          else res = { status: rp.result?.isError ? 'error' : 'ok', raw: rp.result };
          w.log(res.status === 'ok' ? 'ok' : 'err', `${call.name}: ${res.status}`);
        }
      }
      if (tool && srv.permission !== 'deny' && res.status !== 'rejected') {
        c.set(k, { count: r + 1, at: Date.now(), result: res });
        if (r > 0) res.note = `[WMB] This call is identical to the previous one (${r + 1} now). It was executed again and this is the CURRENT result; if you already have the data, do not repeat it.`;
      }
      if (det.extra > 0) res.note = `[WMB] Only the first call was executed; ${det.extra} more were ignored. Send ONE call per message and wait for the result.`;
      await g(this.deliver(a, w, s, srv, call, res), D, 'The chat did not accept the result in time.');
    }
  };
})();

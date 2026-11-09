/** ui_widget_panels.js - Panel and approval-card rendering for the floating widget. */
(() => {
  'use strict';
  const WMB = globalThis.WMB;
  const PERMS = [['allow', 'Always allow'], ['ask', 'Always ask'], ['deny', 'Do not allow']];

  WMB.widgetPermSelect = function (widget, value, onChange, label) {
    const h = widget._h;
    const options = PERMS.map(([v, text]) => h('option', { value: v, selected: v === value ? '' : false }, text));
    if (value === 'mixed') options.unshift(h('option', { value: 'mixed', selected: '', disabled: '' }, 'Mixed'));
    return h('select', {
      class: value,
      'aria-label': label,
      onfocus: () => { widget.selectFocusedAt = Date.now(); },
      onchange: (e) => { const { value: chosen } = e.target; e.target.blur(); onChange(chosen); },
      onblur: () => { widget.selectFocusedAt = 0; widget.render(true); },
    }, options);
  };

  WMB.widgetApprovalCard = function (widget, item) {
    const h = widget._h;
    const { call } = item;
    const decide = (value) => {
      widget.approvals = widget.approvals.filter((a) => a !== item);
      item.resolve(value);
      widget.render(true);
    };
    let args = JSON.stringify(call.arguments ?? {}, null, 2);
    if (args.length > 1500) args = `${args.slice(0, 1500)}\n…`;
    return h('div', { class: 'card' },
      h('strong', {}, 'The AI wants to run a tool'),
      h('div', {}, `${call.server} › ${call.name}`),
      h('pre', {}, args),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => decide(true) }, 'Run'),
        h('button', { onclick: () => decide('always') }, 'Always allow'),
        h('button', { class: 'danger', onclick: () => decide(false) }, 'Reject')));
  };

  WMB.widgetPanel = function (widget) {
    const h = widget._h;
    const { servers, injection, adapterName, bridgeEnabled } = widget.model;
    const injectionText = {
      none: 'Instructions will be added automatically when you send your next message.',
      ok: 'Instructions injected and up to date.',
      stale: 'The active MCPs changed: inject the instructions again.',
    }[injection];
    const perms = new Set(servers.map((s) => s.permission));
    const common = perms.size === 1 ? [...perms][0] : 'mixed';

    return h('div', { class: 'panel', role: 'dialog', 'aria-label': 'Web MCP Bridge' },
      h('div', { class: 'head', 'data-drag': '1', style: 'cursor: move;' },
        h('strong', {}, `Web MCP Bridge · ${adapterName}`),
        h('button', { 'aria-label': 'Close', onclick: () => { widget.open = false; widget.render(true); } }, '✕')),

      servers.length
        ? h('ul', {}, servers.map((s) => h('li', { class: 'srv' },
          h('i', { class: `dot ${s.status === 'connected' ? 'ok' : s.status === 'connecting' ? 'warn' : ''}` }),
          h('span', { class: 'grow' }, s.name, h('span', { class: 'muted' },
            s.permission === 'deny' ? ' · blocked' : s.status === 'connected' ? ` · ${s.toolCount} tools` : ' · disconnected')),
          WMB.widgetPermSelect(widget, s.permission, (value) => widget.handlers.onSetPermission(s.id, value), `Permission for ${s.name}`))))
        : h('p', { class: 'muted' }, 'Open the extension icon and enable an MCP server.'),

      servers.length > 1
        ? h('div', { class: 'perm' }, h('strong', {}, 'All MCPs'),
          WMB.widgetPermSelect(widget, common, (value) => widget.handlers.onSetPermission(null, value), 'Permission for all MCPs'))
        : null,

      h('div', { class: 'row' },
        h('button', { class: bridgeEnabled ? 'danger' : 'primary', onclick: () => widget.handlers.onToggleBridge(!bridgeEnabled) },
          bridgeEnabled ? 'Disable bridge' : 'Enable bridge')),

      h('p', { class: 'muted' }, injectionText),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => widget.handlers.onInject() }, 'Inject instructions'),
        h('button', { onclick: () => widget.handlers.onRefresh() }, 'Refresh')),

      widget.approvals.map((item) => WMB.widgetApprovalCard(widget, item)),

      widget.logs.length
        ? h('ul', { class: 'log' }, widget.logs.map((l) => h('li', { class: l.kind },
          `${l.ts.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${l.text}`)))
        : null,

      h('div', { class: 'foot' }, h('div', {}, `Web MCP Bridge v${WMB.VERSION}`), h('div', {}, 'Github: @AstraxOf')));
  };
})();

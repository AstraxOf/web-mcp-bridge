/**
 * ui_widget.js — Panel flotante dentro de la página (Shadow DOM, sin conflictos de estilos).
 *
 * Muestra el estado de los MCP activos, permite inyectar las instrucciones y elegir el permiso
 * de cada MCP (permitir siempre · preguntar siempre · no permitir). Con «preguntar» pide
 * APROBACIÓN antes de cada herramienta (human-in-the-loop).
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (value !== false && value != null) el.setAttribute(key, value);
    }
    for (const child of children.flat()) el.append(child?.nodeType ? child : document.createTextNode(child ?? ''));
    return el;
  };

  const PERMS = [['allow', 'Permitir siempre'], ['ask', 'Preguntar siempre'], ['deny', 'No permitir']];

  const CSS = `
    :host { all: initial; }
    .wrap {
      --bg:#ffffff; --fg:#16211d; --muted:#67736d; --line:#dde2dc; --accent:#0f766e; --accent-fg:#fff;
      --ok:#16a34a; --warn:#d97706; --err:#dc2626;
      position: fixed; left: 16px; bottom: 16px; z-index: 2147483647;
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg);
      display: flex; flex-direction: column; gap: 8px; align-items: flex-start;
    }
    @media (prefers-color-scheme: dark) {
      .wrap { --bg:#1b2326; --fg:#e6ece9; --muted:#91a09a; --line:#2c373b; --accent:#2dd4bf; --accent-fg:#062a27; }
    }
    .pill, .panel { background: var(--bg); border: 1px solid var(--line); box-shadow: 0 6px 24px rgba(0,0,0,.18); }
    .pill {
      display: flex; gap: 8px; align-items: center; padding: 7px 12px; border-radius: 999px;
      cursor: pointer; color: inherit; font: inherit;
    }
    .pill.alert { border-color: var(--warn); }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); }
    .dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); }
    .panel { width: 340px; max-height: 70vh; overflow: auto; border-radius: 12px; padding: 12px 14px; }
    .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .head strong { font-size: 14px; }
    .muted { color: var(--muted); font-size: 12px; }
    ul { list-style: none; margin: 6px 0; padding: 0; display: grid; gap: 4px; }
    li.srv { display: flex; gap: 8px; align-items: center; }
    .row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
    button { font: inherit; cursor: pointer; border-radius: 8px; padding: 6px 10px; border: 1px solid var(--line); background: transparent; color: var(--fg); }
    button.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; font-weight: 600; }
    button.danger { color: var(--err); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .card { margin: 8px 0; padding: 10px; border: 1px solid var(--warn); border-radius: 10px; }
    .card pre {
      margin: 6px 0; padding: 8px; max-height: 140px; overflow: auto; white-space: pre-wrap; word-break: break-word;
      background: rgba(127,127,127,.12); border-radius: 6px; font: 12px/1.4 ui-monospace, Menlo, Consolas, monospace;
    }
    .log { font-size: 12px; color: var(--muted); }
    .log .err { color: var(--err); } .log .ok { color: var(--ok); }
    .perm { display: flex; gap: 8px; align-items: center; justify-content: space-between; margin-top: 10px; font-size: 12px; }
    select { font: inherit; font-size: 12px; padding: 4px 6px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); cursor: pointer; }
    select.allow { border-color: var(--ok); } select.deny { border-color: var(--err); }
    li.srv .grow { flex: 1; min-width: 0; }
  `;

  class Widget {
    constructor(handlers) {
      this.handlers = handlers;
      this.model = { adapterName: '', servers: [], toolCount: 0, injection: 'none', bridgeEnabled: true };
      this.logs = [];
      this.approvals = [];
      this.open = false;
      this.selectFocusedAt = 0;

      this.host = document.createElement('div');
      this.host.id = 'wmb-host';
      this.shadow = this.host.attachShadow({ mode: 'closed' });
      this.root = h('div', { class: 'wrap' });
      this.shadow.append(h('style', {}, CSS), this.root);
      document.documentElement.append(this.host);
      this.render();
    }

    update(patch) { Object.assign(this.model, patch); this.render(); }

    log(kind, text) {
      this.logs.unshift({ kind, text, ts: new Date() });
      this.logs.length = Math.min(this.logs.length, 6);
      this.render();
    }

    /** Pide confirmación al usuario. Resuelve `true` (ejecutar), `'always'` (ejecutar y permitir siempre) o `false` (rechazar). */
    requestApproval(call) {
      return new Promise((resolve) => {
        this.approvals.push({ call, resolve });
        this.open = true;
        this.render(true);
      });
    }

    // ───────────── Render ─────────────

    render(force = false) {
      // No cerrar un desplegable mientras se usa, pero SOLO unos segundos: un <select> con el foco no puede congelar el panel.
      if (!force && this.shadow.activeElement?.tagName === 'SELECT' && Date.now() - this.selectFocusedAt < 6000) return;
      const { servers, toolCount } = this.model;
      const pending = this.approvals.length;
      const activeLabel = !this.model.bridgeEnabled ? 'Bridge desactivado' : servers.length
        ? `${servers.length} MCP · ${toolCount} herramientas`
        : 'Sin MCP activos';
      const allUp = servers.length > 0 && servers.every((s) => s.status === 'connected');

      const pill = h('button', {
        class: `pill${pending ? ' alert' : ''}`,
        'aria-expanded': String(this.open),
        onclick: () => { this.open = !this.open; this.render(); },
      },
      h('i', { class: `dot ${pending ? 'warn' : allUp && this.model.bridgeEnabled ? 'ok' : ''}` }),
      h('span', {}, pending ? `${pending} llamada${pending > 1 ? 's' : ''} por aprobar` : activeLabel));

      this.root.replaceChildren(...(this.open ? [this.#panel()] : []), pill);
    }

    /** Selector de 3 estados. `value` puede ser 'mixed' cuando los MCP tienen permisos distintos. */
    #permSelect(value, onChange, label) {
      const options = PERMS.map(([v, text]) => h('option', { value: v, selected: v === value ? '' : false }, text));
      if (value === 'mixed') options.unshift(h('option', { value: 'mixed', selected: '', disabled: '' }, 'Mixto'));
      return h('select', {
        class: value,
        'aria-label': label,
        onfocus: () => { this.selectFocusedAt = Date.now(); },
        onchange: (e) => { const { value: chosen } = e.target; e.target.blur(); onChange(chosen); }, // soltar el foco: el panel vuelve a repintarse
        onblur: () => { this.selectFocusedAt = 0; this.render(true); },
      }, options);
    }

    #panel() {
      const { servers, injection, adapterName, bridgeEnabled } = this.model;
      const injectionText = {
        none: 'Las instrucciones se añadirán solas al enviar tu próximo mensaje.',
        ok: 'Instrucciones inyectadas y al día.',
        stale: 'Los MCP activos cambiaron: vuelve a inyectar las instrucciones.',
      }[injection];
      const perms = new Set(servers.map((s) => s.permission));
      const common = perms.size === 1 ? [...perms][0] : 'mixed';

      return h('div', { class: 'panel', role: 'dialog', 'aria-label': 'Web MCP Bridge' },
        h('div', { class: 'head' },
          h('strong', {}, `Web MCP Bridge · ${adapterName}`),
          h('button', { 'aria-label': 'Cerrar', onclick: () => { this.open = false; this.render(true); } }, '✕')),

        servers.length
          ? h('ul', {}, servers.map((s) => h('li', { class: 'srv' },
            h('i', { class: `dot ${s.status === 'connected' ? 'ok' : s.status === 'connecting' ? 'warn' : ''}` }),
            h('span', { class: 'grow' }, s.name, h('span', { class: 'muted' }, s.permission === 'deny' ? ' · bloqueado' : s.status === 'connected' ? ` · ${s.toolCount} herr.` : ' · sin conexión')),
            this.#permSelect(s.permission, (value) => this.handlers.onSetPermission(s.id, value), `Permiso de ${s.name}`))))
          : h('p', { class: 'muted' }, 'Abre el icono de la extensión y activa un servidor MCP.'),

        servers.length > 1
          ? h('div', { class: 'perm' }, h('strong', {}, 'Todos los MCP'),
            this.#permSelect(common, (value) => this.handlers.onSetPermission(null, value), 'Permiso de todos los MCP'))
          : null,

        h('div', { class: 'row' },
          h('button', { class: bridgeEnabled ? 'danger' : 'primary', onclick: () => this.handlers.onToggleBridge(!bridgeEnabled) },
            bridgeEnabled ? 'Desactivar bridge' : 'Activar bridge')),

        h('p', { class: 'muted' }, injectionText),
        h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: () => this.handlers.onInject() }, 'Inyectar instrucciones'),
          h('button', { onclick: () => this.handlers.onRefresh() }, 'Actualizar')),

        this.approvals.map((item) => this.#approvalCard(item)),

        this.logs.length
          ? h('ul', { class: 'log' }, this.logs.map((l) => h('li', { class: l.kind },
            `${l.ts.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${l.text}`)))
          : null);
    }

    #approvalCard(item) {
      const { call } = item;
      const decide = (value) => {
        this.approvals = this.approvals.filter((a) => a !== item);
        item.resolve(value);
        this.render(true);
      };
      let args = JSON.stringify(call.arguments ?? {}, null, 2);
      if (args.length > 1500) args = `${args.slice(0, 1500)}\n…`;
      return h('div', { class: 'card' },
        h('strong', {}, 'La IA quiere ejecutar una herramienta'),
        h('div', {}, `${call.server} › ${call.name}`),
        h('pre', {}, args),
        h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: () => decide(true) }, 'Ejecutar'),
          h('button', { onclick: () => decide('always') }, 'Permitir siempre'),
          h('button', { class: 'danger', onclick: () => decide(false) }, 'Rechazar')));
    }
  }

  WMB.Widget = Widget;
})();

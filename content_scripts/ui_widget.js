/**
 * ui_widget.js — Panel flotante dentro de la página (Shadow DOM, sin conflictos de estilos).
 *
 * v1.8: estética ciberpunk (negro por defecto, blanco opcional), selector English/Español y de tema en la cabecera,
 * y un diseño más aireado. Muestra el estado de los MCP activos, permite inyectar las instrucciones y elegir el permiso
 * de cada MCP (permitir siempre · preguntar siempre · no permitir). Con «preguntar» pide APROBACIÓN antes de cada
 * herramienta (human-in-the-loop).
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;
  const tr = (key, vars) => (typeof WMB.t === 'function' ? WMB.t(key, vars) : key);
  const trp = (key, n) => (typeof WMB.tp === 'function' ? WMB.tp(key, n) : `${key} ${n}`);

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

  const PERMS = [['allow', 'perm.allow'], ['ask', 'perm.ask'], ['deny', 'perm.deny']];

  const CSS = `
    :host { all: initial; }
    .wrap {
      /* ── Tema OSCURO ciberpunk (por defecto) ── */
      --bg:#0a0c12; --bg2:#10141d; --fg:#e8f1ff; --muted:#8893aa; --line:#1c2333;
      --accent:#00e5ff; --accent2:#ff2e97; --accent-fg:#031217;
      --ok:#27f5a0; --warn:#ffb020; --err:#ff4d6d;
      --glow: 0 0 0 1px rgba(0,229,255,.14), 0 14px 44px rgba(0,0,0,.6), 0 0 26px rgba(0,229,255,.10);
      --soft: rgba(255,255,255,.04);
      position: fixed; left: var(--x, 16px); top: var(--y, auto); bottom: var(--y, 16px); z-index: 2147483647;
      touch-action: none; user-select: none;
      font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg);
      display: flex; flex-direction: column; gap: 10px; align-items: flex-start;
    }
    /* ── Tema CLARO (opcional) ── */
    .wrap[data-theme="light"] {
      --bg:#ffffff; --bg2:#f3f6fb; --fg:#0b1220; --muted:#5b6577; --line:#e1e6ef;
      --accent:#0891b2; --accent2:#c026d3; --accent-fg:#ffffff;
      --ok:#059669; --warn:#d97706; --err:#dc2626;
      --glow: 0 0 0 1px rgba(8,145,178,.14), 0 12px 36px rgba(15,23,42,.16);
      --soft: rgba(15,23,42,.05);
    }
    .pill, .panel { background: var(--bg); border: 1px solid var(--line); box-shadow: var(--glow); }
    .pill {
      display: flex; gap: 10px; align-items: center; padding: 8px 14px; border-radius: 999px;
      cursor: grab; color: inherit; font: inherit; font-weight: 600; letter-spacing: .01em;
      border-color: color-mix(in srgb, var(--accent) 38%, var(--line));
    }
    .pill:hover { border-color: var(--accent); }
    .wrap.dragging .pill { cursor: grabbing; }
    .wrap.dragging { transition: none !important; }
    .wrap:not(.dragging) { transition: left .12s ease, top .12s ease; }
    .wrap.flip { flex-direction: column-reverse; }
    .wrap.flip .panel { margin-bottom: 4px; }
    @media (prefers-reduced-motion: reduce) { .wrap:not(.dragging) { transition: none; } }
    .pill.alert { border-color: var(--warn); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
    .dot.ok { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
    .dot.warn { background: var(--warn); box-shadow: 0 0 8px var(--warn); }

    .panel {
      position: relative; width: 348px; max-width: calc(100vw - 24px); max-height: min(72vh, calc(100vh - 40px));
      overflow: hidden; display: flex; flex-direction: column; border-radius: 16px; padding: 16px 16px 12px;
    }
    .panel::before { /* filo de neón superior */
      content: ""; position: absolute; left: 0; right: 0; top: 0; height: 2px;
      background: linear-gradient(90deg, var(--accent), var(--accent2));
    }
    .panel > * { flex: none; }
    .head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 12px; }
    .head .ttl { min-width: 0; }
    .head strong { display: block; font-size: 14px; letter-spacing: .02em; }
    .head .sub { display: block; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .12em; }
    .tools { display: flex; align-items: center; gap: 6px; }
    .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    .seg button { border: 0; border-radius: 0; padding: 3px 8px; font-size: 11px; font-weight: 700; letter-spacing: .06em; color: var(--muted); }
    .seg button.on { background: var(--accent); color: var(--accent-fg); }
    .icon { padding: 3px 8px; line-height: 1.2; }
    .muted { color: var(--muted); font-size: 12px; }
    .sec { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
    .sec:first-of-type { margin-top: 0; }
    .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: .12em; color: var(--muted); font-weight: 600; }
    ul { list-style: none; margin: 6px 0 0; padding: 0; display: grid; gap: 8px; }
    li.srv { display: flex; gap: 10px; align-items: center; padding: 8px 10px; background: var(--soft); border-radius: 10px; }
    .row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
    button { font: inherit; cursor: pointer; border-radius: 9px; padding: 6px 12px; border: 1px solid var(--line); background: transparent; color: var(--fg); transition: border-color .12s, background .12s; }
    button:hover:not(:disabled) { border-color: var(--accent); }
    button.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; font-weight: 700; }
    button.primary:hover:not(:disabled) { filter: brightness(1.08); }
    button.danger { color: var(--err); }
    button:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    button:disabled { opacity: .5; cursor: default; }
    .bridge .state { display: inline-flex; gap: 6px; align-items: center; }
    .bridge .row button { flex: 1; }
    .bridge .row + .perm { margin-top: 16px; padding-top: 14px; border-top: 1px dashed var(--line); min-height: 34px; }
    .card { margin: 0 0 12px; padding: 12px; border: 1px solid var(--warn); border-radius: 12px; background: var(--soft); }
    .card pre {
      margin: 8px 0; padding: 8px 10px; max-height: 140px; overflow: auto; white-space: pre-wrap; word-break: break-word;
      background: var(--bg2); border-radius: 8px; font: 12px/1.4 ui-monospace, Menlo, Consolas, monospace;
    }
    .panel > ul.log { flex: 0 1 auto; min-height: 56px; max-height: 100px; overflow-y: auto; overscroll-behavior: contain; padding-right: 6px; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
    ul.log { gap: 3px; margin-top: 12px; }
    ul.log::-webkit-scrollbar, ul.srvs::-webkit-scrollbar { width: 5px; }
    ul.log::-webkit-scrollbar-track, ul.srvs::-webkit-scrollbar-track { background: transparent; }
    ul.log::-webkit-scrollbar-thumb, ul.srvs::-webkit-scrollbar-thumb { background: var(--line); border-radius: 4px; }
    ul.log::-webkit-scrollbar-thumb:hover, ul.srvs::-webkit-scrollbar-thumb:hover { background: var(--muted); }
    .panel > ul.srvs { flex: 0 0.25 auto; min-height: 0; }
    .panel > ul.srvs.scroll { max-height: 128px; min-height: 64px; overflow-y: auto; overscroll-behavior: contain; padding-right: 6px; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
    .panel > .foot, .panel > .head { flex: none; }
    .panel > p.muted { margin: 10px 0 0; }
    .approvals { flex: none; }
    .approvals .queue { margin: -4px 0 12px; text-align: center; }
    .panel.has-approval .card pre { max-height: 96px; }
    .log { font-size: 12px; color: var(--muted); }
    .log .err { color: var(--err); } .log .ok { color: var(--ok); }
    .perm { display: flex; gap: 8px; align-items: center; justify-content: space-between; font-size: 12px; }
    .perm + .perm { margin-top: 10px; }
    select { font: inherit; font-size: 12px; padding: 4px 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg2); color: var(--fg); cursor: pointer; }
    select.allow { border-color: var(--ok); } select.deny { border-color: var(--err); }
    li.srv .grow { flex: 1; min-width: 0; }
    .foot { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line); text-align: center; font-size: 11px; color: var(--muted); letter-spacing: .04em; }
  `;

  const MAX_LOGS = 200;

  class Widget {
    constructor(handlers) {
      this.handlers = handlers;
      this.model = { adapterName: '', servers: [], toolCount: 0, injection: 'none', bridgeEnabled: true, bridge: null, bridgeBusy: null, responseDelayMs: 1500, language: 'en', theme: 'dark' };
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
      this.#initDrag();
      this.render();
    }

    // ═════════════════════════════ Arrastre de la ventana ═════════════════════════════
    // La pill es el asa. La posición se recuerda por URL en sessionStorage; doble clic la resetea.
    #posKey() { return `wmb-widget-pos:${location.origin}${location.pathname}`; }

    #applyPosition(pos) {
      if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') {
        this.root.style.removeProperty('--x');
        this.root.style.removeProperty('--y');
        return;
      }
      const w = this.root.getBoundingClientRect().width || 0;
      const hgt = this.root.getBoundingClientRect().height || 0;
      const x = Math.min(Math.max(0, pos.x), Math.max(0, window.innerWidth - w));
      const y = Math.min(Math.max(0, pos.y), Math.max(0, window.innerHeight - hgt));
      this.root.style.setProperty('--x', `${x}px`);
      this.root.style.setProperty('--y', `${y}px`);
      this.root.style.setProperty('bottom', 'auto');
    }

    #savePosition(x, y) {
      try { sessionStorage.setItem(this.#posKey(), JSON.stringify({ x, y })); } catch { /* almacenamiento no disponible */ }
    }

    #resetPosition() {
      try { sessionStorage.removeItem(this.#posKey()); } catch { /* noop */ }
      this.root.style.removeProperty('--x');
      this.root.style.removeProperty('--y');
      this.root.style.removeProperty('bottom');
    }

    #fitToViewport() {
      const r = this.root.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      let dx = 0, dy = 0;
      if (r.right > vw) dx -= (r.right - vw);
      if (r.left < 0) dx -= r.left;
      if (r.bottom > vh) dy -= (r.bottom - vh);
      if (r.top < 0) dy -= r.top;
      if (dx === 0 && dy === 0) return;
      this.root.style.setProperty('--x', `${Math.round(r.left + dx)}px`);
      this.root.style.setProperty('--y', `${Math.round(r.top + dy)}px`);
      this.root.style.setProperty('bottom', 'auto');
    }

    #initDrag() {
      requestAnimationFrame(() => {
        try {
          const raw = sessionStorage.getItem(this.#posKey());
          if (raw) this.#applyPosition(JSON.parse(raw));
        } catch { /* ignore */ }
        window.addEventListener('resize', () => {
          const raw = sessionStorage.getItem(this.#posKey());
          if (!raw) return;
          try { const pos = JSON.parse(raw); this.#applyPosition(pos); } catch { /* ignore */ }
        }, { passive: true });
      });

      this.root.addEventListener('pointerdown', (e) => this.#onPointerDown(e));
      this.root.addEventListener('dblclick', (e) => {
        if (e.target.closest('.pill')) { this.#resetPosition(); }
      });
    }

    #onPointerDown(e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      let handle = e.target.closest('.pill');
      if (!handle) {
        const head = e.target.closest('.head[data-drag]');
        if (head && !e.target.closest('button, select, input, a, textarea')) handle = head;
      }
      if (!handle) return;
      e.preventDefault();
      e.stopPropagation();

      const rect = this.root.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY;
      const origX = rect.left, origY = rect.top;
      let moved = false;
      this.root.classList.add('dragging');
      try { handle.setPointerCapture(e.pointerId); } catch { /* navegadores antiguos */ }

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        this.root.style.setProperty('--x', `${Math.round(origX + dx)}px`);
        this.root.style.setProperty('--y', `${Math.round(origY + dy)}px`);
        this.root.style.setProperty('bottom', 'auto');
        this.#fitToViewport();
      };
      const onUp = () => {
        try { handle.releasePointerCapture(e.pointerId); } catch { /* noop */ }
        this.root.classList.remove('dragging');
        document.removeEventListener('pointermove', onMove, true);
        document.removeEventListener('pointerup', onUp, true);
        document.removeEventListener('pointercancel', onUp, true);
        if (moved) {
          const r = this.root.getBoundingClientRect();
          this.#savePosition(r.left, r.top);
          this._suppressClickUntil = Date.now() + 250;
        }
      };
      document.addEventListener('pointermove', onMove, true);
      document.addEventListener('pointerup', onUp, true);
      document.addEventListener('pointercancel', onUp, true);
    }

    update(patch) { Object.assign(this.model, patch); this.render(); }

    log(kind, text) {
      this.logs.unshift({ kind, text, ts: new Date() });
      this.logs.length = Math.min(this.logs.length, MAX_LOGS); // historial temporal (solo en memoria)
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
      const visible = this.model.bridgeEnabled !== false;
      this.host.style.setProperty('display', visible ? '' : 'none', visible ? '' : 'important');
      if (!visible) { this.open = false; }
      this.root.dataset.theme = this.model.theme === 'light' ? 'light' : 'dark';
      if (!force && this.shadow.activeElement?.tagName === 'SELECT' && Date.now() - this.selectFocusedAt < 6000) return;
      const { servers, toolCount } = this.model;
      const pending = this.approvals.length;
      const bridgeDown = Boolean(this.model.bridge?.checked && !this.model.bridge.online);
      const activeLabel = !this.model.bridgeEnabled ? tr('wd.disabled') : bridgeDown ? tr('wd.bridgeOff') : servers.length
        ? tr('wd.label', { servers: servers.length, tools: toolCount })
        : tr('wd.noMcp');
      const allUp = servers.length > 0 && servers.every((s) => s.status === 'connected');

      const pill = h('button', {
        class: `pill${pending ? ' alert' : ''}`,
        'aria-expanded': String(this.open),
        onclick: () => { if (this._suppressClickUntil && Date.now() < this._suppressClickUntil) return; this.open = !this.open; this.render(); },
      },
      h('i', { class: `dot ${pending ? 'warn' : allUp && this.model.bridgeEnabled ? 'ok' : ''}` }),
      h('span', {}, pending ? trp('wd.pending', pending) : activeLabel));

      const srvScroll = this.root.querySelector('ul.srvs')?.scrollTop ?? 0;
      const logScroll = this.root.querySelector('ul.log')?.scrollTop ?? 0;
      this.root.replaceChildren(...(this.open ? [this.#panel()] : []), pill);
      const logList = this.root.querySelector('ul.log');
      if (logList && logScroll) logList.scrollTop = logScroll;
      const srvList = this.root.querySelector('ul.srvs');
      if (srvList && srvScroll) srvList.scrollTop = srvScroll;
      if (this.open) requestAnimationFrame(() => this.#fitToViewport());
    }

    /** Selector de 3 estados. `value` puede ser 'mixed' cuando los MCP tienen permisos distintos. */
    #permSelect(value, onChange, label) {
      const options = PERMS.map(([v, key]) => h('option', { value: v, selected: v === value ? '' : false }, tr(key)));
      if (value === 'mixed') options.unshift(h('option', { value: 'mixed', selected: '', disabled: '' }, tr('perm.mixed')));
      return h('select', {
        class: value,
        'aria-label': label,
        onfocus: () => { this.selectFocusedAt = Date.now(); },
        onchange: (e) => { const { value: chosen } = e.target; e.target.blur(); onChange(chosen); },
        onblur: () => { this.selectFocusedAt = 0; this.render(true); },
      }, options);
    }

    /** Selector del tiempo de respuesta (pausa antes de entregar cada resultado a la IA). */
    #delaySelect() {
      const current = Number(this.model.responseDelayMs) || 0;
      const sec = (ms) => `${(ms / 1000).toFixed(1).replace(/\.0$/, '').replace('.', this.model.language === 'es' ? ',' : '.')} s`;
      const steps = [[0, tr('wd.instant')], ...[1000, 1500, 2000, 3000, 5000, 8000, 10000, 15000, 30000].map((ms) => [ms, sec(ms)])];
      if (!steps.some(([ms]) => ms === current)) steps.push([current, sec(current)]);
      steps.sort((a, b) => a[0] - b[0]);
      return h('select', {
        'aria-label': tr('wd.delayLabel'),
        title: tr('wd.delayTip'),
        onfocus: () => { this.selectFocusedAt = Date.now(); },
        onchange: (e) => { const ms = Number(e.target.value); e.target.blur(); this.handlers.onSetDelay?.(ms); },
        onblur: () => { this.selectFocusedAt = 0; this.render(true); },
      }, steps.map(([ms, text]) => h('option', { value: String(ms), selected: ms === current ? '' : false }, text)));
    }

    /** Control GLOBAL del puente: encender / apagar / reiniciar el PROCESO (funciona esté como esté). */
    #bridgeSection() {
      const { bridge, bridgeBusy } = this.model;
      const checked = Boolean(bridge?.checked);
      const online = Boolean(bridge?.online);
      const busy = Boolean(bridgeBusy);
      const stateText = !checked ? tr('wd.checking') : online ? (bridge.pid ? tr('wd.onPid', { pid: bridge.pid }) : tr('wd.on')) : tr('wd.off');
      const act = (action) => () => { if (!busy) this.handlers.onBridgeAction?.(action); };
      return h('div', { class: 'sec bridge' },
        h('div', { class: 'perm' },
          h('span', { class: 'lbl' }, tr('wd.bridge')),
          h('span', { class: 'muted state' }, h('i', { class: `dot ${online ? 'ok' : ''}` }), stateText)),
        h('div', { class: 'row' },
          online
            ? h('button', { class: 'danger', disabled: busy ? '' : false, onclick: act('stop') }, bridgeBusy === 'stop' ? tr('wd.stopping') : tr('wd.stop'))
            : h('button', { class: 'primary', disabled: busy ? '' : false, onclick: act('start') }, bridgeBusy === 'start' ? tr('wd.starting') : tr('wd.start')),
          h('button', { disabled: busy ? '' : false, onclick: act('restart') }, bridgeBusy === 'restart' ? tr('wd.restarting') : (online ? tr('wd.restart') : tr('wd.restartStart')))),
        h('div', { class: 'perm' }, h('span', { class: 'lbl' }, tr('wd.delayLabel')), this.#delaySelect()));
    }

    /** Cabecera: título + idioma (EN | ES) + tema + cerrar. */
    #headSection() {
      const { adapterName, language, theme } = this.model;
      const light = theme === 'light';
      const langBtn = (code) => h('button', {
        class: language === code ? 'on' : '',
        title: tr('wd.langTip'),
        'aria-pressed': String(language === code),
        onclick: () => { if (language !== code) this.handlers.onSetLang?.(code); },
      }, code.toUpperCase());
      return h('div', { class: 'head', 'data-drag': '1', style: 'cursor: move;' },
        h('div', { class: 'ttl' }, h('strong', {}, 'Web MCP Bridge'), h('span', { class: 'sub' }, adapterName)),
        h('div', { class: 'tools' },
          h('div', { class: 'seg', role: 'group', 'aria-label': tr('lang.switch') }, langBtn('en'), langBtn('es')),
          h('button', { class: 'icon', title: tr(light ? 'theme.toDark' : 'theme.toLight'), 'aria-label': tr(light ? 'theme.toDark' : 'theme.toLight'), onclick: () => this.handlers.onSetTheme?.(light ? 'dark' : 'light') }, light ? '☾' : '☀'),
          h('button', { class: 'icon', 'aria-label': tr('wd.close'), onclick: () => { this.open = false; this.render(true); } }, '✕')));
    }

    #panel() {
      const { servers, injection } = this.model;
      const injectionText = tr({ none: 'wd.inj.none', ok: 'wd.inj.ok', stale: 'wd.inj.stale' }[injection] ?? 'wd.inj.none');
      const locale = this.model.language === 'es' ? 'es' : 'en';

      return h('div', { class: `panel${this.approvals.length ? ' has-approval' : ''}`, role: 'dialog', 'aria-label': 'Web MCP Bridge' },
        this.#headSection(),

        this.#approvalSection(),

        servers.length
          ? h('ul', { class: `srvs${servers.length >= 3 ? ' scroll' : ''}` }, servers.map((s) => h('li', { class: 'srv' },
            h('i', { class: `dot ${s.status === 'connected' ? 'ok' : s.status === 'connecting' ? 'warn' : ''}` }),
            h('span', { class: 'grow' }, s.name, h('span', { class: 'muted' }, s.permission === 'deny' ? tr('wd.blocked') : s.status === 'connected' ? tr('wd.toolsShort', { n: s.toolCount }) : tr('wd.noConn'))),
            this.#permSelect(s.permission, (value) => this.handlers.onSetPermission(s.id, value), tr('p.srv.permAria', { name: s.name })))))
          : h('p', { class: 'muted' }, tr('wd.noServers')),

        this.#bridgeSection(),

        h('p', { class: 'muted' }, injectionText),
        h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: () => this.handlers.onInject() }, tr('wd.inject')),
          h('button', { onclick: () => this.handlers.onRefresh() }, tr('wd.refresh')),
          h('button', { title: tr('wd.rescanTip'), onclick: () => this.handlers.onRescan?.() }, tr('wd.rescan'))),

        this.logs.length
          ? h('ul', { class: 'log' }, this.logs.map((l) => h('li', { class: l.kind },
            `${l.ts.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${l.text}`)))
          : null,

        h('div', { class: 'foot' }, `Web MCP Bridge v${WMB.VERSION} · Github: @AstraxOf`));
    }

    /** La aprobación va SIEMPRE arriba (bajo el encabezado) para que sus botones nunca queden fuera del panel. */
    #approvalSection() {
      if (!this.approvals.length) return null;
      const rest = this.approvals.length - 1;
      return h('div', { class: 'approvals' },
        this.#approvalCard(this.approvals[0]),
        rest > 0 ? h('p', { class: 'muted queue' }, tr('wd.queue', { n: rest })) : null);
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
        h('strong', {}, tr('wd.askTitle')),
        h('div', {}, `${call.server} › ${call.name}`),
        h('pre', {}, args),
        h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: () => decide(true) }, tr('wd.run')),
          h('button', { onclick: () => decide('always') }, tr('wd.always')),
          h('button', { class: 'danger', onclick: () => decide(false) }, tr('wd.reject'))));
    }
  }

  WMB.Widget = Widget;
})();

/**
 * ui_widget.js — Panel flotante dentro de la página (Shadow DOM, sin conflictos de estilos).
 *
 * v1.8: estética ciberpunk (negro por defecto, blanco opcional), selector English/Español y de tema en la cabecera,
 * y un diseño más aireado. Muestra el estado de los MCP activos, permite inyectar las instrucciones y elegir el permiso
 * de cada MCP (permitir siempre · preguntar siempre · no permitir). Con «preguntar» pide APROBACIÓN antes de cada
 * herramienta (human-in-the-loop).
 *
 * Maquetación del panel: cabecera fija · cuerpo con scroll (nada se aplasta ni se desborda) · pie fijo (créditos siempre
 * visibles). Con el panel abierto la píldora se oculta: el panel ocupa su lugar y la ✕ lo vuelve a convertir en píldora.
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
      --bg:#0a0c12; --bg2:#10141d; --field:#10141d; --fg:#e8f1ff; --muted:#8893aa; --line:#1c2333;
      --accent:#00e5ff; --accent2:#ff2e97; --accent-fg:#031217;
      --ok:#27f5a0; --warn:#ffb020; --err:#ff4d6d;
      --glow: 0 0 0 1px rgba(0,229,255,.14), 0 14px 44px rgba(0,0,0,.6), 0 0 26px rgba(0,229,255,.10);
      --soft: rgba(255,255,255,.04); --row-line: rgba(255,255,255,.06);
      --dot-ok-glow: 0 0 8px var(--ok); --dot-warn-glow: 0 0 8px var(--warn);
      position: fixed; left: var(--x, auto); right: 16px; top: var(--y, 16px); bottom: auto; z-index: 2147483647;
      max-width: calc(100vw - 24px);
      touch-action: none; user-select: none;
      font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg);
      display: flex; flex-direction: column; gap: 10px; align-items: flex-start;
    }
    /* ── Tema CLARO (opcional): papel limpio, acento cian oscuro con buen contraste ── */
    .wrap[data-theme="light"] {
      --bg:#fcfdff; --bg2:#f1f5f9; --field:#ffffff; --fg:#0f172a; --muted:#5f6b7e; --line:#d9e0ea;
      --accent:#0e7490; --accent2:#9333ea; --accent-fg:#ffffff;
      --ok:#047857; --warn:#b45309; --err:#be123c;
      --glow: 0 0 0 1px rgba(15,23,42,.04), 0 12px 32px rgba(15,23,42,.16), 0 2px 6px rgba(15,23,42,.06);
      --soft:#f1f5f9; --row-line:#e4e9f1;
      --dot-ok-glow: 0 0 0 3px rgba(4,120,87,.16); --dot-warn-glow: 0 0 0 3px rgba(180,83,9,.18);
    }
    .pill, .panel { background: var(--bg); border: 1px solid var(--line); box-shadow: var(--glow); }
    .pill {
      display: flex; gap: 10px; align-items: center; padding: 8px 14px; border-radius: 999px;
      cursor: grab; color: inherit; font: inherit; font-weight: 600; letter-spacing: .01em; touch-action: none;
      border-color: color-mix(in srgb, var(--accent) 38%, var(--line));
    }
    .pill:hover { border-color: var(--accent); }
    .wrap.dragging .pill { cursor: grabbing; }
    .wrap.dragging { transition: none !important; }
    .wrap:not(.dragging) { transition: left .12s ease, top .12s ease; }
    @media (prefers-reduced-motion: reduce) { .wrap:not(.dragging) { transition: none; } }
    .pill.alert { border-color: var(--warn); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
    .dot.ok { background: var(--ok); box-shadow: var(--dot-ok-glow); }
    .dot.warn { background: var(--warn); box-shadow: var(--dot-warn-glow); }

    /* ── Panel: cabecera fija + cuerpo con scroll + pie fijo ── */
    .panel {
      position: relative; width: 364px; max-width: calc(100vw - 24px); max-height: min(560px, calc(100vh - 100px));
      overflow: hidden; display: flex; flex-direction: column; border-radius: 16px;
    }
    .panel::before { /* filo de neón superior */
      content: ""; position: absolute; left: 0; right: 0; top: 0; height: 2px; z-index: 1;
      background: linear-gradient(90deg, var(--accent), var(--accent2));
    }
    .head {
      flex: none; display: flex; justify-content: space-between; align-items: center; gap: 8px;
      padding: 12px 16px 6px; touch-action: none;
    }
    .head .ttl { min-width: 0; flex: 1; }
    .head strong { display: block; font-size: 12px; letter-spacing: .02em; white-space: nowrap; }
    .head .sub { display: block; font-size: 10px; color: var(--muted); letter-spacing: .08em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tools { display: flex; align-items: center; gap: 4px; flex: none; }
    .head button, .head .seg button { padding: 2px 6px; font-size: 10px; }
    .seg { border-radius: 6px; }
    .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    .seg button { border: 0; border-radius: 0; padding: 3px 8px; font-size: 11px; font-weight: 700; letter-spacing: .06em; color: var(--muted); }
    .seg button.on { background: var(--accent); color: var(--accent-fg); }
    .icon { padding: 3px 8px; line-height: 1.2; }
    .body {
      flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow-x: hidden; overflow-y: auto;
      overscroll-behavior: contain; padding: 2px 16px 10px; scrollbar-width: none;
    }
    .body::-webkit-scrollbar { display: none; }
    .body > * { flex: none; }
    .body > .srvsec { flex: 0 1 auto; min-height: 0; display: flex; flex-direction: column; }
    .body > .logsec { flex: 0 10 auto; min-height: 0; display: flex; flex-direction: column; }
    .foot {
      flex: none; padding: 8px 16px 9px; border-top: 1px solid var(--line); background: var(--bg);
      text-align: center; font-size: 11px; color: var(--muted); letter-spacing: .04em;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .muted { color: var(--muted); font-size: 12px; }
    .sec { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
    .sec.first { margin-top: 0; padding-top: 0; border-top: 0; }
    .sec p.muted { margin: 0; }
    .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: .12em; color: var(--muted); font-weight: 600; white-space: nowrap; }
    ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; }

    /* Lista de MCP: cada fila con altura propia (no se aplasta); con 4 o más, scroll interno */
    ul.srvs { grid-auto-rows: min-content; align-content: start; flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
    ul.srvs.scroll { max-height: 150px; padding-right: 6px; }
    li.srv {
      display: flex; gap: 10px; align-items: center; min-height: 40px; box-sizing: border-box; padding: 4px 10px;
      background: var(--soft); border: 1px solid var(--row-line); border-radius: 10px;
    }
    li.srv .grow { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 4px; }
    li.srv .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
    li.srv .grow .muted { flex: none; white-space: nowrap; }

    .row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
    .row button { flex: 1 1 auto; white-space: nowrap; }
    .actions button { font-size: 12px; padding: 6px 9px; }
    .actions .primary { flex-grow: 2; }
    button { font: inherit; cursor: pointer; border-radius: 9px; padding: 6px 12px; border: 1px solid var(--line); background: transparent; color: var(--fg); line-height: 1.3; transition: border-color .12s, background .12s; }
    button:hover:not(:disabled) { border-color: var(--accent); background: var(--soft); }
    button.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; font-weight: 700; }
    button.primary:hover:not(:disabled) { background: var(--accent); filter: brightness(1.1); }
    button.danger { color: var(--err); }
    button:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    button:disabled { opacity: .5; cursor: default; }

    .bridge .state { display: inline-flex; gap: 6px; align-items: center; min-width: 0; white-space: nowrap; }
    .bridge .row { margin-top: 8px; }
    .bridge .row button { flex: 1 1 0; }
    .bridge .row + .perm { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--line); }

    .card { margin: 0 0 12px; padding: 12px; border: 1px solid var(--warn); border-radius: 12px; background: var(--soft); }
    .card pre {
      margin: 8px 0; padding: 8px 10px; max-height: 140px; overflow: auto; white-space: pre-wrap; word-break: break-word;
      background: var(--bg2); border-radius: 8px; font: 12px/1.4 ui-monospace, Menlo, Consolas, monospace;
    }
    .approvals .queue { margin: -4px 0 12px; text-align: center; }
    .panel.has-approval .card pre { max-height: 96px; }

    /* Registro: filas con aire, separador fino e hora atenuada */
    ul.log { display: block; flex: 1 1 auto; min-height: 0; max-height: 104px; overflow-y: auto; overscroll-behavior: contain; padding-right: 6px; font-size: 12px; line-height: 1.45; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
    ul.log li { padding: 5px 0; border-bottom: 1px solid var(--row-line); overflow-wrap: anywhere; }
    ul.log li:first-child { padding-top: 0; }
    ul.log li:last-child { border-bottom: 0; padding-bottom: 0; }
    ul.log .ts { color: var(--muted); font-variant-numeric: tabular-nums; margin-right: 6px; opacity: .85; }
    ul.log .msg { color: var(--muted); }
    ul.log li.err .msg { color: var(--err); }
    ul.log li.ok .msg { color: var(--ok); }
    ul.log::-webkit-scrollbar, ul.srvs::-webkit-scrollbar { width: 5px; }
    ul.log::-webkit-scrollbar-track, ul.srvs::-webkit-scrollbar-track { background: transparent; }
    ul.log::-webkit-scrollbar-thumb, ul.srvs::-webkit-scrollbar-thumb { background: var(--line); border-radius: 4px; }
    ul.log::-webkit-scrollbar-thumb:hover, ul.srvs::-webkit-scrollbar-thumb:hover { background: var(--muted); }
    .seg.tabs { margin-top: 10px; }
    ul.log.files { max-height: 160px; }
    ul.log.files li { display: flex; flex-direction: column; gap: 1px; }
    ul.log.files .path { font-size: 11px; word-break: break-all; }
    ul.log.files .add { color: var(--ok); font-weight: 700; }
    ul.log.files .rem { color: var(--err); font-weight: 700; }
    .approvals { flex: none; }
    .log { font-size: 12px; color: var(--muted); }
    .log .err { color: var(--err); } .log .ok { color: var(--ok); }
    .perm { display: flex; gap: 8px; align-items: center; justify-content: space-between; font-size: 12px; min-height: 26px; }
    .perm + .perm { margin-top: 10px; }
    select { font: inherit; font-size: 12px; padding: 4px 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--field); color: var(--fg); cursor: pointer; flex: none; max-width: 128px; }
    select.allow { border-color: var(--ok); } select.deny { border-color: var(--err); }
  `;

  const MAX_LOGS = 200;

  class Widget {
    constructor(handlers) {
      this.handlers = handlers;
      this.model = { adapterName: '', servers: [], toolCount: 0, injection: 'none', bridgeEnabled: true, bridge: null, bridgeBusy: null, responseDelayMs: 1500, language: 'en', theme: 'dark' };
      this.logs = [];
      this.approvals = [];
      this.fileOps = [];          // registro de archivos tocados en esta instancia
      this.tab = 'servers';       // 'servers' | 'files'
      this.open = false;
      this.selectFocusedAt = 0;

      // Evitar duplicados: al recargar la extension quedaban hosts viejos
      // y se veian varios panels/pills a la vez. Shadow DOM cerrado => el
      // id no se ve desde fuera, asi que hay que buscar por atributo id via
      // la raiz del documento (los hosts viven document.documentElement).
      for (const el of Array.from(document.documentElement.children)) {
        if (el.id === 'wmb-host' || el.getAttribute?.('id') === 'wmb-host') el.remove();
      }
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
    // La pill (o la cabecera del panel abierto) es el asa. La posición se recuerda por URL en sessionStorage; doble clic en la pill la resetea.
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

    /** Registra una operacion de archivo con el diff que devolvio el MCP. */
    recordFileOp(server, name, args, text) {
      const m = /\[WMB_DIFF path=(.*?) op=(\w+) added=(\d+) removed=(\d+)\]/.exec(text || '');
      if (!m) return;
      this.fileOps.unshift({
        ts: new Date(), server, name, op: m[2],
        path: m[1], added: Number(m[3]), removed: Number(m[4]),
      });
      this.fileOps.length = Math.min(this.fileOps.length, 200);
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
      const detecting = Boolean(this.model.detecting);
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
      h('i', { class: `dot ${detecting ? 'warn' : pending ? 'warn' : allUp && this.model.bridgeEnabled ? 'ok' : ''}` }),
      h('span', {}, detecting ? (this.model.language === 'es' ? 'Detectando herramienta… esperando a que termine' : 'Tool detected… waiting for it to finish')
        : pending ? trp('wd.pending', pending) : activeLabel));

      const bodyScroll = this.root.querySelector('.body')?.scrollTop ?? 0;
      const srvScroll = this.root.querySelector('ul.srvs')?.scrollTop ?? 0;
      const logScroll = this.root.querySelector('ul.log')?.scrollTop ?? 0;
      // Con el panel abierto la píldora desaparece (el panel ocupa su lugar); la ✕ vuelve a mostrarla.
      this.root.replaceChildren(this.open ? this.#panel() : pill);
      const body = this.root.querySelector('.body');
      if (body && bodyScroll) body.scrollTop = bodyScroll;
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

      const serversSection = h('div', { class: 'sec first srvsec' },
        this.#tabsSection(),
        this.tab === 'servers'
          ? (servers.length
            ? h('ul', { class: `srvs${servers.length >= 2 ? ' scroll' : ''}` }, servers.map((s) => {
              const info = s.permission === 'deny' ? tr('wd.blocked') : s.status === 'connected' ? tr('wd.toolsShort', { n: s.toolCount }) : tr('wd.noConn');
              return h('li', { class: 'srv' },
                h('i', { class: `dot ${s.status === 'connected' ? 'ok' : s.status === 'connecting' ? 'warn' : ''}` }),
                h('span', { class: 'grow' }, h('span', { class: 'nm', title: s.name }, s.name), h('span', { class: 'muted' }, info)),
                this.#permSelect(s.permission, (value) => this.handlers.onSetPermission(s.id, value), tr('p.srv.permAria', { name: s.name })));
            }))
            : h('p', { class: 'muted' }, tr('wd.noServers')))
          : this.#filesSection());

      const injectSection = h('div', { class: 'sec' },
        h('p', { class: 'muted' }, injectionText),
        h('div', { class: 'row actions' },
          h('button', { class: 'primary', onclick: () => this.handlers.onInject() }, tr('wd.inject')),
          h('button', { onclick: () => this.handlers.onRefresh() }, tr('wd.refresh')),
          h('button', { title: tr('wd.rescanTip'), onclick: () => this.handlers.onRescan?.() }, tr('wd.rescan'))));

      const logSection = this.logs.length
        ? h('div', { class: 'sec logsec' },
          h('ul', { class: 'log' }, this.logs.map((l) => h('li', { class: l.kind },
            h('span', { class: 'ts' }, l.ts.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
            h('span', { class: 'msg' }, l.text)))))
        : null;

      return h('div', { class: `panel${this.approvals.length ? ' has-approval' : ''}`, role: 'dialog', 'aria-label': 'Web MCP Bridge' },
        this.#headSection(),
        h('div', { class: 'body' },
          this.#approvalSection(),
          serversSection,
          this.#bridgeSection(),
          injectSection,
          logSection),
        h('div', { class: 'foot' }, `Web MCP Bridge v${WMB.VERSION} · Github: @AstraxOf`));
    }

    /** Pestañas: Servidores / Archivos. */
    #tabsSection() {
      const tab = (id, label) => h('button', {
        class: this.tab === id ? 'on' : '',
        'aria-pressed': String(this.tab === id),
        onclick: () => { this.tab = id; this.render(true); },
      }, label);
      return h('div', { class: 'seg tabs', role: 'group', 'aria-label': 'Panel' },
        tab('servers', this.model.language === 'es' ? 'Servidores' : 'Servers'),
        tab('files', `${this.model.language === 'es' ? 'Archivos' : 'Files'}${this.fileOps.length ? ` (${this.fileOps.length})` : ''}`));
    }

    /** Historial de archivos tocados en esta instancia del chat. */
    #filesSection() {
      if (!this.fileOps.length) {
        return h('p', { class: 'muted' }, this.model.language === 'es'
          ? 'Aun no se修改o ningun archivo en este chat.'
          : 'No files changed in this chat yet.');
      }
      const locale = this.model.language === 'es' ? 'es' : 'en';
      return h('ul', { class: 'log files' }, this.fileOps.map((f) => h('li', { class: 'ok' },
        h('div', {}, `${f.ts.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${f.op} · ${f.name}`),
        h('div', { class: 'muted path' }, f.path),
        h('div', {},
          h('span', { class: 'add' }, `+${f.added}`),
          ' ',
          h('span', { class: 'rem' }, `-${f.removed}`),
          ` ${this.model.language === 'es' ? 'lineas' : 'lines'}`))));
    }

    /** La aprobación va SIEMPRE arriba del cuerpo para que sus botones nunca queden fuera del panel. */
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

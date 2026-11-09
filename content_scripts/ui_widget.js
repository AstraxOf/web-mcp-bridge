/**
 * ui_widget.js — Floating panel inside the page (Shadow DOM, no style conflicts).
 *
 * Shows the state of active MCPs, lets you inject the instructions and choose each MCP's
 * permission (always allow · always ask · do not allow). With "ask" it requests
 * APPROVAL before every tool (human-in-the-loop).
 *
 * CSS lives in ui_widget_css.js (WMB.WIDGET_CSS); panel and approval rendering live in
 * ui_widget_panels.js (WMB.widgetPanel / WMB.widgetApprovalCard / WMB.widgetPermSelect).
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

  class Widget {
    constructor(handlers) {
      this.handlers = handlers;
      this.model = { adapterName: '', servers: [], toolCount: 0, injection: 'none', bridgeEnabled: true };
      this.logs = [];
      this.approvals = [];
      this.open = false;
      this.selectFocusedAt = 0;
      this._h = h;

      this.host = document.createElement('div');
      this.host.id = 'wmb-host';
      this.shadow = this.host.attachShadow({ mode: 'closed' });
      this.root = h('div', { class: 'wrap' });
      this.shadow.append(h('style', {}, WMB.WIDGET_CSS), this.root);
      document.documentElement.append(this.host);
      this.#initDrag();
      this.render();
    }

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
      try { sessionStorage.setItem(this.#posKey(), JSON.stringify({ x, y })); } catch { /* storage unavailable */ }
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
          try { this.#applyPosition(JSON.parse(raw)); } catch { /* ignore */ }
        }, { passive: true });
      });
      this.root.addEventListener('pointerdown', (e) => this.#onPointerDown(e));
      this.root.addEventListener('dblclick', (e) => {
        if (e.target.closest('.pill')) this.#resetPosition();
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
      try { handle.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
      const onMove = (ev) => {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
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
      this.logs.length = Math.min(this.logs.length, 6);
      this.render();
    }

    requestApproval(call) {
      return new Promise((resolve) => {
        this.approvals.push({ call, resolve });
        this.open = true;
        this.render(true);
      });
    }

    render(force = false) {
      if (!force && this.shadow.activeElement?.tagName === 'SELECT' && Date.now() - this.selectFocusedAt < 6000) return;
      const { servers, toolCount } = this.model;
      const pending = this.approvals.length;
      const activeLabel = !this.model.bridgeEnabled ? 'Bridge disabled' : servers.length
        ? `${servers.length} MCP · ${toolCount} tools`
        : 'No active MCP';
      const allUp = servers.length > 0 && servers.every((s) => s.status === 'connected');
      const pill = h('button', {
        class: `pill${pending ? ' alert' : ''}`,
        'aria-expanded': String(this.open),
        onclick: () => { if (this._suppressClickUntil && Date.now() < this._suppressClickUntil) return; this.open = !this.open; this.render(); },
      },
      h('i', { class: `dot ${pending ? 'warn' : allUp && this.model.bridgeEnabled ? 'ok' : ''}` }),
      h('span', {}, pending ? `${pending} call${pending > 1 ? 's' : ''} awaiting approval` : activeLabel));
      this.root.replaceChildren(...(this.open ? [WMB.widgetPanel(this)] : []), pill);
      if (this.open) requestAnimationFrame(() => this.#fitToViewport());
    }
  }

  WMB.Widget = Widget;
})();

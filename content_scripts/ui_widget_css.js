/** ui_widget_css.js - CSS for the floating widget (kept separate for size). */
(() => {
  'use strict';
  const WMB = globalThis.WMB;
  WMB.WIDGET_CSS = `
    :host { all: initial; }
    .wrap {
      --bg:#ffffff; --fg:#16211d; --muted:#67736d; --line:#dde2dc; --accent:#0f766e; --accent-fg:#fff;
      --ok:#16a34a; --warn:#d97706; --err:#dc2626;
      position: fixed; left: var(--x, 16px); top: var(--y, auto); bottom: var(--y, 16px); z-index: 2147483647;
      touch-action: none; user-select: none;
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg);
      display: flex; flex-direction: column; gap: 8px; align-items: flex-start;
    }
    @media (prefers-color-scheme: dark) {
      .wrap { --bg:#1b2326; --fg:#e6ece9; --muted:#91a09a; --line:#2c373b; --accent:#2dd4bf; --accent-fg:#062a27; }
    }
    .pill, .panel { background: var(--bg); border: 1px solid var(--line); box-shadow: 0 6px 24px rgba(0,0,0,.18); }
    .pill { display: flex; gap: 8px; align-items: center; padding: 7px 12px; border-radius: 999px; cursor: grab; color: inherit; font: inherit; }
    .wrap.dragging .pill { cursor: grabbing; }
    .wrap.dragging { transition: none !important; }
    .wrap:not(.dragging) { transition: left .12s ease, top .12s ease; }
    .wrap.flip { flex-direction: column-reverse; }
    .wrap.flip .panel { margin-bottom: 4px; }
    @media (prefers-reduced-motion: reduce) { .wrap:not(.dragging) { transition: none; } }
    .panel { max-width: calc(100vw - 24px); max-height: min(70vh, calc(100vh - 40px)); }
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
    .card pre { margin: 6px 0; padding: 8px; max-height: 140px; overflow: auto; white-space: pre-wrap; word-break: break-word; background: rgba(127,127,127,.12); border-radius: 6px; font: 12px/1.4 ui-monospace, Menlo, Consolas, monospace; }
    .log { font-size: 12px; color: var(--muted); }
    .log .err { color: var(--err); } .log .ok { color: var(--ok); }
    .perm { display: flex; gap: 8px; align-items: center; justify-content: space-between; margin-top: 10px; font-size: 12px; }
    select { font: inherit; font-size: 12px; padding: 4px 6px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); cursor: pointer; }
    select.allow { border-color: var(--ok); } select.deny { border-color: var(--err); }
    li.srv .grow { flex: 1; min-width: 0; }
    .foot { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--line); text-align: center; font-size: 11px; color: var(--muted); }
  `;
})();

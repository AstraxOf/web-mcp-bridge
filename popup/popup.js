/**
 * popup.js - Extension control panel (entry point).
 *
 * MCP servers are defined in server/servers.json (the extension auto-detects them):
 * here they are only enabled, given permission, and tested. The panel can open that
 * file and restart the bridge. Cards are reused across refreshes (not recreated), so
 * transitions animate instead of jumping.
 *
 * Implementation lives in sibling modules, all sharing state via window.POPUP:
 *   popup_shared.js, popup_bridge.js, popup_servers.js, popup_notices.js,
 *   popup_history.js, popup_settings.js
 */
import './popup_shared.js';
import { renderBridge, bindBridgeEvents } from './popup_bridge.js';
import { renderServers, renderGlobalPermission, bindPermissionEvents } from './popup_servers.js';
import { renderNotices, bindNoticesEvents } from './popup_notices.js';
import { renderHistory, bindHistoryEvents } from './popup_history.js';
import { renderSettings, bindSettingsEvents } from './popup_settings.js';

const P = window.POPUP;
const { $, api, toast, guard } = P;

// ─── Tabs ───
const tabsBar = $('.tabs');
const ink = $('.tab-ink');
function moveInk() {
  const selected = tabsBar.querySelector('[aria-selected="true"]');
  if (!selected) return;
  ink.style.width = `${selected.offsetWidth}px`;
  ink.style.transform = `translateX(${selected.offsetLeft}px)`;
}
moveInk();
requestAnimationFrame(() => requestAnimationFrame(() => tabsBar.classList.add('ready')));

for (const btn of document.querySelectorAll('.tabs button')) {
  btn.addEventListener('click', () => {
    P.currentTab = btn.dataset.tab;
    for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b === btn));
    for (const section of document.querySelectorAll('main > section')) section.hidden = section.id !== `tab-${P.currentTab}`;
    moveInk();
    P.historySig = '';
    P.refresh(true);
  });
}

// ─── Refresh loop ───
document.addEventListener('focusin', (e) => { if (e.target.matches?.('select')) P.selectFocusedAt = Date.now(); });

P.refresh = async function refresh(force = false) {
  if (!force && document.activeElement?.matches('input[type="text"], input[type="number"]')) return;
  if (!force && document.activeElement?.matches('select') && Date.now() - P.selectFocusedAt < 6000) return;
  try {
    const state = await api('GET_STATE');
    P.latest = state;
    const sig = JSON.stringify([state.version, state.notices, state.settings, state.bridge,
      state.servers.map((s) => [s.id, s.name, s.url, s.enabled, s.permission, s.status, s.toolCount, s.auto, s.error, s.bridgeStatus, s.bridgeError])]);
    if (force || sig !== P.lastSig) {
      P.lastSig = sig;
      renderBridge(state);
      renderServers(state);
      renderGlobalPermission(state.servers);
      renderSettings(state);
      renderNotices(state);
    }
    if (P.currentTab === 'history') await renderHistory();
  } catch (err) { toast(err.message); }
};

// ─── Bind events ───
bindBridgeEvents();
bindPermissionEvents();
bindNoticesEvents();
bindHistoryEvents();
bindSettingsEvents();

// Re-export helpers so modules loaded later can call them via window.POPUP.
P.renderHistory = renderHistory;

P.refresh(true);
setInterval(P.refresh, 1500);

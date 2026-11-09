import { MAX_ACTIVE_SERVERS, RECOMMENDED_ACTIVE_SERVERS, PERMISSIONS, PERMISSION_LABELS, DEMO_SERVER } from '../shared/constants.js';

const P = window.POPUP = window.POPUP || {};
Object.assign(P, { MAX_ACTIVE_SERVERS, RECOMMENDED_ACTIVE_SERVERS, PERMISSIONS, PERMISSION_LABELS, DEMO_SERVER });

P.STATUS_TEXT = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Disconnected (retrying)',
  error: 'Connection error',
};
P.DEMO_TOOL = 'info_sistema';
P.LEVEL_TEXT = { info: 'News', update: 'New version', warning: 'Important' };
P.ICONS = {
  trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>',
  power: '<svg viewBox="0 0 24 24"><path d="M12 3v9"/><path d="M6.4 6.6a8 8 0 1 0 11.2 0"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>',
};
for (const el of document.querySelectorAll('.ico[data-ico]')) el.innerHTML = P.ICONS[el.dataset.ico] ?? '';

P.$ = (sel, root = document) => root.querySelector(sel);
P.latest = null;
P.cards = new Map();
P.demoOutputs = new Map();
P.noticesSig = '';
P.historySig = '';
P.lastSig = '';
P.currentTab = 'servers';
P.selectFocusedAt = 0;
P.restarting = false;
P.opening = false;
P.togglingBridge = false;

P.api = async function (type, payload = {}) {
  let res;
  try { res = await chrome.runtime.sendMessage({ type, ...payload }); }
  catch (err) { throw new Error(err.message); }
  if (!res?.ok) throw new Error(res?.error ?? 'Unknown error.');
  return res;
};

P.toast = function (message, ms = 3200) {
  const el = P.$('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(P.toast.timer);
  P.toast.timer = setTimeout(() => el.classList.remove('show'), ms);
};

P.guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (err) { P.toast(err.message); }
  await P.refresh(true);
};

P.openLink = function (url) {
  try { if (new URL(url).protocol === 'https:') chrome.tabs.create({ url }); } catch { /* invalid link */ }
};

P.setLabel = (btn, text) => { btn.querySelector('span:not(.ico)').textContent = text; };
P.setBusy = (btn, busy) => { btn.disabled = busy; btn.classList.toggle('busy', busy); };

P.isDemo = function (server) {
  if (String(server.name).toLowerCase() === 'demo') return true;
  try { return new URL(server.url).port === new URL(P.DEMO_SERVER.url).port; } catch { return false; }
};

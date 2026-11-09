const P = window.POPUP;
const { $, api, toast, guard, openLink } = P;

export function renderSettings(state) {
  const s = state.settings;
  $('#master').checked = s.bridgeEnabled;
  $('#master-label').textContent = s.bridgeEnabled ? 'Enabled' : 'Disabled';
  $('#main').classList.toggle('off', !s.bridgeEnabled);
  if (document.activeElement?.id !== 'set-maxResultChars') $('#set-maxResultChars').value = s.maxResultChars;
  $('#set-autoInject').checked = s.autoInject;
  $('#set-autoSend').checked = s.autoSend;
  $('#set-reminder').checked = s.reminder;
  $('#set-autoDiscover').checked = s.autoDiscover !== false;
  $('#set-autoEnableDiscovered').checked = Boolean(s.autoEnableDiscovered);
  $('#set-focusFallback').checked = s.focusFallback;
  $('#set-showNotices').checked = s.showNotices !== false;
  if (document.activeElement?.id !== 'set-reinjectEvery') $('#set-reinjectEvery').value = s.reinjectEvery;
  $('#version').textContent = state.version ? `v${state.version}` : '';
  $('#version-line').textContent = state.version ? `Web MCP Bridge v${state.version}` : '';
}

export function bindSettingsEvents() {
  $('#gh-link').addEventListener('click', (e) => { e.preventDefault(); openLink('https://github.com/AstraxOf'); });
  $('#master').addEventListener('change', guard((e) => api('UPDATE_SETTINGS', { settings: { bridgeEnabled: e.target.checked } })));
  for (const key of ['autoInject','autoSend','reminder','focusFallback','autoDiscover','autoEnableDiscovered','showNotices']) {
    $(`#set-${key}`).addEventListener('change', guard((e) => api('UPDATE_SETTINGS', { settings: { [key]: e.target.checked } })));
  }
  $('#set-reinjectEvery').addEventListener('change', guard((e) => {
    const v = Math.min(100, Math.max(0, Math.round(Number(e.target.value)) || 0));
    return api('UPDATE_SETTINGS', { settings: { reinjectEvery: v } });
  }));
  $('#discover-now').addEventListener('click', guard(async () => {
    const res = await api('DISCOVER', { reset: true });
    toast(res.added ? `Detected ${res.added} new server(s).` : 'Servers up to date.');
  }));
  $('#set-maxResultChars').addEventListener('change', guard((e) => {
    const v = Math.min(100000, Math.max(500, Number(e.target.value) || 12000));
    return api('UPDATE_SETTINGS', { settings: { maxResultChars: v } });
  }));
}

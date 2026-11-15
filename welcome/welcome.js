/**
 * welcome.js — asistente de primer arranque.
 *
 * 1) Primera pantalla: SOLO la elección de idioma (English por defecto · Español).
 * 2) Al pulsar «Continue/Continuar» se guarda el idioma y aparece la bienvenida de siempre, que consulta el estado
 *    cada 1,5 s y deja controlar el puente.
 */
const WMB = globalThis.WMB; // shared/i18n.js se carga antes (script clásico)
const t = (key, vars) => WMB.t(key, vars);
const tp = (key, n, vars) => WMB.tp(key, n, vars);
const $ = (selector) => document.querySelector(selector);

let busy = false;
let latest = null;
let chosen = 'en';
let loopStarted = false;

async function send(type, extra = {}) {
  try { return (await chrome.runtime.sendMessage({ type, ...extra })) ?? { ok: false, error: t('w.noResponse') }; }
  catch (err) { return { ok: false, error: err.message }; }
}

function showMessage(text) {
  const el = $('#bridge-msg');
  el.hidden = !text;
  el.textContent = text ?? '';
}

// ───────────────────────── Idioma ─────────────────────────

function showScreen(name) {
  $('#lang-screen').hidden = name !== 'lang';
  $('#wizard').hidden = name !== 'wizard';
}

function paintLanguage() {
  WMB.i18n.apply();
  for (const card of document.querySelectorAll('.lang-card')) card.setAttribute('aria-checked', String(card.dataset.lang === chosen));
  for (const btn of document.querySelectorAll('#lang-seg button')) {
    const on = btn.dataset.lang === chosen;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  if (latest) render(latest);
}

function selectLanguage(code) {
  chosen = WMB.i18n.setLang(code);
  paintLanguage();
}

for (const card of document.querySelectorAll('.lang-card')) card.addEventListener('click', () => selectLanguage(card.dataset.lang));

$('#lang-continue').addEventListener('click', async () => {
  $('#lang-continue').disabled = true;
  await send('UPDATE_SETTINGS', { settings: { language: chosen, languageChosen: true } });
  $('#lang-continue').disabled = false;
  showScreen('wizard');
  startLoop();
});

// Cambio de idioma desde la propia bienvenida (ya dentro del asistente)
for (const btn of document.querySelectorAll('#lang-seg button')) {
  btn.addEventListener('click', async () => {
    selectLanguage(btn.dataset.lang);
    await send('UPDATE_SETTINGS', { settings: { language: chosen, languageChosen: true } });
  });
}

// ───────────────────────── Asistente ─────────────────────────

function render(state) {
  const b = state.bridge ?? {};
  const servers = state.servers ?? [];
  const launcher = Boolean(b.launcherOnline);

  $('#step-launcher').dataset.state = launcher ? 'done' : 'current';
  $('#launcher-status').textContent = t(launcher ? 'w.s1.ok' : 'w.s1.no');
  $('#launcher-help').hidden = launcher;

  $('#step-bridge').dataset.state = !launcher ? 'pending' : (b.online ? 'done' : 'current');
  $('#bridge-status').textContent = !b.checked ? t('w.s2.checking') : (b.online ? t('w.s2.on') : t(b.paused ? 'w.s2.paused' : 'w.s2.off'));
  $('#btn-start').disabled = busy || !launcher || Boolean(b.online);
  $('#btn-restart').disabled = busy || !launcher || !b.online;
  $('#btn-stop').disabled = busy || !launcher || !b.online;

  const list = $('#server-list');
  list.replaceChildren(...servers.map((s) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = s.name;
    const tag = document.createElement('span');
    tag.className = 'tag' + (s.status === 'connected' ? ' on' : '');
    tag.textContent = s.status === 'connected' ? t('w.tag.connected') : (s.enabled ? t('w.tag.active') : t('w.tag.off'));
    li.append(name, tag);
    return li;
  }));
  const hasServers = b.online && servers.length > 0;
  $('#step-servers').dataset.state = !b.online ? 'pending' : (hasServers ? 'done' : 'current');
  $('#servers-status').textContent = !b.online ? '' : (hasServers ? tp('w.s3.found', servers.length) : t('w.s3.none'));
  $('#btn-config').disabled = !b.online;
  $('#step-ready').dataset.state = hasServers ? 'current' : 'pending';
}

async function refresh() {
  const state = await send('GET_STATE');
  if (state?.ok === false) return;
  await send('PROBE_BRIDGE'); // refresca tambien el estado del lanzador
  latest = await send('GET_STATE');
  render(latest);
}

function startLoop() {
  if (loopStarted) return;
  loopStarted = true;
  refresh();
  setInterval(refresh, 1500);
}

async function run(type, okKey) {
  if (busy) return;
  busy = true;
  showMessage(t('w.wait'));
  if (latest) render(latest);
  const res = await send(type);
  busy = false;
  showMessage(res.ok ? t(okKey) : (res.error ?? t('w.failed')));
  await refresh();
}

$('#btn-start').addEventListener('click', () => run('START_BRIDGE', 'w.started'));
$('#btn-restart').addEventListener('click', () => run('RESTART_BRIDGE', 'w.restarted'));
$('#btn-stop').addEventListener('click', () => run('STOP_BRIDGE', 'w.stopped'));
$('#btn-config').addEventListener('click', async () => {
  const res = await send('OPEN_CONFIG');
  showMessage(res.ok ? t('w.opening') : (res.error ?? t('w.openFail')));
});
$('#copy-cmd').addEventListener('click', async (event) => {
  try { await navigator.clipboard.writeText($('#cmd-text').textContent); event.currentTarget.textContent = t('common.copied'); }
  catch { event.currentTarget.textContent = t('common.copyManual'); }
});

// ───────────────────────── Arranque ─────────────────────────

(async () => {
  const params = new URLSearchParams(location.search);
  const state = await send('GET_STATE');
  const settings = state?.settings;
  if (settings) WMB.i18n.setTheme(settings.theme);
  // La pantalla de idioma va SIEMPRE primero en la instalación; desde «Abrir guía» (?guide=1) o si ya se eligió, se salta.
  const needLanguage = !params.has('guide') && !settings?.languageChosen;
  chosen = needLanguage ? 'en' : WMB.i18n.setLang(settings?.language ?? 'en');
  if (needLanguage) WMB.i18n.setLang('en');
  paintLanguage();
  if (needLanguage) { showScreen('lang'); return; }
  showScreen('wizard');
  startLoop();
})();

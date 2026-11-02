/** welcome.js - asistente de primer arranque. Consulta el estado cada 1,5 s y deja controlar el puente. */
const $ = (selector) => document.querySelector(selector);
let busy = false;
let latest = null;

async function send(type) {
  try { return (await chrome.runtime.sendMessage({ type })) ?? { ok: false, error: 'Sin respuesta de la extensi\u00f3n.' }; }
  catch (err) { return { ok: false, error: err.message }; }
}

function showMessage(text) {
  const el = $('#bridge-msg');
  el.hidden = !text;
  el.textContent = text ?? '';
}

function render(state) {
  const b = state.bridge ?? {};
  const servers = state.servers ?? [];
  const launcher = Boolean(b.launcherOnline);

  $('#step-launcher').dataset.state = launcher ? 'done' : 'current';
  $('#launcher-status').textContent = launcher ? 'Lanzador activo \u2713' : 'No detectado todav\u00eda';
  $('#launcher-help').hidden = launcher;

  $('#step-bridge').dataset.state = !launcher ? 'pending' : (b.online ? 'done' : 'current');
  $('#bridge-status').textContent = !b.checked ? 'Comprobando\u2026' : (b.online ? 'Puente conectado \u2713' : (b.paused ? 'Apagado a prop\u00f3sito' : 'Apagado'));
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
    tag.textContent = s.status === 'connected' ? 'conectado' : (s.enabled ? 'activo' : 'desactivado');
    li.append(name, tag);
    return li;
  }));
  const hasServers = b.online && servers.length > 0;
  $('#step-servers').dataset.state = !b.online ? 'pending' : (hasServers ? 'done' : 'current');
  $('#servers-status').textContent = !b.online ? '' : (hasServers ? `${servers.length} detectado${servers.length === 1 ? '' : 's'} \u2713` : 'Ninguno todav\u00eda');
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

async function run(type, okText) {
  if (busy) return;
  busy = true;
  showMessage('Un momento\u2026');
  if (latest) render(latest);
  const res = await send(type);
  busy = false;
  showMessage(res.ok ? okText : (res.error ?? 'No se pudo completar la acci\u00f3n.'));
  await refresh();
}

$('#btn-start').addEventListener('click', () => run('START_BRIDGE', 'Puente iniciado.'));
$('#btn-restart').addEventListener('click', () => run('RESTART_BRIDGE', 'Puente reiniciado.'));
$('#btn-stop').addEventListener('click', () => run('STOP_BRIDGE', 'Puente apagado.'));
$('#btn-config').addEventListener('click', async () => {
  const res = await send('OPEN_CONFIG');
  showMessage(res.ok ? 'Abriendo servers.json\u2026 guarda el archivo y el puente lo recarga solo.' : (res.error ?? 'No se pudo abrir el archivo.'));
});
$('#copy-cmd').addEventListener('click', async (event) => {
  try { await navigator.clipboard.writeText($('#cmd-text').textContent); event.currentTarget.textContent = 'Copiado \u2713'; }
  catch { event.currentTarget.textContent = 'Selecci\u00f3nalo y copia a mano'; }
});

refresh();
setInterval(refresh, 1500);
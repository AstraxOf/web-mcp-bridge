/**
 * editor.js - Editor de servers.json dentro de la extensión (v1.7.0).
 *
 * Lee y guarda el archivo a través del puente (GET_CONFIG / SAVE_CONFIG en el service worker). El puente valida,
 * deja copia servers.json.bak, escribe de forma atómica y recarga los MCP al instante.
 * Con el puente apagado se puede editar igualmente y descargar el archivo; guardar exige el puente encendido.
 */
const $ = (selector, root = document) => root.querySelector(selector);

/** Envía un mensaje al service worker. Devuelve siempre la respuesta (ok o no) para poder reaccionar a offline / oldBridge. */
async function send(type, payload = {}) {
  try { return (await chrome.runtime.sendMessage({ type, ...payload })) ?? { ok: false, error: 'Sin respuesta de la extensión.' }; } catch (err) { return { ok: false, error: err.message }; }
}

function toast(message, ms = 3600) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), ms);
}

const DEFAULT_TEXT = '{\n  "control_port": 8099,\n  "servers": []\n}\n';
const RESERVED_PORTS = new Set([8098, 8099]);
const TEMPLATES = [
  { label: 'Windows Administrator', name: 'windows-administrator', command: "cmd.exe /d /c 'python -m pip show -q windows-server-mcp >nul 2>&1 || python -m pip install -q windows-server-mcp >nul 2>&1 & python -m windows_server_mcp.server'", hint: 'Se instala solo desde PyPI la primera vez (pip install windows-server-mcp)' },
  { label: 'Memoria', name: 'memoria', command: 'npx -y @modelcontextprotocol/server-memory' },
  { label: 'Fetch (web)', name: 'fetch', command: 'uvx mcp-server-fetch' },
  { label: 'Demo', name: 'demo', command: 'python server/examples/demo_mcp_server.py' },
];

const editor = $('#editor');
const gutter = $('#gutter');
const saveBtn = $('#b-save');
const view = { saved: '', path: '', online: false, bridgeChecked: false, canSave: false, last: null };

// ───────────────────────── Utilidades JSON ─────────────────────────

/** JSON legible: los arreglos cortos de valores simples (como "command") quedan en una sola línea. */
function pretty(value, indent = 0) {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (value.every((x) => x === null || typeof x !== 'object')) {
      const one = `[${value.map((x) => JSON.stringify(x)).join(', ')}]`;
      if (one.length + indent * 2 <= 90) return one;
    }
    return `[\n${value.map((x) => `${pad}  ${pretty(x, indent + 1)}`).join(',\n')}\n${pad}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return '{}';
    return `{\n${keys.map((k) => `${pad}  ${JSON.stringify(k)}: ${pretty(value[k], indent + 1)}`).join(',\n')}\n${pad}}`;
  }
  return JSON.stringify(value);
}

/** Línea (1-based) de un error de JSON.parse, según lo que informe el navegador. */
function errorLine(text, err) {
  const m = /line (\d+) column (\d+)/.exec(err.message);
  if (m) return Number(m[1]);
  const p = /position (\d+)/.exec(err.message);
  if (p) return text.slice(0, Number(p[1])).split('\n').length;
  return null;
}

/** Misma lógica que el puente al arrancar, para avisar antes de guardar. */
function validate(text) {
  const errors = [];
  const warnings = [];
  if (!text.trim()) return { errors: [{ msg: 'El archivo está vacío.' }], warnings, count: 0, data: null };
  let data;
  try { data = JSON.parse(text); } catch (err) {
    return { errors: [{ msg: `JSON mal escrito: ${err.message.replace(/ in JSON at position \d+.*/, '')}`, line: errorLine(text, err) }], warnings, count: 0, data: null };
  }
  const entries = Array.isArray(data) ? data : (data && typeof data === 'object' ? data.servers : null);
  if (!Array.isArray(entries)) return { errors: [{ msg: 'Falta la lista "servers": [ ... ]' }], warnings, count: 0, data };
  const names = new Set();
  const ports = new Map();
  let count = 0;
  entries.forEach((entry, i) => {
    const n = i + 1;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { errors.push({ msg: `El servidor #${n} debe ser un objeto { ... }` }); return; }
    if (entry.disabled || entry.enabled === false) return;
    if (typeof entry.name !== 'string' || !entry.name.trim()) { errors.push({ msg: `El servidor #${n} no tiene "name"` }); return; }
    const label = `"${entry.name}"`;
    if (names.has(entry.name)) errors.push({ msg: `El nombre ${label} está repetido`, name: entry.name });
    names.add(entry.name);
    const cmd = entry.command;
    const okCmd = (typeof cmd === 'string' && cmd.trim()) || (Array.isArray(cmd) && cmd.length && cmd.every((c) => ['string', 'number'].includes(typeof c)));
    if (!okCmd) errors.push({ msg: `${label}: "command" debe ser una lista no vacía, por ejemplo ["python", "mi_mcp.py"]`, name: entry.name });
    const port = Number(entry.port);
    if (entry.port === undefined || entry.port === null || entry.port === '' || !Number.isInteger(port)) errors.push({ msg: `${label}: falta "port" (un número, por ejemplo 8080)`, name: entry.name });
    else if (port < 1 || port > 65535) errors.push({ msg: `${label}: "port" debe estar entre 1 y 65535`, name: entry.name });
    else {
      if (ports.has(port)) warnings.push({ msg: `El puerto ${port} lo usan ${label} y "${ports.get(port)}": solo uno podrá abrirse.`, name: entry.name });
      else ports.set(port, entry.name);
      if (RESERVED_PORTS.has(port)) warnings.push({ msg: `${label}: el puerto ${port} lo usa el puente/lanzador; elige otro.`, name: entry.name });
    }
    if (entry.env && (typeof entry.env !== 'object' || Array.isArray(entry.env))) errors.push({ msg: `${label}: "env" debe ser un objeto { "VARIABLE": "valor" }`, name: entry.name });
    count += 1;
  });
  if (!Array.isArray(data) && data.control_port !== undefined && !Number.isInteger(Number(data.control_port))) errors.push({ msg: '"control_port" debe ser un número' });
  return { errors, warnings, count, data };
}

/** Línea donde aparece "name": "xxx" (para saltar desde la lista de problemas). */
function lineOfName(text, name) {
  const idx = text.indexOf(`"${name}"`);
  return idx < 0 ? null : text.slice(0, idx).split('\n').length;
}

/** Divide un comando escrito como en una terminal: respeta comillas y no toca las barras de Windows. */
function splitCommand(input) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const ch of input.trim()) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; } else if (ch === '"' || ch === "'") { quote = ch; started = true; } else if (/\s/.test(ch)) {
      if (cur || started) { out.push(cur); cur = ''; started = false; }
    } else cur += ch;
  }
  if (quote) throw new Error('Hay unas comillas sin cerrar en el comando.');
  if (cur || started) out.push(cur);
  return out;
}

function parseEnv(text) {
  const env = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) throw new Error(`Variable mal escrita: «${line}». Usa CLAVE=valor.`);
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return env;
}

// ───────────────────────── Estado del editor ─────────────────────────

function updateGutter() {
  const lines = editor.value.split('\n').length;
  if (gutter.dataset.lines !== String(lines)) {
    gutter.dataset.lines = String(lines);
    gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
  }
  gutter.scrollTop = editor.scrollTop;
}

function jumpToLine(line) {
  if (!line) return;
  const lines = editor.value.split('\n');
  const offset = lines.slice(0, line - 1).reduce((sum, l) => sum + l.length + 1, 0);
  editor.focus();
  editor.setSelectionRange(offset, offset + (lines[line - 1]?.length ?? 0));
  editor.scrollTop = Math.max(0, (line - 4) * 20);
}

function renderStatus() {
  const text = editor.value;
  const result = validate(text);
  view.last = result;
  const status = $('#status');
  const issues = $('#issues');
  issues.replaceChildren();
  const all = [...result.errors.map((e) => ({ ...e, kind: 'bad' })), ...result.warnings.map((w) => ({ ...w, kind: 'warn' }))];
  for (const item of all) {
    const li = document.createElement('li');
    li.className = item.kind;
    const line = item.line ?? (item.name ? lineOfName(text, item.name) : null);
    li.textContent = line ? `Línea ${line} · ${item.msg}` : item.msg;
    li.addEventListener('click', () => jumpToLine(line));
    issues.append(li);
  }
  issues.hidden = all.length === 0;

  if (result.errors.length) { status.className = 'status bad'; status.textContent = `✕ ${result.errors.length} error${result.errors.length === 1 ? '' : 'es'}`; } else if (result.warnings.length) {
    status.className = 'status warn';
    status.textContent = `⚠ JSON válido · ${result.count} servidor${result.count === 1 ? '' : 'es'} · ${result.warnings.length} aviso${result.warnings.length === 1 ? '' : 's'}`;
  } else { status.className = 'status ok'; status.textContent = `✓ JSON válido · ${result.count} servidor${result.count === 1 ? '' : 'es'}`; }

  const dirty = text !== view.saved;
  $('#dirty').textContent = dirty ? '● Sin guardar' : 'Guardado';
  $('#dirty').classList.toggle('on', dirty);
  saveBtn.disabled = !(dirty && !result.errors.length && view.canSave);
  saveBtn.title = !view.canSave ? 'Enciende el puente para guardar' : (result.errors.length ? 'Corrige los errores para guardar' : '');
}

function setText(text, { markSaved = false } = {}) {
  editor.value = text;
  if (markSaved) view.saved = text;
  updateGutter();
  renderStatus();
}

const isDirty = () => editor.value !== view.saved;

// ───────────────────────── Carga y guardado ─────────────────────────

function banner(message, kind = 'warn') {
  const el = $('#banner');
  el.hidden = !message;
  el.className = `callout ${kind}`;
  el.textContent = message ?? '';
}

async function load({ keepDraft = false } = {}) {
  const res = await send('GET_CONFIG');
  if (res.ok) {
    view.path = res.path ?? '';
    view.canSave = true;
    $('#path').textContent = view.path;
    banner(null);
    const text = res.text && res.text.trim() ? res.text : DEFAULT_TEXT;
    if (keepDraft && isDirty()) { view.saved = res.text ?? ''; renderStatus(); } else setText(text, { markSaved: true });
    if (!res.text || !res.text.trim()) view.saved = '';
    renderStatus();
    return;
  }
  view.canSave = false;
  if (res.offline) banner('Puente apagado: puedes editar y descargar. Para guardar, enciéndelo.');
  else if (res.oldBridge) banner(res.error, 'bad');
  else banner(res.error ?? 'No se pudo leer servers.json.', 'bad');
  if (!editor.value) setText(DEFAULT_TEXT, { markSaved: true });
  renderStatus();
}

async function save(label = '') {
  const result = validate(editor.value);
  if (result.errors.length) { toast('Corrige los errores antes de guardar.'); return; }
  saveBtn.classList.add('busy');
  saveBtn.disabled = true;
  const res = await send('SAVE_CONFIG', { text: editor.value });
  saveBtn.classList.remove('busy');
  if (res.ok) {
    view.saved = editor.value;
    const parts = [];
    for (const [key, word] of [['started', 'activo(s)'], ['stopped', 'quitado(s)'], ['restarted', 'reiniciado(s)']]) if (Array.isArray(res[key]) && res[key].length) parts.push(`${res[key].length} ${word}`);
    toast(`${label ? `${label} añadido y guardado` : 'Guardado'} ✓ ${parts.length ? `(${parts.join(', ')})` : ''}`, 4000);
    if (res.restart_needed) banner('Cambiaste "control_port": reinicia el puente para que use el puerto nuevo.', 'warn');
  } else {
    toast(res.error ?? 'No se pudo guardar.', 7000);
    if (res.offline || res.oldBridge) { view.canSave = false; await refreshBridge(); }
  }
  renderStatus();
}

function download() {
  const blob = new Blob([editor.value], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: 'servers.json' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ───────────────────────── Añadir / importar MCP ─────────────────────────

/** Documento actual como objeto { servers: [...] }; lanza si el JSON no es válido. */
function currentDoc() {
  const text = editor.value.trim();
  if (!text) return { servers: [] };
  let data;
  try { data = JSON.parse(text); } catch (err) { throw new Error(`El JSON del editor tiene un error (${err.message.replace(/ in JSON at position \d+.*/, '')}). Corrígelo antes de añadir.`); }
  if (Array.isArray(data)) return { servers: data };
  if (!data || typeof data !== 'object') throw new Error('El JSON del editor debe ser un objeto { "servers": [...] }.');
  if (data.servers === undefined) data.servers = [];
  if (!Array.isArray(data.servers)) throw new Error('"servers" debe ser una lista.');
  return data;
}

function nextFreePort(doc, extra = []) {
  const used = new Set([...RESERVED_PORTS, Number(doc.control_port) || 0, ...extra]);
  for (const s of doc.servers) if (s && Number.isInteger(Number(s.port))) used.add(Number(s.port));
  let port = 8080;
  while (used.has(port)) port += 1;
  return port;
}

function uniqueName(doc, wanted, taken) {
  const names = new Set([...doc.servers.map((s) => s?.name), ...taken]);
  if (!names.has(wanted)) return wanted;
  let n = 2;
  while (names.has(`${wanted}-${n}`)) n += 1;
  return `${wanted}-${n}`;
}

/** Tras añadir/importar: guarda al instante si se puede (así el MCP aparece sin pasos extra). */
async function afterAdd(label) {
  if (view.canSave && !validate(editor.value).errors.length) { await save(label); return; }
  toast(`${label} añadido. ${view.canSave ? 'Corrige los errores y pulsa Guardar.' : 'Enciende el puente y pulsa Guardar.'}`, 6000);
}
function addEntries(entries) {
  const doc = currentDoc();
  const addedNames = [];
  const addedPorts = [];
  for (const entry of entries) {
    const port = Number.isInteger(Number(entry.port)) && Number(entry.port) > 0 && !addedPorts.includes(Number(entry.port)) && !doc.servers.some((s) => Number(s?.port) === Number(entry.port))
      ? Number(entry.port) : nextFreePort(doc, addedPorts);
    const name = uniqueName(doc, entry.name, addedNames);
    const { name: _n, port: _p, ...rest } = entry;
    doc.servers.push({ name, port, ...rest });
    addedNames.push(name);
    addedPorts.push(port);
  }
  setText(`${pretty(doc)}\n`);
  editor.scrollTop = editor.scrollHeight;
  return addedNames;
}

/** Convierte lo que el usuario pega (Claude Desktop, Cursor, lista, objeto suelto...) en entradas de servers.json. */
function toEntries(data) {
  let pairs = [];
  if (Array.isArray(data)) pairs = data.map((e) => [e?.name, e]);
  else if (data && typeof data === 'object') {
    if (data.mcpServers && typeof data.mcpServers === 'object') pairs = Object.entries(data.mcpServers);
    else if (data.mcp && data.mcp.servers && typeof data.mcp.servers === 'object') pairs = Object.entries(data.mcp.servers);
    else if (Array.isArray(data.servers)) pairs = data.servers.map((e) => [e?.name, e]);
    else if (data.command !== undefined || data.url !== undefined) pairs = [[data.name, data]];
    else pairs = Object.entries(data).filter(([, v]) => v && typeof v === 'object' && v.command !== undefined);
  }
  if (!pairs.length) throw new Error('No encontré ningún MCP en ese JSON. Debe traer "mcpServers" o un objeto con "command".');
  return pairs.map(([key, raw], i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`El MCP #${i + 1} no es un objeto.`);
    const name = String(raw.name ?? key ?? `mcp-${i + 1}`).trim() || `mcp-${i + 1}`;
    if (raw.command === undefined) throw new Error(`«${name}»: solo se admiten MCP locales que se arrancan con un comando (no URLs remotas).`);
    let command = typeof raw.command === 'string' ? (Array.isArray(raw.args) ? [raw.command] : splitCommand(raw.command)) : raw.command;
    if (!Array.isArray(command) || !command.length) throw new Error(`«${name}»: "command" no es válido.`);
    if (Array.isArray(raw.args)) command = [...command, ...raw.args.map(String)];
    const entry = { name, command };
    if (raw.port !== undefined) entry.port = Number(raw.port);
    if (raw.cwd) entry.cwd = String(raw.cwd);
    if (raw.env && typeof raw.env === 'object') entry.env = raw.env;
    if (raw.disabled) entry.disabled = true;
    return entry;
  });
}

function fail(selector, message) {
  const el = $(selector);
  el.hidden = !message;
  el.textContent = message ?? '';
}

$('#f-add').addEventListener('click', async () => {
  fail('#form-error', null);
  try {
    const name = $('#f-name').value.trim();
    const cmdText = $('#f-cmd').value.trim();
    if (!name) throw new Error('Falta el nombre.');
    if (!cmdText) throw new Error('Falta el comando.');
    const entry = { name, command: splitCommand(cmdText) };
    const port = $('#f-port').value.trim();
    if (port) {
      const p = Number(port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('El puerto debe estar entre 1 y 65535.');
      entry.port = p;
    }
    const cwd = $('#f-cwd').value.trim();
    if (cwd) entry.cwd = cwd.replace(/\\/g, '/');
    const env = parseEnv($('#f-env').value);
    if (Object.keys(env).length) entry.env = env;
    const [added] = addEntries([entry]);
    await afterAdd(`«${added}»`);
    clearForm();
  } catch (err) { fail('#form-error', err.message); }
});

function clearForm() {
  for (const id of ['f-name', 'f-cmd', 'f-cwd', 'f-env']) $(`#${id}`).value = '';
  $('#f-port').value = '';
  suggestPort();
  fail('#form-error', null);
}
$('#f-clear').addEventListener('click', clearForm);

function suggestPort() {
  try { $('#f-port').placeholder = String(nextFreePort(currentDoc())); } catch { $('#f-port').placeholder = '8080'; }
}

$('#import-btn').addEventListener('click', async () => {
  fail('#import-error', null);
  try {
    const raw = $('#import-text').value.trim();
    if (!raw) throw new Error('Pega primero el JSON del MCP.');
    let data;
    try { data = JSON.parse(raw); } catch (err) { throw new Error(`Ese JSON no es válido: ${err.message.replace(/ in JSON at position \d+.*/, '')}`); }
    const added = addEntries(toEntries(data));
    await afterAdd(added.join(', '));
    $('#import-text').value = '';
  } catch (err) { fail('#import-error', err.message); }
});

for (const tpl of TEMPLATES) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip';
  chip.textContent = tpl.label;
  if (tpl.hint) chip.title = tpl.hint;
  chip.addEventListener('click', () => {
    $('#f-name').value = tpl.name;
    $('#f-cmd').value = tpl.command;
    $('#f-cmd').focus();
    suggestPort();
  });
  $('#templates').append(chip);
}

// ───────────────────────── Puente (estado y botones globales) ─────────────────────────

async function refreshBridge() {
  const res = await send('GET_STATE');
  if (!res.ok) return;
  const b = res.bridge ?? {};
  view.online = Boolean(b.online);
  view.bridgeChecked = Boolean(b.checked);
  const dot = $('#bridge-dot');
  dot.className = `dot ${!b.checked ? 'connecting' : (b.online ? 'online' : 'offline')}`;
  $('#bridge-text').textContent = !b.checked ? 'Comprobando…' : (b.online ? `Puente conectado${b.version ? ` v${b.version}` : ''}` : (b.paused ? 'Puente en pausa' : 'Puente apagado'));
  const toggle = $('#bridge-toggle');
  if (!toggle.classList.contains('busy')) {
    toggle.querySelector('span').textContent = b.online ? 'Apagar' : 'Iniciar';
    toggle.disabled = !b.checked || (!b.online && !b.launcherOnline);
    toggle.title = (!b.online && !b.launcherOnline) ? 'Necesita el lanzador: se instala una vez con server/install.cmd' : '';
  }
  const restart = $('#bridge-restart');
  if (!restart.classList.contains('busy')) restart.disabled = !b.checked || (!b.online && !b.launcherOnline);
  $('#version').textContent = res.version ? `v${res.version}` : '';
  $('#version-line').textContent = res.version ? `Web MCP Bridge v${res.version}` : '';

  const couldSave = view.canSave;
  if (b.online && !couldSave && !isDirty()) await load();
  else if (b.online && !couldSave) { view.canSave = true; banner(null); renderStatus(); } else if (!b.online && couldSave) { view.canSave = false; banner('El puente se apagó. Enciéndelo para poder guardar.'); renderStatus(); }
}

async function bridgeAction(btn, action, busyLabel) {
  const label = btn.querySelector('span');
  const old = label.textContent;
  btn.classList.add('busy');
  btn.disabled = true;
  label.textContent = busyLabel;
  const res = await send('BRIDGE_GLOBAL', { action });
  btn.classList.remove('busy');
  label.textContent = old;
  if (!res.ok) toast(res.error ?? 'No se pudo completar la acción.', 7000);
  else toast(action === 'stop' ? 'Puente apagado.' : (action === 'start' ? 'Puente iniciado ✓' : 'Puente reiniciado ✓'));
  await refreshBridge();
  if (action !== 'stop' && res.ok) await load({ keepDraft: true });
}
$('#bridge-toggle').addEventListener('click', (e) => bridgeAction(e.currentTarget, view.online ? 'stop' : 'start', view.online ? 'Apagando…' : 'Iniciando…'));
$('#bridge-restart').addEventListener('click', (e) => bridgeAction(e.currentTarget, 'restart', 'Reiniciando…'));

// ───────────────────────── Eventos del editor ─────────────────────────

editor.addEventListener('input', () => { updateGutter(); renderStatus(); suggestPort(); });
editor.addEventListener('scroll', () => { gutter.scrollTop = editor.scrollTop; });
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    const { selectionStart: s, selectionEnd: end } = editor;
    editor.setRangeText('  ', s, end, 'end');
    editor.dispatchEvent(new Event('input'));
  }
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (!saveBtn.disabled) save(); }
});
saveBtn.addEventListener('click', save);
$('#b-download').addEventListener('click', download);
$('#b-format').addEventListener('click', () => {
  try {
    const data = JSON.parse(editor.value);
    setText(`${pretty(data)}\n`);
  } catch (err) { toast(`No se puede formatear: ${err.message.replace(/ in JSON at position \d+.*/, '')}`); }
});
$('#b-reload').addEventListener('click', async () => {
  if (isDirty() && !confirm('Tienes cambios sin guardar. ¿Recargar desde el disco y perderlos?')) return;
  await load();
  toast('Recargado desde el disco.');
});
window.addEventListener('beforeunload', (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

(async function init() {
  await refreshBridge();
  await load();
  suggestPort();
  setInterval(refreshBridge, 3000);
})();

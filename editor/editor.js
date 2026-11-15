/**
 * editor.js - Editor de servers.json dentro de la extensión (v1.7.0).
 *
 * Lee y guarda el archivo a través del puente (GET_CONFIG / SAVE_CONFIG en el service worker). El puente valida,
 * deja copia servers.json.bak, escribe de forma atómica y recarga los MCP al instante.
 * Con el puente apagado se puede editar igualmente y descargar el archivo; guardar exige el puente encendido.
 */
const WMB = globalThis.WMB; // shared/i18n.js (script clásico que se carga antes que este módulo)
const t = (key, vars) => WMB.t(key, vars);
const tp = (key, n, vars) => WMB.tp(key, n, vars);
const $ = (selector, root = document) => root.querySelector(selector);

/** Envía un mensaje al service worker. Devuelve siempre la respuesta (ok o no) para poder reaccionar a offline / oldBridge. */
async function send(type, payload = {}) {
  try { return (await chrome.runtime.sendMessage({ type, ...payload })) ?? { ok: false, error: t('ed.noResponse') }; } catch (err) { return { ok: false, error: err.message }; }
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
  { label: 'Windows Administrator', name: 'windows-administrator', command: "cmd.exe /d /c 'python -m pip show -q windows-server-mcp >nul 2>&1 || python -m pip install -q windows-server-mcp >nul 2>&1 & python -m windows_server_mcp.server'", hint: 'ed.tpl.winHint' },
  { label: 'ed.tpl.memory', name: 'memory', command: 'npx -y @modelcontextprotocol/server-memory' },
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
  if (!text.trim()) return { errors: [{ msg: t('ed.v.empty') }], warnings, count: 0, data: null };
  let data;
  try { data = JSON.parse(text); } catch (err) {
    return { errors: [{ msg: t('ed.v.badJson', { msg: err.message.replace(/ in JSON at position \d+.*/, '') }), line: errorLine(text, err) }], warnings, count: 0, data: null };
  }
  const entries = Array.isArray(data) ? data : (data && typeof data === 'object' ? data.servers : null);
  if (!Array.isArray(entries)) return { errors: [{ msg: t('ed.v.noList') }], warnings, count: 0, data };
  const names = new Set();
  const ports = new Map();
  let count = 0;
  entries.forEach((entry, i) => {
    const n = i + 1;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { errors.push({ msg: t('ed.v.notObj', { n }) }); return; }
    if (entry.disabled || entry.enabled === false) return;
    if (typeof entry.name !== 'string' || !entry.name.trim()) { errors.push({ msg: t('ed.v.noName', { n }) }); return; }
    const label = `"${entry.name}"`;
    if (names.has(entry.name)) errors.push({ msg: t('ed.v.dupName', { label }), name: entry.name });
    names.add(entry.name);
    const cmd = entry.command;
    const okCmd = (typeof cmd === 'string' && cmd.trim()) || (Array.isArray(cmd) && cmd.length && cmd.every((c) => ['string', 'number'].includes(typeof c)));
    if (!okCmd) errors.push({ msg: t('ed.v.badCmd', { label }), name: entry.name });
    const port = Number(entry.port);
    if (entry.port === undefined || entry.port === null || entry.port === '' || !Number.isInteger(port)) errors.push({ msg: t('ed.v.noPort', { label }), name: entry.name });
    else if (port < 1 || port > 65535) errors.push({ msg: t('ed.v.portRange', { label }), name: entry.name });
    else {
      if (ports.has(port)) warnings.push({ msg: t('ed.v.dupPort', { port, label, other: ports.get(port) }), name: entry.name });
      else ports.set(port, entry.name);
      if (RESERVED_PORTS.has(port)) warnings.push({ msg: t('ed.v.reservedPort', { label, port }), name: entry.name });
    }
    if (entry.env && (typeof entry.env !== 'object' || Array.isArray(entry.env))) errors.push({ msg: t('ed.v.badEnv', { label }), name: entry.name });
    count += 1;
  });
  if (!Array.isArray(data) && data.control_port !== undefined && !Number.isInteger(Number(data.control_port))) errors.push({ msg: t('ed.v.badControl') });
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
  if (quote) throw new Error(t('ed.f.quote'));
  if (cur || started) out.push(cur);
  return out;
}

function parseEnv(text) {
  const env = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) throw new Error(t('ed.f.badEnv', { line }));
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
    li.textContent = line ? t('ed.line', { n: line, msg: item.msg }) : item.msg;
    li.addEventListener('click', () => jumpToLine(line));
    issues.append(li);
  }
  issues.hidden = all.length === 0;

  if (result.errors.length) { status.className = 'status bad'; status.textContent = `✕ ${tp('ed.n.error', result.errors.length)}`; } else if (result.warnings.length) {
    status.className = 'status warn';
    status.textContent = t('ed.st.warn', { servers: tp('ed.n.server', result.count), warnings: tp('ed.n.warning', result.warnings.length) });
  } else { status.className = 'status ok'; status.textContent = t('ed.st.ok', { servers: tp('ed.n.server', result.count) }); }

  const dirty = text !== view.saved;
  $('#dirty').textContent = dirty ? t('ed.unsaved') : t('ed.savedState');
  $('#dirty').classList.toggle('on', dirty);
  saveBtn.disabled = !(dirty && !result.errors.length && view.canSave);
  saveBtn.title = !view.canSave ? t('ed.tip.needBridge') : (result.errors.length ? t('ed.tip.fix') : '');
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
  if (res.offline) banner(t('ed.bn.offline'));
  else if (res.oldBridge) banner(res.error, 'bad');
  else banner(res.error ?? t('ed.bn.readFail'), 'bad');
  if (!editor.value) setText(DEFAULT_TEXT, { markSaved: true });
  renderStatus();
}

async function save(label = '') {
  const result = validate(editor.value);
  if (result.errors.length) { toast(t('ed.toast.fix')); return; }
  saveBtn.classList.add('busy');
  saveBtn.disabled = true;
  const res = await send('SAVE_CONFIG', { text: editor.value });
  saveBtn.classList.remove('busy');
  if (res.ok) {
    view.saved = editor.value;
    const parts = [];
    for (const [key, word] of [['started', t('ed.w.started')], ['stopped', t('ed.w.stopped')], ['restarted', t('ed.w.restarted')]]) if (Array.isArray(res[key]) && res[key].length) parts.push(`${res[key].length} ${word}`);
    toast(`${label ? t('ed.toast.addedSaved', { label }) : t('ed.toast.saved')} ✓ ${parts.length ? `(${parts.join(', ')})` : ''}`, 4000);
    if (res.restart_needed) banner(t('ed.bn.restartPort'), 'warn');
  } else {
    toast(res.error ?? t('ed.toast.saveFail'), 7000);
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
  try { data = JSON.parse(text); } catch (err) { throw new Error(t('ed.d.jsonErr', { msg: err.message.replace(/ in JSON at position \d+.*/, '') })); }
  if (Array.isArray(data)) return { servers: data };
  if (!data || typeof data !== 'object') throw new Error(t('ed.d.notObj'));
  if (data.servers === undefined) data.servers = [];
  if (!Array.isArray(data.servers)) throw new Error(t('ed.d.serversList'));
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
  toast(t('ed.toast.added', { label, hint: view.canSave ? t('ed.hint.fix') : t('ed.hint.bridge') }), 6000);
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
  if (!pairs.length) throw new Error(t('ed.t.none'));
  return pairs.map(([key, raw], i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(t('ed.t.notObj', { n: i + 1 }));
    const name = String(raw.name ?? key ?? `mcp-${i + 1}`).trim() || `mcp-${i + 1}`;
    if (raw.command === undefined) throw new Error(t('ed.t.remote', { name }));
    let command = typeof raw.command === 'string' ? (Array.isArray(raw.args) ? [raw.command] : splitCommand(raw.command)) : raw.command;
    if (!Array.isArray(command) || !command.length) throw new Error(t('ed.t.badCmd', { name }));
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
    if (!name) throw new Error(t('ed.f.noName'));
    if (!cmdText) throw new Error(t('ed.f.noCmd'));
    const entry = { name, command: splitCommand(cmdText) };
    const port = $('#f-port').value.trim();
    if (port) {
      const p = Number(port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(t('ed.f.portRange'));
      entry.port = p;
    }
    const cwd = $('#f-cwd').value.trim();
    if (cwd) entry.cwd = cwd.replace(/\\/g, '/');
    const env = parseEnv($('#f-env').value);
    if (Object.keys(env).length) entry.env = env;
    const [added] = addEntries([entry]);
    await afterAdd(`"${added}"`);
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
    if (!raw) throw new Error(t('ed.f.pasteFirst'));
    let data;
    try { data = JSON.parse(raw); } catch (err) { throw new Error(t('ed.f.invalidJson', { msg: err.message.replace(/ in JSON at position \d+.*/, '') })); }
    const added = addEntries(toEntries(data));
    await afterAdd(added.join(', '));
    $('#import-text').value = '';
  } catch (err) { fail('#import-error', err.message); }
});

for (const tpl of TEMPLATES) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip';
  chip.dataset.label = tpl.label;
  if (tpl.hint) chip.dataset.hint = tpl.hint;
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
  $('#bridge-text').textContent = !b.checked ? t('ed.checking') : (b.online ? t('ed.br.online', { v: b.version ? ` v${b.version}` : '' }) : t(b.paused ? 'ed.br.paused' : 'ed.br.off'));
  const toggle = $('#bridge-toggle');
  if (!toggle.classList.contains('busy')) {
    toggle.querySelector('span').textContent = t(b.online ? 'ed.stop' : 'ed.start');
    toggle.disabled = !b.checked || (!b.online && !b.launcherOnline);
    toggle.title = (!b.online && !b.launcherOnline) ? t('ed.br.tipLauncher') : '';
  }
  const restart = $('#bridge-restart');
  if (!restart.classList.contains('busy')) restart.disabled = !b.checked || (!b.online && !b.launcherOnline);
  $('#version').textContent = res.version ? `v${res.version}` : '';
  $('#version-line').textContent = res.version ? `Web MCP Bridge v${res.version}` : '';

  const couldSave = view.canSave;
  if (b.online && !couldSave && !isDirty()) await load();
  else if (b.online && !couldSave) { view.canSave = true; banner(null); renderStatus(); } else if (!b.online && couldSave) { view.canSave = false; banner(t('ed.bn.wentOff')); renderStatus(); }
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
  if (!res.ok) toast(res.error ?? t('ed.br.fail'), 7000);
  else toast(action === 'stop' ? t('p.toast.stopped') : (action === 'start' ? t('p.toast.started') : t('p.toast.restarted')));
  await refreshBridge();
  if (action !== 'stop' && res.ok) await load({ keepDraft: true });
}
$('#bridge-toggle').addEventListener('click', (e) => bridgeAction(e.currentTarget, view.online ? 'stop' : 'start', t(view.online ? 'ed.stopping' : 'ed.starting')));
$('#bridge-restart').addEventListener('click', (e) => bridgeAction(e.currentTarget, 'restart', t('ed.restarting')));

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
  } catch (err) { toast(t('ed.noFormat', { msg: err.message.replace(/ in JSON at position \d+.*/, '') })); }
});
$('#b-reload').addEventListener('click', async () => {
  if (isDirty() && !confirm(t('ed.confirmReload'))) return;
  await load();
  toast(t('ed.reloaded'));
});
window.addEventListener('beforeunload', (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

// ───────────────────────── Idioma y tema (v1.8) ─────────────────────────

const SUN = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
let uiLang = '';
let uiTheme = '';

/** Pinta los textos fijos del HTML y las plantillas en el idioma activo, y rehace los mensajes de validación. */
function paintStatic() {
  WMB.i18n.apply();
  document.title = t('ed.title');
  for (const chip of document.querySelectorAll('#templates .chip')) {
    chip.textContent = chip.dataset.label.startsWith('ed.') ? t(chip.dataset.label) : chip.dataset.label;
    if (chip.dataset.hint) chip.title = t(chip.dataset.hint);
  }
  for (const btn of document.querySelectorAll('#lang-seg button')) {
    const on = btn.dataset.lang === uiLang;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  const light = uiTheme === 'light';
  const themeBtn = $('#theme-btn');
  themeBtn.innerHTML = light ? MOON : SUN;
  themeBtn.title = t(light ? 'theme.toDark' : 'theme.toLight');
  themeBtn.setAttribute('aria-label', themeBtn.title);
  renderStatus();
}

async function syncAppearance() {
  const res = await send('GET_STATE');
  if (!res.ok) return;
  const lang = WMB.i18n.setLang(res.settings?.language);
  const theme = WMB.i18n.setTheme(res.settings?.theme);
  if (lang !== uiLang || theme !== uiTheme) { uiLang = lang; uiTheme = theme; paintStatic(); refreshBridge(); }
}
async function choose(patch) {
  if (patch.language) { uiLang = WMB.i18n.setLang(patch.language); patch = { ...patch, languageChosen: true }; }
  if (patch.theme) uiTheme = WMB.i18n.setTheme(patch.theme);
  paintStatic();
  await send('UPDATE_SETTINGS', { settings: patch });
  refreshBridge();
}
for (const btn of document.querySelectorAll('#lang-seg button')) btn.addEventListener('click', () => choose({ language: btn.dataset.lang }));
$('#theme-btn').addEventListener('click', () => choose({ theme: uiTheme === 'light' ? 'dark' : 'light' }));

(async function init() {
  await syncAppearance();
  await refreshBridge();
  await load();
  suggestPort();
  setInterval(refreshBridge, 3000);
  setInterval(syncAppearance, 3000);
})();

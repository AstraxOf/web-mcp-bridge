const P = window.POPUP;
const { $, api, toast, guard, setBusy } = P;

function permSelect(onChange, label) {
  const select = document.createElement('select');
  select.className = 'perm';
  select.setAttribute('aria-label', label);
  for (const perm of P.PERMISSIONS) select.append(new Option(P.PERMISSION_LABELS[perm], perm));
  select.addEventListener('change', guard(() => onChange(select.value)));
  return select;
}

function buildCard(server) {
  const card = { server, els: {} };
  const li = document.createElement('li');
  li.className = 'server';

  const toggle = document.createElement('label');
  toggle.className = 'switch';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.addEventListener('change', guard(() => api('TOGGLE_SERVER', { id: card.server.id, enabled: checkbox.checked })));
  toggle.append(checkbox, document.createElement('span'));

  const info = document.createElement('div');
  info.className = 'info';
  const name = document.createElement('div');
  name.className = 'name';
  const dot = document.createElement('i');
  const title = document.createElement('span');
  title.className = 'title';
  const manual = document.createElement('span');
  manual.className = 'badge';
  manual.textContent = 'manual';
  manual.title = 'Added by hand in earlier versions (does not come from servers.json)';
  const demo = document.createElement('span');
  demo.className = 'badge demo';
  demo.textContent = 'demo';
  demo.title = 'Test server bundled with the extension';
  name.append(dot, title, manual, demo);
  const meta = document.createElement('div');
  meta.className = 'meta';

  const tools = document.createElement('div');
  tools.className = 'tools';
  const select = permSelect((value) => api('SET_PERMISSION', { id: card.server.id, permission: value }), `Permission for ${server.name}`);
  const test = document.createElement('button');
  test.type = 'button';
  test.className = 'test-btn';
  test.innerHTML = `${P.ICONS.play}<span>Test</span>`;
  test.title = 'Runs info_sistema: shows real data from your machine (enables it if needed)';
  test.addEventListener('click', () => runDemo(card));
  tools.append(select, test);
  info.append(name, meta, tools);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'icon-btn danger';
  remove.innerHTML = P.ICONS.trash;
  remove.title = 'Remove from the extension';
  remove.setAttribute('aria-label', 'Remove from the extension');
  remove.dataset.armed = 'Are you sure?';
  remove.addEventListener('click', () => {
    if (!remove.classList.contains('armed')) {
      remove.classList.add('armed');
      clearTimeout(remove.timer);
      remove.timer = setTimeout(() => remove.classList.remove('armed'), 2600);
      return;
    }
    clearTimeout(remove.timer);
    guard(() => api('REMOVE_SERVER', { id: card.server.id }))();
  });
  actions.append(remove);

  li.append(toggle, info, actions);
  Object.assign(card, { li, els: { toggle, checkbox, dot, title, manual, demo, meta, select, test, remove, out: null } });
  return card;
}

function updateCard(card, server, activeCount) {
  card.server = server;
  const { li, els } = card;
  li.classList.toggle('on', server.enabled);
  els.toggle.title = server.enabled ? 'Disable' : 'Enable';
  els.checkbox.checked = server.enabled;
  els.checkbox.disabled = !server.enabled && activeCount >= P.MAX_ACTIVE_SERVERS;
  els.checkbox.setAttribute('aria-label', `Enable ${server.name}`);
  const bridgeBroken = server.bridgeStatus === 'error';
  els.dot.className = `dot ${bridgeBroken ? 'error' : (server.enabled ? server.status : '')}`;
  els.title.textContent = server.name;
  els.title.title = server.name;
  els.manual.hidden = Boolean(server.auto);
  els.demo.hidden = !P.isDemo(server);
  els.remove.parentElement.hidden = Boolean(server.auto);
  let meta;
  if (bridgeBroken) meta = `${server.url} · The bridge could not start it: ${server.bridgeError ?? 'error'}`;
  else if (server.permission === 'deny') meta = `${server.url} · Blocked (not described to the AI)`;
  else if (server.enabled) meta = `${server.url} · ${P.STATUS_TEXT[server.status] ?? server.status}${server.status === 'connected' ? ` · ${server.toolCount} tools` : ''}`;
  else meta = server.url;
  els.meta.textContent = meta;
  els.meta.classList.toggle('err', bridgeBroken);
  els.meta.title = server.enabled && server.error && server.status !== 'connected' ? server.error : '';
  if (document.activeElement !== els.select) els.select.value = server.permission;
  els.select.dataset.perm = server.permission;
  els.test.hidden = !P.isDemo(server);
  const out = P.demoOutputs.get(server.id);
  if (out) {
    if (!els.out) {
      els.out = document.createElement('div');
      els.out.className = 'demo-out';
      els.out.title = 'Click to hide';
      els.out.append(document.createElement('pre'));
      els.out.addEventListener('click', () => { P.demoOutputs.delete(card.server.id); updateCard(card, card.server, activeCount); });
      li.append(els.out);
    }
    els.out.classList.toggle('bad', !out.ok);
    els.out.firstChild.textContent = out.text;
  } else if (els.out) {
    els.out.remove();
    els.out = null;
  }
}

async function runDemo(card) {
  const btn = card.els.test;
  btn.disabled = true;
  try {
    if (!card.server.enabled) await api('TOGGLE_SERVER', { id: card.server.id, enabled: true });
    const res = await api('CALL_TOOL', { server: card.server.slug ?? card.server.name, name: P.DEMO_TOOL, arguments: {} });
    const text = (res.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    P.demoOutputs.set(card.server.id, { ok: !res.result?.isError, text: text || 'The server replied without text.' });
  } catch (err) {
    const hint = /does not exist|is not connected/.test(err.message) ? '\nRestart the bridge to load the updated demo.' : '';
    P.demoOutputs.set(card.server.id, { ok: false, text: err.message + hint });
  } finally {
    btn.disabled = false;
    await P.refresh(true);
  }
}

export function renderServers(state) {
  const list = $('#server-list');
  const active = state.servers.filter((s) => s.enabled);
  $('#counter').textContent = `${active.length}/${P.MAX_ACTIVE_SERVERS} active`;
  const tokens = active.reduce((sum, s) => sum + s.approxTokens, 0);
  $('#tokens').textContent = active.length ? `≈ ${tokens.toLocaleString('en')} tool tokens` : '';
  const warning = $('#warning');
  warning.hidden = active.length <= P.RECOMMENDED_ACTIVE_SERVERS;
  warning.textContent = `You have ${active.length} MCPs enabled. Every tool eats AI context and can saturate it. 1 at a time is recommended.`;
  $('#empty').hidden = state.servers.length > 0;
  const seen = new Set();
  state.servers.forEach((server, index) => {
    seen.add(server.id);
    let card = P.cards.get(server.id);
    if (!card) {
      card = buildCard(server);
      P.cards.set(server.id, card);
      card.li.classList.add('enter');
      card.li.style.setProperty('--i', index);
      card.li.addEventListener('animationend', (e) => { if (e.target === card.li) card.li.classList.remove('enter'); });
    }
    updateCard(card, server, active.length);
    if (list.children[index] !== card.li) list.insertBefore(card.li, list.children[index] ?? null);
  });
  for (const [id, card] of P.cards) {
    if (seen.has(id)) continue;
    P.cards.delete(id);
    card.li.classList.add('leaving');
    setTimeout(() => card.li.remove(), 260);
  }
}

export function renderGlobalPermission(servers) {
  const select = $('#perm-all');
  const perms = new Set(servers.map((s) => s.permission));
  const value = perms.size === 1 ? [...perms][0] : (perms.size === 0 ? 'ask' : 'mixed');
  select.value = value;
  select.dataset.perm = value;
  select.closest('.perm-all').hidden = servers.length === 0;
  $('#perm-hint').textContent = {
    allow: 'All allowed: nothing is ever asked.',
    ask: 'Asked on every AI call.',
    deny: 'All blocked: the AI receives no tools.',
    mixed: 'Each MCP has a different permission.',
  }[value];
}

export function bindPermissionEvents() {
  $('#perm-all').addEventListener('change', guard((e) => api('SET_ALL_PERMISSIONS', { permission: e.target.value })));
}

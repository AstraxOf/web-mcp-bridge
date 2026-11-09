const P = window.POPUP;
const { $, api, toast, guard, setLabel, setBusy } = P;

export function renderBridge(state) {
  const b = state.bridge ?? {};
  const dot = $('#bridge-dot');
  const title = $('#bridge-title');
  const sub = $('#bridge-sub');
  const hint = $('#offline-hint');
  const cfgErr = $('#config-error');

  if (!b.checked) {
    dot.className = 'dot connecting';
    title.textContent = 'Checking the bridge…';
    sub.textContent = '';
  } else if (b.online) {
    dot.className = 'dot online';
    title.textContent = 'Bridge connected';
    const listening = state.servers.filter((s) => s.bridgeStatus === 'listening').length;
    sub.textContent = `v${b.version ?? '?'} · ${listening} server${listening === 1 ? '' : 's'} published`;
  } else {
    dot.className = 'dot offline';
    title.textContent = 'Bridge is off';
    sub.textContent = 'The extension cannot find it on this machine.';
  }

  cfgErr.hidden = !(b.online && b.configError);
  if (!cfgErr.hidden) cfgErr.textContent = `servers.json has an error: ${b.configError}. Fix it and save: the bridge reloads on its own (meanwhile it keeps the previous configuration).`;

  hint.hidden = !(b.checked && !b.online);
  if (!hint.hidden) {
    if (b.launcherOnline) {
      hint.textContent = b.paused
        ? 'The bridge is off on purpose. Press "Start bridge" to turn it on.'
        : 'The bridge went down; the launcher is bringing it back. If it does not return, press "Start bridge".';
    } else {
      hint.replaceChildren('To start it from here, install the launcher once: double-click ', Object.assign(document.createElement('code'), { textContent: 'server/install.cmd' }),
        '. Meanwhile you can run it by hand with ', Object.assign(document.createElement('code'), { textContent: 'server/start_bridge_loop.pyw' }), '.');
    }
  }

  const toggle = $('#toggle-bridge');
  if (!P.togglingBridge) {
    setLabel(toggle, b.online ? 'Stop bridge' : 'Start bridge');
    toggle.disabled = !b.checked || !b.launcherOnline;
    toggle.title = b.launcherOnline
      ? (b.online ? 'Turns the bridge off (stays off until you start it again)' : 'Turns the bridge on')
      : 'Needs the launcher: install it once with server/install.cmd';
  }

  const restart = $('#restart-bridge');
  if (!P.restarting) {
    restart.disabled = !b.online;
    restart.title = !b.online ? 'The bridge is off'
      : (b.canControl ? 'Closes and reopens the bridge (reloads servers.json and the MCPs)' : 'Your bridge is old: run restart_bridge.cmd once to enable this button');
  }
  $('#open-config').title = b.config ? `Open ${b.config}` : 'Open servers.json in your editor';
}

export function bindBridgeEvents() {
  $('#open-config').addEventListener('click', async (event) => {
    if (P.opening) return;
    P.opening = true;
    setBusy(event.currentTarget, true);
    try {
      await api('OPEN_CONFIG');
      toast('Opening servers.json… save the file and the bridge reloads on its own.');
    } catch (err) {
      const path = P.latest?.bridge?.config;
      toast(path && !err.message.includes(path) ? `${err.message} File: ${path}` : err.message, 6500);
    } finally {
      P.opening = false;
      setBusy(event.currentTarget, false);
    }
  });

  $('#toggle-bridge').addEventListener('click', async (event) => {
    if (P.togglingBridge) return;
    const btn = event.currentTarget;
    const turnOff = Boolean(P.latest?.bridge?.online);
    P.togglingBridge = true;
    setBusy(btn, true);
    setLabel(btn, turnOff ? 'Stopping…' : 'Starting…');
    try {
      const res = await api(turnOff ? 'STOP_BRIDGE' : 'START_BRIDGE');
      toast(turnOff ? 'Bridge stopped.' : (res.configError ? 'Bridge started, but servers.json has an error.' : 'Bridge started ✓'), 4200);
    } catch (err) {
      toast(err.message, 7000);
    } finally {
      P.togglingBridge = false;
      setBusy(btn, false);
      await P.refresh(true);
    }
  });

  $('#restart-bridge').addEventListener('click', async (event) => {
    if (P.restarting) return;
    const btn = event.currentTarget;
    P.restarting = true;
    setBusy(btn, true);
    setLabel(btn, 'Restarting…');
    try {
      const res = await api('RESTART_BRIDGE');
      toast(res.configError ? 'Bridge restarted, but servers.json has an error.' : 'Bridge restarted ✓', 4200);
    } catch (err) {
      toast(err.message, 7000);
    } finally {
      P.restarting = false;
      setBusy(btn, false);
      setLabel(btn, 'Restart bridge');
      await P.refresh(true);
    }
  });
}

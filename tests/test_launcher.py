"""Prueba del lanzador (start_bridge_loop.pyw): control Iniciar/Apagar/Reiniciar, marca .paused, seguridad de Origin/Host y supervisor."""
import http.client
import importlib.machinery
import importlib.util
import json
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LAUNCHER_PORT = 18798
DEAD_CONTROL = 18797  # nadie escucha aqui: el puente "no existe"

loader = importlib.machinery.SourceFileLoader("wmb_launcher", str(ROOT / "server/start_bridge_loop.pyw"))
spec = importlib.util.spec_from_loader("wmb_launcher", loader)
mod = importlib.util.module_from_spec(spec)
loader.exec_module(mod)

tmp = Path(tempfile.mkdtemp(prefix="wmb_launcher_"))
cfg = tmp / "servers.json"
cfg.write_text(json.dumps({"servers": [], "control_port": DEAD_CONTROL, "launcher_port": LAUNCHER_PORT}), encoding="utf-8")
paused_file = tmp / ".paused"
spawned = []


def fake_spawn(_launcher):
    spawned.append(time.time())
    return 0


launcher = mod.Launcher(config=str(cfg), paused_file=str(paused_file), spawn=fake_spawn)
assert launcher.launcher_port == LAUNCHER_PORT and launcher.control_port == DEAD_CONTROL
server = mod.make_server(launcher)
threading.Thread(target=server.serve_forever, daemon=True).start()


def call(method, path, origin=None, host=None):
    conn = http.client.HTTPConnection("127.0.0.1", LAUNCHER_PORT, timeout=5)
    headers = {}
    if origin:
        headers["Origin"] = origin
    if host:
        headers["Host"] = host
    conn.request(method, path, headers=headers, body=b"" if method == "POST" else None)
    res = conn.getresponse()
    raw = res.read()
    conn.close()
    return res.status, (json.loads(raw) if raw else None)


def wait_for(cond, timeout=8):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.05)
    return False


# --- estado y seguridad ---
st, body = call("GET", "/status")
assert st == 200 and body["launcher"] is True and body["paused"] is False and body["bridge"] is False, (st, body)
assert call("GET", "/status", origin="chrome-extension://abcdef")[0] == 200
assert call("GET", "/status", origin="https://chatgpt.com")[0] == 403          # una web NO puede controlar el lanzador
assert call("POST", "/stop", origin="https://evil.example")[0] == 403
assert call("GET", "/status", host="evil.example:8098")[0] == 403               # DNS rebinding
assert call("GET", "/nope")[0] == 404
assert not paused_file.exists()
print("OK seguridad y estado")

# --- apagar / iniciar / reiniciar ---
st, body = call("POST", "/stop", origin="chrome-extension://abcdef")
assert st == 200 and body["paused"] is True and paused_file.exists(), (st, body)
assert launcher.paused is True
st, body = call("POST", "/start")
assert st == 200 and body["paused"] is False and not paused_file.exists(), (st, body)
call("POST", "/stop")
st, body = call("POST", "/restart")                                             # reiniciar tambien "enciende"
assert st == 200 and body["paused"] is False and not paused_file.exists()
print("OK iniciar / apagar / reiniciar")

# --- supervisor: no arranca si esta apagado; arranca si el puente no responde ---
launcher.set_paused(True)
thread = threading.Thread(target=launcher.supervise, daemon=True)
thread.start()
time.sleep(1.5)
assert spawned == [], "estando apagado no debe arrancar el puente"
call("POST", "/start")
assert wait_for(lambda: len(spawned) >= 1), "al iniciar debe arrancar el puente"
print("OK supervisor")

# --- salir ---
st, body = call("POST", "/quit")
assert st == 200 and body["bye"] is True
assert wait_for(launcher.quit.is_set)
thread.join(timeout=5)
assert not thread.is_alive(), "el supervisor debe terminar con /quit"
server.server_close()
print("OK test_launcher")
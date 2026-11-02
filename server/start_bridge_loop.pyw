"""Lanzador (launcher) del puente MCP.

Mantiene vivo el puente (si cae, lo relanza) y escucha en 127.0.0.1:8098 para que la EXTENSION pueda
ENCENDERLO, REINICIARLO y APAGARLO desde su panel (una extension no puede lanzar procesos por si sola).

  pythonw start_bridge_loop.pyw                -> modo normal (bucle + servidor de control)
  python  start_bridge_loop.pyw --ctl ACCION   -> ACCION = start | stop | restart | status | quit

"Apagar" deja el puente apagado hasta que se pulse "Iniciar" (la marca .paused sobrevive a los reinicios del PC).
Seguridad: solo atiende a la extension (Origin chrome-extension://) o a clientes sin Origin (CLI), y solo con Host local.
"""
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DIR = os.path.dirname(os.path.abspath(__file__))
PY = os.path.join(os.path.dirname(sys.executable), "python.exe") if sys.executable.lower().endswith("pythonw.exe") else sys.executable
LOG = os.path.join(DIR, "bridge.log")
ALOG = os.path.join(DIR, "loop.log")
CONFIG = os.path.join(DIR, "servers.json")
PAUSED_FILE = os.path.join(DIR, ".paused")
DEFAULT_CONTROL_PORT = 8099
DEFAULT_LAUNCHER_PORT = 8098
ALLOWED_ORIGIN_PREFIXES = ("chrome-extension://", "moz-extension://")


def _log(msg):
    try:
        with open(ALOG, "a", encoding="utf-8") as f:
            f.write("[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


def read_config(path=CONFIG):
    try:
        with open(path, encoding="utf-8-sig") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def alive(port):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/health" % port, timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def http_json(method, port, path, timeout=4):
    """Peticion sin cabecera Origin (la aceptan el puente y este lanzador). Devuelve el JSON o None."""
    try:
        req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path), method=method, data=b"" if method == "POST" else None)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8") or "{}")
    except Exception:
        return None


def spawn_bridge(launcher):
    """Arranca el puente y espera a que termine. Devuelve su codigo de salida."""
    # WMB_SUPERVISED=1: si el puente se reinicia desde la extension, solo se cierra y este bucle lo vuelve a levantar.
    done = subprocess.run([PY, "mcp_ws_bridge.py", "--config", launcher.config, "--log-file", LOG], cwd=DIR,
                          env={**os.environ, "WMB_SUPERVISED": "1"},
                          creationflags=0x08000000 if sys.platform == "win32" else 0)
    return done.returncode


class Launcher:
    def __init__(self, config=CONFIG, paused_file=PAUSED_FILE, spawn=spawn_bridge):
        self.config = config
        self.paused_file = paused_file
        self.spawn = spawn
        self.wake = threading.Event()
        self.quit = threading.Event()

    @property
    def control_port(self):
        try:
            return int(read_config(self.config).get("control_port", DEFAULT_CONTROL_PORT))
        except (TypeError, ValueError):
            return DEFAULT_CONTROL_PORT

    @property
    def launcher_port(self):
        try:
            return int(read_config(self.config).get("launcher_port", DEFAULT_LAUNCHER_PORT))
        except (TypeError, ValueError):
            return DEFAULT_LAUNCHER_PORT

    @property
    def paused(self):
        return os.path.exists(self.paused_file)

    def set_paused(self, flag):
        try:
            if flag:
                with open(self.paused_file, "w", encoding="utf-8") as f:
                    f.write("apagado desde la extension\n")
            elif os.path.exists(self.paused_file):
                os.remove(self.paused_file)
        except OSError as err:
            _log("no se pudo cambiar .paused: %r" % (err,))

    def status(self):
        return {"ok": True, "launcher": True, "pid": os.getpid(), "paused": self.paused, "bridge": alive(self.control_port)}

    # ---- acciones (las usa el servidor HTTP) ----
    def do_start(self):
        self.set_paused(False)
        self.wake.set()

    def do_stop(self):
        self.set_paused(True)
        http_json("POST", self.control_port, "/shutdown")
        self.wake.set()

    def do_restart(self):
        self.set_paused(False)
        if alive(self.control_port):
            http_json("POST", self.control_port, "/restart")
        self.wake.set()

    # ---- bucle principal ----
    def supervise(self):
        _log("launcher START")
        while not self.quit.is_set():
            try:
                if self.paused or alive(self.control_port):
                    self.wake.wait(1.0 if self.paused else 3.0)
                    self.wake.clear()
                    continue
                _log("puente caido -> arrancando")
                delay = 5
                try:
                    if self.spawn(self) == 0:
                        delay = 1  # cierre limpio (reinicio o apagado pedido): volver a mirar enseguida
                except Exception as err:
                    _log("bridge error: %r" % (err,))
                _log("puente termino, reintento en %ds" % delay)
                self.wake.wait(delay)
                self.wake.clear()
            except Exception as err:
                _log("loop error: %r" % (err,))
                self.wake.wait(5)
        _log("launcher STOP")


class Handler(BaseHTTPRequestHandler):
    server_version = "WMBLauncher/1"

    def log_message(self, *args):
        pass

    def _origin(self):
        return self.headers.get("Origin")

    def _allowed(self):
        origin = self._origin()
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        return host in ("127.0.0.1", "localhost") and (origin is None or origin.startswith(ALLOWED_ORIGIN_PREFIXES))

    def _reply(self, status, payload=None):
        body = b"" if payload is None else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        origin = self._origin()
        if origin and origin.startswith(ALLOWED_ORIGIN_PREFIXES):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Vary", "Origin")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self):
        self._reply(204 if self._allowed() else 403)

    def do_GET(self):
        if not self._allowed():
            return self._reply(403, {"ok": False, "error": "origin no permitido"})
        if self.path == "/status":
            return self._reply(200, self.server.launcher.status())
        self._reply(404, {"ok": False, "error": "ruta desconocida"})

    def do_POST(self):
        if not self._allowed():
            return self._reply(403, {"ok": False, "error": "origin no permitido"})
        launcher = self.server.launcher
        actions = {"/start": launcher.do_start, "/stop": launcher.do_stop, "/restart": launcher.do_restart}
        if self.path in actions:
            actions[self.path]()
            return self._reply(200, launcher.status())
        if self.path == "/quit":
            self._reply(200, {"ok": True, "bye": True})
            launcher.quit.set()
            launcher.wake.set()
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return None
        self._reply(404, {"ok": False, "error": "ruta desconocida"})


def make_server(launcher):
    server = ThreadingHTTPServer(("127.0.0.1", launcher.launcher_port), Handler)
    server.daemon_threads = True
    server.launcher = launcher
    return server


def run_forever(launcher):
    try:
        server = make_server(launcher)
    except OSError:
        _log("el puerto %d ya esta ocupado: ya hay un lanzador corriendo, salgo" % launcher.launcher_port)
        return 0
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        launcher.supervise()
    finally:
        server.shutdown()
        server.server_close()
    return 0


def ctl(action):
    """Modo terminal: --ctl start|stop|restart|status|quit."""
    launcher = Launcher()
    port = launcher.launcher_port
    method = "GET" if action == "status" else "POST"
    data = http_json(method, port, "/" + action, timeout=8)
    if data is None:
        print("El lanzador no esta activo (puerto %d)." % port)
        return 3
    if action == "status":
        print("Lanzador activo (pid %s) - puente: %s%s" % (data.get("pid"), "encendido" if data.get("bridge") else "apagado",
                                                       " (apagado a proposito)" if data.get("paused") else ""))
    else:
        print("Hecho: %s." % action)
    return 0


if __name__ == "__main__":
    os.chdir(DIR)
    if len(sys.argv) >= 3 and sys.argv[1] == "--ctl":
        sys.exit(ctl(sys.argv[2]))
    sys.exit(run_forever(Launcher()))
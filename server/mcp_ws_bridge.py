#!/usr/bin/env python3
"""
mcp_ws_bridge.py - Puente WebSocket <-> servidor MCP (stdio).  v1.4.0

Los servidores MCP locales (como `astrax-mcp`) hablan JSON-RPC por stdin/stdout.
El navegador solo puede hablar WebSocket. Este script lanza cada servidor MCP como
subproceso y reenvia los mensajes JSON-RPC en ambos sentidos.

Uso rapido
----------
    # Un servidor
    python mcp_ws_bridge.py --port 8080 -- python -m astrax_mcp

    # Varios servidores desde servers.json (recomendado)
    python mcp_ws_bridge.py --config servers.json

Novedades 1.3.0 (modo --config)
-------------------------------
* Puerto de control http://127.0.0.1:8099 (`/health`, `/servers`, `/reload`, `/shutdown`).
  La extension lo usa para DETECTAR SOLA los servidores de servers.json.
* Recarga en caliente: al guardar servers.json se arrancan/paran/reinician solo los servidores que cambiaron.
* Si ya hay un puente corriendo, `--config` lo recarga en vez de fallar con "puerto ocupado".
* `--restart` reinicia el puente (apaga el anterior con elegancia y, si hace falta, libera los puertos que
  ocupe un puente viejo); `--stop`, `--status` y `--reload` completan el control desde la terminal.
* Un puerto ocupado por otro programa ya no tumba el puente: ese servidor queda en error y el resto sigue.

Seguridad
---------
* Solo escucha en 127.0.0.1 por defecto.
* Rechaza conexiones cuyo `Origin` sea una pagina web (p. ej. https://chatgpt.com):
  solo acepta extensiones (`chrome-extension://...`) o clientes sin Origin (CLI).
* El puerto de control aplica la misma regla de Origin; /reload y /shutdown solo aceptan POST.
* Opcional: `--token SECRETO` exige `ws://localhost:8080?token=SECRETO`.
"""
from __future__ import annotations

import argparse
import asyncio
import hmac
import json
import logging
import os
import shlex
import shutil
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:  # websockets >= 13
    from websockets.asyncio.server import serve as ws_serve
except ImportError:  # websockets 12
    from websockets import serve as ws_serve  # type: ignore[assignment]

VERSION = "1.6.0"
DEFAULT_CONTROL_PORT = 8099
log = logging.getLogger("mcp_ws_bridge")

STDIO_LIMIT = 32 * 1024 * 1024  # tamano maximo de un mensaje JSON-RPC
ALLOWED_ORIGIN_PREFIXES = ("chrome-extension://", "moz-extension://")
WIN = sys.platform == "win32"
# start_bridge_loop.pyw lo pone a 1: si el puente se cierra para reiniciarse, el supervisor lo vuelve a levantar.
SUPERVISED = os.environ.get("WMB_SUPERVISED") == "1"


@dataclass
class ServerConfig:
    """Configuracion de un servidor MCP expuesto por WebSocket."""

    name: str
    command: list[str]
    port: int = 8080
    host: str = "127.0.0.1"
    cwd: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    token: str | None = None
    allowed_origins: tuple[str, ...] = ALLOWED_ORIGIN_PREFIXES


# ----------------------------------------------------------------- utilidades

def _request_parts(ws) -> tuple[str, dict]:
    """Obtiene (path, headers) compatible con las distintas versiones de `websockets`."""
    request = getattr(ws, "request", None)
    if request is not None:
        return request.path, request.headers
    return ws.path, ws.request_headers  # websockets 12


def _origin_allowed(origin: str | None, cfg: ServerConfig) -> bool:
    return origin is None or origin.startswith(cfg.allowed_origins)


def _token_ok(path: str, cfg: ServerConfig) -> bool:
    if not cfg.token:
        return True
    supplied = parse_qs(urlparse(path).query).get("token", [""])[0]
    return hmac.compare_digest(supplied, cfg.token)


async def _spawn(cfg: ServerConfig) -> asyncio.subprocess.Process:
    executable = shutil.which(cfg.command[0]) or cfg.command[0]  # resuelve npx.cmd en Windows
    extra = {"creationflags": 0x08000000} if WIN else {}  # CREATE_NO_WINDOW
    return await asyncio.create_subprocess_exec(
        executable,
        *cfg.command[1:],
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cfg.cwd,
        env={**os.environ, **cfg.env},
        limit=STDIO_LIMIT,
        **extra,
    )


async def _stop(proc: asyncio.subprocess.Process) -> None:
    """Cierra el subproceso con elegancia (stdin -> terminate -> kill)."""
    if proc.returncode is not None:
        return
    try:
        proc.stdin.close()  # type: ignore[union-attr]
        await asyncio.wait_for(proc.wait(), 2)
        return
    except Exception:  # noqa: BLE001
        pass
    try:
        proc.terminate()
        await asyncio.wait_for(proc.wait(), 3)
    except Exception:  # noqa: BLE001
        proc.kill()


# -------------------------------------------------------------------- tuberias

async def _stdout_to_ws(proc: asyncio.subprocess.Process, ws) -> None:
    """stdout del servidor MCP -> WebSocket (una linea = un mensaje JSON-RPC)."""
    assert proc.stdout is not None
    while True:
        line = await proc.stdout.readline()
        if not line:
            return
        text = line.decode("utf-8", errors="replace").strip()
        if not text:
            continue
        try:
            json.loads(text)
        except ValueError:
            log.debug("stdout que no es JSON (ignorado): %.200s", text)
            continue
        await ws.send(text)


async def _ws_to_stdin(proc: asyncio.subprocess.Process, ws) -> None:
    """WebSocket -> stdin del servidor MCP. Responde `ping` directamente."""
    assert proc.stdin is not None
    async for raw in ws:
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", errors="replace")
        try:
            message = json.loads(raw)
        except ValueError:
            continue
        if isinstance(message, dict) and message.get("method") == "ping" and "id" in message:
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": {}}))
            continue
        proc.stdin.write((json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n").encode())
        await proc.stdin.drain()


async def _log_stderr(proc: asyncio.subprocess.Process, name: str) -> None:
    assert proc.stderr is not None
    while True:
        line = await proc.stderr.readline()
        if not line:
            return
        log.info("[%s] %s", name, line.decode("utf-8", errors="replace").rstrip())


async def handle_client(ws, cfg: ServerConfig) -> None:
    """Cada conexion WebSocket obtiene su propio subproceso MCP."""
    path, headers = _request_parts(ws)
    origin = headers.get("Origin")
    if not _origin_allowed(origin, cfg):
        log.warning("[%s] Conexion rechazada: Origin no permitido (%s)", cfg.name, origin)
        await ws.close(1008, "Origin no permitido")
        return
    if not _token_ok(path, cfg):
        log.warning("[%s] Conexion rechazada: token invalido", cfg.name)
        await ws.close(1008, "Token invalido")
        return

    try:
        proc = await _spawn(cfg)
    except (FileNotFoundError, PermissionError, OSError) as err:
        log.error("[%s] No se pudo ejecutar %s: %s", cfg.name, cfg.command, err)
        await ws.close(1011, "No se pudo iniciar el servidor MCP")
        return

    log.info("[%s] Cliente conectado -> pid %s", cfg.name, proc.pid)
    pipes = {
        asyncio.create_task(_stdout_to_ws(proc, ws)),
        asyncio.create_task(_ws_to_stdin(proc, ws)),
    }
    stderr_task = asyncio.create_task(_log_stderr(proc, cfg.name))
    try:
        await asyncio.wait(pipes, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in (*pipes, stderr_task):
            task.cancel()
        await asyncio.gather(*pipes, stderr_task, return_exceptions=True)
        await _stop(proc)
        log.info("[%s] Cliente desconectado", cfg.name)


# ------------------------------------------------------- puertos y procesos

def _port_owners(ports: list[int]) -> dict[int, tuple[int, str, str]]:
    """{puerto: (pid, nombre, linea_de_comando)} de quien ESCUCHA en esos puertos (mejor esfuerzo)."""
    owners: dict[int, tuple[int, str, str]] = {}
    ports = sorted({int(p) for p in ports if p})
    if not ports:
        return owners
    try:
        if WIN:
            plist = ",".join(str(p) for p in ports)
            script = (
                "$r=@(); Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | "
                "Where-Object { @(%s) -contains $_.LocalPort } | ForEach-Object { "
                "$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$_.OwningProcess) -ErrorAction SilentlyContinue; "
                "$r += [pscustomobject]@{port=$_.LocalPort;pid=$_.OwningProcess;name=$p.Name;cmd=$p.CommandLine} }; "
                "if($r.Count){ $r | ConvertTo-Json -Compress }" % plist
            )
            res = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                capture_output=True, text=True, timeout=25, creationflags=0x08000000,
            )
            if res.stdout.strip():
                data = json.loads(res.stdout)
                for item in ([data] if isinstance(data, dict) else data):
                    owners.setdefault(int(item["port"]), (int(item["pid"]), item.get("name") or "?", item.get("cmd") or ""))
        else:
            for port in ports:
                res = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"], capture_output=True, text=True, timeout=10)
                pid = next((int(x) for x in res.stdout.split() if x.isdigit()), None)
                if pid:
                    ps = subprocess.run(["ps", "-p", str(pid), "-o", "comm=,args="], capture_output=True, text=True, timeout=10)
                    line = ps.stdout.strip()
                    owners[port] = (pid, line.split(" ", 1)[0] or "?", line)
    except Exception as err:  # noqa: BLE001
        log.debug("No se pudo consultar el dueno de los puertos: %s", err)
    return owners


def _is_bridge_cmd(cmd: str) -> bool:
    return "mcp_ws_bridge" in (cmd or "")


def _kill_pid(pid: int) -> None:
    try:
        if WIN:
            subprocess.run(["taskkill", "/PID", str(pid), "/F", "/T"], capture_output=True, timeout=15, creationflags=0x08000000)
        else:
            os.kill(pid, 15)
    except Exception as err:  # noqa: BLE001
        log.debug("No se pudo matar %s: %s", pid, err)


def _free_old_bridges(ports: list[int], quiet: bool = False) -> list[int]:
    """Cierra SOLO procesos que sean un mcp_ws_bridge y esten ocupando alguno de los puertos. Devuelve los pids."""
    killed = []
    me = os.getpid()
    for port, (pid, name, cmd) in sorted(_port_owners(ports).items()):
        if pid == me:
            continue
        if _is_bridge_cmd(cmd):
            if not quiet:
                print(f"  - cerrando puente anterior (pid {pid}) que ocupaba el puerto {port}")
            _kill_pid(pid)
            killed.append(pid)
        elif not quiet:
            print(f"  ! el puerto {port} lo usa otro programa: {name} (pid {pid}); no lo toco.")
    return killed


# ---------------------------------------------------------------- supervisor

class Supervisor:
    """Mantiene los listeners WebSocket alineados con servers.json (arranca, para y reinicia solo lo que cambia)."""

    def __init__(self) -> None:
        self.desired: dict[str, ServerConfig] = {}
        self.listeners: dict[str, object] = {}
        self.errors: dict[str, str] = {}
        self.stop_event = asyncio.Event()
        self.config_error: str | None = None   # ultimo error al leer servers.json (None = todo bien)
        self.restart_requested = False
        self.started_at = time.time()

    async def _start_one(self, cfg: ServerConfig) -> None:
        for other_name, other in self.desired.items():
            if other_name != cfg.name and other_name in self.listeners and (other.host, other.port) == (cfg.host, cfg.port):
                self.errors[cfg.name] = f"puerto {cfg.port} duplicado en servers.json (ya lo usa '{other_name}')"
                log.error("[%s] %s", cfg.name, self.errors[cfg.name])
                return
        try:
            server = await ws_serve(lambda ws, c=cfg: handle_client(ws, c), cfg.host, cfg.port, max_size=STDIO_LIMIT)
        except OSError as err:
            owner = (await asyncio.to_thread(_port_owners, [cfg.port])).get(cfg.port)
            who = f" por {owner[1]} (pid {owner[0]})" if owner else ""
            self.errors[cfg.name] = f"puerto {cfg.port} ocupado{who}: {err.strerror or err}"
            log.error("[%s] %s", cfg.name, self.errors[cfg.name])
            return
        self.listeners[cfg.name] = server
        self.errors.pop(cfg.name, None)
        log.info("[%s] disponible en ws://%s:%d  ->  %s", cfg.name, cfg.host, cfg.port, " ".join(cfg.command))

    async def _stop_one(self, name: str) -> None:
        server = self.listeners.pop(name, None)
        if server is None:
            return
        try:
            server.close(close_connections=True)  # type: ignore[attr-defined]
        except TypeError:
            server.close()  # type: ignore[attr-defined]
        await asyncio.gather(server.wait_closed(), return_exceptions=True)  # type: ignore[attr-defined]
        log.info("[%s] detenido", name)

    async def apply(self, configs: list[ServerConfig]) -> dict[str, list[str]]:
        new = {c.name: c for c in configs}
        report: dict[str, list[str]] = {"started": [], "stopped": [], "restarted": []}
        for name in list(self.listeners):
            if name not in new:
                await self._stop_one(name)
                report["stopped"].append(name)
            elif self.desired.get(name) != new[name]:
                await self._stop_one(name)
                report["restarted"].append(name)
        for name in list(self.errors):
            if name not in new:
                self.errors.pop(name)
        self.desired = new
        for name, cfg in new.items():
            if name not in self.listeners:
                await self._start_one(cfg)
                if name in self.listeners and name not in report["restarted"]:
                    report["started"].append(name)
        return report

    async def retry_failed(self) -> None:
        for name, cfg in list(self.desired.items()):
            if name not in self.listeners and name in self.errors:
                await self._start_one(cfg)

    async def stop_all(self) -> None:
        for name in list(self.listeners):
            await self._stop_one(name)

    def snapshot(self) -> list[dict]:
        items = []
        for name, cfg in self.desired.items():
            host = "127.0.0.1" if cfg.host in ("0.0.0.0", "::", "") else cfg.host
            items.append({
                "name": name,
                "host": cfg.host,
                "port": cfg.port,
                "url": f"ws://{host}:{cfg.port}",
                "status": "listening" if name in self.listeners else "error",
                "error": self.errors.get(name),
            })
        return items


# ------------------------------------------------------------ puerto de control

_REASONS = {200: "OK", 204: "No Content", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 500: "Error"}


async def _http_reply(writer, status: int, payload: dict | None, origin: str | None) -> None:
    body = b"" if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    head = [f"HTTP/1.1 {status} {_REASONS.get(status, 'OK')}", "Content-Type: application/json; charset=utf-8",
            f"Content-Length: {len(body)}", "Connection: close", "Cache-Control: no-store"]
    if origin and origin.startswith(ALLOWED_ORIGIN_PREFIXES):
        head += [f"Access-Control-Allow-Origin: {origin}", "Access-Control-Allow-Methods: GET, POST, OPTIONS",
                 "Access-Control-Allow-Private-Network: true", "Vary: Origin"]
    writer.write(("\r\n".join(head) + "\r\n\r\n").encode("latin-1") + body)
    await writer.drain()


def _open_in_editor(path: Path) -> tuple[bool, str]:
    """Abre un archivo con el editor predeterminado del sistema (como el boton "Edit config" de Claude Desktop)."""
    if os.environ.get("WMB_NO_OPEN") == "1":  # pruebas automaticas: no abrir nada
        return True, ""
    try:
        if WIN:
            try:
                os.startfile(str(path))  # type: ignore[attr-defined]  # noqa: S606
            except OSError:
                subprocess.Popen(["notepad.exe", str(path)])  # sin programa asociado a .json
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])
        return True, ""
    except Exception as err:  # noqa: BLE001
        return False, str(err)


async def _control_handler(reader, writer, sup: Supervisor, config_path: Path | None) -> None:
    origin = None
    try:
        raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
        lines = raw.decode("latin-1").split("\r\n")
        method, path = lines[0].split(" ")[:2]
        headers = {k.strip().lower(): v.strip() for k, v in (ln.split(":", 1) for ln in lines[1:] if ":" in ln)}
        origin = headers.get("origin")
        path = path.split("?")[0]
        host = headers.get("host", "")
        host_name = host.rsplit(":", 1)[0].strip("[]") if host else ""
        if host and host_name not in ("127.0.0.1", "localhost", "::1"):  # anti DNS-rebinding
            await _http_reply(writer, 403, {"ok": False, "error": "host no permitido"}, None)
        elif origin and not origin.startswith(ALLOWED_ORIGIN_PREFIXES):
            await _http_reply(writer, 403, {"ok": False, "error": "origin no permitido"}, None)
        elif method == "OPTIONS":
            await _http_reply(writer, 204, None, origin)
        elif method == "GET" and path == "/health":
            await _http_reply(writer, 200, {"ok": True, "version": VERSION, "pid": os.getpid(),
                                            "started_at": sup.started_at, "config_error": sup.config_error}, origin)
        elif method == "GET" and path == "/servers":
            await _http_reply(writer, 200, {"ok": True, "version": VERSION, "pid": os.getpid(),
                                            "config": str(config_path) if config_path else None, "config_error": sup.config_error,
                                            "started_at": sup.started_at, "supervised": SUPERVISED, "servers": sup.snapshot()}, origin)
        elif path in ("/reload", "/shutdown", "/restart", "/open-config") and method != "POST":
            await _http_reply(writer, 405, {"ok": False, "error": "usa POST"}, origin)
        elif method == "POST" and path == "/reload":
            if not config_path:
                await _http_reply(writer, 400, {"ok": False, "error": "sin servers.json"}, origin)
            else:
                try:
                    configs, _ = load_config(config_path)
                    report = await sup.apply(configs)
                    sup.config_error = None
                    await _http_reply(writer, 200, {"ok": True, **report, "servers": sup.snapshot()}, origin)
                except Exception as err:  # noqa: BLE001
                    sup.config_error = str(err)
                    await _http_reply(writer, 500, {"ok": False, "error": f"servers.json invalido: {err}"}, origin)
        elif method == "POST" and path == "/shutdown":
            await _http_reply(writer, 200, {"ok": True, "bye": True}, origin)
            log.info("Apagado solicitado por el puerto de control")
            sup.stop_event.set()
        elif method == "POST" and path == "/restart":
            await _http_reply(writer, 200, {"ok": True, "restarting": True, "supervised": SUPERVISED}, origin)
            log.info("Reinicio solicitado por el puerto de control")
            sup.restart_requested = True
            sup.stop_event.set()
        elif method == "POST" and path == "/open-config":
            if not config_path or not Path(config_path).exists():
                await _http_reply(writer, 400, {"ok": False, "error": "no hay servers.json que abrir"}, origin)
            else:
                opened, detail = _open_in_editor(Path(config_path))
                body = {"ok": opened, "path": str(config_path)}
                if not opened:
                    body["error"] = detail
                await _http_reply(writer, 200 if opened else 500, body, origin)
        else:
            await _http_reply(writer, 404, {"ok": False, "error": "ruta desconocida"}, origin)
    except Exception as err:  # noqa: BLE001
        log.debug("control: %s", err)
    finally:
        try:
            writer.close()
        except Exception:  # noqa: BLE001
            pass


def ctl(port: int, method: str, path: str, timeout: float = 2.0) -> dict | None:
    """Cliente sincrono del puerto de control. None si no hay puente escuchando."""
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method, data=b"" if method == "POST" else None)
        with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 (solo localhost)
            return json.loads(res.read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None


# -------------------------------------------------------------------- principal

def _mtime(path: Path) -> tuple[int, int]:
    """Huella del archivo (fecha + tamano): detecta guardados aunque la fecha no cambie."""
    try:
        st = path.stat()
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return (0, 0)


async def _watch(sup: Supervisor, path: Path) -> None:
    """Recarga servers.json al guardarlo y reintenta los servidores que fallaron (puerto ocupado, etc.)."""
    last = _mtime(path)
    ticks = 0
    while not sup.stop_event.is_set():
        try:
            await asyncio.wait_for(sup.stop_event.wait(), 2)
        except asyncio.TimeoutError:
            pass
        if sup.stop_event.is_set():
            break
        ticks += 1
        current = _mtime(path)
        if current != last:
            last = current
            try:
                configs, _ = load_config(path)
                report = await sup.apply(configs)
                sup.config_error = None
                log.info("servers.json recargado: %s", report)
            except Exception as err:  # noqa: BLE001
                sup.config_error = str(err)
                log.error("servers.json invalido (se mantiene la configuracion anterior): %s", err)
        elif ticks % 5 == 0:
            await sup.retry_failed()


async def run(configs: list[ServerConfig], control_port: int = 0, config_path: Path | None = None,
              config_error: str | None = None) -> bool:
    """Corre el puente hasta que lo apaguen. Devuelve True si se pidio un REINICIO."""
    sup = Supervisor()
    sup.config_error = config_error
    await sup.apply(configs)
    control = None
    watcher = None
    if control_port:
        try:
            control = await asyncio.start_server(lambda r, w: _control_handler(r, w, sup, config_path), "127.0.0.1", control_port)
            log.info("Control en http://127.0.0.1:%d  (/health /servers /reload /shutdown)", control_port)
        except OSError as err:
            log.error("Puerto de control %d no disponible: %s (la extension no podra detectar servidores)", control_port, err)
    if config_path:
        watcher = asyncio.create_task(_watch(sup, config_path))
    try:
        await sup.stop_event.wait()
    finally:
        if watcher:
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)
        if control:
            control.close()
            try:
                await asyncio.wait_for(control.wait_closed(), 2)
            except Exception:  # noqa: BLE001
                pass
        await sup.stop_all()
    return sup.restart_requested


def _resolve_script_args(command: list[str], cwd: Path, base: Path) -> list[str]:
    """Un script relativo (p. ej. server/examples/demo_mcp_server.py) se busca en el cwd, junto a servers.json y en la raiz del proyecto."""
    out = list(command)
    for i, arg in enumerate(out[1:], start=1):
        if arg.startswith("-") or Path(arg).is_absolute() or not arg.lower().endswith((".py", ".pyw", ".js", ".mjs", ".cjs")):
            continue
        for root in (cwd, base, base.parent):
            candidate = root / arg
            if candidate.is_file():
                out[i] = str(candidate)
                break
    return out


def load_config(path: Path) -> tuple[list[ServerConfig], int | None]:
    """Lee servers.json. Cualquier problema se reporta como ValueError con un mensaje que el usuario puede entender."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8-sig"))  # utf-8-sig: tolera el BOM que mete PowerShell
    except json.JSONDecodeError as err:
        raise ValueError(f"JSON mal escrito (linea {err.lineno}, columna {err.colno}): {err.msg}") from err
    except OSError as err:
        raise ValueError(f"no se pudo leer {Path(path).name}: {err.strerror or err}") from err
    entries = data if isinstance(data, list) else (data.get("servers") if isinstance(data, dict) else None)
    if not isinstance(entries, list):
        raise ValueError('falta la lista "servers": [ ... ]')
    base = Path(path).resolve().parent
    configs: list[ServerConfig] = []
    names: set[str] = set()
    for n, entry in enumerate(entries, start=1):
        if not isinstance(entry, dict):
            raise ValueError(f"el servidor #{n} debe ser un objeto {{ ... }}")
        if entry.get("disabled") or entry.get("enabled") is False:
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f'el servidor #{n} no tiene "name"')
        label = f'"{name}"'
        if name in names:
            raise ValueError(f"el nombre {label} esta repetido")
        names.add(name)
        command = entry.get("command")
        if isinstance(command, str) and command.strip():
            try:
                argv = shlex.split(command, posix=not WIN)
            except ValueError as err:
                raise ValueError(f'{label}: "command" mal escrito ({err})') from err
        elif isinstance(command, list) and command and all(isinstance(c, (str, int, float)) for c in command):
            argv = [str(c) for c in command]
        else:
            raise ValueError(f'{label}: "command" debe ser una lista no vacia, por ejemplo ["python", "mi_mcp.py"]')
        try:
            port = int(entry["port"])
        except (KeyError, TypeError, ValueError):
            raise ValueError(f'{label}: falta "port" (un numero, por ejemplo 8080)') from None
        if not 1 <= port <= 65535:
            raise ValueError(f'{label}: "port" debe estar entre 1 y 65535')
        env = entry.get("env") or {}
        if not isinstance(env, dict):
            raise ValueError(f'{label}: "env" debe ser un objeto {{ "VARIABLE": "valor" }}')
        cwd = entry.get("cwd") or str(base)
        configs.append(ServerConfig(
            name=name,
            command=_resolve_script_args(argv, Path(cwd), base),
            port=port,
            host=entry.get("host", "127.0.0.1"),
            cwd=cwd,
            env={str(k): str(v) for k, v in env.items()},
            token=entry.get("token"),
        ))
    control = data.get("control_port") if isinstance(data, dict) else None
    try:
        return configs, (int(control) if control is not None else None)
    except (TypeError, ValueError):
        raise ValueError('"control_port" debe ser un numero') from None

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Puente WebSocket <-> MCP (stdio) para Web MCP Bridge.",
        usage="%(prog)s [--port N] [--name NOMBRE] -- COMANDO [ARGS...]\n       %(prog)s --config servers.json [--restart | --stop | --status | --reload]",
    )
    parser.add_argument("--config", type=Path, help="JSON con varios servidores (ver servers.example.json)")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--host", default="127.0.0.1", help="Por seguridad, solo 127.0.0.1 por defecto")
    parser.add_argument("--name", default="mcp", help="Nombre para los logs")
    parser.add_argument("--token", help="Exige ?token=... en la URL del WebSocket")
    parser.add_argument("--cwd", help="Directorio de trabajo del servidor MCP")
    parser.add_argument("--log-file", type=Path, help="Escribe los logs en este archivo (util como servicio)")
    parser.add_argument("--control-port", type=int, default=None, help=f"Puerto de control/deteccion (defecto {DEFAULT_CONTROL_PORT}; 0 = desactivado)")
    parser.add_argument("--restart", action="store_true", help="Reinicia el puente (cierra el anterior y arranca uno nuevo en segundo plano)")
    parser.add_argument("--stop", action="store_true", help="Apaga el puente que este corriendo")
    parser.add_argument("--status", action="store_true", help="Muestra el estado de los servidores")
    parser.add_argument("--reload", action="store_true", help="Pide al puente que relea servers.json")
    parser.add_argument("--detach", action="store_true", help="Arranca en segundo plano y devuelve el control")
    parser.add_argument("-v", "--verbose", action="store_true")
    parser.add_argument("command", nargs=argparse.REMAINDER, help="Comando que lanza el servidor MCP (stdio)")
    return parser


def _setup_logging(args) -> None:
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
        filename=str(args.log_file) if args.log_file else None,
        encoding="utf-8" if args.log_file else None,
    )


def _print_status(port: int) -> bool:
    info = ctl(port, "GET", "/servers")
    if not info:
        print(f"El puente no esta corriendo (puerto de control {port}).")
        return False
    print(f"Puente v{info.get('version')} activo (pid {info.get('pid')}) - config: {info.get('config')}")
    if info.get("config_error"):
        print(f"  ! servers.json tiene un error: {info['config_error']}")
    for s in info["servers"]:
        mark = "OK " if s["status"] == "listening" else "ERR"
        print(f"  [{mark}] {s['name']:<22} {s['url']:<24} {s.get('error') or ''}")
    return True


def _stop_existing(control_port: int, ports: list[int]) -> None:
    """Apaga el puente anterior: primero con elegancia (/shutdown), luego liberando sus puertos."""
    if ctl(control_port, "GET", "/health"):
        print("  - apagando el puente anterior...")
        ctl(control_port, "POST", "/shutdown")
        end = time.time() + 8
        while time.time() < end and ctl(control_port, "GET", "/health"):
            time.sleep(0.3)
    _free_old_bridges(ports + [control_port])  # versiones viejas (sin puerto de control) o colgadas
    time.sleep(0.5)


def _spawn_detached(args, config: Path, control_port: int) -> None:
    exe = sys.executable
    if WIN:
        pyw = Path(exe).with_name("pythonw.exe")
        exe = str(pyw) if pyw.exists() else exe
    log_file = args.log_file or (Path(config).resolve().parent / "bridge.log")
    argv = [exe, str(Path(__file__).resolve()), "--config", str(Path(config).resolve()), "--control-port", str(control_port), "--log-file", str(log_file)]
    if args.verbose:
        argv.append("-v")
    clean_env = {k: v for k, v in os.environ.items() if k != "WMB_SUPERVISED"}  # el puente nuevo NO esta bajo el supervisor
    kwargs: dict = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "close_fds": True, "env": clean_env}
    if WIN:
        kwargs["creationflags"] = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED | NEW_GROUP | NO_WINDOW
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen(argv, **kwargs)  # noqa: S603


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    _setup_logging(args)

    if not args.config:
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        if args.stop or args.status or args.reload or args.restart:
            parser.error("--stop/--status/--reload/--restart necesitan --config servers.json")
        if not command:
            parser.error("indica el comando del servidor MCP tras `--` o usa --config")
        cfg = ServerConfig(name=args.name, command=command, port=args.port, host=args.host, cwd=args.cwd, token=args.token)
        control = args.control_port or 0
        try:
            asyncio.run(run([cfg], control_port=control))
        except KeyboardInterrupt:
            log.info("Detenido.")
        except OSError as err:
            log.error("No se pudo abrir el puerto: %s", err)
            return 1
        return 0

    initial_error: str | None = None
    try:
        configs, file_control = load_config(args.config)
    except ValueError as err:
        # El puente arranca igual (sin servidores) para que la extension pueda mostrar el error, abrir el archivo y reiniciarlo.
        configs, file_control, initial_error = [], None, str(err)
        log.error("servers.json invalido: %s", err)
        print(f"servers.json invalido: {err}")
        try:
            import re
            found = re.search(r"""["']control_port["']\s*:\s*(\d+)""", Path(args.config).read_text(encoding="utf-8-sig"))
            file_control = int(found.group(1)) if found else None
        except Exception:  # noqa: BLE001
            pass
    control = args.control_port if args.control_port is not None else (file_control if file_control is not None else DEFAULT_CONTROL_PORT)
    ports = [c.port for c in configs]
    alive = ctl(control, "GET", "/health") if control else None

    if args.status:
        return 0 if _print_status(control) else 1
    if args.reload:
        if not alive:
            print("El puente no esta corriendo.")
            return 1
        ctl(control, "POST", "/reload", timeout=10)
        _print_status(control)
        return 0
    if args.stop:
        _stop_existing(control, ports)
        print("Puente detenido.")
        return 0

    if args.restart:
        print("Reiniciando el puente...")
        _stop_existing(control, ports)
    elif alive:
        print("Ya hay un puente corriendo: recargo servers.json (usa --restart para reiniciarlo del todo).")
        ctl(control, "POST", "/reload", timeout=10)
        _print_status(control)
        return 0
    elif _free_old_bridges(ports, quiet=True):
        time.sleep(0.7)  # un puente viejo (sin control port) tenia los puertos: se cerro y arrancamos el nuevo

    if args.restart or args.detach:
        _spawn_detached(args, args.config, control)
        end = time.time() + 20
        while time.time() < end and not ctl(control, "GET", "/health"):
            time.sleep(0.4)
        if not _print_status(control):
            print("No arranco a tiempo: revisa bridge.log")
            return 1
        return 0

    wants_restart = False
    try:
        wants_restart = asyncio.run(run(configs, control_port=control, config_path=args.config, config_error=initial_error))
    except KeyboardInterrupt:
        log.info("Detenido.")
    except OSError as err:
        log.error("No se pudo abrir el puerto: %s", err)
        return 1
    if wants_restart:
        if SUPERVISED:
            log.info("Reinicio: el supervisor (start_bridge_loop) levantara el puente de nuevo.")
        else:
            log.info("Reinicio: arrancando un puente nuevo en segundo plano.")
            _spawn_detached(args, args.config, control)
    return 0


if __name__ == "__main__":
    sys.exit(main())
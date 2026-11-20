#!/usr/bin/env python3
"""
mcp_ws_bridge.py — Puente WebSocket ⇄ servidor MCP (stdio).

Los servidores MCP locales (como `astrax-mcp`) hablan JSON-RPC por stdin/stdout.
El navegador solo puede hablar WebSocket. Este script lanza el servidor MCP como
subproceso y reenvía los mensajes JSON-RPC en ambos sentidos.

Uso rápido
----------
    # Un servidor
    python mcp_ws_bridge.py --port 8080 -- python -m astrax_mcp

    # Otro servidor en otro puerto
    python mcp_ws_bridge.py --port 8081 -- npx -y @modelcontextprotocol/server-filesystem ~/proyectos

    # Varios servidores a la vez desde un archivo de configuración
    # (se recarga solo al guardarlo: no hace falta reiniciar el puente)
    python mcp_ws_bridge.py --config servers.json

Formatos de servers.json admitidos
----------------------------------
    {"servers": [{"name": "demo", "port": 8090, "command": ["python", "demo.py"]}]}
    {"mcpServers": {"archivos": {"command": "npx", "args": ["-y", "…"], "port": 8091}}}   # estilo Claude Desktop
    {"archivos": {"command": "npx", "args": ["-y", "…"], "port": 8091}}
    {"autocad": {"url": "http://127.0.0.1:8765/mcp"}}   # MCP por HTTP: no se arranca, solo se anuncia
Si una entrada no indica `port`, se le asigna uno libre a partir de 8800.

Descubrimiento
--------------
Con --config, el puente abre además un canal de control en ws://127.0.0.1:47615 (--control-port).
Al conectarse, envía la lista de servidores configurados ({"type": "servers", "servers": […]})
y cierra. La extensión lo usa para mostrar los MCP del PC sin escribir direcciones a mano.
Mismas reglas de seguridad: solo 127.0.0.1 y solo orígenes de extensión.

Seguridad
---------
* Solo escucha en 127.0.0.1 por defecto.
* Rechaza conexiones cuyo `Origin` sea una página web (p. ej. https://chatgpt.com):
  solo acepta extensiones (`chrome-extension://…`) o clientes sin Origin (CLI).
  Así ninguna web puede ejecutar tus herramientas conectándose a localhost.
* Opcional: `--token SECRETO` exige `ws://localhost:8080?token=SECRETO`.
"""
from __future__ import annotations

import argparse
import asyncio
import hmac
import json
import logging
import os
import shutil
import sys
import sysconfig
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:  # websockets >= 13
    from websockets.asyncio.server import serve as ws_serve
except ImportError:  # websockets 12
    from websockets import serve as ws_serve  # type: ignore[assignment]

import auditoria  # noqa: E402  (registro de auditoría de las llamadas; mismo directorio)

log = logging.getLogger("mcp_ws_bridge")

STDIO_LIMIT = 32 * 1024 * 1024  # tamaño máximo de un mensaje JSON-RPC
CONTROL_PORT = 47615              # canal de descubrimiento (lista de servidores configurados)
# ID fijo de la extensión (campo "key" de manifest.json). Solo ella puede LEER o ESCRIBIR servers.json.
EXTENSION_ID = "kpjokcdpjbiljllmdobofmomhifebbbo"
CONTROL_REQUEST_TIMEOUT = 10     # segundos que el canal espera una petición tras enviar la lista
MAX_CONFIG_BYTES = 256 * 1024
AUTO_PORT_START = 8800           # primer puerto para entradas sin `port`
RELOAD_INTERVAL = 2.0            # segundos entre comprobaciones de cambios en servers.json
ALLOWED_ORIGIN_PREFIXES = ("chrome-extension://", "moz-extension://")


@dataclass
class ServerConfig:
    """Configuración de un servidor MCP expuesto por WebSocket."""

    name: str
    command: list[str]
    port: int = 8080
    host: str = "127.0.0.1"
    cwd: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    token: str | None = None
    allowed_origins: tuple[str, ...] = ALLOWED_ORIGIN_PREFIXES
    url: str | None = None  # MCP por HTTP: el puente NO lo arranca, solo lo anuncia (la extensión se conecta directa)


# ───────────────────────── Utilidades ─────────────────────────

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


def _resolve_executable(command: str) -> str:
    """Encuentra el ejecutable: PATH (resuelve npx.cmd en Windows) y, si no, la carpeta de scripts del Python
    que ejecuta el puente (p. ej. C:\\Python314\\Scripts\\mcp-proxy.exe aunque esa carpeta no esté en el PATH)."""
    found = shutil.which(command)
    if found:
        return found
    base = Path(sys.executable).parent
    folders = [base / "Scripts", base, base.parent / "Scripts"]
    # Instalaciones con `pip install --user` (lo que hace pip cuando la carpeta de Python no admite escritura):
    # en Windows van a %APPDATA%\\Python\\Python3XX\\Scripts, que normalmente NO está en el PATH.
    scheme = "nt_user" if os.name == "nt" else ("osx_framework_user" if sys.platform == "darwin" else "posix_user")
    try:
        folders.append(Path(sysconfig.get_path("scripts", scheme)))
    except (KeyError, ValueError):
        pass
    for folder in folders:
        found = shutil.which(command, path=str(folder))
        if found:
            return found
    return command


def _close_reason(text: str) -> str:
    """Motivo de cierre de WebSocket: máximo 123 bytes UTF-8."""
    data = text.encode("utf-8")[:120]
    return data.decode("utf-8", errors="ignore")


async def _spawn(cfg: ServerConfig) -> asyncio.subprocess.Process:
    executable = _resolve_executable(cfg.command[0])
    extra = {"creationflags": 0x08000000} if sys.platform == "win32" else {}  # CREATE_NO_WINDOW
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
    """Cierra el subproceso con elegancia (stdin → terminate → kill)."""
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


# ───────────────────────── Tuberías ─────────────────────────

async def _stdout_to_ws(proc: asyncio.subprocess.Process, ws) -> None:
    """stdout del servidor MCP → WebSocket (una línea = un mensaje JSON-RPC)."""
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
    """WebSocket → stdin del servidor MCP. Responde `ping` directamente."""
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


async def _log_stderr(proc: asyncio.subprocess.Process, name: str, tail: list[str] | None = None) -> None:
    assert proc.stderr is not None
    while True:
        line = await proc.stderr.readline()
        if not line:
            return
        text = line.decode("utf-8", errors="replace").rstrip()
        log.info("[%s] %s", name, text)
        if tail is not None and text.strip():
            tail.append(text.strip())
            del tail[:-5]


# ───────────────────────── Servidor ─────────────────────────

async def handle_client(ws, cfg: ServerConfig) -> None:
    """Cada conexión WebSocket obtiene su propio subproceso MCP."""
    path, headers = _request_parts(ws)
    origin = headers.get("Origin")
    if not _origin_allowed(origin, cfg):
        log.warning("[%s] Conexión rechazada: Origin no permitido (%s)", cfg.name, origin)
        await ws.close(1008, "Origin no permitido")
        return
    if not _token_ok(path, cfg):
        log.warning("[%s] Conexión rechazada: token inválido", cfg.name)
        await ws.close(1008, "Token inválido")
        return

    try:
        proc = await _spawn(cfg)
    except (FileNotFoundError, PermissionError, OSError) as err:
        log.error("[%s] No se pudo ejecutar %s: %s", cfg.name, cfg.command, err)
        await ws.close(1011, _close_reason(f"No se encontró o no se pudo ejecutar «{cfg.command[0]}»"))
        return

    log.info("[%s] Cliente conectado → pid %s", cfg.name, proc.pid)
    stdout_task = asyncio.create_task(_stdout_to_ws(proc, ws))
    pipes = {stdout_task, asyncio.create_task(_ws_to_stdin(proc, ws))}
    stderr_tail: list[str] = []
    stderr_task = asyncio.create_task(_log_stderr(proc, cfg.name, stderr_tail))
    try:
        done, _ = await asyncio.wait(pipes, return_when=asyncio.FIRST_COMPLETED)
        # El MCP terminó por su cuenta (stdout cerrado): se cierra el WebSocket explicando por qué.
        if stdout_task in done:
            try:
                await asyncio.wait_for(proc.wait(), 2)
            except asyncio.TimeoutError:
                pass
        if stdout_task in done and proc.returncode is not None:
            await asyncio.sleep(0.2)  # últimas líneas de stderr
            detail = stderr_tail[-1] if stderr_tail else "sin mensaje de error"
            log.warning("[%s] El MCP terminó (código %s): %s", cfg.name, proc.returncode, detail)
            try:
                await ws.close(1011, _close_reason(f"El MCP terminó (código {proc.returncode}): {detail}"))
            except Exception:  # noqa: BLE001
                pass
    finally:
        for task in (*pipes, stderr_task):
            task.cancel()
        await asyncio.gather(*pipes, stderr_task, return_exceptions=True)
        await _stop(proc)
        log.info("[%s] Cliente desconectado", cfg.name)


async def _serve(cfg: ServerConfig):
    server = await ws_serve(lambda ws, cfg=cfg: handle_client(ws, cfg), cfg.host, cfg.port, max_size=STDIO_LIMIT)
    log.info("✔ «%s» disponible en ws://%s:%d  →  %s", cfg.name, cfg.host, cfg.port, " ".join(cfg.command))
    return server


async def _close(server) -> None:
    server.close()
    try:
        await asyncio.wait_for(server.wait_closed(), 5)
    except Exception:  # noqa: BLE001
        pass


class BridgeManager:
    """Mantiene un listener WebSocket por servidor MCP y lo alinea con la configuración (recarga en caliente)."""

    def __init__(self, config_path: Path | None = None, owner_origin: str | None = None) -> None:
        self.active: dict[str, tuple[ServerConfig, object]] = {}
        self.remote: dict[str, ServerConfig] = {}  # MCP por HTTP (solo se anuncian)
        self.config_path = config_path
        self.owner_origin = owner_origin
        self.write_lock = asyncio.Lock()
        self.config_error: str | None = None  # último error al leer servers.json (se muestra en la extensión)

    def listing(self) -> list[dict]:
        local = [{"name": cfg.name, "port": cfg.port, "url": f"ws://localhost:{cfg.port}", "transport": "ws"}
                 for cfg, _ in self.active.values()]
        remote = [{"name": cfg.name, "url": cfg.url, "transport": "http"} for cfg in self.remote.values()]
        return local + remote

    async def apply(self, configs: list[ServerConfig]) -> None:
        self.remote = {cfg.name: cfg for cfg in configs if cfg.url}
        for cfg in self.remote.values():
            log.info("✔ «%s» (HTTP) anunciado: la extensión se conecta directamente a %s", cfg.name, cfg.url)
        wanted = {cfg.name: cfg for cfg in configs if not cfg.url}
        for name in list(self.active):
            cfg, server = self.active[name]
            if wanted.get(name) != cfg:  # eliminado o modificado → se cierra (y se reabre abajo si sigue)
                await _close(server)
                del self.active[name]
                log.info("■ «%s» detenido (puerto %d)", name, cfg.port)
        for name, cfg in wanted.items():
            if name in self.active:
                continue
            try:
                self.active[name] = (cfg, await _serve(cfg))
            except OSError as err:
                log.error("No se pudo abrir el puerto %d para «%s»: %s", cfg.port, name, err)

    async def close(self) -> None:
        for _, server in self.active.values():
            server.close()
        await asyncio.gather(*(s.wait_closed() for _, s in self.active.values()), return_exceptions=True)
        self.active.clear()


async def _reply(ws, **payload) -> None:
    await ws.send(json.dumps(payload, ensure_ascii=False))


async def _write_config(manager: BridgeManager, content: str) -> list[ServerConfig]:
    """Valida, guarda (con copia .bak) y aplica una configuración nueva. Lanza ValueError si no es válida."""
    if len(content.encode("utf-8")) > MAX_CONFIG_BYTES:
        raise ValueError("la configuración es demasiado grande")
    path = manager.config_path
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    try:
        configs = load_config(tmp)  # misma validación que al arrancar
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    if path.exists():
        path.with_name(path.name + ".bak").write_text(path.read_text(encoding="utf-8-sig"), encoding="utf-8")
    os.replace(tmp, path)
    await manager.apply(configs)
    return configs


def _git_info(root: Path) -> dict:
    """Rama, commit y origin/main del repositorio en `root`, leyendo .git sin ejecutar git."""
    git = root / ".git"

    def ref(name: str):
        f = git / name
        if f.is_file():
            return f.read_text(encoding="utf-8").strip() or None
        packed = git / "packed-refs"
        if packed.is_file():
            for line in packed.read_text(encoding="utf-8").splitlines():
                parts = line.split()
                if len(parts) == 2 and parts[1] == name:
                    return parts[0]
        return None

    head = (git / "HEAD").read_text(encoding="utf-8").strip()
    branch, commit = None, head
    if head.startswith("ref:"):
        name = head[4:].strip()
        branch, commit = name.removeprefix("refs/heads/"), ref(name)
    return {"name": root.name, "branch": branch, "commit": commit, "latest": ref("refs/remotes/origin/main")}


def repos_of(configs) -> list[dict]:
    """Repositorios git de los que salen los MCP (p. ej. mis-mcp), para que el panel muestre SU versión."""
    roots: dict[str, dict] = {}
    for cfg in configs:
        candidates = [Path(a) for a in cfg.command[1:] if a.lower().endswith((".py", ".js", ".mjs", ".ps1"))]
        if cfg.cwd:
            candidates.append(Path(cfg.cwd))
        for cand in candidates:
            root = next((d for d in [cand, *cand.parents] if (d / ".git").is_dir()), None)
            if root is not None:
                roots.setdefault(str(root), {"root": root, "servers": set()})["servers"].add(cfg.name)
                break
    out = []
    for item in roots.values():
        try:
            info = _git_info(item["root"])
        except OSError:
            continue
        info["servers"] = sorted(item["servers"])
        info["ruta"] = str(item["root"])
        out.append(info)
    return sorted(out, key=lambda r: r["name"])


def scripts_actualizacion(manager) -> list[Path]:
    """Scripts que actualizan desde GitHub: los de los repos de los MCP y, AL FINAL, el de la propia extensión
    (puede reiniciar este puente si cambió server/)."""
    out = []
    for repo in repos_of([cfg for cfg, _ in manager.active.values()]):
        s = Path(repo["ruta"]) / "actualizacion" / "actualizar.ps1"
        if s.is_file():
            out.append(s)
    propio = Path(__file__).resolve().parent.parent / "scripts" / "windows" / "update.ps1"
    if propio.is_file() and propio not in out:
        out.append(propio)
    return out


def lanzar_actualizacion(manager) -> list[str]:
    """Ejecuta ya (sin esperar a las tareas programadas) los scripts de actualización, en un proceso aparte."""
    import subprocess
    if os.name != "nt":
        raise RuntimeError("solo en Windows")
    scripts = scripts_actualizacion(manager)
    if not scripts:
        raise RuntimeError("no encontré scripts de actualización")
    py = Path(sys.executable)
    py = py.with_name("python.exe") if py.name.lower() == "pythonw.exe" and py.with_name("python.exe").exists() else py
    partes = []
    for s in scripts:
        extra = f" -Python '{py}'" if s.name == "update.ps1" else ""
        partes.append(f"& '{s}'{extra}")
    comando = "; ".join(partes)
    kw = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
    args = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", comando]
    flags = 0x00000008 | 0x00000200                      # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    try:
        subprocess.Popen(args, creationflags=flags | 0x01000000, **kw)   # + BREAKAWAY_FROM_JOB
    except OSError:
        subprocess.Popen(args, creationflags=flags, **kw)
    log.info("⟳ actualización pedida desde la extensión: %s", ", ".join(s.parent.parent.name if s.name == "actualizar.ps1"
                                                                       else "web-mcp-bridge" for s in scripts))
    return [s.parent.parent.name if s.name == "actualizar.ps1" else "web-mcp-bridge" for s in scripts]


async def handle_control(ws, manager: BridgeManager) -> None:
    """Canal de control.

    - Al conectarse: envía la lista de servidores configurados (lectura, cualquier extensión).
    - Después acepta UNA petición, solo de la extensión propietaria (`owner_origin`):
        {"type": "get_config"}                 → {"type": "config", "content": "<servers.json>", "path": "..."}
        {"type": "put_config", "content": "…"} → {"type": "result", "ok": true, "servers": [...]} | {"ok": false, "error": "…"}
    """
    _, headers = _request_parts(ws)
    origin = headers.get("Origin")
    if not (origin is None or origin.startswith(ALLOWED_ORIGIN_PREFIXES)):
        log.warning("[control] Conexión rechazada: Origin no permitido (%s)", origin)
        await ws.close(1008, "Origin no permitido")
        return
    await _reply(ws, type="servers", servers=manager.listing(), editable=bool(manager.config_path),
                 config_error=manager.config_error, repos=repos_of([cfg for cfg, _ in manager.active.values()]))
    try:
        raw = await asyncio.wait_for(ws.recv(), CONTROL_REQUEST_TIMEOUT)
    except Exception:  # noqa: BLE001  (el cliente cerró o no pidió nada)
        return
    try:
        request = json.loads(raw)
        kind = request.get("type")
    except (ValueError, AttributeError):
        await _reply(ws, type="result", ok=False, error="petición no válida")
        return
    if kind not in ("get_config", "put_config", "audit", "update_now"):
        await _reply(ws, type="result", ok=False, error=f"petición desconocida: {kind}")
        return
    if kind == "update_now":
        if origin != manager.owner_origin:
            await _reply(ws, type="result", ok=False, error="no autorizado")
            return
        try:
            repos = lanzar_actualizacion(manager)
        except Exception as err:  # noqa: BLE001
            await _reply(ws, type="result", ok=False, error=str(err))
            return
        await _reply(ws, type="result", ok=True, repos=repos)
        return
    if kind == "audit":
        if origin != manager.owner_origin:
            await _reply(ws, type="result", ok=False, error="no autorizado")
            return
        carpeta = (manager.config_path.parent if manager.config_path else Path(__file__).resolve().parent) / "auditoria"
        try:
            n = auditoria.escribir(carpeta, request.get("entries"), extra=request.get("extra") if isinstance(request.get("extra"), dict) else None)
        except (ValueError, OSError) as err:
            await _reply(ws, type="result", ok=False, error=str(err))
            return
        await _reply(ws, type="result", ok=True, written=n)
        return
    if not manager.config_path:
        await _reply(ws, type="result", ok=False, error="el puente no se inició con --config")
        return
    if origin != manager.owner_origin:
        log.warning("[control] %s rechazado: solo la extensión Web MCP Bridge puede usarlo (Origin %s)", kind, origin)
        await _reply(ws, type="result", ok=False, error="no autorizado")
        return
    if kind == "get_config":
        path = manager.config_path
        content = path.read_text(encoding="utf-8-sig") if path.exists() else '{\n}\n'
        await _reply(ws, type="config", content=content, path=str(path))
        return
    content = request.get("content")
    if not isinstance(content, str):
        await _reply(ws, type="result", ok=False, error="falta el contenido")
        return
    async with manager.write_lock:
        try:
            configs = await _write_config(manager, content)
        except Exception as err:  # noqa: BLE001
            log.warning("[control] servers.json NO guardado: %s", err)
            await _reply(ws, type="result", ok=False, error=str(err))
            return
    manager.config_error = None
    log.info("✎ servers.json guardado desde la extensión (%d servidor(es)): %s", len(configs), ", ".join(c.name for c in configs))
    await _reply(ws, type="result", ok=True, servers=manager.listing())


async def _watch_config(path: Path, manager: BridgeManager) -> None:
    """Recarga servers.json cuando cambia. Si el archivo nuevo es inválido, se mantiene la configuración actual."""
    def stamp():
        try:
            return path.stat().st_mtime_ns
        except OSError:
            return None
    last = stamp()
    while True:
        await asyncio.sleep(RELOAD_INTERVAL)
        current = stamp()
        if current == last:
            continue
        last = current
        try:
            configs = load_config(path)
        except Exception as err:  # noqa: BLE001
            log.error("servers.json inválido, se mantiene la configuración anterior: %s", err)
            manager.config_error = str(err)
            continue
        manager.config_error = None
        log.info("↻ servers.json cambió: aplicando %d servidor(es)", len(configs))
        await manager.apply(configs)


async def run(configs: list[ServerConfig], config_path: Path | None = None, control_port: int = 0,
              owner_origin: str | None = None) -> None:
    manager = BridgeManager(config_path, owner_origin or f"chrome-extension://{EXTENSION_ID}")
    control = None
    tasks = []
    if config_path and not configs:
        try:
            load_config(config_path)  # solo para conocer el error y mostrarlo en la extensión
        except Exception as err:  # noqa: BLE001
            manager.config_error = str(err)
    try:
        await manager.apply(configs)
        if not manager.active and not config_path:  # con --config se sigue: el editor de la extensión puede arreglarlo
            raise OSError("ningún servidor pudo arrancar")
        if control_port:
            try:
                control = await ws_serve(lambda ws: handle_control(ws, manager), "127.0.0.1", control_port)
                log.info("✔ Descubrimiento disponible en ws://127.0.0.1:%d", control_port)
            except OSError as err:
                log.error("No se pudo abrir el canal de descubrimiento (%d): %s. Otro programa usa ese puerto; "
                          "los MCP funcionan, pero la extensión no podrá detectarlos.", control_port, err)
        if config_path:
            tasks.append(asyncio.create_task(_watch_config(config_path, manager)))
        await asyncio.Event().wait()  # bloquea hasta Ctrl+C
    finally:
        for task in tasks:
            task.cancel()
        if control:
            await _close(control)
        await manager.close()


# ───────────────────────── CLI ─────────────────────────

def _entries(data) -> list[dict]:
    """Normaliza los formatos admitidos a una lista de entradas con `name`."""
    if isinstance(data, dict) and isinstance(data.get("servers"), list):
        return [dict(e) for e in data["servers"]]
    mapping = data.get("mcpServers", data) if isinstance(data, dict) else None
    if not isinstance(mapping, dict):
        raise ValueError("formato no reconocido: se esperaba {\"servers\": [...]}, {\"mcpServers\": {...}} o {nombre: {...}}")
    entries = []
    for name, entry in mapping.items():
        if not isinstance(entry, dict):
            raise ValueError(f"«{name}» debe ser un objeto con al menos `command`")
        entries.append({"name": name, **entry})
    return entries


def load_config(path: Path) -> list[ServerConfig]:
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    entries = _entries(data)
    used = {int(e["port"]) for e in entries if e.get("port") is not None and not e.get("url")}
    next_port = AUTO_PORT_START
    configs, names = [], set()
    for entry in entries:
        name = str(entry.get("name") or "").strip()
        if not name:
            raise ValueError("cada servidor necesita un nombre")
        if name in names:
            raise ValueError(f"nombre repetido: «{name}»")
        names.add(name)
        if entry.get("disabled"):  # detenido desde mcp_ctl.py: sigue en el archivo pero no se arranca
            continue
        if entry.get("url") and not entry.get("command"):
            url = str(entry["url"]).strip()
            if not url.startswith(("http://", "https://")):
                raise ValueError(f"«{name}»: la url debe empezar por http:// o https://")
            configs.append(ServerConfig(name=name, command=[], port=0, url=url))
            continue
        command = entry.get("command")
        command = [command] if isinstance(command, str) else list(command or [])
        command += [str(a) for a in entry.get("args", [])]
        if not command:
            raise ValueError(f"«{name}» no tiene `command`")
        if entry.get("port") is None:
            while next_port in used:
                next_port += 1
            entry["port"] = next_port
            used.add(next_port)
        configs.append(
            ServerConfig(
                name=name,
                command=command,
                port=int(entry["port"]),
                host=entry.get("host", "127.0.0.1"),
                cwd=entry.get("cwd"),
                env={str(k): str(v) for k, v in (entry.get("env") or {}).items()},
                token=entry.get("token"),
            )
        )
    ports = [c.port for c in configs if not c.url]
    if len(ports) != len(set(ports)):
        raise ValueError(f"hay puertos repetidos: {sorted(p for p in set(ports) if ports.count(p) > 1)}")
    return configs


def parse_args(argv: list[str] | None = None) -> tuple[list[ServerConfig], Path | None, int, str]:
    parser = argparse.ArgumentParser(
        description="Puente WebSocket ⇄ MCP (stdio) para Web MCP Bridge.",
        usage="%(prog)s [--port N] [--name NOMBRE] -- COMANDO [ARGS…]\n       %(prog)s --config servers.json",
    )
    parser.add_argument("--config", type=Path, help="JSON con varios servidores (ver servers.example.json)")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--host", default="127.0.0.1", help="Por seguridad, solo 127.0.0.1 por defecto")
    parser.add_argument("--name", default="mcp", help="Nombre para los logs")
    parser.add_argument("--token", help="Exige ?token=… en la URL del WebSocket")
    parser.add_argument("--cwd", help="Directorio de trabajo del servidor MCP")
    parser.add_argument("--control-port", type=int, default=None,
                        help=f"Canal de descubrimiento (por defecto {CONTROL_PORT} con --config; 0 = desactivado)")
    parser.add_argument("--extension-id", default=EXTENSION_ID,
                        help="ID de la extensión autorizada a leer/editar servers.json desde el popup")
    parser.add_argument("--log-file", type=Path, help="Escribe los logs en este archivo (útil como servicio)")
    parser.add_argument("-v", "--verbose", action="store_true")
    parser.add_argument("command", nargs=argparse.REMAINDER, help="Comando que lanza el servidor MCP (stdio)")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
        filename=str(args.log_file) if args.log_file else None,
        encoding="utf-8" if args.log_file else None,
    )
    logging.getLogger("websockets").setLevel(logging.WARNING)  # sin «connection open» en cada consulta del popup

    if args.config:
        control = CONTROL_PORT if args.control_port is None else args.control_port
        owner = f"chrome-extension://{args.extension_id}"
        try:
            configs = load_config(args.config)
        except (OSError, ValueError) as err:
            # Se arranca igualmente (sin MCP) para poder corregir servers.json desde la extensión.
            log.error("servers.json no es válido (%s). Arranco sin MCP: corrígelo desde la extensión.", err)
            configs = []
        return configs, args.config.resolve(), control, owner

    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("indica el comando del servidor MCP tras `--` o usa --config")
    single = [ServerConfig(name=args.name, command=command, port=args.port, host=args.host, cwd=args.cwd, token=args.token)]
    return single, None, args.control_port or 0, f"chrome-extension://{args.extension_id}"


def main(argv: list[str] | None = None) -> int:
    try:
        configs, config_path, control_port, owner = parse_args(argv)
    except (OSError, ValueError) as err:  # servers.json ausente, JSON inválido o formato no reconocido
        log.error("No se pudo leer la configuración: %s", err)
        return 1
    try:
        asyncio.run(run(configs, config_path, control_port, owner))
    except KeyboardInterrupt:
        log.info("Detenido.")
    except OSError as err:
        log.error("No se pudo abrir el puerto: %s", err)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

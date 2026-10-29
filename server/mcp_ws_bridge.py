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
    python mcp_ws_bridge.py --config servers.json

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
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:  # websockets >= 13
    from websockets.asyncio.server import serve as ws_serve
except ImportError:  # websockets 12
    from websockets import serve as ws_serve  # type: ignore[assignment]

log = logging.getLogger("mcp_ws_bridge")

STDIO_LIMIT = 32 * 1024 * 1024  # tamaño máximo de un mensaje JSON-RPC
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


async def _spawn(cfg: ServerConfig) -> asyncio.subprocess.Process:
    executable = shutil.which(cfg.command[0]) or cfg.command[0]  # resuelve npx.cmd en Windows
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


async def _log_stderr(proc: asyncio.subprocess.Process, name: str) -> None:
    assert proc.stderr is not None
    while True:
        line = await proc.stderr.readline()
        if not line:
            return
        log.info("[%s] %s", name, line.decode("utf-8", errors="replace").rstrip())


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
    except (FileNotFoundError, PermissionError) as err:
        log.error("[%s] No se pudo ejecutar %s: %s", cfg.name, cfg.command, err)
        await ws.close(1011, "No se pudo iniciar el servidor MCP")
        return

    log.info("[%s] Cliente conectado → pid %s", cfg.name, proc.pid)
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


async def run(configs: list[ServerConfig]) -> None:
    servers = []
    try:
        for cfg in configs:
            server = await ws_serve(
                lambda ws, cfg=cfg: handle_client(ws, cfg),
                cfg.host,
                cfg.port,
                max_size=STDIO_LIMIT,
            )
            servers.append(server)
            log.info("✔ «%s» disponible en ws://%s:%d  →  %s", cfg.name, cfg.host, cfg.port, " ".join(cfg.command))
        await asyncio.Event().wait()  # bloquea hasta Ctrl+C
    finally:
        for server in servers:
            server.close()
        await asyncio.gather(*(s.wait_closed() for s in servers), return_exceptions=True)


# ───────────────────────── CLI ─────────────────────────

def load_config(path: Path) -> list[ServerConfig]:
    data = json.loads(path.read_text(encoding="utf-8"))
    configs = []
    for entry in data["servers"]:
        configs.append(
            ServerConfig(
                name=entry["name"],
                command=list(entry["command"]),
                port=int(entry["port"]),
                host=entry.get("host", "127.0.0.1"),
                cwd=entry.get("cwd"),
                env=entry.get("env", {}),
                token=entry.get("token"),
            )
        )
    return configs


def parse_args(argv: list[str] | None = None) -> list[ServerConfig]:
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

    if args.config:
        return load_config(args.config)

    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("indica el comando del servidor MCP tras `--` o usa --config")
    return [ServerConfig(name=args.name, command=command, port=args.port, host=args.host, cwd=args.cwd, token=args.token)]


def main(argv: list[str] | None = None) -> int:
    configs = parse_args(argv)
    try:
        asyncio.run(run(configs))
    except KeyboardInterrupt:
        log.info("Detenido.")
    except OSError as err:
        log.error("No se pudo abrir el puerto: %s", err)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Servidor MCP de shell (stdio, sin dependencias).

Tools:
  run          ejecuta un comando y devuelve stdout+stderr (con timeout).
  info         informacion del sistema: SO, shell, usuario, cwd, python,
               unidades/discos y comandos utiles segun la plataforma.

Seguridad: los comandos se ejecutan con subprocess sin shell=True (salvo
cuando se pide explicitamente), con timeout y limite de salida.
"""
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

TIMEOUT = 30
MAX_OUT = 64 * 1024

WIN = sys.platform == "win32"


def system_info() -> str:
    lines = [
        f"Sistema: {platform.system()} {platform.release()} ({platform.version()})",
        f"Maquina: {platform.machine()}",
        f"Usuario: {os.environ.get('USERNAME') or os.environ.get('USER') or '?'}",
        f"CWD: {os.getcwd()}",
        f"Python: {platform.python_version()}",
        f"Shell por defecto: {'PowerShell / cmd' if WIN else 'bash/sh'}",
    ]
    if WIN:
        lines.append("Comandos: dir, Get-ChildItem, where, tasklist, ipconfig, systeminfo, type")
        lines.append("Ejemplo run: {\"command\": [\"cmd\", \"/c\", \"dir\"]}")
    else:
        lines.append("Comandos: ls, pwd, which, ps, uname, df -h, cat")
        lines.append("Ejemplo run: {\"command\": [\"bash\", \"-lc\", \"ls -la\"]}")
    return "\n".join(lines)


TOOLS = [
    {"name": "info",
     "description": "Info del sistema (SO, usuario, shell, comandos utiles). No requiere argumentos.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "run",
     "description": "Ejecuta un comando. command es una lista [programa, arg, ...]. shell=true permite tuberias.",
     "inputSchema": {"type": "object",
                     "properties": {
                         "command": {"type": "array", "items": {"type": "string"}},
                         "shell": {"type": "boolean"},
                         "cwd": {"type": "string"},
                         "timeout": {"type": "integer"},
                     },
                     "required": ["command"]}},
]


def run(args) -> str:
    cmd = args.get("command") or []
    if not cmd:
        return "Error: command vacio"
    if not all(isinstance(x, str) for x in cmd):
        return "Error: command debe ser lista de strings"
    use_shell = bool(args.get("shell", False))
    t = int(args.get("timeout", TIMEOUT))
    cwd = args.get("cwd")
    try:
        p = subprocess.run(
            cmd if not use_shell else " ".join(cmd),
            shell=use_shell,
            cwd=cwd,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=t,
        )
        out = (p.stdout or "") + (("\n[stderr]\n" + p.stderr) if p.stderr else "")
        if len(out) > MAX_OUT:
            out = out[:MAX_OUT] + "\n... (salida truncada)"
        return f"[exit={p.returncode}]\n{out or '(sin salida)'}"
    except subprocess.TimeoutExpired:
        return f"Error: timeout tras {t}s"
    except Exception as err:  # noqa: BLE001
        return f"Error: {err!r}"


def reply(msg_id, result=None, error=None):
    body = {"jsonrpc": "2.0", "id": msg_id}
    body.update({"error": error} if error else {"result": result})
    sys.stdout.write(json.dumps(body, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    for stream in (sys.stdin, sys.stdout):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        method, msg_id = msg.get("method"), msg.get("id")
        if msg_id is None:
            continue
        if method == "initialize":
            reply(msg_id, {"protocolVersion": "2025-03-26",
                           "capabilities": {"tools": {}},
                           "serverInfo": {"name": "shell-mcp", "version": "1.0"}})
        elif method == "tools/list":
            reply(msg_id, {"tools": TOOLS})
        elif method == "tools/call":
            params = msg.get("params", {})
            name = params.get("name")
            try:
                text = system_info() if name == "info" else run(params.get("arguments", {}))
                reply(msg_id, {"content": [{"type": "text", "text": text}], "isError": False})
            except Exception as err:  # noqa: BLE001
                reply(msg_id, {"content": [{"type": "text", "text": f"Error: {err!r}"}],
                               "isError": True})
        elif method == "ping":
            reply(msg_id, {})
        else:
            reply(msg_id, error={"code": -32601, "message": f"Method not supported: {method}"})


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
demo_mcp_server.py - Servidor MCP minimo (stdio, sin dependencias) para probar la extension.

    python server/mcp_ws_bridge.py --port 8080 --name demo -- python server/examples/demo_mcp_server.py

La herramienta `info_sistema` es la prueba mas rapida: devuelve datos reales de tu equipo.
"""
import json
import os
import platform
import shutil
import socket
import sys
import time
from datetime import datetime


def _memory() -> str:
    """RAM total/libre sin dependencias (Windows via ctypes, Linux via /proc)."""
    try:
        if sys.platform == "win32":
            import ctypes

            class MemStatus(ctypes.Structure):
                _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong),
                            ("total", ctypes.c_ulonglong), ("avail", ctypes.c_ulonglong),
                            ("tpage", ctypes.c_ulonglong), ("apage", ctypes.c_ulonglong),
                            ("tvirt", ctypes.c_ulonglong), ("avirt", ctypes.c_ulonglong),
                            ("ext", ctypes.c_ulonglong)]

            st = MemStatus()
            st.length = ctypes.sizeof(MemStatus)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st))
            total, free = st.total, st.avail
        else:
            info = {}
            with open("/proc/meminfo", encoding="utf-8") as f:
                for line in f:
                    key, _, rest = line.partition(":")
                    info[key] = int(rest.split()[0]) * 1024
            total, free = info["MemTotal"], info.get("MemAvailable", info["MemFree"])
        gb = 1024 ** 3
        return f"{(total - free) / gb:.1f} GB usados de {total / gb:.1f} GB ({free / gb:.1f} GB libres)"
    except Exception:  # noqa: BLE001
        return "no disponible"


def _uptime() -> str:
    try:
        if sys.platform == "win32":
            import ctypes
            seconds = ctypes.windll.kernel32.GetTickCount64() / 1000
        else:
            with open("/proc/uptime", encoding="utf-8") as f:
                seconds = float(f.read().split()[0])
        days, rest = divmod(int(seconds), 86400)
        hours, rest = divmod(rest, 3600)
        return f"{days} d {hours} h {rest // 60} min"
    except Exception:  # noqa: BLE001
        return "no disponible"


def system_info() -> str:
    anchor = os.path.splitdrive(os.getcwd())[0] + os.sep if sys.platform == "win32" else "/"
    disk = shutil.disk_usage(anchor)
    gb = 1024 ** 3
    rows = [
        ("Equipo", socket.gethostname()),
        ("Sistema", f"{platform.system()} {platform.release()} ({platform.version()})"),
        ("Procesador", f"{platform.processor() or platform.machine()} - {os.cpu_count()} hilos"),
        ("Memoria", _memory()),
        (f"Disco {anchor}", f"{disk.used / gb:.0f} GB usados de {disk.total / gb:.0f} GB ({disk.free / gb:.0f} GB libres)"),
        ("Encendido hace", _uptime()),
        ("Python", platform.python_version()),
        ("Fecha y hora", datetime.now().astimezone().isoformat(timespec="seconds")),
    ]
    return "\n".join(f"{k}: {v}" for k, v in rows)


TOOLS = [
    {
        "name": "info_sistema",
        "description": "Muestra informacion real del equipo: sistema operativo, procesador, memoria, disco, tiempo encendido y version de Python. Es la prueba mas rapida de que todo funciona.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "hora_actual",
        "description": "Devuelve la fecha y hora actuales del equipo del usuario.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "sumar",
        "description": "Suma dos numeros.",
        "inputSchema": {
            "type": "object",
            "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
            "required": ["a", "b"],
        },
    },
    {
        "name": "eco",
        "description": "Devuelve el mismo texto que recibe.",
        "inputSchema": {
            "type": "object",
            "properties": {"texto": {"type": "string", "description": "Texto a repetir"}},
            "required": ["texto"],
        },
    },
]


def call_tool(name: str, args: dict) -> str:
    if name == "info_sistema":
        return system_info()
    if name == "hora_actual":
        return datetime.now().astimezone().isoformat(timespec="seconds")
    if name == "sumar":
        return str(args["a"] + args["b"])
    if name == "eco":
        return str(args["texto"])
    raise KeyError(name)


def reply(msg_id, result=None, error=None) -> None:
    body = {"jsonrpc": "2.0", "id": msg_id}
    body.update({"error": error} if error else {"result": result})
    sys.stdout.write(json.dumps(body, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    for stream in (sys.stdin, sys.stdout):  # el puente habla UTF-8 en ambos sentidos
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        method, msg_id = msg.get("method"), msg.get("id")
        if msg_id is None:  # notificacion: no se responde
            continue
        if method == "initialize":
            reply(msg_id, {
                "protocolVersion": "2025-03-26",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "demo-mcp", "version": "1.1.0"},
            })
        elif method == "tools/list":
            reply(msg_id, {"tools": TOOLS})
        elif method == "tools/call":
            params = msg.get("params", {})
            try:
                text = call_tool(params["name"], params.get("arguments", {}))
                reply(msg_id, {"content": [{"type": "text", "text": text}], "isError": False})
            except Exception as err:  # noqa: BLE001
                reply(msg_id, {"content": [{"type": "text", "text": f"Error: {err!r}"}], "isError": True})
        elif method == "ping":
            reply(msg_id, {})
        else:
            reply(msg_id, error={"code": -32601, "message": f"Metodo no soportado: {method}"})


if __name__ == "__main__":
    main()
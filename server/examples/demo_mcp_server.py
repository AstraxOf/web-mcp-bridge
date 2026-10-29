#!/usr/bin/env python3
"""
demo_mcp_server.py — Servidor MCP mínimo (stdio, sin dependencias) para probar la extensión.

    python server/mcp_ws_bridge.py --port 8080 --name demo -- python server/examples/demo_mcp_server.py
"""
import json
import sys
from datetime import datetime

TOOLS = [
    {
        "name": "hora_actual",
        "description": "Devuelve la fecha y hora actuales del equipo del usuario.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "sumar",
        "description": "Suma dos números.",
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
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        method, msg_id = msg.get("method"), msg.get("id")
        if msg_id is None:  # notificación: no se responde
            continue
        if method == "initialize":
            reply(msg_id, {
                "protocolVersion": "2025-03-26",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "demo-mcp", "version": "1.0.0"},
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
            reply(msg_id, error={"code": -32601, "message": f"Método no soportado: {method}"})


if __name__ == "__main__":
    main()

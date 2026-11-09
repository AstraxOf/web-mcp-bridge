#!/usr/bin/env python3
"""
stage_mcp_server.py - MCP server (stdio) para subir archivos grandes por trozos.

Ejecuta:
    GITHUB_TOKEN=ghp_xxx python server/mcp_ws_bridge.py --config servers.json
con un servidor apuntando a este archivo:
    {"name":"staging","command":["python","server/examples/stage_mcp_server.py"],"port":8081}

Herramientas:
  stage_file(session_id, path, chunk_index, content, total_chunks?, stage_id?)
  flush_staged_file(stage_id, owner, repo, branch, message, sha?)
  abort_staged_file(stage_id)

Diseno: el modelo envia trozos <=150 lineas; stage_store los guarda en disco;
flush concatena y empuja a GitHub con la API Contents (sin incrustar el archivo
completo en un unico JSON de mcp_call).
"""
import json
import os
import sys
import urllib.request
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stage_store  # noqa: E402

GITHUB_API = "https://api.github.com"

TOOLS = [
    {
        "name": "stage_file",
        "description": "Sube UN trozo de un archivo a un almacen temporal. Usalo para archivos >150 lineas: envia cada trozo (<=150 lineas) con el mismo stage_id y chunk_index 0..N-1.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Ruta destino en el repo (ej. crates/x/src/lib.rs)"},
                "chunk_index": {"type": "integer", "minimum": 0},
                "content": {"type": "string", "description": "Contenido del trozo (sin escapar manualmente)"},
                "total_chunks": {"type": "integer", "minimum": 1},
                "stage_id": {"type": "string", "description": "Obligatorio a partir del 2o trozo (lo devuelve la 1a llamada)"},
            },
            "required": ["path", "chunk_index", "content"],
        },
    },
    {
        "name": "flush_staged_file",
        "description": "Concatena todos los trozos y hace commit del archivo a GitHub. Requiere GITHUB_TOKEN en el entorno del servidor.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "stage_id": {"type": "string"},
                "owner": {"type": "string"},
                "repo": {"type": "string"},
                "branch": {"type": "string"},
                "message": {"type": "string"},
                "sha": {"type": "string", "description": "SHA del blob actual si el archivo ya existe"},
            },
            "required": ["stage_id", "owner", "repo", "branch", "message"],
        },
    },
    {
        "name": "abort_staged_file",
        "description": "Borra los trozos de un stage_id sin hacer commit.",
        "inputSchema": {"type": "object", "properties": {"stage_id": {"type": "string"}}, "required": ["stage_id"]},
    },
]


def call_tool(name: str, args: dict) -> str:
    if name == "stage_file":
        sid = args.get("stage_id")
        if not sid:
            stage = stage_store.create(args["path"], args.get("total_chunks"))
            sid = stage.stage_id
        stage = stage_store.put(sid, int(args["chunk_index"]), args["content"], args.get("total_chunks"))
        return json.dumps({"stage_id": sid, "received": len(stage.received), "total": stage.total_chunks, "complete": stage.complete})
    if name == "abort_staged_file":
        stage_store.abort(args["stage_id"])
        return json.dumps({"ok": True})
    if name == "flush_staged_file":
        text, stage = stage_store.read_all(args["stage_id"])
        result = _push_to_github(text, args, stage)
        stage_store.abort(args["stage_id"])
        return json.dumps(result)
    raise KeyError(name)


# _push_to_github se implementa en el siguiente commit (separado para no truncar).
def _push_to_github(text: str, args: dict, stage) -> dict:  # pragma: no cover
    raise RuntimeError("flush_staged_file aun no implementado")


def _reply(msg_id, result=None, error=None):
    body = {"jsonrpc": "2.0", "id": msg_id}
    body.update({"error": error} if error else {"result": result})
    sys.stdout.write(json.dumps(body, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    for s in (sys.stdin, sys.stdout):
        if hasattr(s, "reconfigure"):
            s.reconfigure(encoding="utf-8")
    stage_store.sweep()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        m, mid = msg.get("method"), msg.get("id")
        if mid is None:
            continue
        if m == "initialize":
            _reply(mid, {"protocolVersion": "2025-03-26", "capabilities": {"tools": {}}, "serverInfo": {"name": "staging-mcp", "version": "0.1.0"}})
        elif m == "tools/list":
            _reply(mid, {"tools": TOOLS})
        elif m == "tools/call":
            p = msg.get("params", {})
            try:
                out = call_tool(p["name"], p.get("arguments", {}))
                _reply(mid, {"content": [{"type": "text", "text": out}], "isError": False})
            except Exception as e:  # noqa: BLE001
                _reply(mid, {"content": [{"type": "text", "text": f"Error: {e!r}"}], "isError": True})
        elif m == "ping":
            _reply(mid, {})
        else:
            _reply(mid, error={"code": -32601, "message": f"No soportado: {m}"})


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Servidor MCP de archivos (stdio, sin dependencias).

Tools (todas con raiz limitada a WMB_FILES_ROOT, default Documents):
  read_file        lee archivo (offset/longitud opcionales)
  write_file       crea/sobrescribe archivo
  write_range      escribe por rango (offset + texto)
  delete_range     borra bytes en un rango (offset + longitud)
  move_file        mueve o cambia nombre
  delete_file      elimina archivo/carpeta
  create_file      crea archivo vacio
  list_dir         lista archivos y carpetas
  make_dir         crea carpeta
  copy_file        copia archivo/carpeta
  append_file      agrega al final
"""
import json
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(os.environ.get("WMB_FILES_ROOT",
                           str(Path.home() / "Documents"))).resolve()
MAX_READ = 2 * 1024 * 1024


def safe(path: str) -> Path:
    """Igual que un MCP de archivos normal:
      - ruta absoluta (C:/...) -> apunta directo al disco;
      - ruta relativa ('.', 'carpeta') -> se resuelve dentro de la raiz
        configurada (ROOT = Documents por defecto)."""
    raw = str(path or ".").replace("/", os.sep)
    candidate = Path(raw)
    return candidate.resolve() if candidate.is_absolute() else (ROOT / raw).resolve()


def schema(props, required):
    return {"type": "object", "properties": props, "required": required}


TOOLS = [
    {"name": "read_file",
     "description": "Lee archivo de texto. offset/longitud opcionales para leer un rango.",
     "inputSchema": schema({"path": {"type": "string"},
                            "offset": {"type": "integer"},
                            "length": {"type": "integer"}}, ["path"])},
    {"name": "list_dir",
     "description": "Lista archivos y carpetas ([DIR]/[FILE] y tamano).",
     "inputSchema": schema({"path": {"type": "string"}}, [])},
    {"name": "create_file",
     "description": "Crea un archivo vacio (o lo deja vacio si ya existe).",
     "inputSchema": schema({"path": {"type": "string"}}, ["path"])},
    {"name": "write_file",
     "description": "Crea o sobrescribe un archivo con contenido.",
     "inputSchema": schema({"path": {"type": "string"},
                            "content": {"type": "string"}}, ["path", "content"])},
    {"name": "write_range",
     "description": "Escribe texto en un rango del archivo desde offset (bytes UTF-8).",
     "inputSchema": schema({"path": {"type": "string"},
                            "offset": {"type": "integer"},
                            "content": {"type": "string"}},
                           ["path", "offset", "content"])},
    {"name": "delete_range",
     "description": "Borra 'length' bytes desde 'offset' de un archivo.",
     "inputSchema": schema({"path": {"type": "string"},
                            "offset": {"type": "integer"},
                            "length": {"type": "integer"}},
                           ["path", "offset", "length"])},
    {"name": "move_file",
     "description": "Mueve o cambia el nombre de un archivo/carpeta.",
     "inputSchema": schema({"src": {"type": "string"},
                            "dst": {"type": "string"}}, ["src", "dst"])},
    {"name": "delete_file",
     "description": "Elimina archivo, o carpeta con recursive=true.",
     "inputSchema": schema({"path": {"type": "string"},
                            "recursive": {"type": "boolean"}}, ["path"])},
    {"name": "append_file",
     "description": "Agrega texto al final del archivo.",
     "inputSchema": schema({"path": {"type": "string"},
                            "content": {"type": "string"}}, ["path", "content"])},
    {"name": "copy_file",
     "description": "Copia archivo o carpeta.",
     "inputSchema": schema({"src": {"type": "string"},
                            "dst": {"type": "string"}}, ["src", "dst"])},
    {"name": "make_dir",
     "description": "Crea un directorio.",
     "inputSchema": schema({"path": {"type": "string"}}, ["path"])},
]


def diff_lines(before: str, after: str) -> tuple[int, int]:
    """Cuenta lineas agregadas/borradas (diff simple por conjunto de lineas)."""
    a = before.splitlines()
    b = after.splitlines()
    from collections import Counter
    ca, cb = Counter(a), Counter(b)
    added = sum((cb - ca).values())
    removed = sum((ca - cb).values())
    return added, removed


_last_diff = {"path": "", "added": 0, "removed": 0, "op": ""}


def record(path: str, op: str, before: str = "", after: str = "") -> str:
    add, rem = diff_lines(before, after)
    _last_diff.update({"path": str(path), "added": add, "removed": rem, "op": op})
    return (f"\n[WMB_DIFF path={path} op={op} "
            f"added={add} removed={rem}]")


def call_tool(name, args):
    if name == "read_file":
        p = safe(args["path"])
        if not p.is_file():
            return f"No existe archivo: {p}"
        raw = p.read_bytes()
        off = int(args.get("offset", 0))
        length = int(args.get("length", MAX_READ))
        chunk = raw[off:off + length]
        if len(chunk) > MAX_READ:
            chunk = chunk[:MAX_READ]
        return (f"[bytes {off}-{off + len(chunk)} de {len(raw)}]\n"
                + chunk.decode("utf-8", errors="replace"))
    if name == "list_dir":
        p = safe(args.get("path", "."))
        if not p.is_dir():
            return f"No existe carpeta: {p}"
        filas = []
        for q in sorted(p.iterdir()):
            tam = q.stat().st_size if q.is_file() else 0
            filas.append(("[DIR]  " if q.is_dir() else "[FILE] ") +
                         f"{q.name}  ({tam} bytes)" if q.is_file()
                         else "[DIR]  " + q.name)
        return "\n".join(filas) if filas else "(vacia)"
    if name == "create_file":
        p = safe(args["path"])
        existed = p.is_file()
        before = p.read_text(encoding="utf-8", errors="replace") if existed else ""
        p.parent.mkdir(parents=True, exist_ok=True)
        p.touch()
        d = record(p, "create" if not existed else "write", before, before)
        return f"Creado: {p}{d}"
    if name == "write_file":
        p = safe(args["path"])
        p.parent.mkdir(parents=True, exist_ok=True)
        before = p.read_text(encoding="utf-8", errors="replace") if p.is_file() else ""
        p.write_text(args["content"], encoding="utf-8")
        d = record(p, "write", before, args["content"])
        return f"Escrito: {p}{d}"
    if name == "write_range":
        p = safe(args["path"])
        if not p.is_file():
            return f"No existe archivo: {p}"
        off = int(args["offset"])
        data = args["content"].encode("utf-8")
        raw = bytearray(p.read_bytes())
        before = raw.decode("utf-8", errors="replace")
        raw[off:off + len(data)] = data
        p.write_bytes(bytes(raw))
        d = record(p, "write_range", before, bytes(raw).decode("utf-8", errors="replace"))
        return f"Escrito {len(data)} bytes en offset {off}: {p}{d}"
    if name == "delete_range":
        p = safe(args["path"])
        if not p.is_file():
            return f"No existe archivo: {p}"
        off = int(args["offset"])
        length = int(args["length"])
        raw = bytearray(p.read_bytes())
        if off < 0 or off + length > len(raw):
            return f"Rango fuera de archivo (tamano {len(raw)})"
        before = raw.decode("utf-8", errors="replace")
        del raw[off:off + length]
        p.write_bytes(bytes(raw))
        d = record(p, "delete_range", before, bytes(raw).decode("utf-8", errors="replace"))
        return f"Borrados {length} bytes desde {off}: {p}{d}"
    if name == "move_file":
        src, dst = safe(args["src"]), safe(args["dst"])
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
        d = record(dst, "move", str(src), str(dst))
        return f"Movido/renombrado: {src} -> {dst}{d}"
    if name == "delete_file":
        p = safe(args["path"])
        if p.is_dir():
            if args.get("recursive"):
                shutil.rmtree(p)
            else:
                p.rmdir()
        else:
            p.unlink()
        d = record(p, "delete", "", "")
        return f"Eliminado: {p}{d}"
    if name == "append_file":
        p = safe(args["path"])
        p.parent.mkdir(parents=True, exist_ok=True)
        before = p.read_text(encoding="utf-8", errors="replace") if p.is_file() else ""
        with p.open("a", encoding="utf-8") as f:
            f.write(args["content"])
        d = record(p, "append", before, before + args["content"])
        return f"Agregado: {p}{d}"
    if name == "copy_file":
        src, dst = safe(args["src"]), safe(args["dst"])
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.is_dir():
            shutil.copytree(str(src), str(dst), dirs_exist_ok=True)
        else:
            shutil.copy2(str(src), str(dst))
        return f"Copiado: {src} -> {dst}"
    if name == "make_dir":
        p = safe(args["path"])
        p.mkdir(parents=True, exist_ok=True)
        return f"Carpeta: {p}"
    raise KeyError(name)


def reply(msg_id, result=None, error=None):
    body = {"jsonrpc": "2.0", "id": msg_id}
    body.update({"error": error} if error else {"result": result})
    sys.stdout.write(json.dumps(body, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    for stream in (sys.stdin, sys.stdout):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    print(f"Files MCP root: {ROOT}", file=sys.stderr)
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
                           "serverInfo": {"name": "files-mcp", "version": "2.0"}})
        elif method == "tools/list":
            reply(msg_id, {"tools": TOOLS})
        elif method == "tools/call":
            params = msg.get("params", {})
            try:
                text = call_tool(params["name"], params.get("arguments", {}))
                reply(msg_id, {"content": [{"type": "text", "text": text}],
                               "isError": False})
            except Exception as err:  # noqa: BLE001
                reply(msg_id, {"content": [{"type": "text", "text": f"Error: {err!r}"}],
                               "isError": True})
        elif method == "ping":
            reply(msg_id, {})
        else:
            reply(msg_id, error={"code": -32601, "message": f"Method not supported: {method}"})


if __name__ == "__main__":
    main()

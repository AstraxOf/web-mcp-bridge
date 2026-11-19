#!/usr/bin/env python3
"""
auditoria.py — Registro de auditoría de las llamadas a herramientas MCP (puente local de Web MCP Bridge).

La extensión envía por el canal de control lotes de eventos (llamadas, errores, avisos); aquí se guardan como líneas JSON
(`auditoria-AAAA-MM-DD.jsonl`) en la carpeta `auditoria/` junto a `servers.json`, con rotación diaria y sin secretos.
Sirve para revisar después qué pidió cada chat, qué respondió cada MCP y por qué falló, en cualquier PC donde se instale.

Uso desde la terminal (resumen de lo registrado):
    python auditoria.py                      # últimos 7 días
    python auditoria.py --dias 1 --errores   # solo errores de hoy
    python auditoria.py --carpeta C:\\ruta\\auditoria
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path

MAX_ENTRADAS = 500                # por lote
MAX_BYTES_ARCHIVO = 20 * 1024 * 1024
DIAS_CONSERVADOS = 30
SENSIBLE = re.compile(r"token|password|passwd|clave|secret|api[_-]?key|authorization|cookie|credencial", re.I)
SECRETO = re.compile(r"(ghp_|gho_|github_pat_|sk-|xox[bp]-)[A-Za-z0-9_\-]{12,}")


def enmascarar(valor, profundidad: int = 0):
    """Copia con los valores de campos sensibles (token, clave…) y los textos con aspecto de clave cambiados por «***»."""
    if isinstance(valor, str):
        return SECRETO.sub("***", valor)
    if profundidad >= 6:
        return "[…]"
    if isinstance(valor, list):
        return [enmascarar(v, profundidad + 1) for v in valor[:50]]
    if isinstance(valor, dict):
        return {k: ("***" if SENSIBLE.search(str(k)) else enmascarar(v, profundidad + 1)) for k, v in list(valor.items())[:50]}
    return valor


def archivo_del_dia(carpeta: Path, ahora: datetime) -> Path:
    return carpeta / f"auditoria-{ahora:%Y-%m-%d}.jsonl"


def purgar(carpeta: Path, ahora: datetime, dias: int = DIAS_CONSERVADOS) -> int:
    """Borra los archivos de auditoría con más de `dias` días. Devuelve cuántos."""
    limite = f"auditoria-{ahora - timedelta(days=dias):%Y-%m-%d}.jsonl"
    borrados = 0
    for f in carpeta.glob("auditoria-*.jsonl"):
        if f.name < limite:
            try:
                f.unlink()
                borrados += 1
            except OSError:
                pass
    return borrados


def escribir(carpeta: Path, entradas, ahora: datetime | None = None, extra: dict | None = None) -> int:
    """Añade `entradas` (lista de dicts) al archivo del día; devuelve cuántas escribió. Lanza ValueError si el lote no es válido."""
    if not isinstance(entradas, list) or not entradas:
        raise ValueError("`entries` debe ser una lista no vacía.")
    if len(entradas) > MAX_ENTRADAS:
        raise ValueError(f"Demasiadas entradas en un lote (máx. {MAX_ENTRADAS}).")
    ahora = ahora or datetime.now()
    carpeta.mkdir(parents=True, exist_ok=True)
    destino = archivo_del_dia(carpeta, ahora)
    if destino.exists() and destino.stat().st_size > MAX_BYTES_ARCHIVO:
        raise ValueError("El archivo de auditoría del día superó el tamaño máximo; se reanuda mañana.")
    lineas = []
    for e in entradas:
        if not isinstance(e, dict):
            continue
        ts = e.get("ts")
        try:
            hora = datetime.fromtimestamp(float(ts) / 1000).isoformat(timespec="milliseconds")
        except (TypeError, ValueError, OSError, OverflowError):
            hora = ahora.isoformat(timespec="milliseconds")
        fila = {"hora": hora, **enmascarar(e), **(extra or {})}
        lineas.append(json.dumps(fila, ensure_ascii=False, separators=(",", ":")))
    if lineas:
        with destino.open("a", encoding="utf-8") as fh:
            fh.write("\n".join(lineas) + "\n")
        purgar(carpeta, ahora)
    return len(lineas)


def normalizar(fila: dict):
    """(servidor, herramienta, ok, ms, error, chat) de una línea de llamada (de la extensión o de un servidor MCP); None si no es una llamada."""
    if "herramienta" in fila:                                   # formato de un servidor MCP (autocad-mcp…)
        return (fila.get("servidor") or "?", fila["herramienta"], bool(fila.get("ok")), fila.get("ms"), fila.get("error"), None)
    if fila.get("event") == "tool.call":                        # formato de la extensión
        d = fila.get("details") or {}
        ok = d.get("status") == "ok"
        return (d.get("server") or "?", d.get("tool") or "?", ok, d.get("ms"), d.get("error"), fila.get("platform"))
    return None


def leer(carpeta: Path, dias: int = 7, ahora: datetime | None = None):
    ahora = ahora or datetime.now()
    desde = f"auditoria-{ahora - timedelta(days=dias - 1):%Y-%m-%d}.jsonl"
    for f in sorted(carpeta.glob("auditoria-*.jsonl")):
        if f.name < desde:
            continue
        for linea in f.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                yield json.loads(linea)
            except ValueError:
                continue


def resumen(filas, solo_errores: bool = False) -> str:
    por = defaultdict(lambda: {"n": 0, "err": 0, "ms": []})
    errores, avisos = [], Counter()
    for fila in filas:
        n = normalizar(fila)
        if n is None:
            if fila.get("level") in ("warn", "error"):
                avisos[fila.get("event", "?")] += 1
            continue
        servidor, herramienta, ok, ms, error, chat = n
        s = por[(servidor, herramienta)]
        s["n"] += 1
        if not ok:
            s["err"] += 1
            errores.append((fila.get("hora", ""), chat or "-", servidor, herramienta, str(error or "")[:200]))
        if isinstance(ms, (int, float)):
            s["ms"].append(ms)
    if not por and not avisos and not errores:
        return "Sin errores en el periodo." if solo_errores else "Sin llamadas registradas en el periodo."
    out = []
    if not solo_errores:
        out.append(f"{'servidor › herramienta':45} {'llamadas':>8} {'errores':>8} {'ms medio':>9} {'ms máx':>8}")
        for (srv, her), s in sorted(por.items(), key=lambda kv: -kv[1]["n"]):
            med = round(sum(s["ms"]) / len(s["ms"])) if s["ms"] else 0
            out.append(f"{srv + ' › ' + her:45} {s['n']:>8} {s['err']:>8} {med:>9} {max(s['ms'], default=0):>8.0f}")
        if avisos:
            out.append("")
            out.append("Avisos y errores de la extensión: " + ", ".join(f"{k}×{v}" for k, v in avisos.most_common(8)))
    if errores:
        out.append("")
        out.append("Últimos errores:")
        for hora, chat, srv, her, err in errores[-15:]:
            out.append(f"  {hora[:19]}  {chat:9} {srv} › {her}: {err}")
    elif solo_errores:
        out.append("Sin errores en el periodo.")
    return "\n".join(out) if out else "Sin llamadas registradas en el periodo."


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Resumen de la auditoría de llamadas MCP.")
    ap.add_argument("--carpeta", default=str(Path(__file__).resolve().parent / "auditoria"))
    ap.add_argument("--dias", type=int, default=7)
    ap.add_argument("--errores", action="store_true", help="solo los errores")
    args = ap.parse_args(argv)
    carpeta = Path(args.carpeta)
    if not carpeta.is_dir():
        print(f"No hay carpeta de auditoría en {carpeta}.")
        return 1
    sys.stdout.reconfigure(encoding="utf-8")
    print(resumen(leer(carpeta, args.dias), args.errores))
    return 0


if __name__ == "__main__":
    sys.exit(main())

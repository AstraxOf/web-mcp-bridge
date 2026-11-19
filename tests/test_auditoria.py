"""Pruebas de server/auditoria.py (sin red): máscara de secretos, escritura diaria, purga y resumen."""
import json
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import auditoria as A  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")

# máscara
m = A.enmascarar({"token": "x", "n": {"api_key": "y", "ok": "hola ghp_" + "B" * 20}, "lista": [{"password": "p"}, "sk-" + "C" * 24]})
assert m["token"] == "***" and m["n"]["api_key"] == "***" and "ghp_" not in m["n"]["ok"] and m["lista"][0]["password"] == "***" and "sk-" not in m["lista"][1], m

with tempfile.TemporaryDirectory() as d:
    carpeta = Path(d) / "auditoria"
    hoy = datetime(2026, 11, 19, 15, 0, 0)
    base = {"ts": int(hoy.timestamp() * 1000), "level": "info", "source": "background", "event": "tool.call", "platform": "deepseek"}
    n = A.escribir(carpeta, [
        {**base, "details": {"server": "autocad-mcp", "tool": "dibujar", "status": "ok", "ms": 100}},
        {**base, "details": {"server": "autocad-mcp", "tool": "dibujar", "status": "error", "ms": 300, "error": "no existe la capa"}},
        {**base, "level": "warn", "event": "call.unreadable", "details": {"problem": "json"}},
        "basura",
    ], ahora=hoy, extra={"ext": "1.2.0"})
    assert n == 3, n
    f = A.archivo_del_dia(carpeta, hoy)
    filas = [json.loads(l) for l in f.read_text(encoding="utf-8").splitlines()]
    assert len(filas) == 3 and filas[0]["ext"] == "1.2.0" and filas[0]["hora"].startswith("2026-11-19T15:00"), filas[0]
    # lote no válido
    for malo in (None, [], "x", [{}] * (A.MAX_ENTRADAS + 1)):
        try:
            A.escribir(carpeta, malo, ahora=hoy)
            raise AssertionError(f"debía fallar: {malo!r:.30}")
        except ValueError:
            pass
    # purga: lo de hace más de 30 días se borra
    viejo = carpeta / f"auditoria-{hoy - timedelta(days=45):%Y-%m-%d}.jsonl"
    viejo.write_text("{}\n", encoding="utf-8")
    reciente = carpeta / f"auditoria-{hoy - timedelta(days=10):%Y-%m-%d}.jsonl"
    reciente.write_text("{}\n", encoding="utf-8")
    A.escribir(carpeta, [base], ahora=hoy)
    assert not viejo.exists() and reciente.exists()
    # formato de un servidor MCP (autocad-mcp) junto al de la extensión
    with A.archivo_del_dia(carpeta, hoy).open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"hora": "2026-11-19T15:01:00", "servidor": "autocad-mcp", "herramienta": "comando", "ok": False,
                             "ms": 31000, "error": "la orden se quedó esperando datos"}) + "\n")
    txt = A.resumen(A.leer(carpeta, 7, hoy))
    assert "autocad-mcp › dibujar" in txt and "autocad-mcp › comando" in txt and "no existe la capa" in txt and "esperando datos" in txt, txt
    assert "call.unreadable" in txt, txt
    solo = A.resumen(A.leer(carpeta, 7, hoy), solo_errores=True)
    assert "llamadas" not in solo and "no existe la capa" in solo
    assert A.resumen([], True) == "Sin errores en el periodo." and A.resumen([]) == "Sin llamadas registradas en el periodo."
print("✔ test_auditoria: todo correcto")

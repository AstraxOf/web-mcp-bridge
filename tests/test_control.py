"""Prueba del modo --config: puerto de control, deteccion, recarga en caliente, reinicio, errores de servers.json y apagado."""
import http.client
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BRIDGE = str(ROOT / "server/mcp_ws_bridge.py")
DEMO = str(ROOT / "server/examples/demo_mcp_server.py")
CONTROL = 18799
ENV = {**os.environ, "WMB_NO_OPEN": "1"}  # nunca abrir editores durante las pruebas
ENV.pop("WMB_SUPERVISED", None)


def entry(name, port):
    return {"name": name, "port": port, "command": [sys.executable, DEMO]}


def call(method, path, origin=None):
    req = urllib.request.Request(f"http://127.0.0.1:{CONTROL}{path}", method=method, data=b"" if method == "POST" else None)
    if origin:
        req.add_header("Origin", origin)
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"{}")
    except OSError:
        return None, None


def wait_for(cond, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.3)
    return False


def names():
    status, body = call("GET", "/servers")
    return {s["name"]: s for s in body["servers"]} if status == 200 else {}


def spawn(args, env=ENV):
    return subprocess.Popen([sys.executable, BRIDGE, *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)


def stop_everything():
    """Apaga cualquier puente que haya quedado en el puerto de prueba."""
    if call("GET", "/health")[0] == 200:
        call("POST", "/shutdown")
        wait_for(lambda: call("GET", "/health")[0] is None, 10)


def main():
    stop_everything()
    with tempfile.TemporaryDirectory() as tmp:
        config = Path(tmp) / "servers.json"
        # BOM a proposito: PowerShell lo agrega y antes rompia la lectura
        config.write_text(json.dumps({"servers": [entry("uno", 18771), entry("dos", 18772)]}), encoding="utf-8-sig")
        base = ["--config", str(config), "--control-port", str(CONTROL)]
        bridge = spawn(base)
        try:
            assert wait_for(lambda: call("GET", "/health")[0] == 200), "el puerto de control no arranco"
            found = names()
            assert set(found) == {"uno", "dos"} and all(s["status"] == "listening" for s in found.values()), found
            assert found["uno"]["url"] == "ws://127.0.0.1:18771", found
            info = call("GET", "/servers")[1]
            assert info["config_error"] is None and info["version"] == "1.6.0", info

            # Una web NO puede leer ni apagar el puente
            assert call("GET", "/servers", origin="https://chatgpt.com")[0] == 403
            assert call("POST", "/shutdown", origin="https://evil.example")[0] == 403
            assert call("POST", "/restart", origin="https://evil.example")[0] == 403
            assert call("POST", "/open-config", origin="https://evil.example")[0] == 403
            assert call("GET", "/shutdown")[0] == 405
            assert call("GET", "/restart")[0] == 405
            assert call("GET", "/open-config")[0] == 405

            # Anti DNS-rebinding: un Host que no sea local se rechaza
            conn = http.client.HTTPConnection("127.0.0.1", CONTROL, timeout=5)
            conn.request("GET", "/servers", headers={"Host": f"evil.example:{CONTROL}"})
            assert conn.getresponse().status == 403
            conn.close()

            # La extension (origen chrome-extension://) si puede abrir el archivo
            status, body = call("POST", "/open-config", origin="chrome-extension://abcdefghijklmnop")
            assert status == 200 and body["ok"] and body["path"].endswith("servers.json"), (status, body)

            # Recarga en caliente: se agrega un servidor y se quita otro sin reiniciar
            config.write_text(json.dumps({"servers": [entry("uno", 18771), entry("tres", 18773)]}), encoding="utf-8")
            assert wait_for(lambda: set(names()) == {"uno", "tres"}), names()

            # Un servers.json roto NO tumba nada: se conserva lo anterior y el error se ve en /servers
            config.write_text('{"servers": [ {"name": "uno", "port": 18771, ', encoding="utf-8")
            assert wait_for(lambda: "JSON mal escrito" in ((call("GET", "/servers")[1] or {}).get("config_error") or "")), call("GET", "/servers")
            assert set(names()) == {"uno", "tres"} and names()["uno"]["status"] == "listening"
            for bad, expected in [
                ({"servers": [{"name": "x", "command": ["python"]}]}, "port"),
                ({"servers": [{"name": "x", "port": 18775}]}, "command"),
                ({"servers": [{"name": "x", "port": 18775, "command": ["a"]}, {"name": "x", "port": 18776, "command": ["a"]}]}, "repetido"),
                ({"servers": [{"port": 18775, "command": ["a"]}]}, "name"),
                ({"servers": "no es una lista"}, "servers"),
            ]:
                config.write_text(json.dumps(bad), encoding="utf-8")
                assert wait_for(lambda: expected in ((call("GET", "/servers")[1] or {}).get("config_error") or "")), (bad, call("GET", "/servers")[1])
            # Al corregirlo, el error desaparece solo
            config.write_text(json.dumps({"servers": [entry("uno", 18771), entry("tres", 18773)]}), encoding="utf-8")
            assert wait_for(lambda: (call("GET", "/servers")[1] or {}).get("config_error") is None), call("GET", "/servers")

            # Un segundo `--config` con el puente activo recarga en vez de fallar con "puerto ocupado"
            again = subprocess.run([sys.executable, BRIDGE, *base], capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL, env=ENV)
            assert again.returncode == 0 and "Ya hay un puente" in again.stdout, again.stdout + again.stderr

            # Un puerto ocupado por otro programa no tumba el resto
            blocker = socket.socket()
            blocker.bind(("127.0.0.1", 18774))
            blocker.listen(1)
            config.write_text(json.dumps({"servers": [entry("uno", 18771), entry("ocupado", 18774)]}), encoding="utf-8")
            assert wait_for(lambda: names().get("ocupado", {}).get("status") == "error"), names()
            assert names()["uno"]["status"] == "listening"
            blocker.close()

            # REINICIO desde el puerto de control (sin supervisor): el puente se cierra y arranca uno NUEVO (otro pid)
            old_pid = call("GET", "/health")[1]["pid"]
            assert call("POST", "/restart")[0] == 200
            assert bridge.wait(timeout=20) == 0
            assert wait_for(lambda: (call("GET", "/health")[1] or {}).get("pid") not in (None, old_pid), 30), "no volvio a arrancar"
            assert wait_for(lambda: names().get("uno", {}).get("status") == "listening", 20), names()

            # Apagado limpio por el puerto de control
            assert call("POST", "/shutdown")[0] == 200
            assert wait_for(lambda: call("GET", "/health")[0] is None, 15)
        finally:
            if bridge.poll() is None:
                bridge.terminate()
                bridge.wait(timeout=5)
            stop_everything()

        # Con supervisor (start_bridge_loop): al reiniciar el proceso termina y NO lanza otro (lo hace el supervisor)
        config.write_text(json.dumps({"servers": [entry("uno", 18771)]}), encoding="utf-8")
        supervised = spawn(base, env={**ENV, "WMB_SUPERVISED": "1"})
        try:
            assert wait_for(lambda: call("GET", "/health")[0] == 200)
            assert call("GET", "/servers")[1]["supervised"] is True
            assert call("POST", "/restart")[0] == 200
            assert supervised.wait(timeout=20) == 0
            time.sleep(2.5)
            assert call("GET", "/health")[0] is None, "con supervisor no debe quedar otro puente suelto"
        finally:
            if supervised.poll() is None:
                supervised.terminate()
                supervised.wait(timeout=5)
            stop_everything()

        # Arranque con servers.json ROTO: el puente sube igual, informa el error y se recupera al corregirlo
        config.write_text('{"servers": [ {"name": "uno" ', encoding="utf-8")
        broken = spawn(base)
        try:
            assert wait_for(lambda: call("GET", "/health")[0] == 200), "con el archivo roto el puente debe arrancar igual"
            assert "JSON mal escrito" in call("GET", "/servers")[1]["config_error"]
            assert names() == {}
            config.write_text(json.dumps({"servers": [entry("uno", 18771)]}), encoding="utf-8")
            assert wait_for(lambda: names().get("uno", {}).get("status") == "listening"), names()
            assert call("GET", "/servers")[1]["config_error"] is None
            assert call("POST", "/shutdown")[0] == 200
            broken.wait(timeout=15)
        finally:
            if broken.poll() is None:
                broken.terminate()
                broken.wait(timeout=5)
            stop_everything()
    print("ok test_control: todo correcto")


if __name__ == "__main__":
    main()
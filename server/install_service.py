#!/usr/bin/env python3
"""
install_service.py — Instala el puente MCP para que arranque SOLO al iniciar sesión.

Un

Después basta con la extensión: el puente ya estará escuchando en segundo plano.

Otras opciones:
    python server/install_service.py --purge       # quita los auto-inicios de OTRAS copias del proyecto (Startup + tareas)
    python server/install_service.py --uninstall   # quita el arranque automático
    python server/install_service.py --dry-run     # muestra qué haría sin tocar nada

Los servidores MCP que se exponen se definen en `server/servers.json`
(se crea automáticamente la primera vez; edítalo y vuelve a ejecutar este script).
"""
from __future__ import annotations

import argparse
import json
import shutil
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
BRIDGE = HERE / "mcp_ws_bridge.py"
CONFIG = HERE / "servers.json"
LOG = HERE / "bridge.log"
LAUNCHER = HERE / "start_bridge_loop.pyw"
NAME = "WebMCPBridge"


def default_config() -> dict:
    py = sys.executable
    return {
        "servers": [
            {"name": "astrax-mcp", "port": 8080, "command": [py, "-m", "astrax_mcp"]},
            {"name": "demo", "port": 8090, "command": [py, str(HERE / "examples" / "demo_mcp_server.py")]},
        ]
    }


def ensure_config(dry: bool) -> None:
    if CONFIG.exists():
        print(f"• Usando configuración existente: {CONFIG}")
        return
    print(f"• Creando {CONFIG} (edítalo para añadir más servidores)")
    if not dry:
        CONFIG.write_text(json.dumps(default_config(), indent=2, ensure_ascii=False), encoding="utf-8")


def launcher_command(windowless: bool = False) -> list[str]:
    """Comando del lanzador: es lo que arranca con Windows y mantiene vivo el puente."""
    py = sys.executable
    if windowless and sys.platform == "win32":
        pyw = Path(py).with_name("pythonw.exe")
        py = str(pyw) if pyw.exists() else py
    return [py, str(LAUNCHER)]


def _ports() -> tuple[int, int]:
    """(puerto de control del puente, puerto del lanzador) segun servers.json."""
    try:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8-sig"))
    except Exception:
        cfg = {}
    return int(cfg.get("control_port", 8099)), int(cfg.get("launcher_port", 8098))


def _post(port: int, path: str, timeout: float = 4) -> bool:
    """POST sin cabecera Origin (la aceptan el puente y el lanzador). True si respondio."""
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method="POST", data=b"")
        with urllib.request.urlopen(req, timeout=timeout):
            return True
    except Exception:
        return False


def start_launcher() -> None:
    """Deja el lanzador corriendo ahora mismo: si ya hay uno le pide reiniciar; si no, lo arranca desacoplado."""
    control, launcher = _ports()
    if _post(launcher, "/restart"):
        print("-> Lanzador ya activo: puente reiniciado.")
        return
    _post(control, "/shutdown")  # un puente suelto (sin lanzador) ocuparia los puertos
    time.sleep(1.5)
    flags = 0
    if sys.platform == "win32":
        flags = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
    subprocess.Popen(launcher_command(windowless=True), cwd=str(HERE), creationflags=flags, close_fds=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print("-> Lanzador iniciado en segundo plano.")


def stop_launcher() -> None:
    control, launcher = _ports()
    _post(launcher, "/quit")
    _post(control, "/shutdown")

def restart_bridge() -> int:
    """Reinicia el puente: apaga el anterior (o un puente viejo que ocupe los puertos) y arranca uno nuevo en segundo plano."""
    cmd = [sys.executable, str(BRIDGE), "--config", str(CONFIG), "--log-file", str(LOG), "--restart"]
    return subprocess.run(cmd).returncode


def bridge_command(windowless: bool = False) -> list[str]:
    py = sys.executable
    if windowless and sys.platform == "win32":
        pyw = Path(py).with_name("pythonw.exe")
        py = str(pyw) if pyw.exists() else py
    return [py, str(BRIDGE), "--config", str(CONFIG), "--log-file", str(LOG)]


# ───────────────────────── Windows ─────────────────────────

TASK_NAME = "WebMCPBridgeLauncher"          # tarea programada propia (reintenta cada minuto si el lanzador muere)
MARKERS = ("start_bridge_loop", "mcp_ws_bridge")


def _canon(path) -> str:
    return str(path or "").lower().replace("\\", "/").rstrip("/")


def _is_here(text: str) -> bool:
    """El texto (comando, script...) apunta a un archivo de ESTA carpeta."""
    return (_canon(HERE) + "/") in _canon(text)


def _has_marker(text: str) -> bool:
    low = (text or "").lower()
    return any(m in low for m in MARKERS)


def _ps(script: str, timeout: int = 45) -> tuple[int, str]:
    res = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                         capture_output=True, text=True, timeout=timeout, creationflags=0x08000000 if sys.platform == "win32" else 0)
    return res.returncode, (res.stdout or "").strip()


def _ps_quote(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def purge_foreign_autostarts(dry: bool) -> int:
    """Windows: quita los auto-inicios del puente que apuntan a OTRAS carpetas (la causa del 'bridge anterior que no muere').
    Carpeta Inicio: respalda y borra los archivos ajenos. Tareas programadas ajenas: se DESHABILITAN (no se borran). Devuelve cuantos toco."""
    if sys.platform != "win32":
        return 0
    touched = 0
    startup = windows_startup_file().parent
    backup = HERE / "_autostart_backup"
    if startup.exists():
        for item in sorted(startup.iterdir()):
            if not item.is_file():
                continue
            try:
                if item.suffix.lower() == ".lnk":
                    _, out = _ps("$s=(New-Object -ComObject WScript.Shell).CreateShortcut(%s); $s.TargetPath + ' ' + $s.Arguments" % _ps_quote(str(item)), 20)
                    text = out
                elif item.suffix.lower() in (".vbs", ".cmd", ".bat", ".ps1", ".js"):
                    text = item.read_text(encoding="utf-8-sig", errors="replace")
                else:
                    continue
            except Exception:
                continue
            if _has_marker(text) and not _is_here(text):
                print(f"• Auto-inicio ajeno en Inicio: {item.name} (apunta a otra carpeta) -> respaldo y eliminacion")
                touched += 1
                if not dry:
                    backup.mkdir(exist_ok=True)
                    shutil.copy2(item, backup / item.name)
                    item.unlink(missing_ok=True)
    code, out = _ps("Get-ScheduledTask | ForEach-Object { $a = ($_.Actions | ForEach-Object { \"$($_.Execute) $($_.Arguments) $($_.WorkingDirectory)\" }) -join ' '; "
                    "if ($a -match 'start_bridge_loop|mcp_ws_bridge') { [pscustomobject]@{Name=$_.TaskName;Path=$_.TaskPath;Action=$a;State=[string]$_.State} } } | ConvertTo-Json -Compress")
    try:
        tasks = json.loads(out or "[]")
    except ValueError:
        tasks = []
    for task in ([tasks] if isinstance(tasks, dict) else tasks):
        if task.get("Name") == TASK_NAME or _is_here(task.get("Action", "")):
            continue
        print(f"• Tarea programada ajena: {task.get('Name')} ({task.get('Action', '')[:90]}) -> deshabilitada")
        touched += 1
        if not dry and task.get("State") != "Disabled":
            _ps("Disable-ScheduledTask -TaskName %s -TaskPath %s | Out-Null" % (_ps_quote(task["Name"]), _ps_quote(task.get("Path") or "\\")))
    if not touched:
        print("• No hay auto-inicios de otras copias.")
    return touched


def register_task(dry: bool) -> None:
    """Tarea programada propia: arranca el lanzador al iniciar sesion y lo reintenta cada minuto si muere. Es un seguro extra del .vbs."""
    if sys.platform != "win32":
        return
    cmd = launcher_command(windowless=True)
    print(f"• Registrando tarea programada {TASK_NAME} (reintento cada minuto)")
    if dry:
        return
    script = (
        "$a = New-ScheduledTaskAction -Execute %s -Argument %s -WorkingDirectory %s; "
        "$t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME; "
        "$s = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) "
        "-StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew; "
        "Register-ScheduledTask -TaskName %s -Action $a -Trigger $t -Settings $s -Force | Out-Null"
    ) % (_ps_quote(cmd[0]), _ps_quote('"%s"' % cmd[1]), _ps_quote(str(HERE)), _ps_quote(TASK_NAME))
    code, out = _ps(script)
    if code != 0:
        print(f"  (no se pudo registrar la tarea: {out[:160]}; el auto-inicio de la carpeta Inicio sigue activo)")


def unregister_task(dry: bool) -> None:
    if sys.platform == "win32" and not dry:
        _ps("Unregister-ScheduledTask -TaskName %s -Confirm:$false -ErrorAction SilentlyContinue" % _ps_quote(TASK_NAME), 20)


def windows_startup_file() -> Path:
    return Path(os.environ["APPDATA"]) / "Microsoft/Windows/Start Menu/Programs/Startup" / f"{NAME}.vbs"


def install_windows(dry: bool) -> None:
    cmd = " ".join(f'""{part}""' for part in launcher_command(windowless=True))
    script = f'CreateObject("Wscript.Shell").Run "{cmd}", 0, False\n'
    target = windows_startup_file()
    purge_foreign_autostarts(dry)  # primero se quitan los auto-inicios de otras copias: solo debe quedar UNO
    print(f"• Registrando arranque automático: {target}")
    if dry:
        register_task(dry)
        return
    target.write_text(script, encoding="utf-8")
    register_task(dry)
    start_launcher()  # arranca el lanzador ya (o lo reinicia si estaba corriendo); el lanzador levanta el puente


def uninstall_windows(dry: bool) -> None:
    target = windows_startup_file()
    print(f"• Eliminando {target}")
    if not dry:
        target.unlink(missing_ok=True)
        unregister_task(dry)
        stop_launcher()
        subprocess.run(["taskkill", "/F", "/FI", "WINDOWTITLE eq mcp_ws_bridge*"], capture_output=True)


# ───────────────────────── macOS ─────────────────────────

def mac_plist() -> Path:
    return Path.home() / "Library/LaunchAgents/com.webmcpbridge.plist"


def install_macos(dry: bool) -> None:
    args = "".join(f"<string>{a}</string>" for a in bridge_command())
    plist = (
        '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
        '"http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>'
        "<key>Label</key><string>com.webmcpbridge</string>"
        f"<key>ProgramArguments</key><array>{args}</array>"
        "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>"
    )
    print(f"• Registrando LaunchAgent: {mac_plist()}")
    if dry:
        return
    mac_plist().parent.mkdir(parents=True, exist_ok=True)
    mac_plist().write_text(plist, encoding="utf-8")
    subprocess.run(["launchctl", "unload", str(mac_plist())], capture_output=True)
    subprocess.run(["launchctl", "load", "-w", str(mac_plist())], check=True)


def uninstall_macos(dry: bool) -> None:
    print(f"• Eliminando {mac_plist()}")
    if not dry:
        subprocess.run(["launchctl", "unload", str(mac_plist())], capture_output=True)
        mac_plist().unlink(missing_ok=True)


# ───────────────────────── Linux (systemd --user) ─────────────────────────

def linux_unit() -> Path:
    return Path.home() / ".config/systemd/user/web-mcp-bridge.service"


def install_linux(dry: bool) -> None:
    exec_start = " ".join(f'"{a}"' for a in bridge_command())
    unit = (
        "[Unit]\nDescription=Web MCP Bridge\n\n"
        f"[Service]\nExecStart={exec_start}\nRestart=always\nRestartSec=3\n\n"
        "[Install]\nWantedBy=default.target\n"
    )
    print(f"• Registrando servicio systemd de usuario: {linux_unit()}")
    if dry:
        return
    linux_unit().parent.mkdir(parents=True, exist_ok=True)
    linux_unit().write_text(unit, encoding="utf-8")
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "--user", "enable", "--now", "web-mcp-bridge.service"], check=True)


def uninstall_linux(dry: bool) -> None:
    print(f"• Eliminando {linux_unit()}")
    if not dry:
        subprocess.run(["systemctl", "--user", "disable", "--now", "web-mcp-bridge.service"], capture_output=True)
        linux_unit().unlink(missing_ok=True)


# ───────────────────────── Principal ─────────────────────────

def main() -> int:
    for stream in (sys.stdout, sys.stderr):  # consolas cp1252: que los simbolos no tumben el script
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    parser = argparse.ArgumentParser(description="Instala el puente MCP como servicio de inicio automático.")
    parser.add_argument("--uninstall", action="store_true", help="Quita el arranque automático")
    parser.add_argument("--dry-run", action="store_true", help="Muestra los pasos sin ejecutarlos")
    parser.add_argument("--purge", action="store_true", help="Quita los auto-inicios de OTRAS copias del proyecto (Inicio + tareas programadas) y sale")
    parser.add_argument("--restart", action="store_true", help="Reinicia el puente ahora (cierra el anterior aunque este ocupando los puertos)")
    args = parser.parse_args()

    if args.restart:
        return restart_bridge()
    if args.purge:
        n = purge_foreign_autostarts(args.dry_run)
        print(f"✔ Listo: {n} auto-inicio(s) ajeno(s) tratado(s).")
        return 0

    system = {"win32": "windows", "darwin": "macos"}.get(sys.platform, "linux")
    actions = {
        "windows": (install_windows, uninstall_windows),
        "macos": (install_macos, uninstall_macos),
        "linux": (install_linux, uninstall_linux),
    }[system]

    if args.uninstall:
        actions[1](args.dry_run)
        print("✔ Arranque automático eliminado.")
        return 0

    print("• Instalando dependencias (websockets)…")
    if not args.dry_run:
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-r", str(HERE / "requirements.txt")], check=True)
    ensure_config(args.dry_run)
    actions[0](args.dry_run)
    print("\n✔ Listo. El puente corre en segundo plano y arrancará solo con tu sesión.")
    print(f"  Logs: {LOG}")
    print("  Ahora abre el popup de la extensión: debería mostrar los servidores en verde.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

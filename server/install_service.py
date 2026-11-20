#!/usr/bin/env python3
"""
install_service.py — Instala el puente MCP para que arranque SOLO al iniciar sesión.

Una sola vez:
    python server/install_service.py

Después basta con la extensión: el puente ya estará escuchando en segundo plano.

Otras opciones:
    python server/install_service.py --uninstall   # quita el arranque automático
    python server/install_service.py --dry-run     # muestra qué haría sin tocar nada

Los servidores MCP que se exponen se definen en `server/servers.json`
(se crea automáticamente la primera vez; edítalo y vuelve a ejecutar este script).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BRIDGE = HERE / "mcp_ws_bridge.py"
CONFIG = HERE / "servers.json"
LOG = HERE / "bridge.log"
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


def bridge_command(windowless: bool = False) -> list[str]:
    py = sys.executable
    if windowless and sys.platform == "win32":
        pyw = Path(py).with_name("pythonw.exe")
        py = str(pyw) if pyw.exists() else py
    return [py, str(BRIDGE), "--config", str(CONFIG), "--log-file", str(LOG)]


# ───────────────────────── Windows ─────────────────────────

def windows_startup_file() -> Path:
    return Path(os.environ["APPDATA"]) / "Microsoft/Windows/Start Menu/Programs/Startup" / f"{NAME}.vbs"


def stop_windows_bridges(dry: bool) -> None:
    """Detiene los puentes en marcha (python/pythonw con mcp_ws_bridge.py en la línea de comandos).

    `taskkill` por título de ventana no encuentra pythonw (no tiene ventana): se usa PowerShell + CIM.
    El script va en -EncodedCommand para que ninguna comilla se pierda por el camino.
    """
    import base64
    script = (
        "Get-CimInstance Win32_Process -Filter \"Name LIKE 'python%'\" | "
        "Where-Object { $_.CommandLine -like '*mcp_ws_bridge.py*' } | "
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }"
    )
    print("• Deteniendo puentes anteriores (si los hay)")
    if dry:
        return
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    res = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
                         capture_output=True, text=True)
    stopped = [line for line in res.stdout.split() if line.strip().isdigit()]
    if stopped:
        print(f"  Detenidos: {', '.join(stopped)}")


START_TASK = "WebMCPBridge-Start"
CONTROL_PORT = 47615


def task_xml(user: str, vbs: Path) -> str:
    """XML de una tarea programada SIN disparador que lanza el arranque oculto del puente en la sesión interactiva del usuario.

    Arrancarlo con `schtasks /run` lo independiza de quien lo pida: un `Popen` desde una sesión SSH queda dentro del «job» de esa
    sesión y muere al cerrarla; una tarea la lanza el Programador de tareas, fuera de ese job.
    """
    from xml.sax.saxutils import escape
    return f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Web MCP Bridge: arranca el puente (lo usa install_service.py para reiniciarlo desde fuera de la sesión)</Description></RegistrationInfo>
  <Principals><Principal id="Author"><UserId>{escape(user)}</UserId><LogonType>InteractiveToken</LogonType></Principal></Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT2M</ExecutionTimeLimit>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>"{escape(str(vbs))}"</Arguments></Exec></Actions>
</Task>
"""


def current_user() -> str:
    """Identificador del usuario actual para la tarea: su SID (resuelve siempre, p. ej. con `WORKGROUP\\usuario` no resolvía) o, si
    `whoami` falla, DOMINIO\\USUARIO."""
    try:
        out = subprocess.run(["whoami", "/user", "/fo", "csv", "/nh"], capture_output=True, text=True, timeout=10).stdout.strip()
        sid = out.split(",")[-1].strip().strip('"')
        if sid.startswith("S-1-"):
            return sid
    except (OSError, subprocess.SubprocessError):
        pass
    return f"{os.environ.get('USERDOMAIN', '')}\\{os.environ.get('USERNAME', '')}".strip("\\")


def bridge_listening(timeout: float = 12.0) -> bool:
    """¿Responde el canal de control del puente (127.0.0.1:47615)?"""
    import socket
    import time
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", CONTROL_PORT), timeout=1):
                return True
        except OSError:
            time.sleep(0.5)
    return False


def start_windows_bridge(vbs: Path) -> str:
    """Arranca el puente fuera de la sesión que lo pide. Devuelve cómo lo hizo: «tarea», «independiente» o «directo»."""
    import tempfile
    user = current_user()
    try:
        xml = Path(tempfile.gettempdir()) / f"{START_TASK}.xml"
        xml.write_text(task_xml(user, vbs), encoding="utf-16")
        made = subprocess.run(["schtasks", "/create", "/tn", START_TASK, "/xml", str(xml), "/f"], capture_output=True, text=True)
        xml.unlink(missing_ok=True)
        if made.returncode == 0:
            ran = subprocess.run(["schtasks", "/run", "/tn", START_TASK], capture_output=True, text=True)
            if ran.returncode == 0 and bridge_listening():
                return "tarea"
    except OSError:
        pass
    # Sin tarea: proceso desligado del «job» de la sesión (CREATE_BREAKAWAY_FROM_JOB) si el sistema lo permite
    for flags, nombre in ((0x00000008 | 0x00000200 | 0x01000000, "independiente"), (0x00000008 | 0x00000200, "directo")):
        try:
            subprocess.Popen(bridge_command(windowless=True), creationflags=flags, close_fds=True)
            return nombre
        except OSError:
            continue
    return "ninguno"


def install_windows(dry: bool) -> None:
    cmd = " ".join(f'""{part}""' for part in bridge_command(windowless=True))
    script = f'CreateObject("Wscript.Shell").Run "{cmd}", 0, False\n'
    target = windows_startup_file()
    print(f"• Registrando arranque automático: {target}")
    if dry:
        return
    target.write_text(script, encoding="utf-8")
    stop_windows_bridges(dry)  # si no, el puente nuevo choca con los puertos del anterior
    como = start_windows_bridge(target)
    print(f"• Puente arrancado ({como}); {'responde' if bridge_listening(8) else 'NO responde todavía: abre WebMCPBridge.vbs de la carpeta Inicio'}")


def uninstall_windows(dry: bool) -> None:
    target = windows_startup_file()
    print(f"• Eliminando {target}")
    if not dry:
        target.unlink(missing_ok=True)
        subprocess.run(["schtasks", "/delete", "/tn", START_TASK, "/f"], capture_output=True)
    stop_windows_bridges(dry)


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
    # La tarea programada de Windows (update.ps1) ejecuta esto con la consola en cp1252: sin esto,
    # imprimir «✔» rompía el script DESPUÉS de reiniciar el puente y dejaba un traceback en update.log.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    parser = argparse.ArgumentParser(description="Instala el puente MCP como servicio de inicio automático.")
    parser.add_argument("--uninstall", action="store_true", help="Quita el arranque automático")
    parser.add_argument("--dry-run", action="store_true", help="Muestra los pasos sin ejecutarlos")
    args = parser.parse_args()

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

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


def install_windows(dry: bool) -> None:
    cmd = " ".join(f'""{part}""' for part in bridge_command(windowless=True))
    script = f'CreateObject("Wscript.Shell").Run "{cmd}", 0, False\n'
    target = windows_startup_file()
    print(f"• Registrando arranque automático: {target}")
    if dry:
        return
    target.write_text(script, encoding="utf-8")
    subprocess.Popen(bridge_command(windowless=True), creationflags=0x00000008 | 0x00000200, close_fds=True)  # DETACHED | NEW_GROUP


def uninstall_windows(dry: bool) -> None:
    target = windows_startup_file()
    print(f"• Eliminando {target}")
    if not dry:
        target.unlink(missing_ok=True)
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

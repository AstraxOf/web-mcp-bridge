"""Pruebas de install_service.py que no tocan el sistema: el XML de la tarea de arranque del puente."""
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import install_service as I  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")
vbs = Path("C:/Users/Ana & Co/AppData/Roaming/Startup/WebMCPBridge.vbs")
xml = I.task_xml("PC\\Ana & Co", vbs)
raiz = ET.fromstring(xml.split("?>", 1)[1])                      # el XML es válido aunque haya «&» en nombres
ns = {"t": "http://schemas.microsoft.com/windows/2004/02/mit/task"}
assert raiz.find("t:Principals/t:Principal/t:UserId", ns).text == "PC\\Ana & Co"
assert raiz.find("t:Principals/t:Principal/t:LogonType", ns).text == "InteractiveToken"
assert raiz.find("t:Actions/t:Exec/t:Command", ns).text == "wscript.exe"
assert raiz.find("t:Actions/t:Exec/t:Arguments", ns).text == f'"{vbs}"'
assert raiz.find("t:Triggers", ns) is None, "sin disparador: solo se lanza a mano con schtasks /run"
assert raiz.find("t:Settings/t:MultipleInstancesPolicy", ns).text == "IgnoreNew"
assert I.START_TASK == "WebMCPBridge-Start" and I.CONTROL_PORT == 47615
print("✔ test_install_service: todo correcto")

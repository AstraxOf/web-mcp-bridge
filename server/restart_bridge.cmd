@echo off
rem Reinicia el puente MCP (cierra el anterior aunque este ocupando el puerto 8080 y arranca uno nuevo en segundo plano).
python "%~dp0mcp_ws_bridge.py" --config "%~dp0servers.json" --restart
pause

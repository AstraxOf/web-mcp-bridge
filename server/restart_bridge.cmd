@echo off
rem Restarts the MCP bridge (closes the previous one even if it is holding port 8080, and starts a new one in the background).
python "%~dp0mcp_ws_bridge.py" --config "%~dp0servers.json" --restart
pause

@echo off
python "%~dp0mcp_ws_bridge.py" --config "%~dp0servers.json" --status
pause

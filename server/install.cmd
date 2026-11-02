@echo off
setlocal
cd /d "%~dp0"
where python >nul 2>&1 && (set "PY=python") || (set "PY=py")
%PY% install_service.py
echo.
pause

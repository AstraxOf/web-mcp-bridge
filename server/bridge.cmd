@echo off
rem ============================================================================
rem  Web MCP Bridge - bridge control (start / restart / status / stop / reload)
rem
rem  Double-click       -> menu.
rem  From the terminal  -> bridge.cmd start | restart | status | stop | reload
rem                        (Spanish words also work: iniciar, reiniciar, estado, detener, recargar)
rem
rem  If Python is installed but the requirements (websockets) are missing, they are installed automatically.
rem ============================================================================
setlocal EnableExtensions
cd /d "%~dp0"
title Web MCP Bridge
set "BRIDGE=%~dp0mcp_ws_bridge.py"
set "CONFIG=%~dp0servers.json"
set "LOGF=%~dp0bridge.log"
set "FROMMENU="

rem ---------- 1. Python ----------
set "PY="
python -c "import sys" >nul 2>&1
if not errorlevel 1 set "PY=python"
if defined PY goto have_python
py -3 -c "import sys" >nul 2>&1
if not errorlevel 1 set "PY=py -3"
if defined PY goto have_python
echo.
echo  [X] Python 3 was not found on this computer.
echo      Install it from https://www.python.org/downloads/
echo      and tick "Add python.exe to PATH". Then open this file again.
echo.
pause
exit /b 1

:have_python
%PY% -c "import sys; sys.exit(0 if sys.version_info[:2] >= (3, 9) else 1)" >nul 2>&1
if not errorlevel 1 goto py_ok
echo.
echo  [X] Python 3.9 or newer is required. Update it from https://www.python.org/downloads/
echo.
pause
exit /b 1

:py_ok

rem ---------- 2. Requirements (installed automatically if missing) ----------
%PY% -c "from websockets.asyncio.server import serve" >nul 2>&1
if not errorlevel 1 goto deps_ok
echo.
echo  The bridge requirements are missing. Installing them (one time only)...
%PY% -m pip --version >nul 2>&1
if errorlevel 1 %PY% -m ensurepip --upgrade >nul 2>&1
%PY% -m pip install --disable-pip-version-check -r "%~dp0requirements.txt"
if errorlevel 1 %PY% -m pip install --user --disable-pip-version-check -r "%~dp0requirements.txt"
%PY% -c "from websockets.asyncio.server import serve" >nul 2>&1
if not errorlevel 1 goto deps_installed
echo.
echo  [X] Could not install the requirements. Try it manually:
echo      %PY% -m pip install -r "%~dp0requirements.txt"
echo.
pause
exit /b 1

:deps_installed
echo  Requirements installed successfully.
echo.

:deps_ok
rem ---------- 3. servers.json (created from the example if it does not exist) ----------
if exist "%CONFIG%" goto have_config
if not exist "%~dp0servers.example.json" goto have_config
copy /y "%~dp0servers.example.json" "%CONFIG%" >nul
echo  servers.json was created from servers.example.json.

:have_config

rem ---------- 4. Action ----------
set "ACTION=%~1"
if not defined ACTION goto menu
if /i "%ACTION%"=="start"     goto do_start
if /i "%ACTION%"=="iniciar"   goto do_start
if /i "%ACTION%"=="restart"   goto do_restart
if /i "%ACTION%"=="reiniciar" goto do_restart
if /i "%ACTION%"=="status"    goto do_status
if /i "%ACTION%"=="estado"    goto do_status
if /i "%ACTION%"=="stop"      goto do_stop
if /i "%ACTION%"=="detener"   goto do_stop
if /i "%ACTION%"=="reload"    goto do_reload
if /i "%ACTION%"=="recargar"  goto do_reload
echo Usage: bridge.cmd [start ^| restart ^| status ^| stop ^| reload]
exit /b 2

:menu
set "FROMMENU=1"
cls
echo.
echo   ==============================
echo     Web MCP Bridge
echo   ==============================
echo.
echo     1. Start
echo     2. Restart
echo     3. Status
echo     4. Stop
echo     5. Reload servers.json
echo     0. Exit
echo.
choice /c 123450 /n /m "  Choose an option: "
if errorlevel 6 exit /b 0
if errorlevel 5 goto do_reload
if errorlevel 4 goto do_stop
if errorlevel 3 goto do_status
if errorlevel 2 goto do_restart
goto do_start

:do_start
echo.
echo  Starting the bridge (if it is already running, it only reloads servers.json)...
%PY% "%BRIDGE%" --config "%CONFIG%" --log-file "%LOGF%" --detach
goto after

:do_restart
echo.
%PY% "%BRIDGE%" --config "%CONFIG%" --log-file "%LOGF%" --restart
goto after

:do_status
echo.
%PY% "%BRIDGE%" --config "%CONFIG%" --status
goto after

:do_stop
echo.
%PY% "%BRIDGE%" --config "%CONFIG%" --stop
echo  (If you installed auto-start, the supervisor will bring it back up in a few seconds.)
goto after

:do_reload
echo.
%PY% "%BRIDGE%" --config "%CONFIG%" --reload
goto after

:after
set "RC=%errorlevel%"
if not defined FROMMENU exit /b %RC%
echo.
pause
goto menu

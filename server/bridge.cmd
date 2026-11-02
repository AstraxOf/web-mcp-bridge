@echo off
rem ============================================================================
rem  Web MCP Bridge - control del puente (iniciar / reiniciar / estado / detener / recargar)
rem
rem  Doble clic         -> menu.
rem  Desde la terminal  -> bridge.cmd start | restart | status | stop | reload
rem                        (tambien: iniciar, reiniciar, estado, detener, recargar)
rem
rem  Si Python esta instalado pero faltan los requisitos (websockets), los instala solo.
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
echo  [X] No se encontro Python 3 en este equipo.
echo      Instalalo desde https://www.python.org/downloads/
echo      y marca la casilla "Add python.exe to PATH". Luego vuelve a abrir este archivo.
echo.
pause
exit /b 1

:have_python
%PY% -c "import sys; sys.exit(0 if sys.version_info[:2] >= (3, 9) else 1)" >nul 2>&1
if not errorlevel 1 goto py_ok
echo.
echo  [X] Se necesita Python 3.9 o superior. Actualizalo desde https://www.python.org/downloads/
echo.
pause
exit /b 1

:py_ok

rem ---------- 2. Requisitos (se instalan solos si faltan) ----------
%PY% -c "from websockets.asyncio.server import serve" >nul 2>&1
if not errorlevel 1 goto deps_ok
echo.
echo  Faltan los requisitos del puente. Instalando (una sola vez)...
%PY% -m pip --version >nul 2>&1
if errorlevel 1 %PY% -m ensurepip --upgrade >nul 2>&1
%PY% -m pip install --disable-pip-version-check -r "%~dp0requirements.txt"
if errorlevel 1 %PY% -m pip install --user --disable-pip-version-check -r "%~dp0requirements.txt"
%PY% -c "from websockets.asyncio.server import serve" >nul 2>&1
if not errorlevel 1 goto deps_installed
echo.
echo  [X] No se pudieron instalar los requisitos. Prueba manualmente:
echo      %PY% -m pip install -r "%~dp0requirements.txt"
echo.
pause
exit /b 1

:deps_installed
echo  Requisitos instalados correctamente.
echo.

:deps_ok
rem ---------- 3. servers.json (si no existe, se crea desde el ejemplo) ----------
if exist "%CONFIG%" goto have_config
if not exist "%~dp0servers.example.json" goto have_config
copy /y "%~dp0servers.example.json" "%CONFIG%" >nul
echo  Se creo servers.json a partir de servers.example.json.

:have_config

rem ---------- 4. Accion ----------
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
echo Uso: bridge.cmd [start ^| restart ^| status ^| stop ^| reload]
exit /b 2

:menu
set "FROMMENU=1"
cls
echo.
echo   ==============================
echo     Web MCP Bridge - Puente
echo   ==============================
echo.
echo     1. Iniciar
echo     2. Reiniciar
echo     3. Estado
echo     4. Detener
echo     5. Recargar servers.json
echo     0. Salir
echo.
choice /c 123450 /n /m "  Elige una opcion: "
if errorlevel 6 exit /b 0
if errorlevel 5 goto do_reload
if errorlevel 4 goto do_stop
if errorlevel 3 goto do_status
if errorlevel 2 goto do_restart
goto do_start

:do_start
echo.
echo  Iniciando el puente (si ya esta corriendo, solo recarga servers.json)...
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
echo  (Si instalaste el arranque automatico, el supervisor lo volvera a levantar en unos segundos.)
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
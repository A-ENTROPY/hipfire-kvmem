@echo off
REM ===========================================================================
REM  Start the Chinese control panel (engine management, model picker,
REM  presets, live logs).
REM
REM  Panel listens on 127.0.0.1:18201 and starts the hipfire engine described
REM  by config.json in this directory (engine on 18200 by default).
REM  Requires Node.js 18+ on PATH.
REM
REM  Keep this file pure ASCII - see the note in hipfire.bat.
REM ===========================================================================
setlocal EnableExtensions
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

REM The panel locates the engine and the model directory through these two.
set "KVMEM_HIPFIRE_ROOT=%ROOT%"
set "KVMEM_HIPFIRE_MODELS_DIR=%ROOT%\models"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] node.exe not found on PATH. Install Node.js 18+ and retry.
  pause
  exit /b 1
)

if not exist "%ROOT%\models" mkdir "%ROOT%\models" >nul 2>&1

echo Panel: http://127.0.0.1:18201/
start "" http://127.0.0.1:18201/
cd /d "%ROOT%"
node "%ROOT%\panel\kvmem-control.mjs"
endlocal

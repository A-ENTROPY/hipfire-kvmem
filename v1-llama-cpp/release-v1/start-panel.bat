@echo off
REM ============================================================================
REM  KVMem settings panel launcher (ASCII wrapper)
REM  Starts the Chinese tuning panel (all parameters in a web form, persisted,
REM  apply-and-restart, model switching). Requires Node.js.
REM
REM  If Node.js is missing, use start-kvmem.bat instead for a direct launch.
REM ============================================================================
setlocal EnableExtensions
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-panel.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" pause
endlocal
exit /b %RC%
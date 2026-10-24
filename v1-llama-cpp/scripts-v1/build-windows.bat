@echo off
REM ============================================================================
REM  Build KVMem + ROCmFP4 + DFlash2 on Windows (ASCII wrapper).
REM  All logic and Chinese messages live in build-windows.ps1 (UTF-8 with BOM).
REM  Do NOT put non-ASCII text in this .bat file.
REM
REM  Usage:
REM     scripts\build-windows.bat
REM     scripts\build-windows.bat -RocmPath "C:\Program Files\AMD\ROCm\7.2" -GpuTarget gfx1100 -Jobs 24
REM ============================================================================
setlocal EnableExtensions
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-windows.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
    echo.
    echo [FAILED] exit code = %RC%
    pause
)
endlocal
exit /b %RC%
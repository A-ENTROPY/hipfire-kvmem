@echo off
REM ============================================================================
REM  KVMem + ROCmFP4 + DFlash2 launcher (ASCII wrapper)
REM  Logic and Chinese messages live in start-kvmem.ps1 (UTF-8 with BOM).
REM
REM  SIMPLEST USAGE: put your .gguf models into the models\ folder,
REM  then double-click this file. It auto-detects everything.
REM
REM  Optional:
REM     start-kvmem.bat -List                 list detected models only
REM     start-kvmem.bat -DryRun               print the command, do not start
REM     start-kvmem.bat -ModelsDir "D:\models"   use another model folder
REM     start-kvmem.bat -Spec none            disable speculative decoding
REM     start-kvmem.bat -Context 32768        smaller context, less VRAM
REM ============================================================================
setlocal EnableExtensions
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-kvmem.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
    echo.
    echo [FAILED] exit code = %RC%
    pause
)
endlocal
exit /b %RC%
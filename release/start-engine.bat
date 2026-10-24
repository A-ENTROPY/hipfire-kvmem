@echo off
REM ===========================================================================
REM  Start the hipfire engine alone (no panel): OpenAI-compatible API + web UI.
REM
REM  Usage:
REM    start-engine.bat                    use the first .hfq under models\
REM    start-engine.bat D:\path\model.hfq  use the given model
REM
REM  Endpoints: http://127.0.0.1:18200/v1  and  http://127.0.0.1:18200/ui
REM
REM  Keep this file pure ASCII - see the note in hipfire.bat.
REM ===========================================================================
setlocal EnableExtensions
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "MODEL=%~1"
if not defined MODEL (
  for %%F in ("%ROOT%\models\*.hfq") do (
    if not defined MODEL set "MODEL=%%~fF"
  )
)
if not defined MODEL (
  echo [ERROR] No model given and no .hfq found under "%ROOT%\models".
  echo         Usage: start-engine.bat ^<path-to-model.hfq^>
  pause
  exit /b 1
)
if not exist "%MODEL%" (
  echo [ERROR] Model file not found: %MODEL%
  pause
  exit /b 1
)

set "HIPFIRE_PORT=18200"
set "HIPFIRE_HOST=127.0.0.1"
set "HIPFIRE_SPECULATION=mtp"
set "HIPFIRE_SERVE_MULTI_SLOT=1"
set "HIPFIRE_SERVE_MULTI_SLOT_SLOTS=1"
set "HIPFIRE_SERVE_MULTI_SLOT_CTX=262144"
set "HIPFIRE_SLOTS_PAGED=1"
REM Pool size in 128-token pages. 425 pages = 54400 tokens: a 288-page
REM (36864 token) working window plus slack. Without this the engine sizes the
REM pool for the whole 262144 context (2048 pages = 9 GiB) and the VRAM
REM preflight refuses to start.
set "HIPFIRE_SLOTS_PAGED_PAGES=425"
set "HIPFIRE_LOG=info"

echo Model:  %MODEL%
echo API:    http://127.0.0.1:18200/v1
echo Web UI: http://127.0.0.1:18200/ui
call "%ROOT%\hipfire.bat" serve --model "%MODEL%" --ui
endlocal

@echo off
REM ===========================================================================
REM  hipfire launcher - every path is relative to this file, so the whole
REM  package can live in any directory (no absolute paths baked in).
REM
REM  Why this .bat exists at all:
REM  1) hipfire may spawn clang to compile kernels on demand, and clang on
REM     Windows happily picks up E:\Microsoft Visual Studio\VC98\include
REM     (Visual C++ 6.0, from 1998) and puts its cstdlib ahead of the real
REM     MSVC headers, which breaks kernel compilation. So we call vcvars64
REM     first and then strip the VC98 entries from INCLUDE.
REM  2) The engine locates its config through HOME (<HOME>\.hipfire\config.toml).
REM     We point HOME at the package root so the config travels with the
REM     package instead of polluting the user profile.
REM
REM  This build ships precompiled gfx1100 kernels (.hipfire_kernels\gfx1100),
REM  so nothing gets compiled at runtime in the normal case. vcvars64 is only
REM  called when it exists - the engine runs fine without it.
REM
REM  NOTE: keep this file pure ASCII. cmd parses .bat as ANSI, and GBK trail
REM  bytes can collide with | & < > and corrupt the script.
REM ===========================================================================
setlocal EnableExtensions

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

REM --- HOME: where the engine keeps config.toml -----------------------------
set "HOME=%ROOT%"
set "USERPROFILE=%ROOT%"

REM --- runtime: the package carries its own amdhip64.dll --------------------
set "PATH=%ROOT%\bin;%ROOT%\bin\runtime;%PATH%"

REM --- ROCm: the package ships the HIP runtime only, enough to load and run
REM     the precompiled kernels. If this machine has a full ROCm install and
REM     you need on-demand kernel compilation, set HIP_PATH / ROCM_PATH
REM     before running, or edit the two defaults below.
if not defined HIP_PATH  set "HIP_PATH=%ROOT%\bin\runtime"
if not defined ROCM_PATH set "ROCM_PATH=%ROOT%\bin\runtime"

REM --- MSVC headers: call vcvars64 when present, skip otherwise -------------
set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if exist "%VCVARS%" (
  call "%VCVARS%" >nul 2>&1
  set "INCLUDE=%INCLUDE:E:\Microsoft Visual Studio\VC98\include;=%"
  set "INCLUDE=%INCLUDE:E:\Microsoft Visual Studio\VC98\include=%"
)

cd /d "%ROOT%\bin"
"%ROOT%\bin\hipfire.exe" %*
echo HIPFIRE_RC=%ERRORLEVEL%
endlocal

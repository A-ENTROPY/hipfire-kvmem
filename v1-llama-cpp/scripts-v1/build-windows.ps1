<#
.SYNOPSIS
  用 MSVC + Ninja + ROCm HIP 编译 KVMem+ROCmFP4+DFlash2（Windows）。

.DESCRIPTION
  关键点：
    * MSVC 必须为 14.44（VS 2022）
    * 必须使用标准布局的 ROCm（设备库在 <ROCM>\amdgcn\bitcode）
      —— 本脚本会从 PATH 中剔除 TheRock / 其它 HIP SDK，避免设备库找不到
    * 产物在 build-hip-win\bin\llama-kvmem-server.exe

.EXAMPLE
  .\scripts\build-windows.bat -RocmPath "C:\Program Files\AMD\ROCm\7.2" -GpuTarget gfx1100 -Jobs 24
#>
param(
    [string]$RocmPath  = 'C:\Program Files\AMD\ROCm\7.2',
    [string]$GpuTarget = 'gfx1100',
    [int]   $Jobs      = 0,
    [string]$BuildDir  = '',
    [switch]$ConfigureOnly
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $BuildDir) { $BuildDir = Join-Path $repoRoot 'build-hip-win' }
if ($Jobs -le 0) { $Jobs = [Environment]::ProcessorCount }

if (-not (Test-Path (Join-Path $repoRoot 'llama.cpp/CMakeLists.txt'))) {
    throw '缺少 llama.cpp。先运行 scripts\fetch-llama-and-patch.ps1'
}
if (-not (Test-Path (Join-Path $RocmPath 'bin/clang++.exe'))) {
    throw "ROCm 路径无效（找不到 clang++.exe）: $RocmPath"
}
if (-not (Test-Path (Join-Path $RocmPath 'amdgcn/bitcode/ocml.bc'))) {
    throw "ROCm 不是标准布局：找不到 $RocmPath\amdgcn\bitcode\ocml.bc`n请改用标准安装的 ROCm/HIP SDK（例如 C:\Program Files\AMD\ROCm\7.2）。"
}

# 定位 MSVC
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vcvars = $null
if (Test-Path $vswhere) {
    $vsRoot = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($vsRoot) { $vcvars = Join-Path $vsRoot 'VC\Auxiliary\Build\vcvars64.bat' }
}
if (-not $vcvars -or -not (Test-Path $vcvars)) { throw '找不到 vcvars64.bat，请安装 VS 2022 C++ Build Tools' }

# 干净 PATH：剔除其它 HIP SDK，放入本 ROCm + Ninja
$seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$parts = @()
foreach ($p in ($env:PATH -split ';')) {
    if (-not $p) { continue }
    if ($p -match 'TheRock') { continue }
    if ($p -match 'AMD.ROCm' -and $p -notlike "$RocmPath*") { continue }
    if ($seen.Add($p)) { $parts += $p }
}
$cleanPath = (@("$RocmPath\bin") + $parts) -join ';'

$ninja = Get-Command ninja -ErrorAction SilentlyContinue
if (-not $ninja) { Write-Warning 'PATH 中找不到 ninja，请先安装（单文件 exe 放进 PATH 即可）' }

$rl = Join-Path $RocmPath 'bin/llvm-ranlib.exe'
$rlShim = Join-Path $BuildDir 'kvmem-tools/llvm-ranlib.exe'
New-Item -ItemType Directory -Force -Path (Split-Path $rlShim) | Out-Null
if (-not (Test-Path $rl)) {
    # 部分 ROCm 包缺少 llvm-ranlib，用 llvm-ar 的副本代替（LLVM 工具按 argv[0] 选择模式）
    Copy-Item (Join-Path $RocmPath 'bin/llvm-ar.exe') $rlShim -Force
    $rl = $rlShim
}

$targetArgs = @("-DGPU_TARGETS=$GpuTarget", "-DCMAKE_HIP_ARCHITECTURES=$GpuTarget")
$confOnly = if ($ConfigureOnly) { '1' } else { '' }

Write-Host "仓库     : $repoRoot"
Write-Host "构建目录 : $BuildDir"
Write-Host "ROCm     : $RocmPath"
Write-Host "GPU 目标 : $GpuTarget"
Write-Host "并行任务 : $Jobs"
Write-Host ''

$bat = Join-Path $env:TEMP "kvmem-build-$([guid]::NewGuid().ToString('N').Substring(0,8)).bat"
$lines = @(
    '@echo off'
    'setlocal EnableExtensions'
    "call `"$vcvars`" >nul || exit /b 1"
    "set `"PATH=$RocmPath\bin;$cleanPath`""
    "set `"HIP_PATH=$RocmPath`""
    "set `"ROCM_PATH=$RocmPath`""
    "cmake -S `"$repoRoot`" -B `"$BuildDir`" -G Ninja ^"
    "  -DCMAKE_BUILD_TYPE=Release ^"
    "  -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ ^"
    "  -DCMAKE_AR=`"$RocmPath\bin\llvm-ar.exe`" -DCMAKE_RANLIB=`"$rl`" ^"
    "  -DGGML_HIP=ON -DGGML_CUDA=OFF -DROCM_PATH=`"$RocmPath`" ^"
    "  $($targetArgs -join ' ') ^"
    "  -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DGGML_VULKAN=OFF -DGGML_CCACHE=OFF ^"
    "  -DKVMEM_ENABLE_NVME=OFF -DKVMEM_BUILD_LLAMA=ON -DLLAMA_KVMEM=ON -DLLAMA_KVMEM_ROOT=`"$repoRoot`""
    'if errorlevel 1 ( echo [error] CMake 配置失败 & exit /b 1 )'
    "findstr /C:`"CMAKE_CXX_FLAGS_RELEASE:STRING=-O`" `"$BuildDir\CMakeCache.txt`" >nul 2>&1"
    'if errorlevel 1 ( echo [error] 构建缺少 -O 优化标志 & exit /b 1 )'
    "if `"$confOnly`"==`"1`" ( echo 配置完成。 & exit /b 0 )"
    "cmake --build `"$BuildDir`" --config Release -j$Jobs"
    'if errorlevel 1 ( echo [error] 编译失败 & exit /b 1 )'
    'echo.'
    'echo 完成。产物：'
    "dir /b `"$BuildDir\bin\llama-kvmem-server.exe`" 2>nul"
    'endlocal'
)
# 以 ANSI 写出（bat 只含 ASCII）
[System.IO.File]::WriteAllText($bat, (($lines -join "`r`n") + "`r`n"), [System.Text.Encoding]::ASCII)
& cmd.exe /c $bat
$code = $LASTEXITCODE
Remove-Item $bat -Force -ErrorAction SilentlyContinue
if ($code -ne 0) { throw "编译失败（退出码 $code）" }
Write-Host ''
Write-Host "产物: $(Join-Path $BuildDir 'bin/llama-kvmem-server.exe')"
Write-Host '下一步： .\scripts\package-runtime.ps1'

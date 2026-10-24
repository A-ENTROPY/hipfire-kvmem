<#
.SYNOPSIS
  把编译产物 + ROCm 运行库 + 启动脚本打成一个自包含的发行 ZIP。

.DESCRIPTION
  已实测的最小运行库集合（约 740 MB，含 rocblas 内核库）：
    必须包含 amdhip64_7.dll / hipblas.dll / rocblas.dll / hipblaslt.dll
    以及 rocblas/ 内核目录；hipblaslt/ 内核目录（约 650 MB）可不打包。
    可选用 -Lite 生成不含 ROCm 运行库的小包（需目标机自行安装 ROCm 7.2）。

.EXAMPLE
  .\scripts\package-runtime.ps1 -RocmPath "C:\Program Files\AMD\ROCm\7.2" -GpuTarget gfx1100
#>
[CmdletBinding()]
param(
    [string]$RocmPath  = 'C:\Program Files\AMD\ROCm\7.2',
    [string]$BuildDir  = '',
    [string]$GpuTarget = 'gfx1100',
    [string]$OutDir    = '',
    [string]$UiSource  = '',
    [string[]]$ExtraExe = @('llama-quantize.exe','llama-kvmem-cli.exe'),
    [switch]$Lite,
    [switch]$KeepStage
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $BuildDir) { $BuildDir = Join-Path $repoRoot 'build-hip-win' }
if (-not $OutDir)   { $OutDir   = $repoRoot }

$exe = Join-Path $BuildDir 'bin/llama-kvmem-server.exe'
if (-not (Test-Path $exe)) { throw "找不到编译产物: $exe（先运行 scripts\build-windows.bat）" }

$stage = Join-Path $env:TEMP "kvmem-pkg-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$bin   = Join-Path $stage 'bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null

Copy-Item $exe $bin -Force

# Extra executables. The docs tell users to quantize with the bundled
# llama-quantize, so it must be inside the package too.
foreach ($x in $ExtraExe) {
    $src = Join-Path $BuildDir "bin/$x"
    if (Test-Path $src) { Copy-Item $src $bin -Force; Write-Host "附带可执行文件: $x" }
    else { Write-Warning "未找到 $x（说明文档有引用，建议补上）" }
}

if (-not $Lite) {
    if (-not (Test-Path (Join-Path $RocmPath 'bin/amdhip64_7.dll'))) {
        throw "ROCm 运行库路径无效: $RocmPath"
    }
    $dlls = @('amdhip64_7.dll','hipblas.dll','rocblas.dll','hipblaslt.dll',
              'amd_comgr_3.dll','amd_comgr0702.dll','hiprtc0702.dll','hiprtc-builtins0702.dll')
    foreach ($d in $dlls) {
        $src = Join-Path $RocmPath "bin/$d"
        if (Test-Path $src) { Copy-Item $src $bin -Force }
        else { Write-Warning "运行库缺失（可能不影响）: $d" }
    }
    # rocblas 内核库必需；hipblaslt 内核库体积大且本路径不需要，跳过
    $rocblas = Join-Path $RocmPath 'bin/rocblas'
    if (Test-Path $rocblas) {
        Write-Host '复制 rocblas 内核库（约 350 MB，需要一点时间）...'
        Copy-Item $rocblas -Destination (Join-Path $bin 'rocblas') -Recurse -Force
    } else { Write-Warning '未找到 rocblas 内核目录，可能运行失败' }
}

# 启动脚本与说明
Copy-Item (Join-Path $repoRoot 'release/start-kvmem.bat') $stage -Force
Copy-Item (Join-Path $repoRoot 'release/start-kvmem.ps1') $stage -Force
Copy-Item (Join-Path $repoRoot 'release/start-panel.bat') $stage -Force
Copy-Item (Join-Path $repoRoot 'release/start-panel.ps1') $stage -Force
# 中文调参面板（Node.js 服务）
$panelDst = Join-Path $stage 'panel'
New-Item -ItemType Directory -Force -Path $panelDst | Out-Null
Copy-Item (Join-Path $repoRoot 'panel/*') $panelDst -Force -Recurse
Copy-Item (Join-Path $repoRoot 'release/读我用我.txt')     $stage -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $repoRoot 'release/测试说明-20261006.txt') $stage -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $repoRoot 'LICENSE')                  $stage -Force
Copy-Item (Join-Path $repoRoot 'README.md')                $stage -Force
Copy-Item (Join-Path $repoRoot 'THIRD_PARTY_NOTICES.md')   $stage -Force

# models/ 空目录 + 下载说明（启动脚本会自动扫描这里）
$modelsDst = Join-Path $stage 'models'
New-Item -ItemType Directory -Force -Path $modelsDst | Out-Null
Copy-Item (Join-Path $repoRoot 'release/models/*') $modelsDst -Force -Recurse -ErrorAction SilentlyContinue

# Web UI（来自 llama.cpp / KVMem 的 MIT 许可前端）
if (-not $UiSource) { $UiSource = Join-Path $repoRoot 'ui-src' }
if (Test-Path (Join-Path $UiSource 'index.html')) {
    $uiDst = Join-Path $stage 'share/kvmem/ui'
    New-Item -ItemType Directory -Force -Path $uiDst | Out-Null
    Copy-Item (Join-Path $UiSource '*') $uiDst -Recurse -Force
    # 若存在原始 index.html（未注入本地控制台按钮），用它覆盖
    if (Test-Path (Join-Path $uiDst 'index.html.orig')) {
        Copy-Item (Join-Path $uiDst 'index.html.orig') (Join-Path $uiDst 'index.html') -Force
    }
    Remove-Item (Join-Path $uiDst 'index.html.orig') -Force -ErrorAction SilentlyContinue
    Write-Host 'Web UI 已打包。'
} else {
    Write-Warning "未找到 Web UI 源（$UiSource），包内不含网页界面（仅 API 可用）。用 -UiSource 指定。"
}

$suffix = if ($Lite) { 'lite' } else { 'selfcontained' }
$name = "kvmem-rocmfp4-$GpuTarget-windows-rocm7.2-$suffix.zip"
$zip  = Join-Path $OutDir $name
if (Test-Path $zip) { Remove-Item $zip -Force }

Write-Host "打包 $name ..."
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
$size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "完成: $zip  ($size MB)"

if (-not $KeepStage) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }
else { Write-Host "暂存目录保留: $stage" }

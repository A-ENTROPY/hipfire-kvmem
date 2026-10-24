<#
.SYNOPSIS
  拉取 ROCmFP4 基线（含 DFlash2 的上游 llama.cpp）并应用 KVMem 补丁。

.DESCRIPTION
  基线选择依据：walcz-de/llama.cpp-ROCmFP4 的 rocmfp4-pre-3466812d-20260902 分支，
  其上游基线 3466812d（2026-09-01）与 KVMem 钉定的 b81c99b（2026-09-02）仅差 8 个提交，
  因此 KVMem 补丁可零冲突套用；该基线同时已包含 DFlash2（上游 PR #27342）。

.EXAMPLE
  .\scripts\fetch-llama-and-patch.ps1
#>
[CmdletBinding()]
param(
    [string]$BaseRepo   = 'walcz-de/llama.cpp-ROCmFP4',
    [string]$BaseBranch = 'rocmfp4-pre-3466812d-20260902',
    [string]$Dest       = '',
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $Dest) { $Dest = Join-Path $repoRoot 'llama.cpp' }
$patch = Join-Path $repoRoot 'patches/llama-kvmem-current.patch'

if (-not (Test-Path $patch)) { throw "缺少补丁: $patch" }
if ((Test-Path $Dest) -and -not $Force) {
    if (Test-Path (Join-Path $Dest 'CMakeLists.txt')) {
        Write-Host "llama.cpp 已存在（用 -Force 可重新拉取）: $Dest"
    } else {
        throw "目标目录已存在但不是 llama.cpp 源码: $Dest"
    }
} else {
    if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force }
    $tar = Join-Path $env:TEMP "rocmfp4-$([guid]::NewGuid().ToString('N').Substring(0,8)).tar.gz"
    $url = "https://codeload.github.com/$BaseRepo/tar.gz/refs/heads/$BaseBranch"
    Write-Host "下载基线 $BaseRepo@$BaseBranch ..."
    & curl.exe -L -o $tar $url --retry 10 --retry-delay 5 --retry-all-errors -s
    if ($LASTEXITCODE -ne 0) { throw "下载失败: $url" }

    $stage = Join-Path $env:TEMP "rocmfp4-stage-$([guid]::NewGuid().ToString('N').Substring(0,8))"
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    tar -xzf $tar -C $stage
    $inner = Get-ChildItem $stage -Directory | Select-Object -First 1
    if (-not $inner) { throw '解压后未找到源码目录' }
    Move-Item $inner.FullName $Dest
    Remove-Item $stage, $tar -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "基线已就位: $Dest"
}

# 应用 KVMem 补丁（幂等）
Push-Location $Dest
try {
    if (-not (Test-Path '.git')) { & git init -q 2>$null | Out-Null }
    & git apply --reverse --check $patch 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host 'KVMem 补丁已应用过，跳过。'
    } else {
        Write-Host '应用 KVMem 补丁 ...'
        & git apply $patch
        if ($LASTEXITCODE -ne 0) { throw '补丁应用失败（基线版本可能不匹配）' }
        Write-Host '补丁应用成功。'
    }
    if (-not (Test-Path 'src/llama-kvmem-factory.h')) {
        throw '补丁校验失败：src/llama-kvmem-factory.h 不存在'
    }
    Write-Host '校验通过：KVMem 集成钩子存在。'
} finally {
    Pop-Location
}

Write-Host ''
Write-Host '下一步： .\scripts\build-windows.bat'

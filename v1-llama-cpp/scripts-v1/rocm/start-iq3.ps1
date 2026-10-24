#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Model,
    [Parameter(Mandatory)][string]$Mmproj,
    [ValidatePattern('^ROCm[0-9]+$')][string]$Gpu = 'ROCm0',
    [string]$BuildDir,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (!$BuildDir) {
    $BuildDir = if (Test-Path -LiteralPath "$root/bin/llama-kvmem-server.exe") { $root } else { "$root/build-hip-win" }
}
$binary = Join-Path $BuildDir 'bin/llama-kvmem-server.exe'
$Port = 18200
$UiDir = Join-Path $BuildDir 'share/kvmem/ui'
foreach ($path in @($binary, $Model, $Mmproj)) {
    if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing file: $path" }
}
$binary = (Resolve-Path -LiteralPath $binary).Path
$Model = (Resolve-Path -LiteralPath $Model).Path
$Mmproj = (Resolve-Path -LiteralPath $Mmproj).Path
if (!(Test-Path -LiteralPath "$UiDir/index.html")) {
    throw 'Full UI is missing. Extract the complete runtime package, or build it with scripts/build-webui.py --full-ui.'
}
$serverArgs = @(
    '-m', $Model, '--mmproj', $Mmproj, '--no-mmproj-offload',
    '--device', $Gpu, '-ngl', '99', '--load-mode', 'none',
    '--host', '127.0.0.1', '--port', "$Port", '--webui', '--ui-dir', $UiDir,
    '-c', '262144', '-b', '512', '-n', '16384',
    '--kvmem', '--kvmem-budget', '36864', '--kvmem-gen-reserve', '16384',
    '--kvmem-block-tokens', '128', '--kvmem-query-policy', 'user', '--kv-dtype', 'q8_0',
    '--spec-type', 'draft-mtp', '--spec-draft-n-max', '2', '--spec-kv-dtype', 'f16',
    '--kvmem-mtp-state', 'replay', '--image-max-tokens', '512',
    '--enable-thinking', '--reasoning-budget', '4096'
)
if ($DryRun) { @($binary) + $serverArgs | ConvertTo-Json; return }
$oldPath = $env:PATH
try {
    # Packaged DLLs take precedence; a source build can use an installed SDK.
    $sdk = if ($env:ROCM_PATH) { $env:ROCM_PATH } else { $env:HIP_PATH }
    $env:PATH = (Split-Path $binary) + ';' + $(if ($sdk) { "$sdk/bin;" }) + $oldPath
    Write-Host "IQ3 / HIP / $Gpu : http://127.0.0.1:$Port/ (Ctrl+C to stop)"
    & $binary @serverArgs
    $code = $LASTEXITCODE
} finally { $env:PATH = $oldPath }
exit $code

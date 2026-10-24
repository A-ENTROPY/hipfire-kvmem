# ============================================================================
#  KVMem 参数设置面板启动器（发行包版）
#
#  启动中文 Web 调参面板：所有可调参数可视化、持久保存、一键重启生效、模型切换
#
#  要求：需要 Node.js（面板本身是 Node 写的）。没装也没关系——
#        直接用 start-kvmem.bat 快速启动，或用 -DryRun 看命令。
#
#  用法：
#     .\start-panel.ps1                启动面板并打开浏览器
#     .\start-panel.ps1 -NoBrowser     只启动，不开浏览器
# ============================================================================
[CmdletBinding()]
param(
    [switch]$NoBrowser,
    [int]$PanelPort = 18201
)
$ErrorActionPreference = 'Stop'
$root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$control = Join-Path $root 'panel/kvmem-control.mjs'
$uiFile  = Join-Path $root 'panel/control-ui.html'
$exe     = Join-Path $root 'bin/llama-kvmem-server.exe'

if (-not (Test-Path $exe))     { throw '找不到 bin\llama-kvmem-server.exe —— 请确认 ZIP 解压完整' }
if (-not (Test-Path $control)) { throw "缺少面板脚本: $control" }
if (-not (Test-Path $uiFile))  { throw "缺少面板界面: $uiFile" }

Write-Host ''
Write-Host '============================================================' -ForegroundColor DarkCyan
Write-Host '   KVMem 参数设置面板' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor DarkCyan

# --- 检查 Node.js ---
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host ''
    Write-Host '   [!] 没有找到 Node.js，无法启动调参面板。' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '   两个办法：' -ForegroundColor White
    Write-Host '     1) 安装 Node.js（推荐，一次装好长期可用）' -ForegroundColor Green
    Write-Host '        https://nodejs.org/   或   winget install OpenJS.NodeJS.LTS' -ForegroundColor DarkGray
    Write-Host '     2) 不用面板，直接快速启动（功能一样，只是改参数要编辑启动参数）' -ForegroundColor Green
    Write-Host '        双击 start-kvmem.bat' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '   面板能做什么：把所有可调参数做成中文表单、持久保存到 config.json、' -ForegroundColor Gray
    Write-Host '                 一键「保存并重启生效」、自动扫描 models\ 切换模型、看日志。' -ForegroundColor Gray
    Write-Host ''
    exit 1
}
Write-Host "   Node.js: $(& node --version)" -ForegroundColor Gray

# --- 面板端口占用检查 ---
$busy = $false
try { $busy = [bool](Get-NetTCPConnection -LocalPort $PanelPort -State Listen -ErrorAction SilentlyContinue) } catch {}
if ($busy) {
    Write-Host "   面板已在运行（端口 $PanelPort），直接打开。" -ForegroundColor Green
    if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$PanelPort/" }
    exit 0
}

Write-Host "   面板地址: http://127.0.0.1:$PanelPort/" -ForegroundColor Green
Write-Host '   面板会自动按 config.json 启动/重启模型服务（18400 端口由它接管）' -ForegroundColor Gray
Write-Host '   关闭本窗口即停止面板与服务。' -ForegroundColor Gray
Write-Host '============================================================' -ForegroundColor DarkCyan
Write-Host ''

# 后台启动面板，等它就绪后打开浏览器
$proc = Start-Process -FilePath $node.Source -ArgumentList @($control) -WorkingDirectory $root -PassThru -NoNewWindow
if (-not $NoBrowser) {
    for ($i = 1; $i -le 30; $i++) {
        Start-Sleep -Milliseconds 1000
        try {
            $r = Invoke-WebRequest "http://127.0.0.1:$PanelPort/api/status" -TimeoutSec 3 -UseBasicParsing
            if ($r.StatusCode -eq 200) { Start-Process "http://127.0.0.1:$PanelPort/"; break }
        } catch {}
    }
}
Wait-Process -Id $proc.Id

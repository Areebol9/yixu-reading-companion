param([switch]$DryRun, [switch]$Developer, [switch]$Headless, [switch]$Show)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
try {
    $taskBundledNode = Join-Path $taskRoot 'runtime/node/node.exe'
    if (Test-Path -LiteralPath $taskBundledNode -PathType Leaf) { $taskNode = $taskBundledNode }
    else {
        $taskNodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $taskNodeCommand) { throw '请使用完整 Windows 便携包，或先安装 Node.js 24 及更新版本。' }
        $taskNode = $taskNodeCommand.Source
    }
    $taskVersion = & $taskNode --version
    if ($LASTEXITCODE -ne 0 -or $taskVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) { throw '客户端需要 Node.js 24 或更新版本。' }
    $taskElectron = Join-Path $taskRoot 'runtime/electron/Yixu Reading Companion.exe'
    if (-not (Test-Path -LiteralPath $taskElectron -PathType Leaf)) { $taskElectron = Join-Path $taskRoot 'runtime/electron/electron.exe' }
    if (-not (Test-Path -LiteralPath $taskElectron -PathType Leaf)) { $taskElectron = Join-Path $taskRoot 'node_modules/electron/dist/electron.exe' }
    if (-not (Test-Path -LiteralPath $taskElectron -PathType Leaf)) { throw 'Electron 运行时不完整。源码环境请执行 npm ci --ignore-scripts，然后执行 node node_modules/electron/install.js。' }
    if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'dist/workbench.html') -PathType Leaf)) { throw '阅读界面尚未构建，请先运行 npm run build。' }
    if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'desktop/main.cjs') -PathType Leaf)) { throw '桌面程序入口缺失，请完整解压便携包。' }
    if ($DryRun) {
        Write-Output "检查通过：独立 Node.js $taskVersion；Electron 桌面运行时与阅读界面齐备。"
        Write-Output '检查模式未启动窗口、宿主或模型任务。数据目录可用 YIXU_DATA_DIR 指定。'
        exit 0
    }
    $env:YIXU_NODE_EXE = $taskNode
    $taskArguments = @(('"' + $taskRoot + '"'))
    if ($Developer) { $taskArguments += '--developer' }
    if ($Headless) { $taskArguments += '--yixu-headless' }
    if ($Show) { $taskArguments += '--show' }
    # Electron is a GUI process. BrowserWindow.show controls visibility; SW_HIDE can prevent a later explicit open.
    $taskWindowStyle = 'Normal'
    Start-Process -FilePath $taskElectron -ArgumentList $taskArguments -WorkingDirectory $taskRoot -WindowStyle $taskWindowStyle | Out-Null
} catch {
    Write-Host ('启动未完成：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}

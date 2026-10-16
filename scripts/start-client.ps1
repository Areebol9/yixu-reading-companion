param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$taskServerScript = Join-Path $PSScriptRoot 'start-workbench.mjs'
$taskCreatedServer = $null
$taskServerReady = $false

function Assert-ClientPath([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    if (-not $absolute.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw '客户端数据路径超出当前项目目录。'
    }
    $relative = $absolute.Substring($taskRoot.Length + 1)
    $cursor = $taskRoot
    foreach ($part in $relative.Split([IO.Path]::DirectorySeparatorChar)) {
        $cursor = Join-Path $cursor $part
        if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw '客户端数据目录包含链接，请改用当前项目内的普通目录。'
        }
    }
    return $absolute
}

function Get-ClientListener {
    $listeners = @(Get-NetTCPConnection -LocalPort $taskPort -State Listen -ErrorAction SilentlyContinue)
    if (-not $listeners.Count) { return $null }
    $owners = @($listeners.OwningProcess | Select-Object -Unique)
    if ($owners.Count -ne 1 -or @($listeners | Where-Object LocalAddress -ne '127.0.0.1').Count) {
        throw "端口 $taskPort 已被其他服务占用。请为客户端配置独立的 YIXU_PORT，再启动。"
    }
    $owner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $owners[0])
    $command = [string]$owner.CommandLine
    if ($owner.ExecutablePath -ne $taskNode -or $command.Replace([char]'/', [IO.Path]::DirectorySeparatorChar).IndexOf($taskServerScript.Replace([char]'/', [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw "端口 $taskPort 的服务归属无法确认。若此前通过 npm 启动了本客户端，请先在对应终端按 Ctrl+C 退出，再使用此入口；其他服务请保留，并为客户端配置独立的 YIXU_PORT。"
    }
    return $owner
}

function Find-ClientBrowser {
    $candidates = @()
    foreach ($name in @('msedge.exe', 'chrome.exe')) {
        $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) { $candidates += $command.Source }
    }
    foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
        if ($base) {
            $candidates += Join-Path $base 'Microsoft/Edge/Application/msedge.exe'
            $candidates += Join-Path $base 'Google/Chrome/Application/chrome.exe'
        }
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    throw '请先安装 Microsoft Edge 或 Google Chrome，再启动客户端。'
}

try {
    $portText = if ($null -ne $env:YIXU_PORT) { $env:YIXU_PORT } elseif ($null -ne $env:YIXU_WORKBENCH_PORT) { $env:YIXU_WORKBENCH_PORT } else { '4323' }
    $taskPort = 0
    if (-not [int]::TryParse($portText, [ref]$taskPort) -or $taskPort -lt 1024 -or $taskPort -gt 65535) {
        throw 'YIXU_PORT 应为 1024 至 65535 之间的本地端口。'
    }
    $bundledNode = Assert-ClientPath (Join-Path $taskRoot 'runtime/node/node.exe')
    if (Test-Path -LiteralPath $bundledNode -PathType Leaf) {
        $taskNode = $bundledNode
        $nodeSource = '内置运行时'
    } else {
        $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $nodeCommand) { throw '请下载包含运行时的 Windows 便携包，或安装 Node.js 24 及更新版本。使用步骤见 README.md。' }
        $taskNode = $nodeCommand.Source
        $nodeSource = '系统运行时'
    }
    $version = & $taskNode --version
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) {
        throw '客户端需要 Node.js 24 或更新版本。'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'node_modules/vite/bin/vite.js') -PathType Leaf)) {
        throw '请先在客户端目录运行 npm ci --ignore-scripts，再运行 npm run build。详细步骤见 README.md。'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'dist/workbench.html') -PathType Leaf)) {
        throw '请先在客户端目录运行 npm run build，然后再次启动。'
    }
    $taskBrowser = Find-ClientBrowser
    $taskProfile = Assert-ClientPath (Join-Path $taskRoot '.local/client-browser')
    $taskLogDirectory = Assert-ClientPath (Join-Path $taskRoot '.local/client-launcher')
    $taskUrl = "http://127.0.0.1:$taskPort/workbench.html"
    $existing = Get-ClientListener
    if ($DryRun) {
        Write-Output "检查通过：Node.js $version（$nodeSource）；浏览器 $([IO.Path]::GetFileName($taskBrowser))。"
        Write-Output "客户端地址：$taskUrl"
        Write-Output '浏览器资料使用当前项目的 .local/client-browser；检查模式未创建资料或启动窗口、服务。'
        Write-Output $(if ($existing) { '将复用已确认属于当前项目的服务。' } else { '启动时将建立当前项目的后台服务。' })
        exit 0
    }
    New-Item -ItemType Directory -Path $taskProfile -Force | Out-Null
    if (-not $existing) {
        New-Item -ItemType Directory -Path $taskLogDirectory -Force | Out-Null
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $taskCreatedServer = Start-Process -FilePath $taskNode -ArgumentList ('"' + $taskServerScript + '"') -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskLogDirectory "server-$taskPort-$stamp.log") -RedirectStandardError (Join-Path $taskLogDirectory "server-$taskPort-$stamp.error.log")
        $deadline = [DateTime]::UtcNow.AddSeconds(12)
        do {
            Start-Sleep -Milliseconds 250
            if ($taskCreatedServer.HasExited) { throw '本地服务启动未完成，请查看 .local/client-launcher 中本次启动日志。' }
            $listener = Get-ClientListener
            if ($listener -and $listener.ProcessId -eq $taskCreatedServer.Id) {
                try {
                    $page = Invoke-WebRequest -Uri $taskUrl -TimeoutSec 2 -UseBasicParsing
                    if ($page.StatusCode -eq 200) { $taskServerReady = $true }
                } catch { }
            }
        } until ($taskServerReady -or [DateTime]::UtcNow -ge $deadline)
        if (-not $taskServerReady) { throw '本地服务尚未就绪，请查看本次启动日志。' }
    } else {
        $taskServerReady = $true
    }
    $browserArguments = @('--no-first-run', '--no-default-browser-check', ('--user-data-dir="' + $taskProfile + '"'), ('--app="' + $taskUrl + '"'))
    Start-Process -FilePath $taskBrowser -ArgumentList $browserArguments -WorkingDirectory $taskRoot | Out-Null
    Write-Output '宜序伴读已打开。阅读存档保存在客户端独立浏览器资料中；关闭窗口后本地服务继续可用。'
} catch {
    if ($taskCreatedServer -and -not $taskServerReady) {
        $created = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $taskCreatedServer.Id) -ErrorAction SilentlyContinue
        if ($created -and $created.ExecutablePath -eq $taskNode -and ([string]$created.CommandLine).Replace([char]'/', [IO.Path]::DirectorySeparatorChar).Contains($taskServerScript.Replace([char]'/', [IO.Path]::DirectorySeparatorChar))) {
            Stop-Process -Id $taskCreatedServer.Id -ErrorAction SilentlyContinue
        }
    }
    Write-Host ('启动未完成：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}

param([switch]$SkipBuild, [switch]$Force)

$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$taskArtifactRoot = Join-Path $taskRoot 'artifacts'
$taskNodeVersion = '24.15.0'
$taskNodeArchiveName = "node-v$taskNodeVersion-win-x64.zip"
$taskNodeArchiveSHA256 = 'cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62'
$taskNodeBaseURL = "https://nodejs.org/dist/v$taskNodeVersion"

function Assert-PackageOutput([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    if (-not $absolute.StartsWith($taskArtifactRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw '打包路径超出当前项目 artifacts 目录。'
    }
    $cursor = $taskRoot
    foreach ($part in $absolute.Substring($taskRoot.Length + 1).Split([IO.Path]::DirectorySeparatorChar)) {
        $cursor = Join-Path $cursor $part
        if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw '打包目录包含链接，请使用当前项目内的普通目录。'
        }
    }
    return $absolute
}

function Copy-PackageTree([string]$Source, [string]$Destination) {
    $Destination = Assert-PackageOutput $Destination
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $Source -Force) {
        if ($item.Name -in @('.cache', '.vite', '.vite-temp', '.git', '.local', '.gradle', '.cxx', '.idea', '.vscode')) { continue }
        if ($item.Name -match '^(?:\.env(?:\..*)?|local\.properties|AGENTS\.md|PROJECT\.md|WORKFLOW\.md)$' -or $item.Name -match '\.(?:keystore|jks|pfx|pem|log)$') { continue }
        $androidRoot = Join-Path $taskRoot 'android'
        if ($item.PSIsContainer -and $item.Name -eq 'build' -and $item.FullName.StartsWith($androidRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { continue }
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "源码或依赖包含链接，停止打包：$($item.Name)" }
        $target = Assert-PackageOutput (Join-Path $Destination $item.Name)
        if ($item.PSIsContainer) { Copy-PackageTree $item.FullName $target }
        else { Copy-Item -LiteralPath $item.FullName -Destination $target }
    }
}

if (-not [Environment]::Is64BitOperatingSystem) { throw '此脚本生成 Windows x64 便携包，需要64位Windows环境。' }
$taskPackage = Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw | ConvertFrom-Json
$taskVersion = [string]$taskPackage.version
if ($taskVersion -notmatch '^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$') { throw '项目版本号无效。' }
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'node_modules/vite/bin/vite.js'))) { throw '先执行 npm ci --ignore-scripts 安装锁定依赖。' }
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'LICENSE'))) { throw '项目 LICENSE 缺失，停止打包。' }

$taskZip = Assert-PackageOutput (Join-Path $taskArtifactRoot "Yixu-Reading-Companion-v$taskVersion-windows-x64.zip")
if ((Test-Path -LiteralPath $taskZip) -and -not $Force) { throw '同版本ZIP已存在；确认重新打包时使用 -Force。' }
if (-not $SkipBuild) {
    Push-Location $taskRoot
    try { & npm.cmd run build; if ($LASTEXITCODE -ne 0) { throw '客户端构建失败。' } }
    finally { Pop-Location }
}
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'dist/workbench.html'))) { throw 'dist/workbench.html 缺失，请先构建。' }

$taskDownloadRoot = Assert-PackageOutput (Join-Path $taskArtifactRoot 'downloads')
New-Item -ItemType Directory -Path $taskDownloadRoot -Force | Out-Null
$taskSumsFile = Assert-PackageOutput (Join-Path $taskDownloadRoot "node-v$taskNodeVersion-SHASUMS256.txt")
Invoke-WebRequest -Uri "$taskNodeBaseURL/SHASUMS256.txt" -OutFile $taskSumsFile -TimeoutSec 60
$taskHashRows = @(Get-Content -LiteralPath $taskSumsFile | Where-Object { $_ -match ('\s+' + [regex]::Escape($taskNodeArchiveName) + '$') })
if ($taskHashRows.Count -ne 1 -or ($taskHashRows[0] -split '\s+')[0] -ne $taskNodeArchiveSHA256) {
    throw 'Node.js官方校验清单与固定版本校验值不符，停止打包。'
}
$taskNodeArchive = Assert-PackageOutput (Join-Path $taskDownloadRoot $taskNodeArchiveName)
if (-not (Test-Path -LiteralPath $taskNodeArchive)) {
    Invoke-WebRequest -Uri "$taskNodeBaseURL/$taskNodeArchiveName" -OutFile $taskNodeArchive -TimeoutSec 180
}
if ((Get-FileHash -LiteralPath $taskNodeArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskNodeArchiveSHA256) {
    throw 'Node.js压缩包SHA256校验失败，停止打包。'
}

$taskWorkRoot = Assert-PackageOutput (Join-Path $taskArtifactRoot ('package-work/' + [guid]::NewGuid().ToString('N')))
$taskStageParent = Assert-PackageOutput (Join-Path $taskWorkRoot 'stage')
$taskStage = Assert-PackageOutput (Join-Path $taskStageParent 'Yixu-Reading-Companion')
$taskRuntimeExtract = Assert-PackageOutput (Join-Path $taskWorkRoot 'official-node')
New-Item -ItemType Directory -Path $taskStage, $taskRuntimeExtract -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($taskNodeArchive, $taskRuntimeExtract)
$taskOfficialNode = Join-Path $taskRuntimeExtract "node-v$taskNodeVersion-win-x64"
$taskBundledRuntime = Assert-PackageOutput (Join-Path $taskStage 'runtime/node')
New-Item -ItemType Directory -Path $taskBundledRuntime -Force | Out-Null
foreach ($file in @('node.exe', 'LICENSE', 'README.md', 'CHANGELOG.md')) {
    Copy-Item -LiteralPath (Join-Path $taskOfficialNode $file) -Destination (Join-Path $taskBundledRuntime $file)
}
Copy-Item -LiteralPath $taskSumsFile -Destination (Join-Path $taskBundledRuntime 'SHASUMS256.txt')

# Explicit project inputs keep all user data, credentials and local histories out.
foreach ($directory in @('dist', 'src', 'scripts', 'third_party', 'node_modules', 'android', 'tests', 'data', 'design')) {
    $source = Join-Path $taskRoot $directory
    if (Test-Path -LiteralPath $source -PathType Container) { Copy-PackageTree $source (Join-Path $taskStage $directory) }
}
foreach ($file in @('启动宜序伴读.cmd', 'README.md', 'ARCHITECTURE.md', 'LICENSE', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.mjs', 'index.html', 'workbench.html')) {
    Copy-Item -LiteralPath (Join-Path $taskRoot $file) -Destination (Assert-PackageOutput (Join-Path $taskStage $file))
}
$taskNodeCheck = & (Join-Path $taskBundledRuntime 'node.exe') --version
if ($LASTEXITCODE -ne 0 -or $taskNodeCheck -ne "v$taskNodeVersion") { throw '内置Node.js运行检查失败。' }
$taskManifest = [ordered]@{
    product = 'Yixu Reading Companion'; version = $taskVersion; platform = 'windows-x64'
    runtime = [ordered]@{ version = $taskNodeVersion; source = "$taskNodeBaseURL/$taskNodeArchiveName"; archiveSHA256 = $taskNodeArchiveSHA256; license = 'runtime/node/LICENSE' }
    sourceLicense = 'GPL-3.0-only'; launcher = '启动宜序伴读.cmd'; browserProfile = '.local/client-browser'
}
$taskManifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $taskStage 'release-manifest.json') -Encoding utf8

if (Test-Path -LiteralPath $taskZip) { Remove-Item -LiteralPath (Assert-PackageOutput $taskZip) }
[IO.Compression.ZipFile]::CreateFromDirectory($taskStageParent, $taskZip, [IO.Compression.CompressionLevel]::Optimal, $false)
$taskDigest = (Get-FileHash -LiteralPath $taskZip -Algorithm SHA256).Hash.ToLowerInvariant()
"$taskDigest  $([IO.Path]::GetFileName($taskZip))" | Set-Content -LiteralPath (Assert-PackageOutput ($taskZip + '.sha256')) -Encoding ascii
[pscustomobject]@{ File = $taskZip; Bytes = (Get-Item -LiteralPath $taskZip).Length; SHA256 = $taskDigest; Node = $taskNodeCheck; Stage = $taskStage }

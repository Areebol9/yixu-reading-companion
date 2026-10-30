param([switch]$SkipBuild, [switch]$Force)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$taskArtifactRoot = Join-Path $taskRoot 'artifacts'
$taskNodeVersion = '24.20.0'
$taskNodeArchiveName = "node-v$taskNodeVersion-win-x64.zip"
$taskNodeArchiveSHA256 = '6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba'
$taskNodeBaseURL = "https://nodejs.org/dist/v$taskNodeVersion"
function Assert-PackageOutput([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    if (-not $absolute.StartsWith($taskArtifactRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '打包路径超出当前项目 artifacts 目录。' }
    $cursor = $taskRoot
    foreach ($part in $absolute.Substring($taskRoot.Length + 1).Split([IO.Path]::DirectorySeparatorChar)) {
        $cursor = Join-Path $cursor $part
        if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '打包目录包含链接，请使用普通目录。' }
    }
    return $absolute
}
function Copy-PackageContents([string]$Source, [string]$Destination, [bool]$SkipModules) {
    [IO.Directory]::CreateDirectory($Destination) | Out-Null
    if (([IO.DirectoryInfo]::new($Destination)).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '目标目录包含链接。' }
    foreach ($item in ([IO.DirectoryInfo]::new($Source)).EnumerateFileSystemInfos()) {
        if ($item.Name -in @('.cache','.vite','.vite-temp','.git','.local','.yixu-client','.gradle','.cxx','.idea','.vscode') -or ($SkipModules -and $item.Name -eq 'node_modules')) { continue }
        if ($item.Name -match '^(?:\.env(?:\..*)?|local\.properties|AGENTS\.md|PROJECT\.md|WORKFLOW\.md)$' -or $item.Name -match '\.(?:keystore|jks|pfx|pem|log)$') { continue }
        if ([IO.Path]::GetFullPath($Source) -eq [IO.Path]::GetFullPath((Join-Path $taskRoot 'desktop/assets')) -and $item.Name -eq 'README.md') { continue }
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "运行资源包含链接，停止打包：$($item.Name)" }
        $target = [IO.Path]::Combine($Destination, $item.Name)
        if ($item.Attributes -band [IO.FileAttributes]::Directory) { Copy-PackageContents $item.FullName $target $SkipModules }
        else { [IO.File]::Copy($item.FullName, $target, $true) }
    }
}
function Copy-PackageTree([string]$Source, [string]$Destination, [switch]$SkipModules) {
    $Destination = Assert-PackageOutput $Destination
    Copy-PackageContents $Source $Destination $SkipModules.IsPresent
}
function Copy-RuntimeFile([string]$Relative) {
    if ($Relative -match '(^|[\\/])(?:\.local|\.git|\.env|android|tests|research)([\\/]|$)' -or [IO.Path]::IsPathRooted($Relative)) { throw '运行文件清单含非交付路径。' }
    $source = [IO.Path]::GetFullPath((Join-Path $taskRoot $Relative))
    if (-not $source.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "运行文件清单缺失或越界：$Relative" }
    $destination = Assert-PackageOutput (Join-Path $taskStage $Relative)
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
}
if (-not [Environment]::Is64BitOperatingSystem) { throw '此脚本生成 Windows x64 便携包。' }
$taskPackage = Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw | ConvertFrom-Json
$taskLock = Get-Content -LiteralPath (Join-Path $taskRoot 'package-lock.json') -Raw | ConvertFrom-Json -AsHashtable
$taskVersion = [string]$taskPackage.version
$taskElectronVersion = [string]$taskPackage.devDependencies.electron
if ($taskVersion -notmatch '^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$' -or $taskElectronVersion -notmatch '^\d+\.\d+\.\d+$') { throw '项目与 Electron 必须使用固定版本号。' }
$taskElectronRoot = Join-Path $taskRoot 'node_modules/electron/dist'
if (-not (Test-Path -LiteralPath (Join-Path $taskElectronRoot 'electron.exe'))) { throw '请先安装锁定依赖，并执行 node node_modules/electron/install.js。' }
$taskInstalledElectron = (Get-Content -LiteralPath (Join-Path $taskElectronRoot 'version') -Raw).Trim()
if ($taskInstalledElectron -ne $taskElectronVersion) { throw '已安装 Electron 与 package.json 固定版本不符。' }
$taskCoreFile = Join-Path $taskRoot 'client-core-manifest.json'
if (-not (Test-Path -LiteralPath $taskCoreFile)) { throw '缺少明确的客户端运行源码清单。' }
$taskCore = Get-Content -LiteralPath $taskCoreFile -Raw | ConvertFrom-Json
$taskZip = Assert-PackageOutput (Join-Path $taskArtifactRoot "Yixu-Reading-Companion-v$taskVersion-windows-x64.zip")
if ((Test-Path -LiteralPath $taskZip) -and -not $Force) { throw '当前发布 ZIP 已存在；重新生成时请使用 -Force，新包生成成功后才替换。' }
if (-not $SkipBuild) {
    Push-Location $taskRoot
    try { & npm.cmd run build; if ($LASTEXITCODE -ne 0) { throw '客户端构建失败。' } }
    finally { Pop-Location }
}
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'dist/workbench.html'))) { throw '阅读界面构建缺失。' }
$taskDownloadRoot = Assert-PackageOutput (Join-Path $taskArtifactRoot 'downloads')
New-Item -ItemType Directory -Path $taskDownloadRoot -Force | Out-Null
$taskSumsFile = Assert-PackageOutput (Join-Path $taskDownloadRoot "node-v$taskNodeVersion-SHASUMS256.txt")
if (-not (Test-Path -LiteralPath $taskSumsFile)) { Invoke-WebRequest -Uri "$taskNodeBaseURL/SHASUMS256.txt" -OutFile $taskSumsFile -TimeoutSec 60 }
$taskHashRows = @(Get-Content -LiteralPath $taskSumsFile | Where-Object { $_ -match ('\s+' + [regex]::Escape($taskNodeArchiveName) + '$') })
if ($taskHashRows.Count -ne 1 -or ($taskHashRows[0] -split '\s+')[0] -ne $taskNodeArchiveSHA256) { throw 'Node.js官方清单与固定校验值不符。' }
$taskNodeArchive = Assert-PackageOutput (Join-Path $taskDownloadRoot $taskNodeArchiveName)
if (-not (Test-Path -LiteralPath $taskNodeArchive)) { Invoke-WebRequest -Uri "$taskNodeBaseURL/$taskNodeArchiveName" -OutFile $taskNodeArchive -TimeoutSec 180 }
if ((Get-FileHash -LiteralPath $taskNodeArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskNodeArchiveSHA256) { throw 'Node.js压缩包校验失败。' }
$taskWorkRoot = Assert-PackageOutput (Join-Path $taskArtifactRoot ('package-work/' + [guid]::NewGuid().ToString('N')))
try {
$taskStageParent = Assert-PackageOutput (Join-Path $taskWorkRoot 'stage')
$taskStage = Assert-PackageOutput (Join-Path $taskStageParent 'Yixu-Reading-Companion')
$taskExtract = Assert-PackageOutput (Join-Path $taskWorkRoot 'official-node')
New-Item -ItemType Directory -Path $taskStage,$taskExtract -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($taskNodeArchive, $taskExtract)
$taskOfficialNode = Join-Path $taskExtract "node-v$taskNodeVersion-win-x64"
$taskBundledNode = Assert-PackageOutput (Join-Path $taskStage 'runtime/node')
New-Item -ItemType Directory -Path $taskBundledNode -Force | Out-Null
foreach ($file in @('node.exe','LICENSE','README.md','CHANGELOG.md')) { Copy-Item -LiteralPath (Join-Path $taskOfficialNode $file) -Destination (Join-Path $taskBundledNode $file) }
Copy-Item -LiteralPath $taskSumsFile -Destination (Join-Path $taskBundledNode 'SHASUMS256.txt')
Copy-PackageTree $taskElectronRoot (Join-Path $taskStage 'runtime/electron')
$taskBrandedExe = Assert-PackageOutput (Join-Path $taskStage 'runtime/electron/Yixu Reading Companion.exe')
Move-Item -LiteralPath (Join-Path $taskStage 'runtime/electron/electron.exe') -Destination $taskBrandedExe
& (Join-Path $taskRoot 'scripts/set-executable-icon.ps1') -Executable $taskBrandedExe -Icon (Join-Path $taskRoot 'desktop/assets/app-icon.ico')
Copy-PackageTree (Join-Path $taskRoot 'dist') (Join-Path $taskStage 'dist')
foreach ($item in Get-ChildItem -LiteralPath (Join-Path $taskRoot 'desktop') -Force) {
    if ($item.Name -eq 'launchers') { continue }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '桌面运行资源包含链接。' }
    if ($item.PSIsContainer) { Copy-PackageTree $item.FullName (Join-Path $taskStage ('desktop/' + $item.Name)) }
    else { Copy-RuntimeFile ('desktop/' + $item.Name) }
}
foreach ($launcher in @('Start Yixu Reading Companion.cmd','Agent.cmd','启动宜序伴读.cmd','代理操作.cmd')) {
    Copy-Item -LiteralPath (Join-Path $taskRoot ('desktop/launchers/' + $launcher)) -Destination (Assert-PackageOutput (Join-Path $taskStage $launcher))
}
$taskFiles = @($taskCore.files | ForEach-Object { if ($_ -is [string]) { $_ } elseif ($_.path) { [string]$_.path } else { throw '运行文件清单格式无效。' } })
foreach ($entry in $taskCore.files) {
    if ($entry.sha256) {
        $actual = (Get-FileHash -LiteralPath (Join-Path $taskRoot $entry.path) -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $entry.sha256) { throw "运行源码与接入清单不符：$($entry.path)" }
    }
}
foreach ($file in $taskFiles) { Copy-RuntimeFile $file }
foreach ($required in @('dsh/profile/package.json','dsh/profile/cordis.patch.yml','dsh/bundle/package.json','dsh/bundle/cordis.patch.yml','dsh/plugin/package.json','dsh/plugin/index.mjs','src/host/domain.ts','scripts/companion-host/registry.mjs','scripts/local-bridge.mjs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $taskStage $required) -PathType Leaf)) { throw "包中缺少实际宿主运行文件：$required" }
}
foreach ($file in @('scripts/start-client.ps1','scripts/package-client.ps1','scripts/set-executable-icon.ps1','scripts/sync-client-core.mjs','README.md','README.zh-CN.md','THIRD_PARTY_NOTICES.md','LICENSE','package.json','package-lock.json','client-core-manifest.json','tsconfig.json','vite.config.mjs','workbench.html')) { Copy-RuntimeFile $file }
# Copy only packages belonging to the production lock graph, including nested dependencies.
$taskDependencyCount = 0
foreach ($property in $taskLock.packages.GetEnumerator() | Sort-Object Key) {
    if (-not $property.Key.StartsWith('node_modules/') -or $property.Value.dev -eq $true) { continue }
    $source = Join-Path $taskRoot $property.Key
    if (-not (Test-Path -LiteralPath $source -PathType Container)) {
        if ($property.Value.optional -eq $true) { continue }
        throw "缺少生产依赖：$($property.Key)"
    }
    Copy-PackageTree $source (Join-Path $taskStage $property.Key) -SkipModules
    $taskDependencyCount++
}
$taskNodeCheck = & (Join-Path $taskBundledNode 'node.exe') --version
if ($LASTEXITCODE -ne 0 -or $taskNodeCheck -ne "v$taskNodeVersion") { throw '包内独立 Node.js 运行失败。' }
$taskManifest = [ordered]@{
    product = 'Yixu Reading Companion'; version = $taskVersion; platform = 'windows-x64'; launcher = 'Start Yixu Reading Companion.cmd'; launcherAliases = @('启动宜序伴读.cmd'); agent = 'Agent.cmd'
    executable = 'runtime/electron/Yixu Reading Companion.exe'; icon = 'desktop/assets/app-icon.ico'
    runtime = [ordered]@{node = $taskNodeVersion; electron = $taskElectronVersion; nodeArchiveSHA256 = $taskNodeArchiveSHA256; productionPackages = $taskDependencyCount}
    data = [ordered]@{default = '%LOCALAPPDATA%/YixuReading/Desktop'; override = 'YIXU_DATA_DIR'; legacyDataIncluded = $false}
    sourceLicense = 'GPL-3.0-only'; coreManifest = 'client-core-manifest.json'
}
$taskManifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $taskStage 'release-manifest.json') -Encoding utf8
$taskNewZip = Assert-PackageOutput (Join-Path $taskWorkRoot 'package.zip')
$taskNewSHA = Assert-PackageOutput (Join-Path $taskWorkRoot 'package.zip.sha256')
$taskPublishedSHA = Assert-PackageOutput ($taskZip + '.sha256')
[IO.Compression.ZipFile]::CreateFromDirectory($taskStageParent, $taskNewZip, [IO.Compression.CompressionLevel]::Optimal, $false)
$taskDigest = (Get-FileHash -LiteralPath $taskNewZip -Algorithm SHA256).Hash.ToLowerInvariant()
"$taskDigest  $([IO.Path]::GetFileName($taskZip))" | Set-Content -LiteralPath $taskNewSHA -Encoding ascii
[IO.File]::Move($taskNewZip, $taskZip, $true)
[IO.File]::Move($taskNewSHA, $taskPublishedSHA, $true)
[pscustomobject]@{File = $taskZip; Bytes = (Get-Item -LiteralPath $taskZip).Length; SHA256 = $taskDigest; Node = $taskNodeCheck; Electron = $taskElectronVersion}
} finally {
    $taskCleanup = Assert-PackageOutput $taskWorkRoot
    if (Test-Path -LiteralPath $taskCleanup) { Remove-Item -LiteralPath $taskCleanup -Recurse -Force }
}

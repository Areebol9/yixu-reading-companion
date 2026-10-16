param([string]$SdkPath = "$env:LOCALAPPDATA\Android\Sdk", [string]$GradlePath)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'dist\index.html'))) { throw '先运行 npm run build' }
if (-not $GradlePath) {
    $taskGradle = Get-ChildItem -LiteralPath "$env:USERPROFILE\.gradle\wrapper\dists\gradle-8.7-bin" -Recurse -Filter gradle.bat | Select-Object -First 1
    if (-not $taskGradle) { throw '需要 Gradle 8.7，请传入 -GradlePath' }
    $GradlePath = $taskGradle.FullName
}
$taskAndroid = Join-Path $taskRoot 'android'
$taskAssetHash = (Get-FileHash -LiteralPath (Join-Path $taskRoot 'dist\index.html') -Algorithm SHA256).Hash.Substring(0,16).ToLowerInvariant()
$taskAssetRoot = Join-Path $taskRoot ('.local\android-assets\' + $taskAssetHash)
$taskAssets = Join-Path $taskAssetRoot 'web'
New-Item -ItemType Directory -Path $taskAssets -Force | Out-Null
Copy-Item -Path (Join-Path $taskRoot 'dist\*') -Destination $taskAssets -Recurse -Force
& python (Join-Path $PSScriptRoot 'prepare-voice.py')
if ($LASTEXITCODE -ne 0) { throw '中文语音依赖准备失败' }
& python (Join-Path $PSScriptRoot 'prepare-native.py')
if ($LASTEXITCODE -ne 0) { throw '原生运行依赖准备失败' }
& node (Join-Path $PSScriptRoot 'build-native-core.mjs')
if ($LASTEXITCODE -ne 0) { throw '原生核心构建失败' }
$taskSdkValue = $SdkPath.Replace('\','/')
[System.IO.File]::WriteAllText((Join-Path $taskAndroid 'local.properties'), "sdk.dir=$taskSdkValue`n", [System.Text.UTF8Encoding]::new($false))
Push-Location $taskAndroid
try { & $GradlePath assembleDebug --console=plain "-PyixuAssets=$taskAssetRoot"; if ($LASTEXITCODE -ne 0) { throw 'Android 构建失败' } } finally { Pop-Location }
$taskOut = Join-Path $taskRoot 'artifacts'
New-Item -ItemType Directory -Path $taskOut -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $taskAndroid 'app\build\outputs\apk\debug\app-debug.apk') -Destination (Join-Path $taskOut '宜序伴读-原型.apk') -Force
Write-Output (Join-Path $taskOut '宜序伴读-原型.apk')

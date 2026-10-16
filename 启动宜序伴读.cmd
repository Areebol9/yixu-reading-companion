@echo off
chcp 65001 >nul
setlocal
set "YIXU_PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"
if exist "%YIXU_PWSH%" goto launch
where pwsh.exe >nul 2>nul
if errorlevel 1 (
  set "YIXU_PWSH=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
  goto launch
)
set "YIXU_PWSH=pwsh.exe"
:launch
"%YIXU_PWSH%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-client.ps1" %*
set "YIXU_EXIT=%ERRORLEVEL%"
if not "%YIXU_EXIT%"=="0" pause
exit /b %YIXU_EXIT%

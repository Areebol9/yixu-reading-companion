@echo off
setlocal
set "YIXU_NODE=%~dp0runtime\node\node.exe"
if exist "%YIXU_NODE%" goto run
where node.exe >nul 2>nul
if errorlevel 1 (
  echo {"ok":false,"error":"Node.js runtime unavailable; use the complete portable package."}
  exit /b 1
)
set "YIXU_NODE=node.exe"
:run
"%YIXU_NODE%" "%~dp0desktop\agent.cjs" %*
exit /b %ERRORLEVEL%

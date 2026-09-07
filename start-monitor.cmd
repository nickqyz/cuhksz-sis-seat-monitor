@echo off
setlocal
cd /d "%~dp0"
if not exist .data\secrets.json (
  echo Missing encrypted secrets. Run save-secrets.ps1 first.
  pause
  exit /b 1
)
call npm run monitor
pause

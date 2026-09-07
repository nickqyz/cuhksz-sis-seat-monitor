@echo off
setlocal
cd /d "%~dp0"
call npm install
if errorlevel 1 pause & exit /b 1
echo Dependencies installed.
echo Next, save your PushPlus token with save-secrets.ps1 as described in README.md.
pause

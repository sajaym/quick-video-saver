@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
if errorlevel 1 (
  echo Unregistering failed. Read the error above.
  pause
  exit /b 1
)
pause

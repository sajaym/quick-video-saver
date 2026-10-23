@echo off
setlocal
title Quick Video Saver - helper setup
echo Quick Video Saver - local helper setup
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
if errorlevel 1 (
  echo.
  echo Setup did not finish. Read the message above, fix it, and run this file again.
  pause
  exit /b 1
)
echo.
echo Next: restart your browser, then load the "extension" folder (see START-HERE.html).
pause

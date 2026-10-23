@echo off
setlocal
echo Close active video downloads before updating.
echo (The extension can also do this from Settings - Update downloader.)
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -UpdateDownloader
if errorlevel 1 (
  echo Update failed. Existing installed files are retained where possible.
  pause
  exit /b 1
)
pause

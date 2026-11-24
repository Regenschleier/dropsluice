@echo off
rem DropSluice - portable launcher / 绿色版启动器
rem Double-click this file to start. Keep the window open while your phone is downloading.
cd /d "%~dp0"
set DROPSLUICE_NO_PAUSE=1
echo Starting DropSluice ...
"%~dp0DropSluice.exe" %*
echo.
echo DropSluice stopped. Press any key to close this window.
pause >nul

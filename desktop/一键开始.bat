@echo off
rem Byteferry - portable launcher / 绿色版启动器
rem Double-click this file to start. Keep the window open while your phone is downloading.
cd /d "%~dp0"
set BYTEFERRY_NO_PAUSE=1
echo Starting Byteferry ...
"%~dp0Byteferry.exe" %*
echo.
echo Byteferry stopped. Press any key to close this window.
pause >nul

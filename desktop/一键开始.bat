@echo off
rem Phone Drop - portable launcher / 绿色版启动器
rem Double-click this file to start. Keep the window open while your phone is downloading.
cd /d "%~dp0"
set PHONE_DROP_NO_PAUSE=1
echo Starting Phone Drop ...
"%~dp0PhoneDrop.exe" %*
echo.
echo Phone Drop stopped. Press any key to close this window.
pause >nul

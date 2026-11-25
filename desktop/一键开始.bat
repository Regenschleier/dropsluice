@echo off
rem DropSluice - portable launcher / 绿色版启动器
rem exe 是 GUI 子系统（双击不弹命令行窗口），这里也不去等它：
rem 起完就退出，服务在后台跑，要停就到面板上点「停止服务」。
cd /d "%~dp0"
echo 正在启动 DropSluice ...
start "" "%~dp0DropSluice.exe" %*
echo.
echo 已启动。浏览器里会自动打开面板；手机扫码用面板上那张二维码。
echo 日志（出问题时看这里）：%%LOCALAPPDATA%%\DropSluice\server.log
echo 要停服务：面板上点「停止服务」，或任务管理器里结束 DropSluice.exe。
timeout /t 4 >nul

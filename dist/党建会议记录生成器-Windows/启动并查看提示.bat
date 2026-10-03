@echo off
chcp 65001 >nul
cd /d "%~dp0"
"党建会议记录生成器.exe"
echo.
echo 程序已结束，请查看上方提示。
pause

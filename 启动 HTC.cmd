@echo off
chcp 65001 >nul
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
if exist "release\HTC-2.0.0-win32-x64\HTC.exe" (
  start "" "%~dp0release\HTC-2.0.0-win32-x64\HTC.exe"
  exit /b
)
echo 未找到 HTC 2.0.0，请保留 release\HTC-2.0.0-win32-x64 完整程序目录。
pause
exit /b 1

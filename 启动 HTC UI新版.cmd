@echo off
chcp 65001 >nul
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
if not exist "artifacts\ui-release-20261011\HTC-UI-20261011\HTC.exe" (
  echo 未找到本次 UI 新版程序，请保留 artifacts\ui-release-20261011 下的完整程序目录。
  pause
  exit /b 1
)
start "" "%~dp0artifacts\ui-release-20261011\HTC-UI-20261011\HTC.exe"

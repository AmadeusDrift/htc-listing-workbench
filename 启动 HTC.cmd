@echo off
chcp 65001 >nul
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
if exist "release\HTC-1.0.0-win32-x64\HTC.exe" (
  start "" "%~dp0release\HTC-1.0.0-win32-x64\HTC.exe"
  exit /b
)
if not exist "node_modules\electron\package.json" (
  echo 请先在本目录执行 npm install 和 npm run build。
  pause
  exit /b 1
)
call npm run start
if errorlevel 1 pause

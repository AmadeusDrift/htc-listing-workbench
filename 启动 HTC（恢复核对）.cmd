@echo off
chcp 65001 >nul
setlocal
set "ELECTRON_RUN_AS_NODE="
set "RED_DATA_DIR=%~dp0artifacts\ftp-configuration-2026-10-09\reconstruction\workspace-restored"
cd /d "%~dp0"
if not exist "%RED_DATA_DIR%\red.sqlite" (
  echo 恢复副本不存在，请保留原工作区并联系维护人员。
  pause
  exit /b 1
)
start "" "%~dp0release\HTC-1.0.0-win32-x64\HTC.exe"
endlocal

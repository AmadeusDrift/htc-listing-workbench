@echo off
set "RED_DATA_DIR=%~dp0release\HTC-0.6.0-rc.1-win32-x64\test-workspace"
set "RED_E2E="
set "RED_COLLECTION_TEST_HOST="
set "RED_DEV_SERVER_URL="
set "ELECTRON_RUN_AS_NODE="
start "" "%~dp0release\HTC-1.0.0-win32-x64\HTC.exe"

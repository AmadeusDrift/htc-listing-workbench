@echo off
set "RED_DATA_DIR=%~dp0.test-data\1688-live-workspace"
set "RED_E2E="
set "RED_COLLECTION_TEST_HOST="
set "RED_DEV_SERVER_URL="
set "ELECTRON_RUN_AS_NODE="
start "" "%~dp0release\HTC-0.7.0-rc.5-win32-x64\HTC.exe"

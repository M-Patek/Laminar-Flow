@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"
node "%SCRIPT_DIR%bin\duplex-msg.js" %*
exit /b %ERRORLEVEL%

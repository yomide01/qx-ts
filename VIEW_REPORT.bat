@echo off
title QX Trading Journal Analytics Report
cd /d "%~dp0"

:: Ensure Node.js is on PATH
where node >nul 2>nul
if %errorlevel% neq 0 (
    set "PATH=C:\Program Files\nodejs;%PATH%"
)

npm run journal:report
pause

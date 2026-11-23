@echo off
title QX TS: Quotex Analytics, Manual ^& Auto Trading Assistant
cd /d "%~dp0"

:: Ensure Node.js is on PATH
where node >nul 2>nul
if %errorlevel% neq 0 (
    set "PATH=C:\Program Files\nodejs;%PATH%"
)

echo =================================================================
echo     QX TS: QUOTEX ANALYTICS, MANUAL ^& AUTO TRADING ASSISTANT
echo =================================================================
echo  Dedicated Chrome (./qx_user_profile) will launch automatically
echo  and close cleanly when this terminal closes (CLOSE_CHROME_ON_EXIT).
echo =================================================================
echo.

npm start
pause

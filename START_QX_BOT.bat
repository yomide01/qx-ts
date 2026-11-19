@echo off
title QX TS: Quotex Semi-Automated Trading Assistant
cd /d "%~dp0"

:: Ensure Node.js is on PATH
where node >nul 2>nul
if %errorlevel% neq 0 (
    set "PATH=C:\Program Files\nodejs;%PATH%"
)

echo =================================================================
echo        QX TS: QUOTEX SEMI-AUTOMATED TRADING ASSISTANT
echo =================================================================
echo  [1/2] Checking environment and launching dedicated Chrome...
echo  [2/2] Initializing stream sniffer, candle engine, and journal...
echo =================================================================
echo.

npm start
pause

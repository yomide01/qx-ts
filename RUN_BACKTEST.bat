@echo off
title QX TS: Offline Walk-Forward Backtester
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel% neq 0 set "PATH=C:\Program Files\nodejs;%PATH%"
npm run backtest -- %*
pause

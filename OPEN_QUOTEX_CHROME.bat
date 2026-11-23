@echo off
title Quotex Visible Chrome Launcher (QX TS)
cd /d "%~dp0"

echo =================================================================
echo        OPENING VISIBLE GOOGLE CHROME FOR QUOTEX (PORT 9222)
echo =================================================================
echo.

:: Remove any stale profile lock files
if exist "qx_user_profile\lockfile" del /f /q "qx_user_profile\lockfile" >nul 2>nul
if exist "qx_user_profile\SingletonLock" del /f /q "qx_user_profile\SingletonLock" >nul 2>nul
if exist "qx_user_profile\SingletonSocket" del /f /q "qx_user_profile\SingletonSocket" >nul 2>nul
if exist "qx_user_profile\SingletonCookie" del /f /q "qx_user_profile\SingletonCookie" >nul 2>nul

start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%~dp0qx_user_profile" ^
  --start-maximized ^
  --no-first-run ^
  --no-default-browser-check ^
  --autoplay-policy=no-user-gesture-required ^
  "https://quotex.com/en/demo-trade"

echo  [OK] Google Chrome has been launched visibly on your screen.
echo  1. Complete any Cloudflare security check if shown.
echo  2. Log into your Quotex DEMO account so the candlestick chart is visible.
echo  3. Keep the Chrome window open!
echo =================================================================
timeout /t 5

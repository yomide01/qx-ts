@echo off
title QX TS: Quotex Pro Manual ^& Automatic Multi-Market Trading Bot
cd /d "%~dp0"

:: Ensure Node.js is on PATH
where node >nul 2>nul
if %errorlevel% neq 0 (
    set "PATH=C:\Program Files\nodejs;%PATH%"
)

echo =================================================================
echo     QX TS: QUOTEX PRO MANUAL ^& AUTO MULTI-MARKET TRADING BOT
echo =================================================================
echo  [1/2] Launching / connecting to visible Google Chrome (port 9222)...
echo  [2/2] Starting interactive Manual / Automatic Trading Engine...
echo =================================================================
echo.

:: Check if port 9222 is already listening; if not, launch visible Chrome directly on desktop
netstat -ano | findstr ":9222 " | findstr "LISTENING" >nul 2>nul
if %errorlevel% neq 0 (
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

    timeout /t 3 /nobreak >nul
)

npm start
pause

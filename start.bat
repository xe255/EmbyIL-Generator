@echo off
title embyIL - Telegram Bot + Dashboard
color 0A
echo ================================================
echo    embyIL Unified App Starter
echo ================================================
echo.
echo [1/2] Checking and installing dependencies...
npm install
if errorlevel 1 (
    echo.
    echo ERROR: npm install failed!
    pause
    exit /b 1
)
echo.
echo ================================================
echo [2/2] Starting embyIL Bot + Dashboard...
echo ================================================
echo.
echo Bot Status: Starting...
echo Dashboard: http://localhost:3000
echo.
echo Press Ctrl+C to stop the application
echo ================================================
echo.
node app.js

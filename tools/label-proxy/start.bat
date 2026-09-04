@echo off
rem One-click start for label-proxy in the background.
rem The command window closes after startup; logs go to run\label-proxy.log.
setlocal

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo label-proxy needs Node.js 18 or newer.
  pause
  exit /b 1
)

node "%~dp0background.mjs" start
if errorlevel 1 (
  echo.
  echo Background start failed. See run\label-proxy.log for details.
  pause
  exit /b 1
)

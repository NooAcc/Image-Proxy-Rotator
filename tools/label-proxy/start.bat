@echo off
rem One-click start for label-proxy (same as: npm run label-proxy).
title Label Proxy - 127.0.0.1:19191
node "%~dp0cli.mjs" --service
if errorlevel 1 (
  echo.
  echo Failed to start. Make sure Node.js 18+ is installed and port 19191 is free.
  pause
)

@echo off
REM Double-click this to test on your phone. Leave it running.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo   Get the LTS installer from https://nodejs.org
  echo   Install it, then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo.
  echo   First run: installing. This takes a few minutes.
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   Install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

if not exist "public\models\face_landmarker.task" (
  echo   Fetching the tracking models...
  call npm run assets
)

call npm run phone
pause

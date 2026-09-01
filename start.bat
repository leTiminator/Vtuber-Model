@echo off
REM One-click launcher for Windows. Double-click this file.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo.
  echo   Get the LTS installer from https://nodejs.org
  echo   Install it, then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo.
  echo   First run: installing. This downloads about 30 MB of tracking
  echo   model and takes a few minutes. It only happens once.
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
  echo   Fetching the face tracking model...
  call npm run assets
)

echo.
echo   Starting. Your browser should open automatically.
echo   If it does not, go to:  http://127.0.0.1:5173
echo.
echo   LEAVE THIS WINDOW OPEN while you stream.
echo   Closing it stops the model.
echo.
start "" http://127.0.0.1:5173
call npm run dev
pause

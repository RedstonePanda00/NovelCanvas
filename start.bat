@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "FRONTEND_URL=http://127.0.0.1:5173"
set "BACKEND_URL=http://127.0.0.1:8000"
set "PYTHON_EXE=%ROOT%\.venv\Scripts\python.exe"

cd /d "%ROOT%" || (
  echo Failed to enter project directory: %ROOT%
  pause
  exit /b 1
)

echo.
echo === Novel Canvas Startup ===
echo Project: %ROOT%
echo.

where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm was not found. Install Node.js, then run this file again.
  pause
  exit /b 1
)

set "PY_CMD="
where py >nul 2>nul
if not errorlevel 1 set "PY_CMD=py -3"
if not defined PY_CMD (
  where python >nul 2>nul
  if not errorlevel 1 set "PY_CMD=python"
)
if not defined PY_CMD (
  echo ERROR: Python was not found. Install Python 3, then run this file again.
  pause
  exit /b 1
)

if not exist "%PYTHON_EXE%" (
  echo Creating Python virtual environment...
  %PY_CMD% -m venv "%ROOT%\.venv"
  if errorlevel 1 (
    echo ERROR: Failed to create Python virtual environment.
    pause
    exit /b 1
  )
)

echo Checking backend dependencies...
"%PYTHON_EXE%" -c "import fastapi, uvicorn" >nul 2>nul
if errorlevel 1 (
  echo Installing backend dependencies...
  "%PYTHON_EXE%" -m pip install -r "%ROOT%\backend\requirements.txt"
  if errorlevel 1 (
    echo ERROR: Failed to install backend dependencies.
    pause
    exit /b 1
  )
) else (
  echo Backend dependencies OK.
)

echo Checking frontend dependencies...
if not exist "%ROOT%\frontend\node_modules\.bin\vite.cmd" (
  echo Installing frontend dependencies...
  if exist "%ROOT%\frontend\package-lock.json" (
    pushd "%ROOT%\frontend"
    call npm ci
    popd
  ) else (
    pushd "%ROOT%\frontend"
    call npm install
    popd
  )
  if errorlevel 1 (
    echo ERROR: Failed to install frontend dependencies.
    pause
    exit /b 1
  )
) else (
  echo Frontend dependencies OK.
)

echo.
echo Starting backend and frontend...

powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>nul
if errorlevel 1 (
  start "Novel Canvas Backend" /D "%ROOT%" cmd /k ""%PYTHON_EXE%" -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --reload"
) else (
  echo Backend already appears to be running on %BACKEND_URL%.
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>nul
if errorlevel 1 (
  start "Novel Canvas Frontend" /D "%ROOT%\frontend" cmd /k "npm run dev -- --port 5173"
) else (
  echo Frontend already appears to be running on %FRONTEND_URL%.
)

echo Waiting for frontend...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$deadline=(Get-Date).AddSeconds(45); while((Get-Date) -lt $deadline){ try { $r=Invoke-WebRequest -UseBasicParsing -Uri '%FRONTEND_URL%' -TimeoutSec 2; if($r.StatusCode -ge 200 -and $r.StatusCode -lt 500){ exit 0 } } catch {}; Start-Sleep -Milliseconds 500 }; exit 1" >nul 2>nul

echo Opening %FRONTEND_URL% ...
start "" "%FRONTEND_URL%"

echo.
echo Novel Canvas is starting.
echo Backend:  %BACKEND_URL%
echo Frontend: %FRONTEND_URL%
echo You can close this window.
echo.
pause

@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "FRONTEND_URL=http://127.0.0.1:5173"
set "BACKEND_PORT=53173"
set "BACKEND_URL=http://127.0.0.1:%BACKEND_PORT%"
set "VITE_API_BASE=%BACKEND_URL%"
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
if not exist "%PYTHON_EXE%" if not defined PY_CMD (
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
"%PYTHON_EXE%" -c "from backend.app.main import app" >nul 2>nul
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

call :check_listener %BACKEND_PORT% "%BACKEND_URL%" Backend
if errorlevel 2 (
  echo ERROR: Cannot safely use backend port %BACKEND_PORT%. Check the listener or port conflict.
  pause
  exit /b 1
)
if not errorlevel 1 (
  start "Novel Canvas Backend" /D "%ROOT%" cmd /k ""%PYTHON_EXE%" -m uvicorn backend.app.main:app --host 127.0.0.1 --port %BACKEND_PORT% --reload"
) else (
  echo Backend already appears to be running on %BACKEND_URL%.
)

call :check_listener 5173 "%FRONTEND_URL%" Frontend
if errorlevel 2 (
  echo ERROR: Cannot safely use frontend port 5173. Check the listener or port conflict.
  pause
  exit /b 1
)
if not errorlevel 1 (
  start "Novel Canvas Frontend" /D "%ROOT%\frontend" cmd /k "npm run dev -- --port 5173 --strictPort"
) else (
  echo Frontend already appears to be running on %FRONTEND_URL%.
)

echo Waiting for Novel Canvas...
for /l %%i in (1,1,45) do (
  call :check_listener %BACKEND_PORT% "%BACKEND_URL%" Backend
  if not errorlevel 2 if errorlevel 1 (
    call :check_listener 5173 "%FRONTEND_URL%" Frontend
    if not errorlevel 2 if errorlevel 1 goto :ready
  )
  timeout /t 1 /nobreak >nul
)
echo ERROR: Novel Canvas did not become ready. See the service terminals.
pause
exit /b 1

:ready
echo Opening %FRONTEND_URL% ...
start "" "%FRONTEND_URL%"

echo.
echo Novel Canvas is starting.
echo Backend:  %BACKEND_URL%
echo Frontend: %FRONTEND_URL%
echo MCP:      %BACKEND_URL%/mcp
exit /b 0


:check_listener
rem 0 = free, 1 = our loopback service, 2 = conflicting or unverifiable listener.
powershell -NoProfile -Command "$ErrorActionPreference = 'Stop'; try { $listeners = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq %~1 }); if (!$listeners.Count) { exit 0 }; foreach ($listener in $listeners) { if (![Net.IPAddress]::IsLoopback($listener.Address)) { exit 2 } }; if ('%~3' -eq 'Backend') { $health = Invoke-RestMethod -MaximumRedirection 0 -Uri '%~2/health' -TimeoutSec 3; if ($health.service -eq 'novelcanvas') { exit 1 } } else { $page = Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 -Uri '%~2/' -TimeoutSec 3; if ($page.Content.Contains('<title>Novel Canvas</title>')) { exit 1 } }; exit 2 } catch { exit 2 }"
exit /b %errorlevel%

@echo off
REM ---------------------------------------------------------------------------
REM  Start the Battleship server on the LAN (Windows).
REM
REM    run.bat                            start on the default port
REM    set PORT=9000 ^&^& run.bat         start on another port
REM    set ADMIN_KEY=CAPTAIN ^&^& run.bat pin the admin key
REM
REM  Works from Command Prompt, from PowerShell (.\run.bat), or by
REM  double-clicking the file in Explorer.
REM ---------------------------------------------------------------------------

setlocal
cd /d "%~dp0"

set "VENV_PY=.venv\Scripts\python.exe"

if exist "%VENV_PY%" goto check_deps

echo First run: creating a Python environment...
py -3 -m venv .venv 2>nul
if not exist "%VENV_PY%" python -m venv .venv 2>nul
if not exist "%VENV_PY%" goto no_python

:check_deps
"%VENV_PY%" -c "import fastapi, uvicorn" 2>nul
if not errorlevel 1 goto start

echo Installing dependencies (this only happens once)...
"%VENV_PY%" -m pip install --quiet --upgrade pip
"%VENV_PY%" -m pip install --quiet fastapi "uvicorn[standard]"
if errorlevel 1 goto no_deps

:start
"%VENV_PY%" server.py
goto end

:no_python
echo.
echo Could not create a Python environment.
echo.
echo Install Python 3.9 or newer from https://www.python.org/downloads/
echo and tick "Add python.exe to PATH" during setup, then run this again.
echo.
pause
goto end

:no_deps
echo.
echo Could not install FastAPI and uvicorn.
echo Check your internet connection or proxy settings, then run this again.
echo.
pause

:end
endlocal

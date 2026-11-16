@echo off
REM One-time setup: creates a private Python environment in .venv and installs the libraries.
cd /d "%~dp0"
echo.
echo  Institutional Lens - setup
echo  ==========================
set "PY=python"
where py >nul 2>nul && set "PY=py -3"
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)" >nul 2>nul
if errorlevel 1 (
  echo  Python 3.11 or newer was not found. Install it from python.org first - see README step 1.
  pause
  exit /b 1
)
if not exist ".venv\Scripts\python.exe" %PY% -m venv .venv
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
  echo  Installing libraries failed. Check your internet connection and run setup.bat again.
  pause
  exit /b 1
)
echo.
echo  Setup complete.
echo  Next: open config.toml in Notepad and put your name and email in sec_user_agent.
echo  Then double-click run_update.bat.
pause

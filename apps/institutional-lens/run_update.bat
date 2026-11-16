@echo off
REM Downloads data and rebuilds scores. Used by the nightly scheduled task.
REM Extra options are passed through, e.g.:  run_update.bat --tickers AAPL,MSFT,JPM
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Run setup.bat first.
  exit /b 1
)
".venv\Scripts\python.exe" update.py %*

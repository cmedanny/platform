@echo off
REM Opens the app in your browser at http://localhost:8501  (close this window to stop it).
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Run setup.bat first.
  pause
  exit /b 1
)
start "" cmd /c "timeout /t 4 >nul & start http://localhost:8501"
".venv\Scripts\python.exe" -m streamlit run app.py --server.port 8501

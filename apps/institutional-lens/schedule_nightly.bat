@echo off
REM Creates a Windows scheduled task that runs run_update.bat every night at 02:00.
cd /d "%~dp0"
schtasks /Create /F /SC DAILY /ST 02:00 /TN "Institutional Lens nightly update" /TR "\"%~dp0run_update.bat\""
if errorlevel 1 (
  echo Could not create the task. Try right-clicking this file and choosing "Run as administrator".
) else (
  echo Scheduled: every night at 02:00. Change it in Task Scheduler if you like.
)
pause

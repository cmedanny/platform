@echo off
rem OFSD Terminal starter for Windows. Double-click to run.
cd /d "%~dp0"
title OFSD Terminal

where node >nul 2>nul
if errorlevel 1 goto nonode

node scripts\check-node.mjs
if errorlevel 1 goto fail

if exist node_modules goto installed
echo.
echo   First run: installing OFSD Terminal. This takes a minute or two...
echo.
call npm install
if errorlevel 1 goto installfail
:installed

if not exist .env copy .env.example .env >nul

findstr /r /c:"^ANTHROPIC_API_KEY=..*" .env >nul
if errorlevel 1 goto needkey
goto run

:needkey
echo.
echo   One more thing: your Claude API key.
echo   Notepad will open. Paste your key right after ANTHROPIC_API_KEY=
echo   and put your name and email in the SEC_USER_AGENT line.
echo   Then press Ctrl+S to save and close Notepad.
echo.
notepad .env

:run
echo.
echo   Starting OFSD Terminal. Your browser will open in a few seconds.
echo   Keep this window open while you use it. Close it to stop.
echo.
call npm start
goto end

:nonode
echo.
echo   Node.js is not installed yet.
echo   Opening nodejs.org now. Download the LTS version, run the installer,
echo   click Next through it, then double-click this file again.
echo.
start "" https://nodejs.org/en/download
goto end

:installfail
echo.
echo   The install did not finish. Copy the messages above and send them to Claude.
goto end

:fail
echo.
echo   Something went wrong. Copy the messages above and send them to Claude.

:end
echo.
pause

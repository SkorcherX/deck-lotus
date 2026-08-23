@echo off
rem ---------------------------------------------------------------------------
rem  Double-click this to open the theme wizard.
rem
rem  It finds a Deck Lotus that is already running and opens the wizard there;
rem  if nothing is running it starts the client dev server and opens that
rem  instead. Leave the window open while you work.
rem
rem  Point it somewhere specific by passing the address, or by dragging a
rem  shortcut with the address on the end:
rem
rem      theme-forge.bat http://unraid.local:3000
rem
rem  It lives here rather than in client/public/tools/ because everything in
rem  that folder is served to anyone who can reach the site and copied into the
rem  Docker image. A launcher for this machine belongs on this machine.
rem ---------------------------------------------------------------------------

setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on this machine.
  echo Install it from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

node scripts\open-forge.mjs %*

rem Only pause on failure. A successful run either exits straight away, having
rem handed off to the browser, or sits here running the dev server.
if errorlevel 1 (
  echo.
  pause
)

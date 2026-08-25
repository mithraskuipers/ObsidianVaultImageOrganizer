@echo off
setlocal enabledelayedexpansion
title Obsidian Vault Image Organizer - Launcher

set "PORT=8000"
set "SERVER_TITLE=OVIO-Server"

cd /d "%~dp0"

REM ------------------------------------------------------------------
REM Find a working Python launcher (py, then python)
REM ------------------------------------------------------------------
set "PYCMD="
where py >nul 2>&1
if not errorlevel 1 (
    set "PYCMD=py"
) else (
    where python >nul 2>&1
    if not errorlevel 1 (
        set "PYCMD=python"
    )
)

if "%PYCMD%"=="" (
    echo.
    echo   Python was not found on this system.
    echo   Install it from https://www.python.org/downloads/
    echo   ^(during install, tick "Add python.exe to PATH"^) and run this again.
    echo.
    pause
    exit /b 1
)

REM ------------------------------------------------------------------
REM Make sure the chosen port is free; if not, find the next open one
REM ------------------------------------------------------------------
:findport
netstat -ano | findstr /r /c:":%PORT% " >nul 2>&1
if not errorlevel 1 (
    set /a PORT+=1
    goto findport
)

REM ------------------------------------------------------------------
REM Detect this machine's LAN IPv4 address (for the network URL)
REM ------------------------------------------------------------------
set "LOCALIP="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4 Address"') do (
    if not defined LOCALIP (
        set "IPCANDIDATE=%%a"
        set "IPCANDIDATE=!IPCANDIDATE: =!"
        set "LOCALIP=!IPCANDIDATE!"
    )
)
if not defined LOCALIP set "LOCALIP=127.0.0.1"

echo.
echo ============================================================
echo   Obsidian Vault Image Organizer
echo ============================================================
echo   Starting local web server on port %PORT% ...
echo.
echo   On this PC:      http://localhost:%PORT%/
echo   On your network: http://%LOCALIP%:%PORT%/
echo.
echo   (Full vault-picker support only works on "localhost" -
echo    the network link is fine for viewing from other devices.)
echo ============================================================
echo.

REM ------------------------------------------------------------------
REM Start the server in its own minimized window, then open the page
REM ------------------------------------------------------------------
start "%SERVER_TITLE%" /min cmd /c "%PYCMD% -m http.server %PORT% --bind 0.0.0.0"

timeout /t 2 /nobreak >nul

start "" "http://localhost:%PORT%/"

echo Server is running in a separate minimized window titled "%SERVER_TITLE%".
echo.
echo Press any key in THIS window to stop the server and exit...
pause >nul

taskkill /fi "WINDOWTITLE eq %SERVER_TITLE%*" /t /f >nul 2>&1

echo.
echo Server stopped. You can close this window.
timeout /t 2 >nul
endlocal

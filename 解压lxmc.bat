@echo off
chcp 65001 >nul 2>&1
setlocal

set "SCRIPT=%~dp0lxmc_decoder.py"

rem --- Find Python: try WorkBuddy python, then system python, then py launcher ---
set "PYEXE="
if exist "C:\Users\Gan\.workbuddy\binaries\python\versions\3.13.12\python.exe" (
    set "PYEXE=C:\Users\Gan\.workbuddy\binaries\python\versions\3.13.12\python.exe"
)
if not defined PYEXE (
    where python >nul 2>&1 && for /f "delims=" %%i in ('where python') do (set "PYEXE=%%i" & goto :foundpy)
)
if not defined PYEXE (
    where py >nul 2>&1 && for /f "delims=" %%i in ('where py') do (set "PYEXE=%%i" & goto :foundpy)
)
:foundpy

if not defined PYEXE (
    echo.
    echo [ERROR] No Python found on this machine.
    echo Please install Python 3.8+ from https://www.python.org/downloads/
    echo or put python.exe in your PATH.
    echo.
    pause
    exit /b 1
)

if not exist "%SCRIPT%" (
    echo.
    echo [ERROR] Decoder script not found: %SCRIPT%
    echo Please make sure lxmc_decoder.py is in the same folder as this bat.
    echo.
    pause
    exit /b 1
)

rem --- Usage: drag .lxmc onto this bat, or double-click to pick a file ---
if not "%~1"=="" (
    "%PYEXE%" "%SCRIPT%" "%~1"
    goto :end
)

rem --- Double-click: Python script will show a file dialog itself ---
"%PYEXE%" "%SCRIPT%"

:end
echo.
pause
endlocal

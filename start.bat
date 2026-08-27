@echo off
REM Reliquary — double-click to start (Windows)
cd /d "%~dp0"
set PORT=8780
set PYTHONUNBUFFERED=1
echo.
echo   Reliquary - writing archaeology
echo   Open: http://127.0.0.1:%PORT%
echo   Stop: close this window or Ctrl+C
echo.

REM Open the browser after Python has a moment to bind
start "" cmd /c "ping -n 2 127.0.0.1 >NUL && start http://127.0.0.1:%PORT%/"

where python >NUL 2>&1
if %ERRORLEVEL%==0 (
  python -u serve.py
  goto :eof
)
where py >NUL 2>&1
if %ERRORLEVEL%==0 (
  py -3 -u serve.py
  goto :eof
)
echo Python 3 not found. Install from https://www.python.org/downloads/
echo Check "Add Python to PATH" during setup, then try again.
pause
exit /b 1

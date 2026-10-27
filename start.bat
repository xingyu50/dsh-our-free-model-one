@echo off
rem One-click launcher for the Our Free Model standalone service.
rem Kept strictly ASCII: cmd.exe parses .bat in the OEM code page,
rem so UTF-8 non-ASCII text here corrupts the script and it exits at once.
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto no_node

node "%~dp0scripts\start-standalone.mjs" %*
if errorlevel 1 goto fail
exit /b 0

:no_node
echo.
echo [ERROR] Node.js was not found in PATH.
echo         Install Node.js 22.19+ or 24+, then run this file again.
goto pause_end

:fail
echo.
echo [ERROR] Startup failed. See the message above for details.

:pause_end
echo.
echo Press any key to close this window...
pause >nul
exit /b 1

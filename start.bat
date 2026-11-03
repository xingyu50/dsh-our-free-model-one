@echo off
rem One-click launcher for the Our Free Model standalone service.
rem Kept strictly ASCII: cmd.exe parses .bat in the OEM code page,
rem so UTF-8 non-ASCII text here corrupts the script and it exits at once.
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem Window title: product abbreviation plus the version read from
rem package.json at launch, so a version bump never leaves a stale title.
rem Falls back to the bare abbreviation when node or the file is missing.
set "OFM_TITLE=OFM"
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version" 2^>nul`) do set "OFM_TITLE=OFM %%v"
title %OFM_TITLE%
rem Windows draws an elevated console window as "<elevation marker>:
rem <account>:  <title>" and the title command cannot remove that prefix,
rem because it belongs to the window rather than to the console title.
rem Replace the window text outright; if PowerShell is unavailable or blocks
rem Add-Type the line above already set a usable title, so this may fail.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -Namespace OfmTitle -Name Native -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern System.IntPtr GetConsoleWindow(); [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern bool SetWindowText(System.IntPtr window, string text);'; $ofmWindow = [OfmTitle.Native]::GetConsoleWindow(); if ($ofmWindow -ne [System.IntPtr]::Zero) { [void][OfmTitle.Native]::SetWindowText($ofmWindow, '%OFM_TITLE%') }" >nul 2>nul

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

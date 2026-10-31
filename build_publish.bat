@echo off
setlocal EnableExtensions
REM FlickFetch - single-file portable Windows x64 build (Electron + React + Tailwind).
REM Requires Node.js 22.12+ and npm on the BUILD MACHINE only. Output: publish\FlickFetch.exe - ONE portable file, no installer.

where node >nul 2>nul
if errorlevel 1 (
    echo ERROR: node was not found on PATH.
    echo Install Node.js LTS from https://nodejs.org/
    goto :fail_end
)
where npm >nul 2>nul
if errorlevel 1 (
    echo ERROR: npm was not found on PATH.
    goto :fail_end
)

cd /d "%~dp0"

REM Never let electron-builder go hunting for a code-signing certificate on its own; signing is handled by :sign_outputs.
set "CSC_IDENTITY_AUTO_DISCOVERY=false"

echo Closing any running FlickFetch.exe...
taskkill /f /im FlickFetch.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo.
echo Cleaning previous build output...
if exist "dist" rmdir /s /q "dist"
if exist "release" rmdir /s /q "release"
REM Remove only the old exe. App data now lives in %LOCALAPPDATA%\FlickFetch, not beside the exe.
if exist "publish\FlickFetch.exe" del /f /q "publish\FlickFetch.exe"

echo.
echo Installing project dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo ERROR: npm install failed. Check your internet connection and the npm output above.
    goto :fail_end
)

echo.
echo Checking main-process scripts for syntax errors...
call npm run check
if errorlevel 1 (
    echo ERROR: syntax check failed. Fix the errors above before building.
    goto :fail_end
)

call :publish_with_retry "FlickFetch.exe"
if errorlevel 1 goto :fail_end

call :collect_output
if errorlevel 1 goto :fail_end

call :sign_outputs
if errorlevel 1 goto :fail_end

echo.
echo ============================================================
echo FlickFetch build complete.
echo Output: %~dp0publish\FlickFetch.exe
echo Portable: YES ^(no installer, no installation, no administrator permission^)
echo Runtime: win-x64
echo Single-file: YES ^(ship only FlickFetch.exe; it keeps its data in %%LOCALAPPDATA%%\FlickFetch^)
echo ============================================================
exit /b 0

:fail_end
echo.
echo FlickFetch build failed. Review the output above.
echo TIP: "Cannot create symbolic link" / "required privilege is not held" means Windows Developer Mode
echo      ^(Settings ^> System ^> For developers^) is off - turn it on, or run this once as Administrator.
pause
exit /b 1

:publish_with_retry
set "PUBLISH_TARGET_NAME=%~1"
echo.
echo Building FlickFetch.exe ^(Vite renderer + Electron portable, single file^)...
call npm run build:win
if not errorlevel 1 exit /b 0

echo.
echo First build failed. Closing FlickFetch.exe and retrying once...
taskkill /f /im "%PUBLISH_TARGET_NAME%" >nul 2>&1
timeout /t 3 /nobreak >nul

call npm run build:win
if not errorlevel 1 exit /b 0

exit /b 1

:collect_output
REM electron-builder writes into release\ (portable exe + win-unpacked + yml files).
REM Copy ONLY the portable exe into publish\ under a stable name, then delete the staging folder.
set "BUILT_EXE="
for %%F in ("%~dp0release\*-Portable.exe") do set "BUILT_EXE=%%~fF"
if not defined BUILT_EXE (
    echo ERROR: the portable executable was not found in release\ after the build.
    exit /b 1
)
mkdir "%~dp0publish" >nul 2>&1
copy /y "%BUILT_EXE%" "%~dp0publish\FlickFetch.exe" >nul
if errorlevel 1 (
    echo ERROR: could not copy the portable executable into publish\.
    exit /b 1
)
rmdir /s /q "%~dp0release" >nul 2>&1
exit /b 0

:sign_outputs
REM Authenticode-sign the exe. Settings come from signing\signing.config.bat or environment variables (see signing\README.md).
set "SIGN_DIR=%~dp0signing"
if not exist "%SIGN_DIR%\sign.ps1" (
    echo.
    echo NOTE: signing\sign.ps1 was not found - publish\FlickFetch.exe is left UNSIGNED.
    exit /b 0
)
if exist "%SIGN_DIR%\signing.config.bat" call "%SIGN_DIR%\signing.config.bat"
echo.
echo Signing publish\FlickFetch.exe...
powershell -NoProfile -ExecutionPolicy Bypass -File "%SIGN_DIR%\sign.ps1" -Path "%~dp0publish\FlickFetch.exe"
if errorlevel 1 exit /b 1
exit /b 0

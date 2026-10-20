@echo off
setlocal EnableExtensions
REM FlickFetch - verified self-contained single-file Windows build.
REM Requirements: Windows, .NET 8 SDK, PowerShell, internet access for bundled dependencies.

cd /d "%~dp0" || goto :fail_no_pause
set "PREP_LOG=%~dp0tool-preparation.log"
set "BUILD_LOG=%~dp0build-publish.log"

where dotnet >nul 2>nul
if errorlevel 1 (
    echo ERROR: dotnet was not found on PATH.
    echo Install the .NET 8 SDK from https://dotnet.microsoft.com/download/dotnet/8.0
    goto :fail
)
where powershell >nul 2>nul
if errorlevel 1 (
    echo ERROR: Windows PowerShell was not found on PATH.
    goto :fail
)

if not exist "%~dp0scripts\prepare-bundled-tools.ps1" (
    echo ERROR: scripts\prepare-bundled-tools.ps1 is missing.
    goto :fail
)
if not exist "%~dp0FlickFetch.csproj" (
    echo ERROR: FlickFetch.csproj is missing.
    goto :fail
)

echo.
echo ============================================================
echo Preparing verified downloader tools for FlickFetch...
echo ============================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\prepare-bundled-tools.ps1" -Force > "%PREP_LOG%" 2>&1
set "PREP_EXIT=%ERRORLEVEL%"
type "%PREP_LOG%"
if not "%PREP_EXIT%"=="0" (
    echo.
    echo ERROR: Dependency staging failed. Full log: "%PREP_LOG%"
    goto :fail
)

for %%T in (yt-dlp.exe ffmpeg.exe ffprobe.exe deno.exe) do (
    if not exist "%~dp0Assets\BundledTools\%%T" (
        echo ERROR: Required bundled tool is missing: %%T
        goto :fail
    )
)
if not exist "%~dp0Assets\BundledTools\bundled-tools-manifest.txt" (
    echo ERROR: The bundled-tools manifest was not generated.
    goto :fail
)
if not exist "%~dp0THIRD-PARTY-NOTICES.md" (
    echo ERROR: THIRD-PARTY-NOTICES.md is missing.
    goto :fail
)

echo.
echo Closing any running FlickFetch.exe...
taskkill /f /im FlickFetch.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo.
echo Cleaning previous Release and publish output...
if exist "bin\Release" rmdir /s /q "bin\Release"
if exist "obj\Release" rmdir /s /q "obj\Release"
if exist "publish" rmdir /s /q "publish"

echo.
echo Publishing FlickFetch.exe (self-contained, single file)...
dotnet publish FlickFetch.csproj -c Release -r win-x64 --self-contained true ^
  -p:PublishSingleFile=true ^
  -p:IncludeNativeLibrariesForSelfExtract=true ^
  -p:EnableCompressionInSingleFile=false ^
  -p:PublishTrimmed=false ^
  -p:DebugType=None ^
  -p:DebugSymbols=false ^
  -o "%~dp0publish" > "%BUILD_LOG%" 2>&1
set "BUILD_EXIT=%ERRORLEVEL%"
type "%BUILD_LOG%"
if not "%BUILD_EXIT%"=="0" (
    echo.
    echo ERROR: dotnet publish failed with exit code %BUILD_EXIT%.
    echo Full compiler/build log: "%BUILD_LOG%"
    goto :fail
)

if not exist "%~dp0publish\FlickFetch.exe" (
    echo ERROR: dotnet publish returned success but publish\FlickFetch.exe was not found.
    echo Full compiler/build log: "%BUILD_LOG%"
    goto :fail
)
for %%F in ("%~dp0publish\FlickFetch.exe") do set "EXE_SIZE=%%~zF"
if not defined EXE_SIZE (
    echo ERROR: Unable to determine the published EXE size.
    goto :fail
)
if %EXE_SIZE% LSS 1000000 (
    echo ERROR: The published EXE is unexpectedly small (%EXE_SIZE% bytes).
    echo The self-contained runtime or embedded resources may be incomplete.
    goto :fail
)

echo.
echo ============================================================
echo FlickFetch build complete.
echo Output: %~dp0publish\FlickFetch.exe
echo Runtime: win-x64, self-contained .NET 8
echo Packaging: single-file EXE
echo Embedded tools: yt-dlp, FFmpeg, FFprobe and Deno
echo Copyright: Jessie Albert Regualos (original app code)
echo ============================================================
echo.
echo NOTE: The app extracts child-process tools into %%LocalAppData%% at first launch.
echo Logs: "%BUILD_LOG%" and "%PREP_LOG%"
echo Third-party components retain their respective copyrights and licenses.
exit /b 0

:fail
echo.
echo FlickFetch build failed. Review the error and log path above.
echo Build log: "%BUILD_LOG%"
echo Preparation log: "%PREP_LOG%"
pause
exit /b 1

:fail_no_pause
 echo ERROR: Could not open the project directory.
exit /b 1

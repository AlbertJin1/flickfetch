@echo off
setlocal EnableExtensions
REM FlickFetch release packager.
REM Builds locally and creates a ZIP with the one-file EXE, notices and SHA-256 manifests.
REM No upload endpoint or unrelated product integration is used.

cd /d "%~dp0"
call "%~dp0build_publish.bat"
if errorlevel 1 exit /b 1

set "VERSION="
for /f "usebackq delims=" %%V in (`powershell -NoProfile -Command "([xml](Get-Content -Raw 'FlickFetch.csproj')).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1"`) do set "VERSION=%%V"
if "%VERSION%"=="" set "VERSION=1.1.0"

set "RELEASE_ROOT=%~dp0release"
set "RELEASE_DIR=%~dp0release\FlickFetch-%VERSION%-win-x64"
set "RELEASE_ZIP=%~dp0release\FlickFetch-%VERSION%-win-x64.zip"
if not exist "%RELEASE_ROOT%" mkdir "%RELEASE_ROOT%"
if exist "%RELEASE_DIR%" rmdir /s /q "%RELEASE_DIR%"
if exist "%RELEASE_ZIP%" del /q "%RELEASE_ZIP%"
mkdir "%RELEASE_DIR%"
if errorlevel 1 goto :fail

copy /y "%~dp0publish\FlickFetch.exe" "%RELEASE_DIR%\FlickFetch.exe" >nul
if errorlevel 1 goto :fail
copy /y "%~dp0README.md" "%RELEASE_DIR%\README.md" >nul
if errorlevel 1 goto :fail
copy /y "%~dp0COPYRIGHT.txt" "%RELEASE_DIR%\COPYRIGHT.txt" >nul
if errorlevel 1 goto :fail
copy /y "%~dp0THIRD-PARTY-NOTICES.md" "%RELEASE_DIR%\THIRD-PARTY-NOTICES.md" >nul
if errorlevel 1 goto :fail
if exist "%~dp0THIRD-PARTY-FFMPEG-LICENSE.txt" copy /y "%~dp0THIRD-PARTY-FFMPEG-LICENSE.txt" "%RELEASE_DIR%\THIRD-PARTY-FFMPEG-LICENSE.txt" >nul
if exist "%~dp0Assets\BundledTools\bundled-tools-manifest.txt" copy /y "%~dp0Assets\BundledTools\bundled-tools-manifest.txt" "%RELEASE_DIR%\BUNDLED-TOOLS-SHA256.txt" >nul
if exist "%~dp0third-party-licenses" (
    mkdir "%RELEASE_DIR%\third-party-licenses" >nul 2>&1
    xcopy /E /I /Y "%~dp0third-party-licenses\*" "%RELEASE_DIR%\third-party-licenses\" >nul
    if errorlevel 2 goto :fail
)
if exist "%~dp0third-party-sources" (
    mkdir "%RELEASE_DIR%\third-party-sources" >nul 2>&1
    xcopy /E /I /Y "%~dp0third-party-sources\*" "%RELEASE_DIR%\third-party-sources\" >nul
    if errorlevel 2 goto :fail
)

powershell -NoProfile -Command "$h=(Get-FileHash -Algorithm SHA256 '%RELEASE_DIR%\FlickFetch.exe').Hash.ToLowerInvariant(); Set-Content -Encoding ASCII '%RELEASE_DIR%\SHA256SUMS.txt' ($h + '  FlickFetch.exe')"
if errorlevel 1 goto :fail
powershell -NoProfile -Command "Compress-Archive -Path '%RELEASE_DIR%\*' -DestinationPath '%RELEASE_ZIP%' -Force"
if errorlevel 1 goto :fail

 echo.
echo ============================================================
echo Release package ready.
echo Single EXE : %~dp0publish\FlickFetch.exe
echo ZIP        : %RELEASE_ZIP%
echo SHA-256    : %RELEASE_DIR%\SHA256SUMS.txt
echo ============================================================
explorer /select,"%~dp0publish\FlickFetch.exe"
exit /b 0

:fail
echo ERROR: release preparation failed. Review the messages above.
exit /b 1

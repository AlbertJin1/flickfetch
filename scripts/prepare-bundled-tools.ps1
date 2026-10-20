[CmdletBinding()]
param([switch]$Force)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$projectRoot = Split-Path -Parent $PSScriptRoot
$assetDir = Join-Path $projectRoot 'Assets\BundledTools'
$licenseDir = Join-Path $projectRoot 'third-party-licenses'
$sourceDir = Join-Path $projectRoot 'third-party-sources'
$tempDir = Join-Path ([IO.Path]::GetTempPath()) ('FlickFetch-build-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $assetDir, $licenseDir, $sourceDir, $tempDir -Force | Out-Null

if ($Force) {
    Remove-Item (Join-Path $projectRoot 'THIRD-PARTY-FFMPEG-LICENSE.txt') -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $licenseDir -Filter 'yt-dlp-*' -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $sourceDir -Filter 'yt-dlp-*.tar.gz' -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $sourceDir -Filter 'FFmpeg-*.tar.gz' -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
}

function Get-Download([string]$Url, [string]$Destination) {
    Write-Host ("Downloading {0}" -f [IO.Path]::GetFileName($Destination)) -ForegroundColor Cyan
    Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -Headers @{ 'User-Agent' = 'FlickFetch-build/1.0' }
    if (!(Test-Path $Destination) -or (Get-Item $Destination).Length -lt 100) {
        throw "Download failed or file was unexpectedly small: $Url"
    }
}

function Get-LatestTag([string]$Repository) {
    $release = Invoke-RestMethod -Uri ("https://api.github.com/repos/{0}/releases/latest" -f $Repository) -Headers @{ 'User-Agent' = 'FlickFetch-build/1.0' }
    $tag = [string]$release.tag_name
    if ([string]::IsNullOrWhiteSpace($tag) -or $tag -notmatch '^[A-Za-z0-9._-]+$') {
        throw "GitHub did not return a valid latest release tag for $Repository."
    }
    return $tag
}

function Copy-ZipEntry([object]$Zip, [string]$LeafName, [string]$Destination) {
    $entry = $Zip.Entries | Where-Object { [IO.Path]::GetFileName($_.FullName) -ieq $LeafName } | Select-Object -First 1
    if ($null -eq $entry) { throw "The downloaded archive does not contain $LeafName." }
    $input = $entry.Open()
    try {
        $output = [IO.File]::Create($Destination)
        try { $input.CopyTo($output) } finally { $output.Dispose() }
    } finally { $input.Dispose() }
    if ((Get-Item $Destination).Length -lt 1024) { throw "Extracted tool is unexpectedly small: $LeafName" }
}

try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem

    # yt-dlp Windows executable and exact-tag license/source materials.
    $ytTag = Get-LatestTag 'yt-dlp/yt-dlp'
    $ytBase = "https://github.com/yt-dlp/yt-dlp/releases/download/$ytTag"
    $ytPath = Join-Path $assetDir 'yt-dlp.exe'
    $ytSumsPath = Join-Path $tempDir 'SHA2-256SUMS'
    if ($Force -or !(Test-Path $ytPath) -or (Get-Item $ytPath).Length -lt 1MB) {
        Get-Download "$ytBase/yt-dlp.exe" $ytPath
        Get-Download "$ytBase/SHA2-256SUMS" $ytSumsPath
        $line = Get-Content $ytSumsPath | Where-Object { $_ -match '\s\*?yt-dlp\.exe\s*$' } | Select-Object -First 1
        if (!$line) { throw "Could not find yt-dlp.exe in the official SHA2-256SUMS file for $ytTag." }
        $expected = (($line -split '\s+')[0]).Trim()
        $actual = (Get-FileHash -Algorithm SHA256 -Path $ytPath).Hash.ToLowerInvariant()
        if ($expected.ToLowerInvariant() -ne $actual) {
            Remove-Item $ytPath -Force -ErrorAction SilentlyContinue
            throw 'yt-dlp SHA-256 verification failed. The release payload was not accepted.'
        }
        Write-Host "Verified yt-dlp $ytTag SHA-256." -ForegroundColor Green
    } else { Write-Host 'Using existing yt-dlp.exe asset.' -ForegroundColor DarkGray }

    Get-Download "https://raw.githubusercontent.com/yt-dlp/yt-dlp/$ytTag/LICENSE" (Join-Path $licenseDir 'yt-dlp-LICENSE.txt')
    Get-Download "https://raw.githubusercontent.com/yt-dlp/yt-dlp/$ytTag/THIRD_PARTY_LICENSES.txt" (Join-Path $licenseDir 'yt-dlp-THIRD_PARTY_LICENSES.txt')
    $ytSourcePath = Join-Path $sourceDir "yt-dlp-$ytTag.tar.gz"
    if ($Force -or !(Test-Path $ytSourcePath)) { Get-Download "$ytBase/yt-dlp.tar.gz" $ytSourcePath }

    # FFmpeg/FFprobe build from the yt-dlp team's official build distribution.
    $ffmpegPath = Join-Path $assetDir 'ffmpeg.exe'
    $ffprobePath = Join-Path $assetDir 'ffprobe.exe'
    $ffZipPath = Join-Path $tempDir 'ffmpeg-win64-gpl.zip'
    $ffArchiveLicensePath = Join-Path $licenseDir 'FFmpeg-Build-LICENSE.txt'
    if ($Force -or !(Test-Path $ffmpegPath) -or !(Test-Path $ffprobePath)) {
        Get-Download 'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip' $ffZipPath
        $zip = [IO.Compression.ZipFile]::OpenRead($ffZipPath)
        try {
            Copy-ZipEntry $zip 'ffmpeg.exe' $ffmpegPath
            Copy-ZipEntry $zip 'ffprobe.exe' $ffprobePath
            $licenseEntry = $zip.Entries | Where-Object {
                [IO.Path]::GetFileName($_.FullName) -match '^(LICENSE(\.txt)?|COPYING(\..+)?|COPYING)$'
            } | Select-Object -First 1
            if ($licenseEntry) {
                $licenseStream = $licenseEntry.Open()
                try {
                    $outStream = [IO.File]::Create($ffArchiveLicensePath)
                    try { $licenseStream.CopyTo($outStream) } finally { $outStream.Dispose() }
                } finally { $licenseStream.Dispose() }
            }
        } finally { $zip.Dispose() }
        Write-Host 'Extracted FFmpeg and FFprobe from the GPL win64 build.' -ForegroundColor Green
    } else { Write-Host 'Using existing FFmpeg assets.' -ForegroundColor DarkGray }

    # Preserve the upstream GPL license text even when the binary archive omits license documents.
    if (!(Test-Path $ffArchiveLicensePath)) {
        Get-Download 'https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/COPYING.GPLv2' (Join-Path $licenseDir 'FFmpeg-COPYING.GPLv2.txt')
    }
    # Keep both official license texts available for review; the exact license depends on build configuration.
    if (!(Test-Path (Join-Path $licenseDir 'FFmpeg-COPYING.GPLv3.txt'))) {
        Get-Download 'https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/COPYING.GPLv3' (Join-Path $licenseDir 'FFmpeg-COPYING.GPLv3.txt')
    }
    if (!(Test-Path (Join-Path $licenseDir 'FFmpeg-COPYING.GPLv2.txt'))) {
        Get-Download 'https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/COPYING.GPLv2' (Join-Path $licenseDir 'FFmpeg-COPYING.GPLv2.txt')
    }

    # Record FFmpeg's exact version/configuration and download its matching FFmpeg source snapshot when possible.
    $ffVersionText = (& $ffmpegPath -version 2>&1 | Out-String)
    $ffVersionText | Set-Content -Path (Join-Path $sourceDir 'FFmpeg-build-version-and-configuration.txt') -Encoding UTF8
    $commitMatch = [regex]::Match($ffVersionText, 'N-\d+-g(?<hash>[0-9a-f]{7,40})', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    $ffCommit = ''
    if ($commitMatch.Success) {
        $ffCommit = $commitMatch.Groups['hash'].Value
        $ffSourcePath = Join-Path $sourceDir "FFmpeg-$ffCommit.tar.gz"
        if ($Force -or !(Test-Path $ffSourcePath)) {
            Get-Download "https://github.com/FFmpeg/FFmpeg/archive/$ffCommit.tar.gz" $ffSourcePath
        }
    } else {
        Write-Warning 'Could not parse the FFmpeg source commit from ffmpeg -version. Confirm matching FFmpeg and external-library sources before redistribution.'
    }

    # Deno is included as yt-dlp's JavaScript runtime dependency.
    $denoTag = Get-LatestTag 'denoland/deno'
    $denoPath = Join-Path $assetDir 'deno.exe'
    $denoZipPath = Join-Path $tempDir 'deno-windows-x64.zip'
    if ($Force -or !(Test-Path $denoPath) -or (Get-Item $denoPath).Length -lt 1MB) {
        Get-Download "https://github.com/denoland/deno/releases/download/$denoTag/deno-x86_64-pc-windows-msvc.zip" $denoZipPath
        $zip = [IO.Compression.ZipFile]::OpenRead($denoZipPath)
        try { Copy-ZipEntry $zip 'deno.exe' $denoPath } finally { $zip.Dispose() }
        Write-Host "Extracted Deno $denoTag." -ForegroundColor Green
    } else { Write-Host 'Using existing deno.exe asset.' -ForegroundColor DarkGray }
    Get-Download "https://raw.githubusercontent.com/denoland/deno/$denoTag/LICENSE.md" (Join-Path $licenseDir 'Deno-LICENSE.md')

    $manifest = @(
        'FlickFetch bundled tool manifest',
        ('Built: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss K')),
        ('yt-dlp tag: ' + $ytTag),
        ('yt-dlp SHA256: ' + (Get-FileHash -Algorithm SHA256 -Path $ytPath).Hash.ToLowerInvariant()),
        ('FFmpeg version: ' + (($ffVersionText -split "`r?`n")[0]).Trim()),
        ('FFmpeg source commit detected: ' + $(if ($ffCommit) { $ffCommit } else { 'not detected; source verification required' })),
        ('ffmpeg SHA256: ' + (Get-FileHash -Algorithm SHA256 -Path $ffmpegPath).Hash.ToLowerInvariant()),
        ('ffprobe SHA256: ' + (Get-FileHash -Algorithm SHA256 -Path $ffprobePath).Hash.ToLowerInvariant()),
        ('Deno tag: ' + $denoTag),
        ('deno SHA256: ' + (Get-FileHash -Algorithm SHA256 -Path $denoPath).Hash.ToLowerInvariant())
    )
    Set-Content -Path (Join-Path $assetDir 'bundled-tools-manifest.txt') -Value $manifest -Encoding UTF8
    Write-Host "All bundled tools are staged in $assetDir" -ForegroundColor Green
    Write-Warning 'The source archives and notices are helpful compliance material, but a redistributor must still verify exact corresponding-source obligations for GPL components and all linked FFmpeg libraries.'
}
finally {
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

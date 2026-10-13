# One command from a fresh clone to the gateway setup wizard.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\setup.ps1
#
# 1. Checks Windows x64, Git and Node 22.
# 2. Downloads DCMTK and portable ImageMagick into C:\Tools (once), checks their SHA-256,
#    and adds them to your user PATH.
# 3. Installs the repository dependencies and builds the Windows bundle (package.ps1).
# 4. Runs the bundle's Gateway.cmd, which installs the gateway and opens the wizard.
#
# Safe to run again. Tools already in C:\Tools are kept, and an installed gateway is
# reopened, never overwritten.
param([string]$ToolsDirectory = 'C:\Tools')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'   # the progress bar makes downloads many times slower
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

# Pinned downloads. To move to a newer version, change the URL and the SHA-256 together.
$dcmtkUrl = 'https://dicom.offis.de/download/dcmtk/dcmtk370/bin/dcmtk-3.7.0-win64-dynamic.zip'
$dcmtkSha256 = 'DCCA45B2A7596E829F0EDA885C746880385176830FE47253A6444330017BA191'
$magickUrl = 'https://github.com/ImageMagick/ImageMagick/releases/download/7.1.2-33/ImageMagick-7.1.2-33-portable-Q16-x64.7z'
$magickSha256 = '5C242A23C4343ADD3F3BBDF265E74BAA28D97D565A7B2A7C2827A4C3C449C278'
# Portable ImageMagick is published only as .7z, which Windows cannot open by itself.
# 7zr.exe is the official stand-alone 7-Zip extractor.
$sevenZipUrl = 'https://www.7-zip.org/a/7zr.exe'
$sevenZipSha256 = '256FECA8E274E5DA655E2A284FABAFD9F554365EB164862089DACD4E8276D282'

$taskName = 'Visilant InSight-Gateway'
$dcmtk = Join-Path $ToolsDirectory 'dcmtk'
$magick = Join-Path $ToolsDirectory 'ImageMagick'

function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Stop-Setup($text) {
    Write-Host ''
    Write-Host $text -ForegroundColor Red
    Write-Host 'Fix this, then run the same command again. Steps that already finished are skipped.'
    exit 1
}

function Get-Download($url, $sha256, $file) {
    Write-Host "Downloading $url"
    try { Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing }
    catch { Stop-Setup "Could not download $url ($($_.Exception.Message)). Check the internet connection or proxy." }
    $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    if ($actual -ne $sha256) {
        Remove-Item -LiteralPath $file -Force
        Stop-Setup "The file from $url is not the expected one (SHA-256 $actual). Do not use it. Tell Visilant."
    }
}

function Add-UserPath($folder) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @(); if ($userPath) { $parts = $userPath.Split(';') | Where-Object { $_ } }
    if ($parts -notcontains $folder) {
        [Environment]::SetEnvironmentVariable('Path', (($parts + $folder) -join ';'), 'User')
        Write-Host "Added $folder to your user PATH. New terminal windows will see it."
    }
    if ($env:Path.Split(';') -notcontains $folder) { $env:Path = $folder + ';' + $env:Path }
}

Step 'Checking this computer'
if (-not [Environment]::Is64BitOperatingSystem) { Stop-Setup 'The gateway needs 64-bit Windows.' }
if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    Stop-Setup 'Git is not installed. Install Git for Windows from https://git-scm.com/download/win, open a new PowerShell window and run this again.'
}
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    Stop-Setup 'Node is not installed. Install Node 22 (64-bit): with nvm-windows run "nvm install 22" then "nvm use 22", or use the Node 22 LTS installer from https://nodejs.org.'
}
$nodeVersion = & $nodeCommand.Source -p 'process.versions.node'
if (-not $nodeVersion.StartsWith('22.')) {
    Stop-Setup "Node $nodeVersion is active, but the gateway needs Node 22. With nvm-windows run ""nvm install 22"" then ""nvm use 22"" (type the 22: nvm-windows does not read .nvmrc). Otherwise install the Node 22 LTS from https://nodejs.org."
}
if ((& $nodeCommand.Source -p 'process.arch') -ne 'x64') { Stop-Setup 'This Node is 32-bit. Install the 64-bit Node 22.' }
Write-Host "Windows x64, Git, Node $($nodeVersion): OK"

# The task may be hidden from a non-administrator, so also look for the installed files.
$installedTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$installedFiles = Test-Path (Join-Path $env:ProgramFiles 'Visilant\InSight-Gateway\manifest.json')
if ($installedTask -or $installedFiles) {
    Step 'The gateway is already installed on this computer'
    Write-Host 'Opening the setup wizard. Settings, accounts and queued images are kept.'
    Write-Host 'To install a newer version, see "Update the gateway" in docs\windows-setup.md. Do not delete C:\ProgramData\Visilant.'
    Start-Process 'http://127.0.0.1:8081'
    exit 0
}

Step "DCMTK and ImageMagick in $ToolsDirectory"
New-Item -ItemType Directory -Path $ToolsDirectory -Force | Out-Null
$download = Join-Path ([IO.Path]::GetTempPath()) ('visilant-setup-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $download | Out-Null
try {
    if (Test-Path (Join-Path $dcmtk 'bin\echoscu.exe')) {
        Write-Host "DCMTK already in $dcmtk"
    } elseif (Test-Path $dcmtk) {
        Stop-Setup "$dcmtk exists but has no bin\echoscu.exe. Delete that folder so it can be downloaded again."
    } else {
        $zip = Join-Path $download 'dcmtk.zip'
        Get-Download $dcmtkUrl $dcmtkSha256 $zip
        Expand-Archive -LiteralPath $zip -DestinationPath $download
        Move-Item -LiteralPath (Join-Path $download 'dcmtk-3.7.0-win64-dynamic') -Destination $dcmtk
        Write-Host "DCMTK installed in $dcmtk"
    }
    if (Test-Path (Join-Path $magick 'magick.exe')) {
        Write-Host "ImageMagick already in $magick"
    } else {
        $sevenZip = Join-Path $download '7zr.exe'
        $archive = Join-Path $download 'imagemagick.7z'
        Get-Download $sevenZipUrl $sevenZipSha256 $sevenZip
        Get-Download $magickUrl $magickSha256 $archive
        & $sevenZip x $archive "-o$magick" -y | Out-Null
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $magick 'magick.exe'))) {
            Stop-Setup "ImageMagick could not be extracted into $magick. Delete that folder and run this again."
        }
        Write-Host "ImageMagick installed in $magick"
    }
} finally { Remove-Item -LiteralPath $download -Recurse -Force -ErrorAction SilentlyContinue }
Add-UserPath (Join-Path $dcmtk 'bin')
Add-UserPath $magick

Step 'Installing dependencies (npm ci)'
& npm.cmd ci
if ($LASTEXITCODE -ne 0) {
    Stop-Setup 'npm ci failed. If the output mentions node-gyp, MSBuild or Visual Studio, the wrong Node is active: run "nvm use 22" and try again.'
}

Step 'Building the Windows bundle'
$output = Join-Path $root 'dist\windows'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'package.ps1') -DcmtkDirectory $dcmtk -ImageMagickDirectory $magick -OutputDirectory $output
if ($LASTEXITCODE -ne 0) { Stop-Setup 'Building the bundle failed. The message above says why; docs\windows-setup.md lists the common causes.' }
$bundle = Get-ChildItem -LiteralPath $output -Directory -Filter 'InSight-Gateway-*' | Sort-Object Name | Select-Object -Last 1
if (-not $bundle) { Stop-Setup "No bundle folder was found in $output." }

Step 'Installing the gateway and opening the setup wizard'
Write-Host 'Windows will ask for administrator permission. Click Yes.'
& (Join-Path $bundle.FullName 'Gateway.cmd')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host ''
Write-Host 'Done. Continue in the browser at http://127.0.0.1:8081 (also on the desktop as "Gateway Setup").' -ForegroundColor Green

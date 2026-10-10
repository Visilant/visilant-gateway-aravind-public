param([switch]$NoBrowser, [string]$LogPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$target = Join-Path $env:ProgramFiles 'Visilant\InSight-Gateway'
$data = Join-Path $env:ProgramData 'Visilant'
$logRoot = Join-Path $data 'logs'
$taskName = 'Visilant InSight-Gateway'
$gatewayProgram = Join-Path $target 'runtime\node.exe'
if (-not $LogPath) { $LogPath = Join-Path $logRoot ('install-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log') }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    # Elevate in a new window and wait for it. The elevated copy writes a transcript to
    # $LogPath. This window keeps the real exit code, so a failure is never hidden behind
    # a window that closes at once. Gateway.cmd pauses when this window reports failure.
    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -NoBrowser -LogPath "' + $LogPath + '"'
    try {
        $process = Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -PassThru -Wait
    } catch {
        Write-Host ('Administrator permission was not granted: ' + $_.Exception.Message)
        Write-Host 'Run Gateway.cmd again and approve the Windows administrator prompt.'
        exit 1
    }
    if ($process.ExitCode -ne 0) {
        Write-Host ('Installation did not complete (exit code ' + $process.ExitCode + ').')
        Write-Host ('Details are in the install log: ' + $LogPath)
        exit $process.ExitCode
    }
    if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:8081' }
    exit 0
}
# Any terminating error in the elevated copy lands here. The window stays open so the
# operator can read the specific failure and the log path before it closes.
trap {
    Write-Host ''
    Write-Host ('Installation did not complete: ' + $_.Exception.Message)
    Write-Host ('Install log: ' + $LogPath + ' (may be missing if it failed before logging started)')
    Write-Host 'Gateway data was not deleted. Send the install log to support before retrying.'
    try { Stop-Transcript | Out-Null } catch { }
    Read-Host 'Press Enter to close this window' | Out-Null
    exit 1
}
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
& icacls.exe $logRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not protect the gateway log folder.' }
try { Start-Transcript -Path $LogPath -Force | Out-Null } catch { Write-Host ('Could not start the install log: ' + $_.Exception.Message) }
function Stop-InstallLog { try { Stop-Transcript | Out-Null } catch { } }
# Firewall rule logic is shared with run.ps1, which reconciles the rule at every start.
. (Join-Path $PSScriptRoot 'firewall.ps1')
function Repair-GatewayFirewall {
    $port = Get-GatewayListenPort -DataFolder $data
    $result = Set-GatewayFirewallRule -RuleName $taskName -Program $gatewayProgram -Port $port
    switch ($result) {
        'correct' { Write-Host ('Firewall rule OK: TCP port ' + $port + ' from the local subnet.') }
        'created' { Write-Host ('Repaired: the firewall rule was missing. Created it for TCP port ' + $port + ' from the local subnet.') }
        'replaced' { Write-Host ('Repaired: the firewall rule had the wrong scope. Replaced it for TCP port ' + $port + ' from the local subnet.') }
    }
}
function Open-GatewaySetup {
    Start-ScheduledTask -TaskName $taskName
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try { $null = Invoke-WebRequest 'http://127.0.0.1:8081/api/session' -UseBasicParsing -TimeoutSec 2; $ready = $true; break } catch { Start-Sleep -Seconds 1 }
    }
    if (-not $ready) { throw 'Installed, but the launcher did not respond. Check the scheduled task and runtime. Preserve the data folder.' }
    if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:8081' }
}
# The same entry command reopens an intact installation. It never upgrades code,
# replaces configuration or creates a second worker against an existing database.
# The logs folder lives inside the data folder, so it is not evidence of an install.
$installedTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$dataItems = @()
if (Test-Path -LiteralPath $data) { $dataItems = @(Get-ChildItem -LiteralPath $data -Force | Where-Object { $_.Name -ne 'logs' }) }
if ((Test-Path $target) -or ($dataItems.Count -gt 0) -or $installedTask) {
    $complete = (Test-Path (Join-Path $target 'runtime\node.exe')) -and
        (Test-Path (Join-Path $target 'application\build\src\setup\launcher.js')) -and
        (Test-Path (Join-Path $target 'run.ps1')) -and (Test-Path (Join-Path $target 'manifest.json')) -and
        (Test-Path $data) -and $installedTask
    if (-not $complete) { throw 'An incomplete installation was found. Ask the administrator to repair the gateway files/startup task. Do not delete the data folder.' }
    # Re-run repair: verify the firewall rule has the expected scope on every run, and
    # recreate it if it is missing or wrong, so an older or damaged rule is corrected.
    Repair-GatewayFirewall
    Open-GatewaySetup
    Write-Host 'Existing gateway opened. Settings and queued images were preserved.'
    Stop-InstallLog
    exit 0
}
$manifest = Get-Content (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
foreach ($entry in $manifest.files) {
    $file = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $entry.path))
    if (-not $file.StartsWith($PSScriptRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid bundle path.' }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.sha256) { throw 'The bundle is incomplete or damaged. Request a new ZIP.' }
}
# Check the exact runtime before installing or registering unattended execution.
& (Join-Path $PSScriptRoot 'runtime\node.exe') (Join-Path $PSScriptRoot 'verify-runtime.cjs') (Join-Path $PSScriptRoot 'application\node_modules\better-sqlite3')
if ($LASTEXITCODE -ne 0) { throw 'The Windows runtime is incompatible with this computer.' }
# No cleanup on failure: if the gateway started before a later step failed, a cleanup
# could delete captures. Leave installed state intact for investigation.
New-Item -ItemType Directory -Path $target -Force | Out-Null
# Copy an explicit payload list, never an arbitrary config or local data directory.
foreach ($name in @('application','runtime','run.ps1','firewall.ps1','manifest.json')) { Copy-Item (Join-Path $PSScriptRoot $name) $target -Recurse }
New-Item -ItemType Directory -Path $data -Force | Out-Null
& icacls.exe $data /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not protect the gateway data directory.' }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $target 'run.ps1') + '"') -WorkingDirectory $target
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Description 'Run the local InSight-Gateway and resume queued image delivery.' | Out-Null
Repair-GatewayFirewall
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Gateway Setup.url'))
$shortcut.TargetPath = 'http://127.0.0.1:8081'
$shortcut.Save()
Open-GatewaySetup
Write-Host 'Installation complete. Continue in Gateway Setup. Restart the computer during the final check.'
Write-Host ('Install log: ' + $LogPath)
Stop-InstallLog
exit 0

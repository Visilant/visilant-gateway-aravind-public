param([switch]$Apply, [switch]$PurgeData, [string]$DataDeletionConfirmation)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') { throw 'Run this on the Windows gateway computer. Nothing was changed.' }
if ($Apply -and $PurgeData -and $DataDeletionConfirmation -cne 'DELETE GATEWAY DATA') {
    throw 'Data deletion requires -DataDeletionConfirmation "DELETE GATEWAY DATA". This erases unsent photographs too.'
}
$target = Join-Path $env:ProgramFiles 'Visilant\InSight-Gateway'
$data = Join-Path $env:ProgramData 'Visilant'
$taskName = 'Visilant InSight-Gateway'
$program = Join-Path $target 'runtime\node.exe'
$shortcut = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Gateway Setup.url'

# Never follow a junction or symbolic link into another application's files.
function Assert-NoLinkedParents([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw ('Refusing a linked path: ' + $current + '. Ask IT to inspect it.')
            }
        }
        $current = Split-Path -Parent $current
    }
}
function Assert-NoLinkedChildren([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    foreach ($item in Get-ChildItem -LiteralPath $Path -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Refusing a linked item: ' + $item.FullName) }
        if ($item.PSIsContainer) { Assert-NoLinkedChildren $item.FullName }
    }
}
Assert-NoLinkedParents $target
Assert-NoLinkedParents $data
Assert-NoLinkedParents $shortcut
if (Test-Path -LiteralPath $target) {
    if (-not (Test-Path -LiteralPath (Join-Path $target 'manifest.json')) -or
        -not (Test-Path -LiteralPath (Join-Path $target 'run.ps1'))) {
        throw 'The application folder is not a recognized gateway installation. Ask IT to inspect it before deletion.'
    }
    Assert-NoLinkedChildren $target
}
if ($PurgeData) { Assert-NoLinkedChildren $data }

if ($Apply) {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Open PowerShell or Git Bash as Administrator, then run the same command.'
    }
}
# Enumerate first: access errors must stop cleanup, not masquerade as an absent task.
$task = @(Get-ScheduledTask | Where-Object { $_.TaskName -eq $taskName -and $_.TaskPath -eq '\' })
$expectedArguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $target 'run.ps1') + '"'
foreach ($entry in $task) {
    if (@($entry.Actions).Count -ne 1 -or $entry.Actions[0].Arguments -ne $expectedArguments -or
        [IO.Path]::GetFileName($entry.Actions[0].Execute) -ne 'powershell.exe') {
        throw 'The gateway startup task has an unexpected action. Ask IT to inspect it before removal.'
    }
}
$rules = @(Get-NetFirewallRule | Where-Object { $_.DisplayName -eq $taskName })
foreach ($rule in $rules) {
    if (($rule | Get-NetFirewallApplicationFilter).Program -ne $program) {
        throw 'The named firewall rule belongs to a different program. Ask IT to inspect it.'
    }
}
if (Test-Path -LiteralPath $shortcut) {
    if ((Get-Content -LiteralPath $shortcut -Raw) -notmatch '(?m)^URL=http://127\.0\.0\.1:8081/?\s*$') {
        throw 'Gateway Setup.url has an unexpected destination. Ask IT to inspect it.'
    }
}
Write-Host ('Application to remove: ' + $target)
Write-Host ('Startup task and firewall rule: ' + $taskName)
Write-Host ('Shortcut: ' + $shortcut)
if ($PurgeData) {
    Write-Host ('PERMANENTLY DELETE settings, accounts, logs and all queued photographs: ' + $data)
} else {
    Write-Host ('Preserve all saved data: ' + $data)
}
if (-not $Apply) { Write-Host 'Preview only. Nothing was changed. Add -Apply to perform these actions.'; exit 0 }

# Disable restart before stopping the launcher. Kill only this installation's runtime.
foreach ($entry in $task) {
    $entry | Disable-ScheduledTask | Out-Null
    $entry | Stop-ScheduledTask
}
$runtimePrefix = (Join-Path $target 'runtime') + '\'
foreach ($process in Get-CimInstance Win32_Process) {
    if ($process.ExecutablePath -and $process.ExecutablePath.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        $live = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
        if ($live -and $live.Path -and $live.Path.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)) {
            $live | Stop-Process -Force
            if (-not $live.WaitForExit(15000)) { throw 'A gateway runtime process did not stop. No data was deleted. Ask IT to stop it before retrying.' }
        }
    }
}
foreach ($entry in $task) { $entry | Unregister-ScheduledTask -Confirm:$false }
foreach ($rule in $rules) { $rule | Remove-NetFirewallRule }
if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force }
if ($PurgeData -and (Test-Path -LiteralPath $data)) { Remove-Item -LiteralPath $data -Recurse -Force }
Write-Host 'Gateway installation removed. Source checkouts and shared tools were left in place.'
if (-not $PurgeData) {
    Write-Host 'Saved data remains. Reinstallation must use the documented backup/repair procedure; setup does not overwrite retained data.'
} else {
    Write-Host 'Saved gateway data was deleted. Run windows\setup.ps1 for a fresh installation.'
}

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location (Join-Path $PSScriptRoot 'application')
$env:PATH = (Join-Path $PSScriptRoot 'runtime\dcmtk\bin') + ';' + (Join-Path $PSScriptRoot 'runtime\imagemagick') + ';' + $env:PATH
$env:GATEWAY_SETUP_DIR = Join-Path $env:ProgramData 'Visilant'
# Log folder passed to the launcher as GATEWAY_LOG_DIR. The launcher writes launcher.log
# and the gateway child writes gateway.log there, each rotating at 5 MB x 5 files.
# Same ACL as the data folder: SYSTEM and Administrators only.
$logDir = Join-Path $env:ProgramData 'Visilant\logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
& icacls.exe $logDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not protect the gateway log folder. Preserve the data folder and contact the administrator.' }
$env:GATEWAY_LOG_DIR = $logDir
# Keep the firewall rule on the port saved by the setup wizard. The installer creates it
# for 8080 before the wizard runs, so a different port is applied here at the next start.
# A firewall problem must never stop the gateway: record it and continue.
$firewallScript = Join-Path $PSScriptRoot 'firewall.ps1'
if (Test-Path -LiteralPath $firewallScript) {
    try {
        . $firewallScript
        $firewallPort = Get-GatewayListenPort -DataFolder $env:GATEWAY_SETUP_DIR
        $firewallResult = Set-GatewayFirewallRule -RuleName 'Visilant InSight-Gateway' -Program (Join-Path $PSScriptRoot 'runtime\node.exe') -Port $firewallPort
        if ($firewallResult -ne 'correct') {
            Add-Content -LiteralPath (Join-Path $logDir 'firewall.log') -Value ((Get-Date).ToString('o') + ' Firewall rule ' + $firewallResult + ' for TCP port ' + $firewallPort + ' from the local subnet.') -ErrorAction SilentlyContinue
        }
    } catch {
        Add-Content -LiteralPath (Join-Path $logDir 'firewall.log') -Value ((Get-Date).ToString('o') + ' Firewall rule could not be checked: ' + $_.Exception.Message + ' Phones may be blocked. Run Gateway.cmd as administrator to repair it.') -ErrorAction SilentlyContinue
    }
}
$env:GATEWAY_MANAGED_STARTUP = '1'
$build = Get-Content (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
$env:GATEWAY_BUILD_ID = $build.source_commit + ' / ' + $build.built_at
# Resolve packaged tools explicitly; inherited per-user overrides must not select a
# different executable when Task Scheduler runs as SYSTEM.
foreach ($tool in @('echoscu','findscu','storescu','img2dcm','dcm2json','dcmdump','dcmodify')) {
    [Environment]::SetEnvironmentVariable(($tool.ToUpperInvariant() + '_BIN'), (Join-Path $PSScriptRoot "runtime\dcmtk\bin\$tool.exe"), 'Process')
}
$env:MAGICK_BIN = Join-Path $PSScriptRoot 'runtime\imagemagick\magick.exe'
# An installer build of ImageMagick finds its coders through registry keys this box does
# not have. Point it at the bundled folders; a portable build ignores these.
$env:MAGICK_CODER_MODULE_PATH = Join-Path $PSScriptRoot 'runtime\imagemagick\modules\coders'
$env:MAGICK_FILTER_MODULE_PATH = Join-Path $PSScriptRoot 'runtime\imagemagick\modules\filters'
$env:MAGICK_CONFIGURE_PATH = Join-Path $PSScriptRoot 'runtime\imagemagick'
& (Join-Path $PSScriptRoot 'runtime\node.exe') (Join-Path $PSScriptRoot 'application\build\src\setup\launcher.js')
exit $LASTEXITCODE

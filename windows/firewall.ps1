# Shared firewall rule logic. Dot-sourced by install.ps1 (install and re-run) and by
# run.ps1 (every start), so the rule always follows the port saved in config.json.
# Must run elevated. Defines functions only; it has no side effects when loaded.

function Get-GatewayListenPort {
    param([Parameter(Mandatory=$true)][string]$DataFolder)
    # The setup wizard writes listen_port to config.json in the data folder. Before the
    # wizard has saved settings there is no file, and the wizard default of 8080 applies.
    $configFile = Join-Path $DataFolder 'config.json'
    if (-not (Test-Path -LiteralPath $configFile)) { return 8080 }
    $port = 0
    try { $port = [int](Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json).listen_port } catch { $port = 0 }
    if ($port -lt 1 -or $port -gt 65535 -or $port -eq 8081) {
        throw 'The saved gateway port is invalid. Preserve the data folder and ask the administrator to check config.json.'
    }
    return $port
}

# Returns 'correct', 'created' or 'replaced'.
function Set-GatewayFirewallRule {
    param(
        [Parameter(Mandatory=$true)][string]$RuleName,
        [Parameter(Mandatory=$true)][string]$Program,
        [Parameter(Mandatory=$true)][int]$Port
    )
    $rules = @(Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue)
    $correct = $false
    if ($rules.Count -eq 1) {
        $rule = $rules[0]
        $portFilter = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule
        $localPorts = @($portFilter.LocalPort)
        $addresses = @((Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $rule).RemoteAddress)
        $ruleProgram = [string](Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $rule).Program
        $ruleProfile = [string]$rule.Profile
        $profileOk = ($ruleProfile -eq 'Any') -or (($ruleProfile -match 'Domain') -and ($ruleProfile -match 'Private') -and ($ruleProfile -match 'Public'))
        $correct = ([string]$rule.Enabled -eq 'True') -and ([string]$rule.Direction -eq 'Inbound') -and ([string]$rule.Action -eq 'Allow') -and
            ([string]$portFilter.Protocol -eq 'TCP') -and ($localPorts.Count -eq 1) -and ([string]$localPorts[0] -eq [string]$Port) -and
            ($addresses.Count -eq 1) -and ([string]$addresses[0] -eq 'LocalSubnet') -and
            ($ruleProgram -eq $Program) -and $profileOk
    }
    if ($correct) { return 'correct' }
    if ($rules.Count -gt 0) { Remove-NetFirewallRule -DisplayName $RuleName }
    # Scope: this node.exe only, TCP on the gateway port only, from the local subnet only.
    # The Public profile is included on purpose. Hospital LANs on non-domain PCs are often
    # classed as Public by Windows, and without it phones on the ward are silently blocked.
    # The LocalSubnet and port limits are what keep that inclusion narrow.
    New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Program $Program -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet -Profile Domain,Private,Public -Action Allow | Out-Null
    if ($rules.Count -eq 0) { return 'created' }
    return 'replaced'
}

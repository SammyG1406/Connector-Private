param(
    [Parameter(Mandatory = $true)]
    [int]$ParentPid
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PowerState {
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
"@

$ES_CONTINUOUS = [uint32]::Parse("80000000", [System.Globalization.NumberStyles]::HexNumber)
$ES_SYSTEM_REQUIRED = [uint32]1

$result = [PowerState]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
if ($result -eq 0) {
    Write-Error "SetThreadExecutionState failed"
    exit 1
}
Write-Host "Sleep prevention active (PID $PID), watching parent PID $ParentPid."

# Poll for the parent's death rather than relying on being told to stop —
# a forceful kill (Task Manager, crash, terminal.dispose()) gives the parent
# no chance to run cleanup code, so this process must notice on its own.
while ($true) {
    Start-Sleep -Seconds 5
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
        Write-Host "Parent process $ParentPid gone; releasing sleep prevention and exiting."
        [PowerState]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
        exit 0
    }
}

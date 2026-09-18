# L3 step 1: silent install of 4.3.0 in a clean guest (no parameters; run via guest-run.ps1).
# NOTE: this file must stay pure ASCII -- the guest reads .ps1 as ANSI when there is no BOM,
# so any non-ASCII character would break string literals and fail to parse.
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }

$Installer = 'C:\Users\tester\fufumidi-guest\setup-4.3.0.exe'
Say 'pkg.path' $Installer
Say 'pkg.exists' (Test-Path $Installer)
if (-not (Test-Path $Installer)) { Say 'error' 'installer missing in guest'; Say 'done' '0'; exit 2 }
Say 'pkg.size' (Get-Item $Installer).Length

# before install: a clean baseline must have no FuFumidi
$before = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'),
  (Join-Path $env:ProgramFiles 'FuFumidi')
) | Where-Object { Test-Path (Join-Path $_ 'FuFumidi.exe') }
Say 'before.installedCount' @($before).Count

# offline check (NIC link is disabled from the host side for this step)
$net = Test-Connection -ComputerName 223.5.5.5 -Count 1 -Quiet -ErrorAction SilentlyContinue
Say 'offline.verified' (-not $net)

# NSIS silent install (/S must be uppercase); -Wait waits for the real process to exit
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru -Wait
Say 'installer.exitCode' $p.ExitCode
Say 'installer.elapsedSec' ([math]::Round($sw.Elapsed.TotalSeconds, 1))

Start-Sleep -Seconds 8
$inst = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'),
  (Join-Path $env:ProgramFiles 'FuFumidi')
) | Where-Object { Test-Path (Join-Path $_ 'FuFumidi.exe') } | Select-Object -First 1
Say 'after.installed' ($null -ne $inst)
if ($inst) {
  Say 'after.dir' $inst
  Say 'after.version' (Get-Item (Join-Path $inst 'FuFumidi.exe')).VersionInfo.ProductVersion
}
Say 'done' '1'
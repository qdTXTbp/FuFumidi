# L3 step 1: silent install of 5.2.3 in a clean guest (host disables the NIC first).
# Pure ASCII only -- the guest reads .ps1 as ANSI when there is no BOM.
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }

# (ascii-only note)
# and it keeps working with the guest NIC link disabled (offline install assertion).
$Installer = '\\vboxsvr\packages\FuFumidi\5.2.3\FuFumidi-Setup-5.2.3.exe'
Say 'pkg.path' $Installer
Say 'pkg.exists' (Test-Path $Installer)
if (-not (Test-Path $Installer)) { Say 'error' 'installer missing in guest'; Say 'done' '0'; exit 2 }
Say 'pkg.size' (Get-Item $Installer).Length
Say 'pkg.sha256' (Get-FileHash $Installer -Algorithm SHA256).Hash

$before = @((Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'), (Join-Path $env:ProgramFiles 'FuFumidi')) | Where-Object { Test-Path (Join-Path $_ 'FuFumidi.exe') }
Say 'before.installedCount' @($before).Count

# offline check: the host sets linkstate1 off for this step
$net = Test-Connection -ComputerName 223.5.5.5 -Count 1 -Quiet -ErrorAction SilentlyContinue
Say 'offline.verified' (-not $net)

$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru -Wait
Say 'installer.exitCode' $p.ExitCode
Say 'installer.elapsedSec' ([math]::Round($sw.Elapsed.TotalSeconds, 1))
Start-Sleep -Seconds 10

$inst = @((Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'), (Join-Path $env:ProgramFiles 'FuFumidi')) | Where-Object { Test-Path (Join-Path $_ 'FuFumidi.exe') } | Select-Object -First 1
Say 'after.installed' ($null -ne $inst)
if ($inst) {
  Say 'after.dir' $inst
  Say 'after.version' (Get-Item (Join-Path $inst 'FuFumidi.exe')).VersionInfo.ProductVersion
}
Say 'done' '1'
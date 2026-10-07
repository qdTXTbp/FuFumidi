# L3 step 1 (beta channel): OFFLINE silent install of the current beta build in a clean guest.
# Pure ASCII only -- the guest reads .ps1 as ANSI when there is no BOM.
# The package is published by the host into the shared folder 'packages' (E:\Midi\<pkg> -> a drive letter in the guest).
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }

# find the shared folder drive (auto-mount letter can vary)
$share = $null
foreach ($d in (Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Free -ne $null })) {
  $p = Join-Path $d.Root 'FuFumidi'
  if (Test-Path $p) { $share = $p; break }
}
Say 'share.path' ($(if ($share) { $share } else { 'NOT_FOUND' }))
if (-not $share) { Say 'error' 'shared folder not mounted'; Say 'done' '0'; exit 2 }

$setup = @(Get-ChildItem -Path $share -Recurse -Filter 'FuFumidi Setup *.exe' -ErrorAction SilentlyContinue |
           Sort-Object LastWriteTime -Descending | Select-Object -First 1)
Say 'pkg.source' ($(if ($setup) { $setup.FullName } else { 'NOT_FOUND' }))
if (-not $setup) { Say 'error' 'no installer in shared folder'; Say 'done' '0'; exit 2 }
Say 'pkg.version' ($setup.VersionInfo.ProductVersion)
Say 'pkg.size' ($setup[0].Length)
Say 'pkg.sha256' (Get-FileHash $setup.FullName -Algorithm SHA256).Hash

# before install: a clean baseline must have no FuFumidi
$before = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'),
  (Join-Path $env:ProgramFiles 'FuFumidi')
) | Where-Object { Test-Path (Join-Path $_ 'FuFumidi.exe') }
Say 'before.installedCount' @($before).Count

# offline check (NIC link is disabled from the host side for this step)
$net = Test-Connection -ComputerName 223.5.5.5 -Count 1 -Quiet -ErrorAction SilentlyContinue
Say 'offline.verified' (-not $net)

# copy locally first: installing straight off a shared folder is slow and can stall
$dst = 'C:\Users\' + $env:USERNAME + '\fufumidi-guest\setup-under-test.exe'
$cp = [Diagnostics.Stopwatch]::StartNew()
Copy-Item -LiteralPath $setup.FullName -Destination $dst -Force
Say 'copy.elapsedSec' ([math]::Round($cp.Elapsed.TotalSeconds, 1))
Say 'local.sha256' (Get-FileHash $dst -Algorithm SHA256).Hash

$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $dst -ArgumentList '/S' -PassThru -Wait
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

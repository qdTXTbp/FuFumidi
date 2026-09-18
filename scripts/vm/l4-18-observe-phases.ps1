# L4: observe a real upgrade in three phases and report ground truth.
#   A) wait until the main app is gone (the updater terminates it)
#   B) wait until the updater exits on its own (file replacement done)
#   C) wait to see whether the app comes back WITHOUT any user action
# Pure ASCII only.
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }
function AppN { return @(Get-CimInstance Win32_Process -Filter "Name='FuFumidi.exe'" -ErrorAction SilentlyContinue).Count }
function UpdN { return @(Get-CimInstance Win32_Process -Filter "Name='FuFumidi.update.exe'" -ErrorAction SilentlyContinue).Count }

$inst = Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'
$t0 = Get-Date
function T { return [math]::Round(((Get-Date) - $t0).TotalSeconds, 1) }

# A) app must disappear
$phaseA = $false
for ($i = 0; $i -lt 48; $i++) {
  if ((AppN) -eq 0) { $phaseA = $true; break }
  Start-Sleep -Seconds 5
}
Say 'A.appGone' $phaseA
Say 'A.atSec' (T)

# B) updater must exit on its own
$phaseB = $false
$sawUpdater = $false
for ($i = 0; $i -lt 120; $i++) {
  $u = UpdN
  if ($u -gt 0) { $sawUpdater = $true }
  if ($sawUpdater -and $u -eq 0) { $phaseB = $true; break }
  Start-Sleep -Seconds 5
}
Say 'B.sawUpdater' $sawUpdater
Say 'B.updaterExited' $phaseB
Say 'B.atSec' (T)

# C) does the app come back by itself?
$phaseC = $false
for ($i = 0; $i -lt 36; $i++) {
  if ((AppN) -gt 0) { $phaseC = $true; break }
  Start-Sleep -Seconds 5
}
Say 'C.appCameBack' $phaseC
Say 'C.atSec' (T)
$withCdp = @(Get-CimInstance Win32_Process -Filter "Name='FuFumidi.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*remote-debugging-port*' }).Count
Say 'C.appCountWithCdp' $withCdp

# ground truth
Say 'version.after' (Get-Item (Join-Path $inst 'FuFumidi.exe')).VersionInfo.ProductVersion
Say 'asar.bytes' (Get-Item (Join-Path $inst 'resources\app.asar')).Length
Say 'updater.sha256.after' (Get-FileHash (Join-Path $inst 'FuFumidi.update.exe') -Algorithm SHA256).Hash
$marker = Join-Path $inst 'FuFumidiData\cache\l4-keep-marker.txt'
$blob = Join-Path $inst 'FuFumidiData\midi\l4-dummy-song.mid'
Say 'data.marker.txt.preserved' (Test-Path $marker)
Say 'data.marker.txt.content' ($(if (Test-Path $marker) { (Get-Content $marker -Raw).Trim() } else { 'MISSING' }))
Say 'data.marker.mid.bytes' ($(if (Test-Path $blob) { (Get-Item $blob).Length } else { 0 }))
Say 'data.fileCount' (@(Get-ChildItem (Join-Path $inst 'FuFumidiData') -Recurse -File -ErrorAction SilentlyContinue).Count)
$log = Join-Path $inst 'FuFumidiData\temp\fufumidi-restart.log'
if (Test-Path $log) { Say 'guard.log' ((Get-Content $log -Raw).Trim() -replace "`r?`n", ' | ') } else { Say 'guard.log' 'MISSING (expected on pre-4.3.0 sources)' }
Say 'done' '1'
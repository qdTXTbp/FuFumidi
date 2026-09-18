# L4: after the updater finished, look for evidence of the auto-restart daemon.
# Pure ASCII only.
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }

$inst = Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'
Say 'version' (Get-Item (Join-Path $inst 'FuFumidi.exe')).VersionInfo.ProductVersion
Say 'proc.FuFumidi' (@(Get-CimInstance Win32_Process -Filter "Name='FuFumidi.exe'" -ErrorAction SilentlyContinue).Count)
Say 'proc.updater' (@(Get-CimInstance Win32_Process -Filter "Name='FuFumidi.update.exe'" -ErrorAction SilentlyContinue).Count)
$ps = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*fufumidi-restart*' })
Say 'proc.restartDaemon' $ps.Count

$daemon = Join-Path $inst 'FuFumidiData\temp\fufumidi-restart.ps1'
Say 'daemon.file' (Test-Path $daemon)
if (Test-Path $daemon) { Say 'daemon.bytes' (Get-Item $daemon).Length; Say 'daemon.mtime' (Get-Item $daemon).LastWriteTime }

# kachina updater staging dir: it downloads into FuFumidiData\temp\fufumidi-update
$upd = Join-Path $inst 'FuFumidiData\temp\fufumidi-update'
Say 'updater.staging.dir' (Test-Path $upd)
if (Test-Path $upd) { Say 'updater.staging.entries' ((Get-ChildItem $upd -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ',') }

# app.asar must be the 4.3.0 one
Say 'asar.bytes' (Get-Item (Join-Path $inst 'resources\app.asar')).Length
Say 'updater.sha256' (Get-FileHash (Join-Path $inst 'FuFumidi.update.exe') -Algorithm SHA256).Hash
Say 'engine.present' (Test-Path (Join-Path $inst 'resources\app.asar.unpacked\engine\music2midi.py'))
Say 'python.present' (Test-Path (Join-Path $inst 'resources\python\python.exe'))
Say 'done' '1'
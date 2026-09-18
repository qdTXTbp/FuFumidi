# L4: poll the guard log for 60s to see whether the daemon ever starts (and whether it dies).
# Pure ASCII only.
$ErrorActionPreference = 'Continue'
$inst = Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'
$log = Join-Path $inst 'FuFumidiData\temp\fufumidi-restart.log'
if (Test-Path $log) { Remove-Item $log -Force }
$t0 = Get-Date
$events = @()
$seenAt = $null
$lastLen = -1
for ($i = 0; $i -lt 30; $i++) {
  $exists = Test-Path $log
  $len = 0
  if ($exists) { $len = (Get-Item $log).Length }
  $el = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
  $ps = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*fufumidi-restart*' }).Count
  $upd = @(Get-CimInstance Win32_Process -Filter "Name='FuFumidi.update.exe'" -ErrorAction SilentlyContinue).Count
  $app = @(Get-CimInstance Win32_Process -Filter "Name='FuFumidi.exe'" -ErrorAction SilentlyContinue).Count
  if ($exists -and $seenAt -eq $null) { $seenAt = $el; $events += ('+' + $el + 's log出现 ps=' + $ps + ' updater=' + $upd + ' app=' + $app) }
  if ($exists -and $len -ne $lastLen) { $events += ('+' + $el + 's log.len=' + $len + ' ps=' + $ps) ; $lastLen = $len }
  $events += ('+' + $el + 's ps=' + $ps + ' updater=' + $upd + ' app=' + $app)
  Start-Sleep -Seconds 2
}
'events:'
$events -join [Environment]::NewLine
'log.seenAtSec = ' + $seenAt
if (Test-Path $log) { 'log.content = ' + ((Get-Content $log -Raw).Trim() -replace "`r?`n", ' | ') } else { 'log.content = MISSING' }
'done = 1'
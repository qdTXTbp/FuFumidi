# L4: after launchUpdater, emulate the user closing the updater window (the kachina window
# stays open in this VM) and verify the guard brings the main app back by itself.
# The app started by the guard has no --remote-debugging-port, which is how we tell it apart.
# Pure ASCII only.
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }

$inst = Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'
$log = Join-Path $inst 'FuFumidiData\temp\fufumidi-restart.log'
$t0 = Get-Date
$last = ''
$changes = @()
$restarted = $false
$killedUpdater = $false
for ($i = 0; $i -lt 60; $i++) {
  $upd = @(Get-CimInstance Win32_Process -Filter "Name='FuFumidi.update.exe'" -ErrorAction SilentlyContinue).Count
  $app = @(Get-CimInstance Win32_Process -Filter "Name='FuFumidi.exe'" -ErrorAction SilentlyContinue)
  $appN = $app.Count
  $withCdp = @($app | Where-Object { $_.CommandLine -like '*remote-debugging-port*' }).Count
  $el = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
  $state = 'updater=' + $upd + ' app=' + $appN + ' cdp=' + $withCdp
  if ($state -ne $last) { $changes += ('+' + $el + 's ' + $state); $last = $state }
  # steal the updater window after 90s (emulates the user closing it)
  if ($upd -gt 0 -and -not $killedUpdater -and $el -gt 90) {
    Get-Process FuFumidi.update -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    $killedUpdater = $true
    $changes += ('+' + $el + 's killed updater (emulating window close)')
  }
  if ($upd -eq 0 -and $appN -gt 0 -and $withCdp -eq 0 -and $killedUpdater) { $restarted = $true; break }
  Start-Sleep -Seconds 5
}
Say 'timeline' ($changes -join ' | ')
Say 'restarted.afterUpdaterClosed' $restarted
Say 'elapsedSec' ([math]::Round(((Get-Date) - $t0).TotalSeconds, 1))
Say 'version' (Get-Item (Join-Path $inst 'FuFumidi.exe')).VersionInfo.ProductVersion
if (Test-Path $log) { Say 'guard.log' ((Get-Content $log -Raw).Trim() -replace "`r?`n", ' | ') } else { Say 'guard.log' 'MISSING' }
Say 'done' '1'
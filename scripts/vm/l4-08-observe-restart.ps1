# L4: watch the auto-restart daemon after launchUpdater was triggered.
# Records a timeline of (updater running?, app running?, app started by daemon?) until the app
# comes back without --remote-debugging-port (== started by the guard). Pure ASCII only.
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }

$t0 = Get-Date
$last = ''
$changes = @()
$restartedByDaemon = $false
for ($i = 0; $i -lt 180; $i++) {
  $upd = @(Get-CimInstance Win32_Process -Filter "Name='FuFumidi.update.exe'" -ErrorAction SilentlyContinue).Count
  $app = @(Get-CimInstance Win32_Process -Filter "Name='FuFumidi.exe'" -ErrorAction SilentlyContinue)
  $appN = $app.Count
  $withCdp = @($app | Where-Object { $_.CommandLine -like '*remote-debugging-port*' }).Count
  $state = 'updater=' + $upd + ' app=' + $appN + ' cdp=' + $withCdp
  if ($state -ne $last) {
    $changes += ('+' + [math]::Round(((Get-Date) - $t0).TotalSeconds, 1) + 's ' + $state)
    $last = $state
  }
  if ($upd -eq 0 -and $appN -gt 0 -and $withCdp -eq 0) { $restartedByDaemon = $true; break }
  Start-Sleep -Seconds 5
}
Say 'timeline' ($changes -join ' | ')
Say 'restarted.byDaemon' $restartedByDaemon
Say 'elapsedSec' ([math]::Round(((Get-Date) - $t0).TotalSeconds, 1))
$daemon = Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi\FuFumidiData\temp\fufumidi-restart.ps1'
if (Test-Path $daemon) {
  $txt = Get-Content $daemon -Raw
  Say 'daemon.hasAppearWait' ($txt -like '*appeared*')
  Say 'daemon.bytes' (Get-Item $daemon).Length
}
Say 'done' '1'
# L4: close the lingering updater window, restart the updated app with CDP and report its version.
# Pure ASCII only.
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }

Get-Process FuFumidi.update -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process FuFumidi -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 6

$inst = Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'
$exe = Join-Path $inst 'FuFumidi.exe'
Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=9222'
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 3
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 3 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { }
}
Say 'cdp.ready' $ok
if ($ok) {
  $v = (Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/version' -UseBasicParsing).Content | ConvertFrom-Json
  Say 'cdp.ua' $v.'User-Agent'
}
Say 'proc.count' (@(Get-CimInstance Win32_Process -Filter "Name='FuFumidi.exe'" -ErrorAction SilentlyContinue).Count)
Say 'done' '1'
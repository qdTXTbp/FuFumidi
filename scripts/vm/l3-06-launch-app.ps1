# L3: first launch of the installed app with a CDP endpoint, so the host can drive it
# through the reverse tunnel. Pure ASCII only.
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }

$inst = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'),
  (Join-Path $env:ProgramFiles 'FuFumidi')
) | Where-Object { Test-Path (Join-Path $_ 'FuFumidi.exe') } | Select-Object -First 1
$exe = Join-Path $inst 'FuFumidi.exe'
Say 'exe' $exe

$running = @(Get-CimInstance Win32_Process -Filter "Name='FuFumidi.exe'" | Where-Object { $_.CommandLine -like '*remote-debugging-port*' })
if ($running.Count -eq 0) {
  Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=9222'
  Say 'launched' 'yes'
} else {
  Say 'launched' 'already-running'
}

$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 3
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 3 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { }
}
Say 'cdp.ready' $ok
if ($ok) {
  $pages = (Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json' -TimeoutSec 5 -UseBasicParsing).Content | ConvertFrom-Json
  Say 'cdp.pageCount' (@($pages | Where-Object { $_.type -eq 'page' }).Count)
}
Start-Sleep -Seconds 10
$p = Join-Path $inst 'FuFumidiData'
Say 'data.dir.exists' (Test-Path $p)
if (Test-Path $p) { Say 'data.subdirs' ((Get-ChildItem $p -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ',') }
Say 'done' '1'
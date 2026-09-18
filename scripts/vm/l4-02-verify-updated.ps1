# L4 step 2: verify the in-app update actually landed on 4.3.0 and the user data survived.
# Pure ASCII only.
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }

$inst = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'),
  (Join-Path $env:ProgramFiles 'FuFumidi')
) | Where-Object { Test-Path (Join-Path $_ 'FuFumidi.exe') } | Select-Object -First 1
Say 'install.dir' $inst
$exe = Join-Path $inst 'FuFumidi.exe'
Say 'version.after' (Get-Item $exe).VersionInfo.ProductVersion
Say 'asar.bytes' (Get-Item (Join-Path $inst 'resources\app.asar')).Length
Say 'updater.sha256' (Get-FileHash (Join-Path $inst 'FuFumidi.update.exe') -Algorithm SHA256).Hash

# user data must be intact
$data = Join-Path $inst 'FuFumidiData'
$marker = Join-Path $data 'cache\l4-keep-marker.txt'
$blob = Join-Path $data 'midi\l4-dummy-song.mid'
Say 'data.exists' (Test-Path $data)
Say 'marker.txt.preserved' (Test-Path $marker)
Say 'marker.txt.content' ($(if (Test-Path $marker) { (Get-Content $marker -Raw).Trim() } else { 'MISSING' }))
Say 'marker.mid.preserved' (Test-Path $blob)
Say 'marker.mid.bytes' ($(if (Test-Path $blob) { (Get-Item $blob).Length } else { 0 }))
Say 'data.fileCount' (@(Get-ChildItem $data -Recurse -File -ErrorAction SilentlyContinue).Count)
Say 'data.dirs' ((Get-ChildItem $data -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ',')

# leftover updater staging must not survive
Say 'temp.staging' (@(Get-ChildItem (Join-Path $inst 'FuFumidiData\temp') -Filter 'fufumidi-update' -ErrorAction SilentlyContinue).Count)
Say 'stray.updaterProcess' (@(Get-CimInstance Win32_Process -Filter "Name='FuFumidi.update.exe'" -ErrorAction SilentlyContinue).Count)

# relaunch the updated app with CDP so the runtime can be checked too
Get-Process FuFumidi -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ($inst + '*') } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=9222'
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 3
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 3 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { }
}
Say 'relaunch.cdp.ready' $ok
if ($ok) { Say 'relaunch.version' ((Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/version' -UseBasicParsing).Content | ConvertFrom-Json).Browser }
Say 'done' '1'
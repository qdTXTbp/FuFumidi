# L4 (beta channel) step 1: install the PREVIOUS published beta (5.0.0-beta.1), plant data markers.
# Pure ASCII only. Installer is taken from the host shared folder.
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }

$share = $null
foreach ($d in (Get-PSDrive -PSProvider FileSystem)) {
  $p = Join-Path $d.Root 'FuFumidi\5.0.0-beta.1'
  if (Test-Path $p) { $share = $p; break }
}
Say 'pkg.dir' ($(if ($share) { $share } else { 'NOT_FOUND' }))
if (-not $share) { Say 'done' '0'; exit 2 }
$setup = @(Get-ChildItem -Path $share -Filter 'FuFumidi Setup *.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1)[0]
Say 'pkg.path' $setup.FullName
Say 'pkg.size' $setup.Length
Say 'pkg.sha256' (Get-FileHash $setup.FullName -Algorithm SHA256).Hash

$dst = Join-Path $env:TEMP 'setup-old-beta.exe'
Copy-Item -LiteralPath $setup.FullName -Destination $dst -Force
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $dst -ArgumentList '/S' -PassThru -Wait
Say 'installer.exitCode' $p.ExitCode
Say 'installer.elapsedSec' ([math]::Round($sw.Elapsed.TotalSeconds, 1))
Start-Sleep -Seconds 8

$inst = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'),
  (Join-Path $env:ProgramFiles 'FuFumidi')
) | Where-Object { Test-Path (Join-Path $_ 'FuFumidi.exe') } | Select-Object -First 1
Say 'install.dir' ($(if ($inst) { $inst } else { 'NOT_FOUND' }))
if (-not $inst) { Say 'done' '0'; exit 2 }
Say 'pre.asar.sha256' (Get-FileHash (Join-Path $inst 'resources\app.asar') -Algorithm SHA256).Hash
Say 'pre.asar.bytes' (Get-Item (Join-Path $inst 'resources\app.asar')).Length
Say 'pre.updater.sha256' (Get-FileHash (Join-Path $inst 'FuFumidi.update.exe') -Algorithm SHA256).Hash

# first launch (creates FuFumidiData) and leave it running: the updater must replace files of a RUNNING app
Start-Process -FilePath (Join-Path $inst 'FuFumidi.exe') -ArgumentList '--remote-debugging-port=9222'
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 3
  try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 3 -UseBasicParsing; if ($r.StatusCode -eq 200) { $ok = $true; break } } catch { }
}
Say 'cdp.ready' $ok
Start-Sleep -Seconds 5

$data = Join-Path $inst 'FuFumidiData'
New-Item -ItemType Directory -Force -Path (Join-Path $data 'cache') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $data 'midi') | Out-Null
Set-Content -LiteralPath (Join-Path $data 'cache\l4-keep-marker.txt') -Value 'fufumidi-l4-keep-marker' -Encoding ASCII
[System.IO.File]::WriteAllBytes((Join-Path $data 'midi\l4-dummy-song.mid'), (New-Object byte[] 2048))
Say 'data.exists' (Test-Path $data)
Say 'data.fileCount' (@(Get-ChildItem $data -Recurse -File -ErrorAction SilentlyContinue).Count)
Say 'marker.txt.exists' (Test-Path (Join-Path $data 'cache\l4-keep-marker.txt'))
Say 'marker.mid.bytes' (Get-Item (Join-Path $data 'midi\l4-dummy-song.mid')).Length
Say 'app.processCount' (@(Get-CimInstance Win32_Process -Filter "Name='FuFumidi.exe'" -ErrorAction SilentlyContinue).Count)
Say 'done' '1'

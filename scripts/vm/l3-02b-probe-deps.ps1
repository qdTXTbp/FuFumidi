# L3: factory dependency probe (six engines) + launch the app for the CDP UI walkthrough.
# Pure ASCII only.
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }
$inst = @((Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'), (Join-Path $env:ProgramFiles 'FuFumidi')) | Where-Object { Test-Path (Join-Path $_ 'FuFumidi.exe') } | Select-Object -First 1
Say 'install.dir' $inst
$py = Join-Path $inst 'resources\python\python.exe'
$midi = Join-Path $inst 'resources\app.asar.unpacked\engine\music2midi.py'
Say 'probe.python' (Test-Path $py)
Say 'probe.script' (Test-Path $midi)
if ((Test-Path $py) -and (Test-Path $midi)) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $out = & $py $midi probe 2>&1 | Out-String
  Say 'probe.elapsedSec' ([math]::Round($sw.Elapsed.TotalSeconds, 1))
  $out -split "`n" | ForEach-Object { if ($_.Trim()) { Write-Output ('probe| ' + $_.Trim()) } }
}

# launch with CDP so the host can drive the UI through the reverse tunnel
$exe = Join-Path $inst 'FuFumidi.exe'
$running = @(Get-CimInstance Win32_Process -Filter "Name='FuFumidi.exe'" | Where-Object { $_.CommandLine -like '*remote-debugging-port*' })
if ($running.Count -eq 0) { Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=9222'; Say 'launched' 'yes' } else { Say 'launched' 'already-running' }
$ok = $false
for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Seconds 3; try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 3 -UseBasicParsing; if ($r.StatusCode -eq 200) { $ok = $true; break } } catch { } }
Say 'cdp.ready' $ok
Say 'version' (Get-Item $exe).VersionInfo.ProductVersion
Say 'done' '1'

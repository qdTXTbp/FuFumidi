# L4: install the rebuilt 4.3.0 (guard fix) over the existing install and relaunch with CDP.
# Pure ASCII only.
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }

Get-Process FuFumidi,FuFumidi.update -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 5

$setup = 'C:\Users\tester\fufumidi-guest\setup-4.3.0-fix4.exe'
Say 'setup.exists' (Test-Path $setup)
Say 'setup.size' (Get-Item $setup).Length
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $setup -ArgumentList '/S' -PassThru -Wait
Say 'installer.exitCode' $p.ExitCode
Say 'installer.elapsedSec' ([math]::Round($sw.Elapsed.TotalSeconds, 1))
Start-Sleep -Seconds 8

$inst = Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'
$exe = Join-Path $inst 'FuFumidi.exe'
Say 'version' (Get-Item $exe).VersionInfo.ProductVersion
Say 'asar.bytes' (Get-Item (Join-Path $inst 'resources\app.asar')).Length
Say 'updater.sha256' (Get-FileHash (Join-Path $inst 'FuFumidi.update.exe') -Algorithm SHA256).Hash
Say 'data.exists' (Test-Path (Join-Path $inst 'FuFumidiData'))
Say 'data.fileCount' (@(Get-ChildItem (Join-Path $inst 'FuFumidiData') -Recurse -File -ErrorAction SilentlyContinue).Count)

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
Say 'done' '1'
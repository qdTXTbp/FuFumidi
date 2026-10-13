# L4 step 1: install the previous release (5.0.1) in a clean guest and plant data markers.
# Pure ASCII only -- the guest reads .ps1 as ANSI when there is no BOM.
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }

$setup = '\\vboxsvr\packages\FuFumidi\5.0.1\FuFumidi-Setup-5.0.1.exe'
Say 'pkg.exists' (Test-Path $setup)
if (-not (Test-Path $setup)) { Say 'error' 'installer missing'; Say 'done' '0'; exit 2 }
Say 'pkg.size' (Get-Item $setup).Length
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $setup -ArgumentList '/S' -PassThru -Wait
Say 'installer.exitCode' $p.ExitCode
Say 'installer.elapsedSec' ([math]::Round($sw.Elapsed.TotalSeconds, 1))
Start-Sleep -Seconds 10
$inst = @((Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'), (Join-Path $env:ProgramFiles 'FuFumidi')) | Where-Object { Test-Path (Join-Path $_ 'FuFumidi.exe') } | Select-Object -First 1
Say 'install.dir' $inst
if (-not $inst) { Say 'done' '0'; exit 2 }
Say 'version.installed' (Get-Item (Join-Path $inst 'FuFumidi.exe')).VersionInfo.ProductVersion
Say 'pre.asar.sha256' (Get-FileHash (Join-Path $inst 'resources\app.asar') -Algorithm SHA256).Hash

# markers: data must survive the update
$data = Join-Path $inst 'FuFumidiData'
$marker = Join-Path $data 'cache\l4-keep-marker.txt'
New-Item -ItemType Directory -Force -Path (Split-Path $marker) | Out-Null
Set-Content -LiteralPath $marker -Value 'fufumidi-l4-keep-marker' -Encoding ASCII
$song = Join-Path $data 'midi\l4-dummy-song.mid'
New-Item -ItemType Directory -Force -Path (Split-Path $song) | Out-Null
[IO.File]::WriteAllBytes($song, (New-Object byte[] 2048))
Say 'marker.written' (Test-Path $marker)
Say 'data.before.fileCount' (@(Get-ChildItem $data -Recurse -File -ErrorAction SilentlyContinue).Count)

# launch the old version so the update replaces a RUNNING app (this is the real upgrade path)
Start-Process -FilePath (Join-Path $inst 'FuFumidi.exe') -ArgumentList '--remote-debugging-port=9222'
$ok = $false
for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Seconds 3; try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 3 -UseBasicParsing; if ($r.StatusCode -eq 200) { $ok = $true; break } } catch { } }
Say 'old.cdp.ready' $ok
Say 'done' '1'
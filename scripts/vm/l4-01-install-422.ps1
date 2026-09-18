# L4 step 1: install the previous release (4.2.2) in a clean guest, then plant data markers
# so the post-update check can prove the data survived. Pure ASCII only.
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }

$setup = 'C:\Users\tester\fufumidi-guest\setup-4.2.2.exe'
Say 'pkg.path' $setup
Say 'pkg.exists' (Test-Path $setup)
if (-not (Test-Path $setup)) { Say 'error' 'installer missing'; Say 'done' '0'; exit 2 }
Say 'pkg.size' (Get-Item $setup).Length

$before = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'),
  (Join-Path $env:ProgramFiles 'FuFumidi')
) | Where-Object { Test-Path (Join-Path $_ 'FuFumidi.exe') }
Say 'before.installedCount' @($before).Count

$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $setup -ArgumentList '/S' -PassThru -Wait
Say 'installer.exitCode' $p.ExitCode
Say 'installer.elapsedSec' ([math]::Round($sw.Elapsed.TotalSeconds, 1))
Start-Sleep -Seconds 8

$inst = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'),
  (Join-Path $env:ProgramFiles 'FuFumidi')
) | Where-Object { Test-Path (Join-Path $_ 'FuFumidi.exe') } | Select-Object -First 1
Say 'install.dir' $inst
if (-not $inst) { Say 'done' '0'; exit 2 }
Say 'version.installed' (Get-Item (Join-Path $inst 'FuFumidi.exe')).VersionInfo.ProductVersion
Say 'updater.exists' (Test-Path (Join-Path $inst 'FuFumidi.update.exe'))
Say 'updater.sha256' (Get-FileHash (Join-Path $inst 'FuFumidi.update.exe') -Algorithm SHA256).Hash
Say 'asar.bytes' (Get-Item (Join-Path $inst 'resources\app.asar')).Length

# first launch so FuFumidiData is created, then plant markers
Start-Process -FilePath (Join-Path $inst 'FuFumidi.exe') -ArgumentList '--remote-debugging-port=9222'
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 3
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 3 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { }
}
Say 'cdp.ready' $ok
Start-Sleep -Seconds 12

$data = Join-Path $inst 'FuFumidiData'
Say 'data.dir' $data
Say 'data.exists' (Test-Path $data)
$marker = Join-Path $data 'cache\l4-keep-marker.txt'
New-Item -ItemType Directory -Force -Path (Split-Path $marker) | Out-Null
Set-Content -LiteralPath $marker -Value 'keep-me-across-update' -Encoding ASCII
# also drop a bigger marker so "the updater really swapped files, not the whole dir" is visible
$blob = Join-Path $data 'midi\l4-dummy-song.mid'
New-Item -ItemType Directory -Force -Path (Split-Path $blob) | Out-Null
$bytes = New-Object byte[] 4096
for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [byte](($i * 7) % 251) }
[IO.File]::WriteAllBytes($blob, $bytes)
Say 'marker.txt' (Test-Path $marker)
Say 'marker.mid' (Test-Path $blob)
Say 'data.fileCount' (@(Get-ChildItem $data -Recurse -File -ErrorAction SilentlyContinue).Count)
Say 'data.dirs' ((Get-ChildItem $data -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ',')
Say 'done' '1'
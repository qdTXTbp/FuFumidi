# L4 step 2: upgrade the running 5.0.1 to 5.1.0 and verify data survived.
# Pure ASCII only -- the guest reads .ps1 as ANSI when there is no BOM.
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }

$inst = @((Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'), (Join-Path $env:ProgramFiles 'FuFumidi')) | Where-Object { Test-Path (Join-Path $_ 'FuFumidi.exe') } | Select-Object -First 1
Say 'install.dir' $inst
if (-not $inst) { Say 'done' '0'; exit 2 }
$data = Join-Path $inst 'FuFumidiData'
Say 'pre.version' (Get-Item (Join-Path $inst 'FuFumidi.exe')).VersionInfo.ProductVersion
Say 'pre.asar.sha256' (Get-FileHash (Join-Path $inst 'resources\app.asar') -Algorithm SHA256).Hash
Say 'pre.data.fileCount' (@(Get-ChildItem $data -Recurse -File -ErrorAction SilentlyContinue).Count)

$setup = '\\vboxsvr\packages\FuFumidi\5.1.0\FuFumidi-Setup-5.1.0.exe'
Say 'pkg.exists' (Test-Path $setup)
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $setup -ArgumentList '/S' -PassThru -Wait
Say 'installer.exitCode' $p.ExitCode
Say 'installer.elapsedSec' ([math]::Round($sw.Elapsed.TotalSeconds, 1))
Start-Sleep -Seconds 12

Say 'post.version' (Get-Item (Join-Path $inst 'FuFumidi.exe')).VersionInfo.ProductVersion
Say 'post.asar.sha256' (Get-FileHash (Join-Path $inst 'resources\app.asar') -Algorithm SHA256).Hash
Say 'post.data.fileCount' (@(Get-ChildItem $data -Recurse -File -ErrorAction SilentlyContinue).Count)
$marker = Join-Path $data 'cache\l4-keep-marker.txt'
Say 'marker.survived' (Test-Path $marker)
if (Test-Path $marker) { Say 'marker.content' (Get-Content -LiteralPath $marker -Raw).Trim() }
$song = Join-Path $data 'midi\l4-dummy-song.mid'
Say 'song.survived' (Test-Path $song)
if (Test-Path $song) { Say 'song.bytes' (Get-Item $song).Length }
Say 'done' '1'
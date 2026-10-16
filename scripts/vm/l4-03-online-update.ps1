# L4 (post-release): install 5.0.1, then run the SHIPPED updater against the live release
# (CNB latest anchor) exactly like main/update.js does: FiFumidi.update.exe -I -O --source <id>.
# Pure ASCII only.
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }

$setup = '\\vboxsvr\packages\FuFumidi\5.0.1\FuFumidi-Setup-5.0.1.exe'
Say 'pkg.exists' (Test-Path $setup)
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $setup -ArgumentList '/S' -PassThru -Wait
Say 'install.exitCode' $p.ExitCode
Say 'install.elapsedSec' ([math]::Round($sw.Elapsed.TotalSeconds, 1))
Start-Sleep -Seconds 10
$inst = Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'
$exe = Join-Path $inst 'FuFumidi.exe'
Say 'pre.version' (Get-Item $exe).VersionInfo.ProductVersion
Say 'pre.asar.sha256' (Get-FileHash (Join-Path $inst 'resources\app.asar') -Algorithm SHA256).Hash
$data = Join-Path $inst 'FuFumidiData'
Say 'pre.data.fileCount' (@(Get-ChildItem $data -Recurse -File -ErrorAction SilentlyContinue).Count)

# the updater replaces files of a running app, so leave it closed for this run
Get-Process FuFumidi,FuFumidi.update -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 5
$upd = Join-Path $inst 'FuFumidi.update.exe'
Say 'updater.exists' (Test-Path $upd)
Say 'updater.sha256' (Get-FileHash $upd -Algorithm SHA256).Hash
# same args as main/update.js; cnb = the stable CNB source id in build/kachina.config.json
$sw2 = [Diagnostics.Stopwatch]::StartNew()
$u = Start-Process -FilePath $upd -ArgumentList '-I','-O','--source','cnb' -WorkingDirectory $inst -PassThru -Wait
Say 'updater.exitCode' $u.ExitCode
Say 'updater.elapsedSec' ([math]::Round($sw2.Elapsed.TotalSeconds, 1))
Start-Sleep -Seconds 15

Say 'post.version' (Get-Item $exe).VersionInfo.ProductVersion
Say 'post.asar.sha256' (Get-FileHash (Join-Path $inst 'resources\app.asar') -Algorithm SHA256).Hash
Say 'post.data.fileCount' (@(Get-ChildItem $data -Recurse -File -ErrorAction SilentlyContinue).Count)
Say 'done' '1'

# L3: inspect what survived the uninstall, then install into a path with spaces + CJK chars.
# NOTE: pure ASCII only. The CJK path is built from code points so this file stays ASCII.
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }

$old = Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'
Say 'leftover.dir.exists' (Test-Path $old)
if (Test-Path $old) {
  $files = @(Get-ChildItem $old -Recurse -File -ErrorAction SilentlyContinue)
  Say 'leftover.fileCount' $files.Count
  Say 'leftover.topEntries' ((Get-ChildItem $old -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ',')
  $res = Join-Path $old 'resources'
  if (Test-Path $res) {
    Say 'leftover.resources.entries' ((Get-ChildItem $res -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ',')
    Say 'leftover.resources.fileCount' (@(Get-ChildItem $res -Recurse -File -ErrorAction SilentlyContinue).Count)
  }
  # python processes kept alive by the engine can hold resources\python open
  Say 'stray.pythonProcesses' (@(Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue).Count)
}

# CJK target dir: C:\<ce shi> <mu lu>\FuFumidi   (spaces + CJK in both segments)
$cn1 = [string][char]0x6D4B + [string][char]0x8BD5    # ce shi
$cn2 = [string][char]0x76EE + [string][char]0x5F55    # mu lu
$dest = 'C:\' + $cn1 + ' ' + $cn2 + '\FuFumidi'
Say 'cn.dest' $dest

$setup = 'C:\Users\tester\fufumidi-guest\setup-4.3.0.exe'
Say 'setup.exists' (Test-Path $setup)
# NSIS: /D must be last and must NOT be quoted (it swallows the rest of the command line),
# so the whole argument list is passed as one verbatim string.
$args = '/S /D=' + $dest
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $setup -ArgumentList $args -PassThru -Wait
Say 'installer.exitCode' $p.ExitCode
Say 'installer.elapsedSec' ([math]::Round($sw.Elapsed.TotalSeconds, 1))
Start-Sleep -Seconds 8

$exe = Join-Path $dest 'FuFumidi.exe'
Say 'cn.exe.exists' (Test-Path $exe)
if (Test-Path $exe) { Say 'cn.version' (Get-Item $exe).VersionInfo.ProductVersion }
Say 'cn.data.exists' (Test-Path (Join-Path $dest 'FuFumidiData'))
Say 'cn.update.exists' (Test-Path (Join-Path $dest 'FuFumidi.update.exe'))
Say 'cn.shortcut.desktop' (Test-Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'FuFumidi.lnk'))
$sm = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
Say 'cn.shortcut.startMenu.count' (@(Get-ChildItem $sm -Recurse -Filter 'FuFumidi*.lnk' -ErrorAction SilentlyContinue).Count)

# first launch from the CJK path
if (Test-Path $exe) {
  Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=9222'
  $ok = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 3
    try {
      $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 3 -UseBasicParsing
      if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch { }
  }
  Say 'cn.cdp.ready' $ok
  Start-Sleep -Seconds 10
  $dp = Join-Path $dest 'FuFumidiData'
  Say 'cn.data.exists.afterLaunch' (Test-Path $dp)
  if (Test-Path $dp) { Say 'cn.data.subdirs' ((Get-ChildItem $dp -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ',') }
}
Say 'done' '1'
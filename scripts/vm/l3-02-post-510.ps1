# L3 step 2: asset integrity / shortcuts / registry / data dir / factory dependency probe.
# Pure ASCII only -- the guest reads .ps1 as ANSI when there is no BOM.
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }

$inst = @((Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'), (Join-Path $env:ProgramFiles 'FuFumidi')) | Where-Object { Test-Path (Join-Path $_ 'FuFumidi.exe') } | Select-Object -First 1
Say 'install.dir' $inst
if (-not $inst) { Say 'done' '0'; exit 2 }
$exe = Join-Path $inst 'FuFumidi.exe'
Say 'version' (Get-Item $exe).VersionInfo.ProductVersion
$asar = Join-Path $inst 'resources\app.asar'
Say 'asar.exists' (Test-Path $asar)
Say 'asar.bytes' (Get-Item $asar).Length
Say 'asar.sha256' (Get-FileHash $asar -Algorithm SHA256).Hash
$unpacked = Join-Path $inst 'resources\app.asar.unpacked\engine'
Say 'engine.unpacked.exists' (Test-Path $unpacked)
Say 'engine.unpacked.dirs' (@(Get-ChildItem $unpacked -Directory -ErrorAction SilentlyContinue).Count)
# 5.1.0: the bundled mel model must be present (Worldline v20 depends on it)
$mel = Join-Path $inst 'resources\app.asar.unpacked\engine\singing\openutau\classic\data\mel.onnx'
Say 'mel.exists' (Test-Path $mel)
if (Test-Path $mel) { Say 'mel.sha256' (Get-FileHash $mel -Algorithm SHA256).Hash }
$eng = Join-Path $inst 'resources\python\python.exe'
Say 'runtime.python.exists' (Test-Path $eng)
$upd = Join-Path $inst 'FuFumidi.update.exe'
Say 'updater.exists' (Test-Path $upd)
Say 'updater.sha256' (Get-FileHash $upd -Algorithm SHA256).Hash
$un = Join-Path $inst 'Uninstall FuFumidi.exe'
Say 'uninstaller.exists' (Test-Path $un)

# shortcuts
$desk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'FuFumidi.lnk'
Say 'shortcut.desktop' (Test-Path $desk)
$sm = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\FuFumidi.lnk'
Say 'shortcut.startmenu' (Test-Path $sm)

# uninstall registry entry
$keys = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
$hit = Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'FuFumidi*' }
Say 'registry.entries' @($hit).Count
if ($hit) { Say 'registry.displayName' (@($hit)[0].DisplayName); Say 'registry.displayVersion' (@($hit)[0].DisplayVersion); Say 'registry.quietUninstall' (@($hit)[0].QuietUninstallString) }

# data dir
$data = Join-Path $inst 'FuFumidiData'
Say 'data.exists' (Test-Path $data)
if (Test-Path $data) { Say 'data.fileCount' (@(Get-ChildItem $data -Recurse -File -ErrorAction SilentlyContinue).Count); Say 'data.dirs' ((Get-ChildItem $data -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ',') }

# factory dependency probe (bundled runtime)
if (Test-Path $eng) {
  $py = Join-Path $inst 'resources\python\python.exe'
  $midi = Join-Path $inst 'resources\app.asar.unpacked\engine\music2midi.py'
  Say 'probe.script' (Test-Path $midi)
  if ((Test-Path $py) -and (Test-Path $midi)) {
    $out = & $py $midi probe 2>&1 | Out-String
    $out -split "`n" | Select-String -Pattern '^(###RESULT|ok|fail|universal|piano|separate|muscriptor|aria|transkun)' | ForEach-Object { Write-Output ('probe| ' + $_.Line.Trim()) }
  }
}
Say 'done' '1'
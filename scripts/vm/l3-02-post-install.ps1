# L3 step 2: post-install state checks inside the guest (no parameters; run via guest-run.ps1).
# NOTE: keep this file pure ASCII (see l3-01 for why).
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }

$inst = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'),
  (Join-Path $env:ProgramFiles 'FuFumidi')
) | Where-Object { Test-Path (Join-Path $_ 'FuFumidi.exe') } | Select-Object -First 1
Say 'install.dir' ($(if ($inst) { $inst } else { 'NOT_FOUND' }))
if (-not $inst) { Say 'done' '0'; exit 2 }

Say 'exe.version' (Get-Item (Join-Path $inst 'FuFumidi.exe')).VersionInfo.ProductVersion

# A4: bundled runtime must be present in the install dir
foreach ($p in @('resources\app.asar', 'resources\app.asar.unpacked\engine\music2midi.py',
                 'resources\python\python.exe', 'resources\rust-core', 'FuFumidi.update.exe',
                 'resources\vcredist', 'resources\models', 'resources\elevate.exe',
                 'Uninstall FuFumidi.exe')) {
  Say ('asset.' + $p) (Test-Path (Join-Path $inst $p))
}
Say 'asset.vcredist.dllCount' (@(Get-ChildItem (Join-Path $inst 'resources\vcredist') -Filter *.dll -ErrorAction SilentlyContinue).Count)

# electron-builder extraFiles takes the updater from release/update/FuFumidi.update.exe:
# the installed updater must be byte-identical to this build, otherwise the installer
# silently ships the stale updater left over from a previous build.
$upd = Join-Path $inst 'FuFumidi.update.exe'
if (Test-Path $upd) { Say 'updater.sha256' (Get-FileHash $upd -Algorithm SHA256).Hash }

# A3: shortcuts
Say 'shortcut.desktop' (Test-Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'FuFumidi.lnk'))
$sm = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
Say 'shortcut.startMenu.count' (@(Get-ChildItem $sm -Recurse -Filter 'FuFumidi*.lnk' -ErrorAction SilentlyContinue).Count)

# registry uninstall entry
$n = 0
foreach ($k in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
                 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
                 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
  $n += @(Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*FuFumidi*' }).Count
}
Say 'registry.uninstallEntries' $n

# B: user data dir must live under the install dir, not on C:
$data = Join-Path $inst 'FuFumidiData'
Say 'data.dir' $data
Say 'data.dir.exists' (Test-Path $data)
if (Test-Path $data) {
  Say 'data.subdirs' ((Get-ChildItem $data -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ',')
}
foreach ($p in @((Join-Path $env:USERPROFILE '.cache'),
                 (Join-Path $env:LOCALAPPDATA 'pip\cache'),
                 (Join-Path $env:USERPROFILE '.matplotlib'))) {
  $c = 0
  if (Test-Path $p) { $c = @(Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue).Count }
  Say ('cdisk.' + $p + '.fileCount') $c
}

# dependency self-check with the bundled python
$py = Join-Path $inst 'resources\python\python.exe'
$eng = Join-Path $inst 'resources\app.asar.unpacked\engine'
if ((Test-Path $py) -and (Test-Path (Join-Path $eng 'music2midi.py'))) {
  $job = Start-Job -ScriptBlock {
    param($py, $eng)
    Set-Location $eng
    $env:PYTHONPATH = $eng
    & $py (Join-Path $eng 'music2midi.py') probe 2>$null
  } -ArgumentList $py, $eng
  if (Wait-Job $job -Timeout 420) { $out = Receive-Job $job } else { $out = 'PROBE_TIMEOUT' }
  Remove-Job $job -Force -ErrorAction SilentlyContinue
  $json = ($out | Out-String)
  Say 'probe.raw.length' $json.Length
  foreach ($m in @('universal', 'piano', 'separate', 'muscriptor', 'aria', 'transkun')) {
    $r = [regex]::Match($json, '"' + $m + '"\s*:\s*\{[^}]*"available"\s*:\s*(true|false)')
    Say ('probe.engine.' + $m) ($(if ($r.Success) { $r.Groups[1].Value } else { 'NOMATCH' }))
  }
  foreach ($lib in @('numpy', 'librosa', 'soundfile', 'pretty_midi', 'scipy', 'onnxruntime', 'torch', 'basic_pitch', 'demucs')) {
    $r = [regex]::Match($json, '"' + $lib + '"\s*:\s*(null|"[^"]*")')
    Say ('probe.lib.' + $lib) ($(if ($r.Success) { $r.Groups[1].Value } else { 'NOMATCH' }))
  }
  $r = [regex]::Match($json, '"gpu"\s*:\s*\{[^}]*"available"\s*:\s*(true|false)')
  Say 'probe.gpu.available' ($(if ($r.Success) { $r.Groups[1].Value } else { 'NOMATCH' }))
  $r = [regex]::Match($json, '"recommended"\s*:\s*"([^"]*)"')
  Say 'probe.perf.recommended' ($(if ($r.Success) { $r.Groups[1].Value } else { 'NOMATCH' }))
} else {
  Say 'probe' 'SKIPPED_NO_PYTHON_OR_ENGINE'
}

$os = Get-CimInstance Win32_OperatingSystem
Say 'os' ($os.Caption + ' build ' + $os.BuildNumber)
Say 'network.online' (Test-Connection -ComputerName 223.5.5.5 -Count 1 -Quiet -ErrorAction SilentlyContinue)
Say 'done' '1'
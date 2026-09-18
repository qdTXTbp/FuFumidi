# L3: silent uninstall must keep user data (FuFumidiData) and remove program files.
# NOTE: pure ASCII only (see l3-01 for why).
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }

$inst = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'),
  (Join-Path $env:ProgramFiles 'FuFumidi')
) | Where-Object { Test-Path (Join-Path $_ 'FuFumidi.exe') } | Select-Object -First 1
Say 'install.dir' $inst
$data = Join-Path $inst 'FuFumidiData'
# plant a marker inside the data dir so retention is provable (not "the dir happened to stay")
$marker = Join-Path $data 'cache\l3-keep-marker.txt'
New-Item -ItemType Directory -Force -Path (Split-Path $marker) | Out-Null
Set-Content -LiteralPath $marker -Value 'keep-me-across-uninstall' -Encoding ASCII
Say 'marker.written' (Test-Path $marker)
Say 'data.before.exists' (Test-Path $data)
Say 'data.before.fileCount' (@(Get-ChildItem $data -Recurse -File -ErrorAction SilentlyContinue).Count)
Say 'data.before.dirs' ((Get-ChildItem $data -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ',')

# close the app first, otherwise the uninstaller cannot delete its files
Get-Process FuFumidi -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 4

$un = Join-Path $inst 'Uninstall FuFumidi.exe'
Say 'uninstaller.exists' (Test-Path $un)
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $un -ArgumentList '/S' -PassThru -Wait
Say 'uninstaller.exitCode' $p.ExitCode
Say 'uninstaller.elapsedSec' ([math]::Round($sw.Elapsed.TotalSeconds, 1))
Start-Sleep -Seconds 6

Say 'after.dir.exists' (Test-Path $inst)
Say 'after.exe.exists' (Test-Path (Join-Path $inst 'FuFumidi.exe'))
Say 'after.data.exists' (Test-Path $data)
Say 'after.data.fileCount' (@(Get-ChildItem $data -Recurse -File -ErrorAction SilentlyContinue).Count)
Say 'after.data.dirs' ((Get-ChildItem $data -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ',')
Say 'after.marker.preserved' (Test-Path $marker)
if (Test-Path $inst) { Say 'after.dir.entries' ((Get-ChildItem $inst -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ',') }

# cleanup of shortcuts / registry
Say 'after.shortcut.desktop' (Test-Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'FuFumidi.lnk'))
$n = 0
foreach ($k in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
                 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
                 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
  $n += @(Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*FuFumidi*' }).Count
}
Say 'after.registry.uninstallEntries' $n
Say 'done' '1'
# L3 step 0: verify the host shared folder is reachable from the guest (so installers need no copy).
# Pure ASCII only.
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }
$share = '\\vboxsvr\packages'
Say 'share.path' $share
Say 'share.exists' (Test-Path $share)
if (Test-Path $share) {
  Say 'share.top' ((Get-ChildItem $share -ErrorAction SilentlyContinue | Select-Object -First 8 | ForEach-Object { $_.Name }) -join ',')
  $f = Join-Path $share 'FuFumidi\5.0.1\FuFumidi-Setup-5.0.1.exe'
  Say 'share.setup501.exists' (Test-Path $f)
  if (Test-Path $f) { Say 'share.setup501.size' (Get-Item $f).Length }
}
Say 'guest.user' $env:USERNAME
Say 'guest.os' (Get-CimInstance Win32_OperatingSystem).Caption
Say 'guest.ram.gb' ([math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1))
Say 'guest.disk.free.gb' ([math]::Round((Get-PSDrive C).Free / 1GB, 1))
$def = 'n/a'
try { $def = (Get-MpPreference).DisableRealtimeMonitoring } catch { }
Say 'guest.defender.realtime' $def
$dn = 'n/a'
try { $dn = (Get-ChildItem 'C:\Windows\Microsoft.NET\Framework64' -Directory -ErrorAction SilentlyContinue | Select-Object -Last 1).Name } catch { }
Say 'guest.dotnet' $dn
Say 'done' '1'

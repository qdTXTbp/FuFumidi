# L4 (beta channel) step 3: same update, but over the DEFAULT domestic path (CNB mirror).
# L4 (beta channel) step 2: trigger the incremental update to 5.0.0-beta.2 and verify the result.
# Pure ASCII only.
#
# NOTE: the updater is launched exactly like main/update.js does it (guard daemon +
#       FuFumidi.update.exe -I -O --source <mirror>), because this test runs without the UI.
#       cnb-beta == https://cnb.cool/FuFuCloud-mirror/FuFuMIDI/-/releases/download/beta/FuFumidi.Install.exe
#       (source id list lives in Build/kachina.config.json).
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }

# clean leftovers from the previous attempt (updater + app), so the replacement is not blocked
Get-Process -Name 'FuFumidi.update' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name 'FuFumidi' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 4
$expectedAsar = 'EE65AB9B8BF9A0F3BBE064E2AB5FCB3D90F513BC576730E06FB673FADADC2ED0'
$inst = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'),
  (Join-Path $env:ProgramFiles 'FuFumidi')
) | Where-Object { Test-Path (Join-Path $_ 'FuFumidi.exe') } | Select-Object -First 1
Say 'install.dir' ($(if ($inst) { $inst } else { 'NOT_FOUND' }))
if (-not $inst) { Say 'done' '0'; exit 2 }
Say 'pre.asar.sha256' (Get-FileHash (Join-Path $inst 'resources\app.asar') -Algorithm SHA256).Hash
Say 'pre.data.fileCount' (@(Get-ChildItem (Join-Path $inst 'FuFumidiData') -Recurse -File -ErrorAction SilentlyContinue).Count)

$guard = Join-Path $env:TEMP 'l4-guard.ps1'
$glog  = Join-Path $env:TEMP 'l4-guard.log'
$exe   = Join-Path $inst 'FuFumidi.exe'
$asar  = Join-Path $inst 'resources\app.asar'
$lines = @(
  '$procName = ''FuFumidi.update''',
  ('$log = ''{0}''' -f $glog),
  'function L($m) { try { Add-Content -LiteralPath $log -Value ((Get-Date).ToString(''HH:mm:ss'') + '' '' + $m) } catch {} }',
  'L ''[guard] start''',
  '$t0 = (Get-Date); $appeared = $false',
  'while ((Get-Date) -lt $t0.AddSeconds(90)) { if (Get-Process -Name $procName -ErrorAction SilentlyContinue) { $appeared = $true; break }; Start-Sleep -Milliseconds 500 }',
  'L (''updater appeared='' + $appeared)',
  'if ($appeared) { $dl = (Get-Date).AddSeconds(1800); while (Get-Process -Name $procName -ErrorAction SilentlyContinue) { if ((Get-Date) -gt $dl) { L ''wait timeout''; break }; Start-Sleep -Seconds 1 }; L ''updater exited'' }',
  'Start-Sleep -Seconds 3',
  ('$asar = ''{0}''' -f $asar),
  '$t0 = (Get-Date); $last = -1; $stable = 0',
  'while ((Get-Date) -lt $t0.AddSeconds(60)) { $st = Get-Item $asar -ErrorAction SilentlyContinue; if ($st -and $st.Length -eq $last -and $st.Length -gt 1048576) { $stable = 1; break }; if ($st) { $last = $st.Length }; Start-Sleep -Seconds 1 }',
  'L (''asar stable='' + $stable + '' size='' + $last)',
  ('Start-Process -FilePath ''{0}'' -ArgumentList ''--remote-debugging-port=9222''' -f $exe),
  'L ''relaunched''',
  ''
)
Set-Content -LiteralPath $guard -Value $lines -Encoding ASCII
Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $guard) -WindowStyle Hidden
Start-Sleep -Seconds 5
Say 'guard.started' (Test-Path $guard)

Start-Process -FilePath (Join-Path $inst 'FuFumidi.update.exe') -ArgumentList @('-I', '-O', '--source', 'cnb-beta')
Say 'updater.launched' $true

$ok = $false
for ($i = 0; $i -lt 420; $i++) {
  Start-Sleep -Seconds 5
  $h = (Get-FileHash $asar -Algorithm SHA256 -ErrorAction SilentlyContinue).Hash
  if ($h -eq $expectedAsar) { $ok = $true; break }
}
Say 'post.asar.matches.new' $ok
Say 'post.asar.sha256' ((Get-FileHash $asar -Algorithm SHA256 -ErrorAction SilentlyContinue).Hash)
Say 'post.asar.bytes' ((Get-Item $asar -ErrorAction SilentlyContinue).Length)
Say 'post.updater.sha256' ((Get-FileHash (Join-Path $inst 'FuFumidi.update.exe') -Algorithm SHA256 -ErrorAction SilentlyContinue).Hash)
Start-Sleep -Seconds 20
Say 'guard.log' ((Get-Content $glog -ErrorAction SilentlyContinue) -join ' | ')
Say 'app.processCount' (@(Get-CimInstance Win32_Process -Filter "Name='FuFumidi.exe'" -ErrorAction SilentlyContinue).Count)
Say 'updater.processCount' (@(Get-CimInstance Win32_Process -Filter "Name='FuFumidi.update.exe'" -ErrorAction SilentlyContinue).Count)
$data = Join-Path $inst 'FuFumidiData'
Say 'data.fileCount' (@(Get-ChildItem $data -Recurse -File -ErrorAction SilentlyContinue).Count)
Say 'marker.txt.preserved' (Test-Path (Join-Path $data 'cache\l4-keep-marker.txt'))
Say 'marker.txt.content' ($(if (Test-Path (Join-Path $data 'cache\l4-keep-marker.txt')) { (Get-Content (Join-Path $data 'cache\l4-keep-marker.txt') -Raw).Trim() } else { 'MISSING' }))
Say 'marker.mid.bytes' ((Get-Item (Join-Path $data 'midi\l4-dummy-song.mid') -ErrorAction SilentlyContinue).Length)
Say 'done' '1'

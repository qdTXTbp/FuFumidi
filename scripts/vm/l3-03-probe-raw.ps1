# L3: dump the raw dependency self-check JSON from the guest so the engine keys can be read verbatim.
# NOTE: pure ASCII only.
$ErrorActionPreference = 'Continue'
$inst = Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'
$py = Join-Path $inst 'resources\python\python.exe'
$eng = Join-Path $inst 'resources\app.asar.unpacked\engine'
$job = Start-Job -ScriptBlock {
  param($py, $eng)
  Set-Location $eng
  $env:PYTHONPATH = $eng
  & $py (Join-Path $eng 'music2midi.py') probe 2>$null
} -ArgumentList $py, $eng
if (Wait-Job $job -Timeout 420) { $out = Receive-Job $job } else { $out = 'PROBE_TIMEOUT' }
Remove-Job $job -Force -ErrorAction SilentlyContinue
Write-Output '---BEGIN-JSON---'
$out | Out-String | Write-Output
Write-Output '---END-JSON---'
Write-Output 'done = 1'
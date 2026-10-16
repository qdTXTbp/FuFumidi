# Host side orchestrator: L4 incremental upgrade for 5.1.0 (install 5.0.1 -> upgrade to 5.1.0 -> verify data survived).
param(
  [string]$VmName = 'FuFumidiTest',
  [string]$OutDir = 'E:\Midi\_attic\_sing_tmp\vm-510'
)
$ErrorActionPreference = 'Continue'

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
function Step([string]$name, [string]$script) {
  Write-Host ("==> " + $name) -ForegroundColor Cyan
  $out = Join-Path $OutDir ($name + ".txt")
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "guest-run.ps1") -ScriptPath (Join-Path $PSScriptRoot $script) -VmName $VmName *>&1 | Tee-Object -FilePath $out | ForEach-Object { Write-Host ("    " + $_) }
}
Write-Host "==== FuFumidi 5.1.0 L4 增量升级 ====" -ForegroundColor Cyan
Step "l4-01-install-501" "l4-01-install-501.ps1" | Out-Null
Step "l4-02-upgrade-510" "l4-02-upgrade-510.ps1" | Out-Null
Write-Host ""
Write-Host "==== 关键断言 ====" -ForegroundColor Cyan
foreach ($kv in @("version.installed", "old.cdp.ready", "pre.version", "post.version", "marker.survived", "marker.content", "song.survived", "song.bytes", "pre.data.fileCount", "post.data.fileCount")) {
  $hit = (Select-String -Path (Join-Path $OutDir "l4-*.txt") -Pattern ("^" + [regex]::Escape($kv) + " = ") | Select-Object -Last 1)
  if ($hit) { Write-Host ("  " + $hit.Line) }
}

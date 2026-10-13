# Host side orchestrator: the L3 release gate for 5.1.0 (fresh install -> post-install -> launch -> uninstall).
# Each step runs the guest script through guest-run.ps1 and its raw output is saved under _attic for the report.
# Usage: $env:FUFUMIDI_VM_PASSWORD=...; powershell -File scripts/vm/run-l3-510.ps1
param(
  [string]$VmName = 'FuFumidiTest',
  [string]$OutDir = 'E:\Midi\_attic\_sing_tmp\vm-510'
)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path $root)) { $root = 'E:\Midi\FuFumidi-Source' }
$vbox = 'C:\Program Files\Oracle\VirtualBox\VBoxManage.exe'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$fail = 0
function Step([string]$name, [string]$script) {
  Write-Host ("==> " + $name) -ForegroundColor Cyan
  $out = Join-Path $OutDir ($name + ".txt")
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "guest-run.ps1") -ScriptPath (Join-Path $PSScriptRoot $script) -VmName $VmName *>&1 | Tee-Object -FilePath $out | ForEach-Object { Write-Host ("    " + $_) }
  $txt = Get-Content $out -Raw
  if ($txt -notmatch "done = 1") { Write-Host ("    [失败] " + $name + " 未报告 done = 1") -ForegroundColor Red; $script:fail++ }
  return $txt
}

Write-Host "==== FuFumidi 5.1.0 L3 发布闸门 ====" -ForegroundColor Cyan

# A 断网静默安装：先摘掉 guest 的网卡链路，装完再挂回来
Write-Host "==> 关闭 guest 网卡链路（断网安装断言）" -ForegroundColor Cyan
& $vbox controlvm $VmName setlinkstate1 off 2>&1 | Out-Null
Start-Sleep -Seconds 3
$a = Step "l3-01-install" "l3-01-install-510.ps1"
Write-Host "==> 恢复 guest 网卡链路" -ForegroundColor Cyan
& $vbox controlvm $VmName setlinkstate1 on 2>&1 | Out-Null
Start-Sleep -Seconds 5

$b = Step "l3-02-post" "l3-02-post-510.ps1"
$c = Step "l3-03-launch" "l3-06-launch-app.ps1"
$d = Step "l3-04-uninstall" "l3-07-uninstall-keep-data.ps1"

Write-Host ""
Write-Host "==== 关键断言 ====" -ForegroundColor Cyan
foreach ($kv in @("offline.verified", "installer.exitCode", "after.version", "mel.exists", "updater.sha256", "registry.entries", "cdp.ready", "data.before.fileCount", "marker.survived", "after.exe.exists")) {
  $hit = (Select-String -Path (Join-Path $OutDir "*.txt") -Pattern ("^" + [regex]::Escape($kv) + " = ") | Select-Object -Last 1)
  if ($hit) { Write-Host ("  " + $hit.Line) }
}
Write-Host ""
Write-Host ("失败步骤数: " + $fail) -ForegroundColor $(if ($fail -gt 0) { "Red" } else { "Green" })
Write-Host ("证据目录: " + $OutDir)

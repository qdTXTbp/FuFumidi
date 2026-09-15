# ============================================================
# 结束一轮测试：关闭测试虚拟机
# 用法: powershell -ExecutionPolicy Bypass -File scripts/vm/stop-test-vm.ps1
# 可选: -VmName FuFumidiTest  -Revert（关闭后再回滚到基线，下次可直接用）
# ============================================================
param(
  [string]$VmName   = 'FuFumidiTest',
  [string]$SnapName = 'clean-baseline',
  [switch]$Revert
)

$ErrorActionPreference = 'Stop'
function Step($m) { Write-Host ("`n==> " + $m) -ForegroundColor Cyan }
function Info($m) { Write-Host ("    " + $m) }
function Die($m)  { Write-Host ("[失败] " + $m) -ForegroundColor Red; exit 1 }

$VBox = 'C:\Program Files\Oracle\VirtualBox\VBoxManage.exe'
if (-not (Test-Path $VBox)) { $c = Get-Command VBoxManage -ErrorAction SilentlyContinue; if ($c) { $VBox = $c.Source } else { Die "找不到 VBoxManage.exe" } }

$running = (& $VBox list runningvms 2>&1 | Out-String)
if ($running -notmatch [regex]::Escape('"' + $VmName + '"')) {
  Info ($VmName + " 未在运行")
} else {
  Step "关闭 " + $VmName
  Info "发送 ACPI 关机（等价于按电源键，让系统正常退出）…"
  & $VBox controlvm $VmName acpipowerbutton | Out-Null
  $ok = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    if (((& $VBox list runningvms 2>&1 | Out-String)) -notmatch [regex]::Escape('"' + $VmName + '"')) { $ok = $true; break }
  }
  if (-not $ok) { Info "ACPI 超时，强制断电"; & $VBox controlvm $VmName poweroff | Out-Null; Start-Sleep -Seconds 5 }
  Info "已关闭"
}

if ($Revert) {
  Step "回滚到 " + $SnapName
  & $VBox snapshot $VmName restore $SnapName | Out-Null
  Info "已回滚，虚拟机停在干净基线（下次启动即为干净环境）"
}

Write-Host "`n完成。" -ForegroundColor Green

# ============================================================
# 开始一轮测试：把测试虚拟机回滚到干净基线并启动
# 每轮全功能测试都必须先跑这个脚本（见 docs/TESTING.md 第 0 节）。
#
# 用法: powershell -ExecutionPolicy Bypass -File scripts/vm/reset-test-vm.ps1
# 可选: -VmName FuFumidiTest  -SnapName clean-baseline  -Headless
# ============================================================
param(
  [string]$VmName   = 'FuFumidiTest',
  [string]$SnapName = 'clean-baseline',
  [switch]$Headless
)

$ErrorActionPreference = 'Stop'
function Step($m) { Write-Host ("`n==> " + $m) -ForegroundColor Cyan }
function Info($m) { Write-Host ("    " + $m) }
function Die($m)  { Write-Host ("[失败] " + $m) -ForegroundColor Red; exit 1 }

$VBox = 'C:\Program Files\Oracle\VirtualBox\VBoxManage.exe'
if (-not (Test-Path $VBox)) { $c = Get-Command VBoxManage -ErrorAction SilentlyContinue; if ($c) { $VBox = $c.Source } else { Die "找不到 VBoxManage.exe，请先运行 deploy-test-vm.ps1" } }

Step "检查虚拟机与基线快照"
$vms = (& $VBox list vms 2>&1 | Out-String)
if ($vms -notmatch [regex]::Escape($VmName)) { Die ("虚拟机不存在: " + $VmName + "，请先运行 deploy-test-vm.ps1") }
$snaps = (& $VBox snapshot $VmName list 2>&1 | Out-String)
if ($snaps -notmatch [regex]::Escape($SnapName)) { Die ("找不到基线快照 " + $SnapName + "，请先运行 make-baseline.ps1") }
Info ($VmName + " / " + $SnapName + " 就绪")

Step "若在运行则先关机"
$running = (& $VBox list runningvms 2>&1 | Out-String)
if ($running -match [regex]::Escape('"' + $VmName + '"')) {
  Info "发送 ACPI 关机…"
  & $VBox controlvm $VmName acpipowerbutton | Out-Null
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    if (((& $VBox list runningvms 2>&1 | Out-String)) -notmatch [regex]::Escape('"' + $VmName + '"')) { break }
  }
  if (((& $VBox list runningvms 2>&1 | Out-String)) -match [regex]::Escape('"' + $VmName + '"')) {
    Info "ACPI 超时，强制断电"
    & $VBox controlvm $VmName poweroff | Out-Null
    Start-Sleep -Seconds 5
  }
  Info "已关机"
} else { Info "本来就是关机状态" }

Step "回滚到快照 " + $SnapName
& $VBox snapshot $VmName restore $SnapName | Out-Null
Info "已回滚（虚拟机磁盘恢复为干净基线）"

Step "启动虚拟机"
if ($Headless) { & $VBox startvm $VmName --type headless | Out-Null; Info "已以 headless 启动" }
else { & $VBox startvm $VmName --type gui | Out-Null; Info "已以 GUI 启动" }

Write-Host "`n当前环境 = 干净基线，可以开始测试。" -ForegroundColor Green
Write-Host "请按 docs/TESTING.md 第 3 节清单逐项验证。" -ForegroundColor Green

# ============================================================
# 创建/更新测试虚拟机基线快照 clean-baseline
# 在 Windows 11 装完、首次进入桌面、且未安装任何被测程序时执行。
# 不需要管理员权限：虚拟机注册在当前用户下，快照属用户级操作。
#
# 用法: powershell -ExecutionPolicy Bypass -File scripts/vm/make-baseline.ps1
# 可选: -VmName FuFumidiTest  -SnapName clean-baseline  -Force（已存在则删除重建）
# ============================================================
param(
  [string]$VmName   = 'FuFumidiTest',
  [string]$SnapName = 'clean-baseline',
  [switch]$Force
)

$ErrorActionPreference = 'Continue'   # 不能用 Stop：VBoxManage 会把版本横幅写到 stderr，Stop 下会被当成终止性错误
function Step($m) { Write-Host ("`n==> " + $m) -ForegroundColor Cyan }
function Info($m) { Write-Host ("    " + $m) }
function Die($m)  { Write-Host ("[失败] " + $m) -ForegroundColor Red; exit 1 }

$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
# 只有「首次安装 VirtualBox」需要管理员；打快照是当前用户级别的操作。
if (-not $elevated) { Info "当前未提权（打快照不需要管理员，继续）" }

$VBox = 'C:\Program Files\Oracle\VirtualBox\VBoxManage.exe'
if (-not (Test-Path $VBox)) { $c = Get-Command VBoxManage -ErrorAction SilentlyContinue; if ($c) { $VBox = $c.Source } else { Die "找不到 VBoxManage.exe，请先运行 deploy-test-vm.ps1" } }

Step "检查虚拟机"
$vms = (& $VBox list vms 2>&1 | Out-String)
if ($vms -notmatch [regex]::Escape($VmName)) { Die ("虚拟机不存在: " + $VmName + "，请先运行 deploy-test-vm.ps1") }
Info ($VmName + " 存在")

# 已存在快照时的处理
$snaps = (& $VBox snapshot $VmName list 2>&1 | Out-String)
if ($snaps -match [regex]::Escape($SnapName)) {
  if (-not $Force) { Die ("快照 " + $SnapName + " 已存在。确认要重建请加 -Force（会先删除旧快照）") }
  Step "删除旧快照 " + $SnapName
  & $VBox snapshot $VmName delete $SnapName | Out-Null
  Info "已删除"
}

Step "关机（确保快照是「干净关机」状态，不含运行态内存）"
$running = (& $VBox list runningvms 2>&1 | Out-String)
if ($running -match [regex]::Escape('"' + $VmName + '"')) {
  Info "发送 ACPI 关机…"
  & $VBox controlvm $VmName acpipowerbutton | Out-Null
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    $r = (& $VBox list runningvms 2>&1 | Out-String)
    if ($r -notmatch [regex]::Escape('"' + $VmName + '"')) { break }
  }
  $r = (& $VBox list runningvms 2>&1 | Out-String)
  if ($r -match [regex]::Escape('"' + $VmName + '"')) {
    Info "ACPI 关机超时，强制断电"
    & $VBox controlvm $VmName poweroff | Out-Null
    Start-Sleep -Seconds 5
  }
  Info "已关机"
} else {
  Info "本来就是关机状态"
}

Step "创建快照 " + $SnapName
& $VBox snapshot $VmName take $SnapName --description "干净 Windows 11 基线：未安装任何 FuFumidi 版本，供每轮全功能测试回滚" | Out-Null
Info "创建完成"

Step "校验"
$snaps = (& $VBox snapshot $VmName list 2>&1 | Out-String)
if ($snaps -match [regex]::Escape($SnapName)) {
  Write-Host "`n基线快照就绪：$SnapName" -ForegroundColor Green
  Write-Host "每轮测试请先运行 scripts/vm/reset-test-vm.ps1 回滚到它。" -ForegroundColor Green
} else {
  Die "快照创建后校验失败"
}

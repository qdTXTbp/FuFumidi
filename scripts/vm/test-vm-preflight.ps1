# ============================================================
# 测试虚拟机 —— 宿主机前置条件自检（无需管理员）
# 用法: powershell -ExecutionPolicy Bypass -File scripts/vm/test-vm-preflight.ps1
#      可加 -VmRoot "E:\VMs" 指定虚拟机根目录
# ============================================================
param(
  [string]$VmRoot = 'E:\VMs',
  [int]$MinFreeGB = 100
)

$ErrorActionPreference = 'Continue'
$fail = 0
function Ok($m)   { Write-Host ("  [OK]   " + $m) -ForegroundColor Green }
function Warn($m) { Write-Host ("  [警告] " + $m) -ForegroundColor Yellow }
function Bad($m)  { Write-Host ("  [失败] " + $m) -ForegroundColor Red; $script:fail++ }

Write-Host "==== FuFumidi 测试虚拟机 前置自检 ====" -ForegroundColor Cyan
Write-Host ""

# 1) 系统版本
$os = Get-CimInstance Win32_OperatingSystem
Write-Host "[1] 操作系统"
Write-Host ("      " + $os.Caption + "  build " + $os.BuildNumber)
if ($os.Caption -match '家庭版|Home') {
  Ok "家庭版可用：走第三方 hypervisor（VirtualBox），不使用 Hyper-V"
} else {
  Ok "专业版/企业版：Hyper-V 与 Windows Sandbox 也可用，但仍推荐 VirtualBox 以便统一基线"
}

# 2) 管理员权限（部署时需要）
Write-Host "[2] 管理员权限"
$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($elevated) { Ok "当前已提权" } else { Warn "当前未提权：仅「首次安装 VirtualBox」需要管理员；VirtualBox 已装好的话，部署虚拟机不需要提权" }

# 3) CPU 虚拟化
Write-Host "[3] CPU 虚拟化"
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
Write-Host ("      " + $cpu.Name)
if ($cpu.VirtualizationFirmwareEnabled) { Ok "固件已开启虚拟化（VT-x / AMD-V）" }
else { Bad "固件未开启虚拟化：请进 BIOS/UEFI 打开 SVM/VT-x，否则虚拟机会极慢或无法启动" }

$cs = Get-CimInstance Win32_ComputerSystem
if ($cs.HypervisorPresent) {
  Ok "检测到已有 hypervisor 在运行（通常是 VBS/内核隔离）——VirtualBox 7 支持这种共存，但性能略有下降"
} else {
  Ok "无既有 hypervisor 抢占"
}

# 4) 内存
Write-Host "[4] 内存"
$memGB = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
Write-Host ("      合计 " + $memGB + " GB")
if ($memGB -ge 16) { Ok "满足（虚拟机分配 8 GB）" } else { Bad "不足 16 GB：给虚拟机 8 GB 后宿主机可能吃紧" }

# 5) 磁盘
Write-Host "[5] 磁盘可用空间（虚拟机目录 $VmRoot）"
$drive = (Split-Path -Qualifier $VmRoot)
$d = Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='" + $drive + "'")
if (-not $d) {
  Bad ("找不到盘符 " + $drive + "，请用 -VmRoot 指定一个存在的盘")
} else {
  $freeGB = [math]::Round($d.FreeSpace / 1GB, 1)
  Write-Host ("      " + $drive + " 可用 " + $freeGB + " GB")
  if ($freeGB -ge $MinFreeGB) { Ok ("满足（需要 ≥ " + $MinFreeGB + " GB）") }
  else { Bad ("不足：需要 ≥ " + $MinFreeGB + " GB（虚拟机约 80 GB + ISO 约 6 GB）") }
}
Write-Host "      其余磁盘："
Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  Write-Host ("        " + $_.DeviceID + "  可用 " + [math]::Round($_.FreeSpace / 1GB, 1) + " GB / 共 " + [math]::Round($_.Size / 1GB, 1) + " GB")
}

# 6) 工具链
Write-Host "[6] 工具链"
$winget = Get-Command winget -ErrorAction SilentlyContinue
if ($winget) { Ok ("winget 可用：" + $winget.Source) } else { Warn "未找到 winget：需要手动下载安装 VirtualBox" }

$vbox = Get-Command VBoxManage -ErrorAction SilentlyContinue
if (-not $vbox) {
  $cand = 'C:\Program Files\Oracle\VirtualBox\VBoxManage.exe'
  if (Test-Path $cand) { $vbox = Get-Item $cand }
}
if ($vbox) { Ok ("VirtualBox 已安装：" + $vbox.Source) }
else { Warn "VirtualBox 未安装：部署脚本会通过 winget 安装（需管理员）" }

# 7) Windows 11 ISO
Write-Host "[7] Windows 11 ISO"
$isoDir = Join-Path $VmRoot '_iso'
$iso = $null
if (Test-Path $isoDir) { $iso = Get-ChildItem $isoDir -Filter '*.iso' -ErrorAction SilentlyContinue | Select-Object -First 1 }
if ($iso) {
  Ok ("已找到 ISO：" + $iso.FullName + "  " + [math]::Round($iso.Length / 1GB, 2) + " GB")
} else {
  Warn ("未找到 ISO。请从官方页面下载后放到 " + $isoDir + "：")
  Write-Host "        https://www.microsoft.com/software-download/windows11" -ForegroundColor Yellow
  Write-Host "      （官方 ISO 有会话校验，无法稳定脚本化下载，故由人工获取）" -ForegroundColor DarkGray
}

# 8) 基线快照
Write-Host "[8] 测试虚拟机与基线快照"
if ($vbox) {
  $vmName = 'FuFumidiTest'
  $vms = & $vbox.Source list vms 2>$null
  if ($vms -match [regex]::Escape($vmName)) {
    Ok ("已存在虚拟机 " + $vmName)
    $snaps = & $vbox.Source snapshot $vmName list 2>$null
    if ($snaps -match 'clean-baseline') { Ok "基线快照 clean-baseline 存在，可直接跑测试" }
    else { Warn "尚无 clean-baseline 快照：请先完成 Windows 安装并执行 deploy-test-vm.ps1 打快照" }
  } else {
    Warn ("尚未创建虚拟机 " + $vmName + "：请以管理员运行 deploy-test-vm.ps1")
  }
}

Write-Host ""
if ($fail -gt 0) {
  Write-Host ("==== 自检未通过：" + $fail + " 项失败，请先处理后再部署 ====") -ForegroundColor Red
  exit 1
} else {
  Write-Host "==== 自检通过，可以部署测试虚拟机 ====" -ForegroundColor Green
  exit 0
}

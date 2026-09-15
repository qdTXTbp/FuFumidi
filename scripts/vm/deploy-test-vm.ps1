# ============================================================
# 部署 FuFumidi 测试虚拟机（Windows 11，干净沙盒基线）
# 需管理员权限。
#
# 用法:
#   # 1) 先放好 Win11 ISO（官方下载）到 E:\VMs\_iso\
#   #     https://www.microsoft.com/software-download/windows11
#   # 2) 管理员 PowerShell 运行：
#   powershell -ExecutionPolicy Bypass -File scripts/vm/deploy-test-vm.ps1
#
# 可选参数:
#   -VmRoot "E:\VMs"          虚拟机根目录（默认 E:\VMs）
#   -IsoPath "E:\VMs\_iso\Win11.iso"   指定 ISO（默认在 -VmRoot\_iso 里找）
#   -VmName  "FuFumidiTest"
#   -MemoryMB 8192  -Cpus 4  -DiskGB 80
#   -Manual      改为人工安装（不跑无人值守，自己在界面里点）
#   -DryRun      只打印将要执行的命令，不做任何改动
#
# 说明：本脚本做「装 hypervisor + 建虚拟机 + 装系统 + 打基线快照」这一套；
#      每轮测试用 reset-test-vm.ps1 回滚到基线快照。
# ============================================================
param(
  [string]$VmRoot   = 'E:\VMs',
  [string]$IsoPath  = '',
  [string]$VmName   = 'FuFumidiTest',
  [int]$MemoryMB    = 8192,
  [int]$Cpus        = 4,
  [int]$DiskGB      = 80,
  [string]$UserName = 'tester',
  [string]$Password = 'FuFumidi!2026',
  [switch]$Manual,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$SnapName = 'clean-baseline'

function Step($m) { Write-Host ("`n==> " + $m) -ForegroundColor Cyan }
function Info($m) { Write-Host ("    " + $m) }
function Die($m)  { Write-Host ("[失败] " + $m) -ForegroundColor Red; exit 1 }

function Invoke-VBox {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  if ($DryRun) { Write-Host ("    [DryRun] VBoxManage " + ($Args -join ' ')) -ForegroundColor DarkGray; return }
  $out = & $script:VBox @Args 2>&1
  if ($LASTEXITCODE -ne 0) { Write-Host ("    VBoxManage " + ($Args -join ' ') + " -> " + ($out -join ' ')) -ForegroundColor Red; throw ("VBoxManage 执行失败: " + ($Args -join ' ')) }
  if ($out) { Write-Host ("    " + ($out -join ' ')) -ForegroundColor DarkGray }
}

# ---------- 1. 权限与前置 ----------
Step "1/7 检查环境"
$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $elevated -and -not $DryRun) {
  Die @"
需要管理员权限。请以管理员身份打开 PowerShell 后重跑：
  powershell -ExecutionPolicy Bypass -File "$PSCommandPath"

（先跑无需提权的自检可查看整体准备情况：
  powershell -ExecutionPolicy Bypass -File "$(Join-Path $PSScriptRoot 'test-vm-preflight.ps1')"）
"@
}
if ($DryRun -and -not $elevated) { Info "DryRun 模式：不要求提权（本模式不做任何改动）" }
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
if (-not $cpu.VirtualizationFirmwareEnabled) { Die "固件未开启 CPU 虚拟化（BIOS/UEFI 里开启 SVM/VT-x）" }
Info ("CPU: " + $cpu.Name + "  虚拟化已开启")

$drive = Split-Path -Qualifier $VmRoot
$d = Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='" + $drive + "'")
if (-not $d) { Die ("盘符不存在: " + $drive) }
$freeGB = [math]::Round($d.FreeSpace / 1GB, 1)
if ($freeGB -lt ($DiskGB + 20)) { Die ($drive + " 可用空间不足：需要 ≥ " + ($DiskGB + 20) + " GB，当前 " + $freeGB + " GB") }
Info ($drive + " 可用 " + $freeGB + " GB")

if (-not (Test-Path $VmRoot)) {
  if ($DryRun) { Write-Host ("    [DryRun] 将创建目录 " + $VmRoot) -ForegroundColor DarkGray }
  else { New-Item -ItemType Directory -Force -Path $VmRoot | Out-Null; Info ("已创建 " + $VmRoot) }
}

# ---------- 2. VirtualBox ----------
Step "2/7 准备 VirtualBox"
$script:VBox = $null
$cand = 'C:\Program Files\Oracle\VirtualBox\VBoxManage.exe'
if (Test-Path $cand) { $script:VBox = $cand }
else {
  $cmd = Get-Command VBoxManage -ErrorAction SilentlyContinue
  if ($cmd) { $script:VBox = $cmd.Source }
}
if ($script:VBox) {
  Info ("已安装：" + $script:VBox)
} else {
  if ($DryRun) { Write-Host "    [DryRun] winget install Oracle.VirtualBox" -ForegroundColor DarkGray; $script:VBox = $cand }
  else {
    Info "通过 winget 安装 VirtualBox…"
    winget install --id Oracle.VirtualBox --accept-package-agreements --accept-source-agreements --silent
    if (-not (Test-Path $cand)) { Die "VirtualBox 安装失败，请手动安装后重跑" }
    $script:VBox = $cand
    Info ("安装完成：" + $script:VBox)
  }
}

# ---------- 3. ISO ----------
Step "3/7 定位 Windows 11 ISO"
$isoDir = Join-Path $VmRoot '_iso'
if (-not $IsoPath) {
  if (Test-Path $isoDir) {
    $f = Get-ChildItem $isoDir -Filter '*.iso' -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 1
    if ($f) { $IsoPath = $f.FullName }
  }
}
if (-not $IsoPath -or -not (Test-Path $IsoPath)) {
  Die @"
未找到 Windows 11 ISO。请先下载官方 ISO：
  https://www.microsoft.com/software-download/windows11
下载后放到：$isoDir
再重跑本脚本（或用 -IsoPath 指定路径）。

（官方 ISO 下载地址带会话校验，无法稳定脚本化，故不自动下载。）
"@
}
Info ("ISO: " + $IsoPath + "  (" + [math]::Round((Get-Item $IsoPath).Length / 1GB, 2) + " GB)")

# ---------- 4. 创建虚拟机 ----------
Step "4/7 创建虚拟机 " + $VmName
$existing = if ($DryRun) { '' } else { (& $script:VBox list vms 2>$null | Out-String) }
if ($existing -match [regex]::Escape($VmName)) {
  Info ($VmName + " 已存在，跳过创建（如需重建请先删除该虚拟机）")
} else {
  Invoke-VBox createvm --name $VmName --ostype Windows11_64 --register --basefolder $VmRoot
  Invoke-VBox modifyvm $VmName --memory $MemoryMB --cpus $Cpus --vram 128 --graphicscontroller vmsvga
  Invoke-VBox modifyvm $VmName --firmware efi --secureboot on --tpm-type 2.0
  Invoke-VBox modifyvm $VmName --clipboard-mode bidirectional --draganddrop bidirectional
  Invoke-VBox modifyvm $VmName --nic1 nat --audio-enabled off
  Invoke-VBox setextradata $VmName VBoxInternal2/EfiGraphicsResolution 1920x1080
  Invoke-VBox createmedium disk --filename (Join-Path $VmRoot ($VmName + '\' + $VmName + '.vdi')) --size ($DiskGB * 1024) --variant Standard
  Invoke-VBox storagectl $VmName --name SATA --add sata --controller IntelAhci --portcount 2 --bootable on
  Invoke-VBox storageattach $VmName --storagectl SATA --port 0 --device 0 --type hdd --medium (Join-Path $VmRoot ($VmName + '\' + $VmName + '.vdi'))
  Invoke-VBox storageattach $VmName --storagectl SATA --port 1 --device 0 --type dvddrive --medium $IsoPath
  # 把安装包目录共享进去，方便在虚拟机里取被测安装包
  $pkgDir = 'E:\Midi\安装包'
  if (Test-Path $pkgDir) { Invoke-VBox sharedfolder add $VmName --name packages --hostpath $pkgDir --automount }
  Info ("已创建：" + $Cpus + " vCPU / " + $MemoryMB + " MB / " + $DiskGB + " GB / UEFI+SecureBoot+TPM2.0")
}

# ---------- 5. 安装 Windows ----------
Step "5/7 安装 Windows 11"
if ($Manual) {
  Info "人工安装模式：即将启动虚拟机，请在界面里完成 Windows 11 安装"
  Info "（建议：选「自定义安装」→ 装到 80GB 磁盘；OOBE 阶段用 Shift+F10 → oobe\bypassnro 建本地账号）"
  Invoke-VBox startvm $VmName --type gui
} else {
  Info "无人值守安装（自动创建本地账号，跳过 OOBE）…"
  Invoke-VBox unattended install $VmName --iso=$IsoPath --user=$UserName --password=$Password `
    --full-user-name="Tester" --hostname="fufumidi-test" --locale=zh_CN --country=CN `
    --time-zone="Asia/Shanghai" --install-additions --start-vm=gui
  Info "安装进行中：虚拟机会自动重启若干次，全程约 20–40 分钟，请勿关闭窗口"
}

# ---------- 6. 基线快照 ----------
Step "6/7 打基线快照 " + $SnapName
Info "系统装完并首次进入桌面后，请执行（本脚本不会自动等它装完）："
Write-Host ("    powershell -ExecutionPolicy Bypass -File `"" + (Join-Path $PSScriptRoot 'make-baseline.ps1') + "`"") -ForegroundColor Yellow
Info "该命令会关机并创建快照 $SnapName —— 这是之后每轮测试的起点。"

# ---------- 7. 完成 ----------
Step "7/7 完成"
Info "后续每轮全功能测试："
Info ("  1) powershell -File scripts/vm/reset-test-vm.ps1    # 回滚到 $SnapName 并启动")
Info  "  2) 按 docs/TESTING.md 第 3 节清单测试"
Info  "  3) powershell -File scripts/vm/stop-test-vm.ps1    # 关闭虚拟机"
Write-Host "`n部署脚本执行完毕。" -ForegroundColor Green

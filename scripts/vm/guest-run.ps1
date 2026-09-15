# 在测试虚拟机里执行一段 PowerShell，并把输出取回宿主机。
#
# 为什么不直接 VBoxManage guestcontrol -- powershell -Command "..."：
#   1) VBoxManage 会把参数里的引号剥掉，"引号里有空格" 的命令必被拆散；
#   2) guestcontrol 的 stdout 按本地代码页解码，中文直接乱码。
# 因此这里改成「把脚本 copyto 进 guest → 执行 → 输出落盘 → copyfrom 取回」。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/vm/guest-run.ps1 -ScriptPath .\probe.ps1
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$ScriptPath,
  [string]$VmName   = 'FuFumidiTest',
  [string]$UserName = 'tester',
  [string]$Password = 'FuFumidi!2026',
  [int]$TimeoutMin  = 30
)

$ErrorActionPreference = 'Continue'

$vbox = @(
  'C:\Program Files\Oracle\VirtualBox\VBoxManage.exe',
  'C:\Program Files (x86)\Oracle\VirtualBox\VBoxManage.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $vbox) { throw '未找到 VBoxManage.exe' }
if (-not (Test-Path $ScriptPath)) { throw ("脚本不存在: " + $ScriptPath) }

$guestDir = 'C:\Users\' + $UserName + '\fufumidi-guest'
# VBoxManage 只认 --username=xxx 这种带等号的写法；用空格分隔的形式会被当成位置参数。
$auth = @(('--username=' + $UserName), ('--password=' + $Password))

# guest 侧的包装脚本：把 run.ps1 的全部输出（含错误流）以 UTF-8 落盘。
# 用 -f 拼接而不是双引号 here-string，免得 $LASTEXITCODE 在宿主机侧就被展开。
$wrapLocal = Join-Path $env:TEMP 'fufumidi-guest-wrap.ps1'
$wrapLines = @(
  '$ErrorActionPreference = ''Continue''',
  ('& ''{0}\run.ps1'' *>&1 | Out-File -LiteralPath ''{0}\out.txt'' -Encoding utf8' -f $guestDir),
  ('''exit='' + $LASTEXITCODE | Out-File -LiteralPath ''{0}\out.txt'' -Encoding utf8 -Append' -f $guestDir)
)
Set-Content -LiteralPath $wrapLocal -Value $wrapLines -Encoding UTF8

& $vbox guestcontrol $VmName mkdir --parents @auth $guestDir 2>&1 | Out-Null
& $vbox guestcontrol $VmName copyto @auth $ScriptPath ($guestDir + '\run.ps1') 2>&1 | Out-Null
& $vbox guestcontrol $VmName copyto @auth $wrapLocal   ($guestDir + '\wrap.ps1') 2>&1 | Out-Null

$guestPs = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
& $vbox guestcontrol $VmName run --exe $guestPs @auth --wait-stdout --timeout ([string]($TimeoutMin * 60000)) `
  -- powershell -NoProfile -ExecutionPolicy Bypass -File ($guestDir + '\wrap.ps1') 2>&1 | Out-Null

$outLocal = Join-Path $env:TEMP 'fufumidi-guest-out.txt'
if (Test-Path $outLocal) { Remove-Item $outLocal -Force }
& $vbox guestcontrol $VmName copyfrom @auth ($guestDir + '\out.txt') $outLocal 2>&1 | Out-Null

if (Test-Path $outLocal) { Get-Content -LiteralPath $outLocal -Encoding UTF8 } else { '[guest-run] 未取到输出文件' }

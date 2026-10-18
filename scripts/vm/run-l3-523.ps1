# Host side orchestrator: the L3 release gate for 5.2.0 (fresh install -> post-install -> launch -> uninstall).
# Each step runs the guest script through guest-run.ps1 and its raw output is saved under _attic for the report.
# Usage: $env:FUFUMIDI_VM_PASSWORD=...; powershell -File scripts/vm/run-l3-523.ps1
param(
  [string]$VmName = 'FuFumidiTest',
  [string]$OutDir = 'E:\Midi\_attic\_sing_tmp\vm-523'
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

Write-Host "==== FuFumidi 5.2.3 L3 发布闸门 ====" -ForegroundColor Cyan

# ★ 等 guest 真的能跑命令再开始（2026-10-17 实测教训）：
#   reset-test-vm.ps1 把快照回滚并以 GUI 启动后**立刻**跑 L3，guestcontrol 还没就绪，
#   四个步骤全部报「未取到输出文件」——那不是应用失败，是通道没起来。
#   判据：guestproperty 报告 GuestAdditions 版本，且真的能跑通一条 cmd。
$guestReady = $false
for ($i = 0; $i -lt 60; $i++) {
  $props = & $vbox guestproperty enumerate $VmName 2>$null | Out-String
  if ($props -match 'GuestAdd/Version') {
    $probe = & $vbox guestcontrol $VmName run --exe 'C:\Windows\System32\cmd.exe' --username=tester --password=$env:FUFUMIDI_VM_PASSWORD --wait-stdout --timeout 20000 -- cmd /c echo ready 2>&1 | Out-String
    if ($probe -match 'ready') { $guestReady = $true; break }
  }
  Start-Sleep -Seconds 5
}
if (-not $guestReady) { Write-Host "[失败] guest 通道 5 分钟内未就绪，中止（这不是应用的问题）" -ForegroundColor Red; exit 2 }
Write-Host "==> guest 通道就绪" -ForegroundColor Green

# A 断网静默安装：先摘掉 guest 的网卡链路，装完再挂回来
Write-Host "==> 关闭 guest 网卡链路（断网安装断言）" -ForegroundColor Cyan
& $vbox controlvm $VmName setlinkstate1 off 2>&1 | Out-Null
Start-Sleep -Seconds 3
$a = Step "l3-01-install" "l3-01-install-523.ps1"
Write-Host "==> 恢复 guest 网卡链路" -ForegroundColor Cyan
& $vbox controlvm $VmName setlinkstate1 on 2>&1 | Out-Null
Start-Sleep -Seconds 5

$b = Step "l3-02-post" "l3-02-post-520.ps1"
# ★ 逐模型实跑（用户要求）：模型"装上了"不等于"跑得动"——
#   Aria-AMT 需要 CUDA、wheel 可能与运行时 ABI 不匹配，只有真跑一次才知道。
$m = Step "l3-05-models" "l3-09-models.ps1"
$f = Step "l3-06-func" "l3-10-func.ps1"
$c = Step "l3-03-launch" "l3-06-launch-app.ps1"
$d = Step "l3-04-uninstall" "l3-07-uninstall-keep-data.ps1"

Write-Host ""
Write-Host "==== 关键断言 ====" -ForegroundColor Cyan
foreach ($kv in @("offline.verified", "installer.exitCode", "after.version", "mel.exists", "updater.sha256", "registry.entries", "cdp.ready", "data.before.fileCount", "marker.survived", "after.exe.exists", "model.audio", "model.torch", "model.universal_basic.ok", "model.universal_muscriptor.ok", "model.piano_pt.ok", "model.piano_transkun.ok", "model.piano_aria.ok", "func.python.version", "func.runtime.dll312", "func.runtime.dll311", "func.mod.engine_diffsinger", "func.mod.engine_gpt_sovits", "func.mod.engine_cover", "func.mod.engine_msst", "func.mod.engine_omr", "func.asset.gpt-sovits")) {
  $hit = (Select-String -Path (Join-Path $OutDir "*.txt") -Pattern ("^" + [regex]::Escape($kv) + " = ") | Select-Object -Last 1)
  if ($hit) { Write-Host ("  " + $hit.Line) }
}
Write-Host ""
Write-Host ("失败步骤数: " + $fail) -ForegroundColor $(if ($fail -gt 0) { "Red" } else { "Green" })
Write-Host ("证据目录: " + $OutDir)

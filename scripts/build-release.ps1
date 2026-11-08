# 一键发布构建：前端 → win-unpacked → kachina(更新器+离线包) → NSIS 安装包
# ★ 顺序不能换：kachina 的 gen 才把应用配置嵌进更新器，NSIS 必须在这之后重新打包，
#   否则安装包内嵌的是「无配置更新器」，用户点更新会报「安装包损坏，请重新下载」。
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-release.ps1 -Version 5.2.3
param([Parameter(Mandatory=$true)][string]$Version, [switch]$SkipUi)
# ★ 不能用 'Stop'：本脚本大量调用原生命令（npm/npx/node/python/kachina-builder），
#   它们的 stderr 警告（vite chunk 提示、basic-pitch 的 CoreML 警告等）经 2>&1
#   重定向时会变成 NativeCommandError 被当成终止性错误，把整条构建冤杀
#   （2026-11-07 6.4.7 连续三次实测）。真正的失败由每一步的显式
#   `$LASTEXITCODE -ne 0 → throw` 把关，不依赖它。
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
# ★ 只给 electron-builder 进程注入 fs 写入重试：它给 200MB exe 回写 asar 完整性时会
#   撞上 Defender 对刚落盘文件的瞬时独占（EPERM）。重试整个 dir 阶段无效，必须让
#   这一次 writeFile 本身重试。见 scripts/retry-fs-write.cjs。
$fsRetryHook = (Join-Path $PSScriptRoot 'retry-fs-write.cjs') -replace '\\', '/'
$env:NODE_OPTIONS = "--require=$fsRetryHook"
# ★ node 类子进程（npm/npx）一律经 cmd /c 启动：PowerShell 5.1 会把它们的 stderr
#   包装成 NativeCommandError 走自己的错误流，vite 渲染 chunks 时的警告输出在
#   后台/CI 会话里没人消费该管道就会阻塞整条构建（2026-11-07 6.4.7 两次实测）。
#   cmd /c 让 stderr 直接落到重定向文件，绕开这套包装。
if (-not $SkipUi) { & cmd /c "npm --prefix frontend run build"; if ($LASTEXITCODE -ne 0) { throw "frontend build failed" } }
Write-Host "[1/3] electron-builder --win dir" -ForegroundColor Cyan
# ★ electron-builder 刚写完 200MB 的 FuFumidi.exe 就要回写 asar 完整性，Windows
#   Defender / 索引器偶尔会短暂占住它 → EPERM 导致整条构建冤死（2026-11-08 6.4.9）。
#   失败时把半成品目录改名挪开（比删 2 万多个文件可靠，也不触发批量删除确认），
#   再完整重跑一次 dir；最多 3 次。
$dirOk = $false
for ($try = 1; $try -le 3 -and -not $dirOk; $try++) {
  & cmd /c "npx electron-builder --win dir --x64"
  if ($LASTEXITCODE -eq 0) { $dirOk = $true; break }
  Write-Host ("[1/3] 第 " + $try + " 次 dir 失败，挪开半成品后重试…") -ForegroundColor Yellow
  Start-Sleep -Seconds 5
  $half = Join-Path $root "release\win-unpacked"
  if (Test-Path $half) {
    $stale = "_stale-win-unpacked-retry" + $try + "-" + (Get-Date -Format 'HHmmss')
    try { Rename-Item -LiteralPath $half -NewName $stale -Force } catch { Write-Host ("  挪开失败：" + $_.Exception.Message) -ForegroundColor Yellow }
  }
}
if (-not $dirOk) { throw "dir build failed" }
# 让杀软/索引器把刚落盘的句柄放掉，再做下一步的裁剪（裁剪本身也会重试 + 告警）
Start-Sleep -Seconds 3
# P1 包体：bundle-python 产出的运行时仍带 pyc/lib/headers/tests（实测约 296 MiB），
# 在 dir 之后、kachina/NSIS 之前裁掉；并用真实 import 自检，失败直接中止构建。
$pyRoot = Join-Path $root "release\win-unpacked\resources\python"
if (Test-Path (Join-Path $pyRoot "python.exe")) {
  Write-Host "[prune] Python 运行时裁剪" -ForegroundColor Cyan
  $env:FUFUMIDI_PY = $pyRoot
  & node (Join-Path $root "scripts\prune-python-bundle.cjs"); if ($LASTEXITCODE -ne 0) { throw "prune-python-bundle failed" }
  & node (Join-Path $root "scripts\prune-python-unused.cjs"); if ($LASTEXITCODE -ne 0) { throw "prune-python-unused failed" }
  & (Join-Path $pyRoot "python.exe") -c "import numpy, scipy, librosa, soundfile, pretty_midi, mido, yaml, PIL, onnxruntime, basic_pitch, torch"; if ($LASTEXITCODE -ne 0) { throw "pruned Python import self-check failed" }
  Remove-Item Env:FUFUMIDI_PY -ErrorAction SilentlyContinue
} else { Write-Host "[prune] 找不到内置 python，跳过" -ForegroundColor Yellow }

Write-Host "[2/3] build-kachina.ps1" -ForegroundColor Cyan
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "build-kachina.ps1") -Version $Version; if ($LASTEXITCODE -ne 0) { throw "kachina failed" }
Write-Host "[3/3] electron-builder --win nsis (更新器已在 gen 之后同步)" -ForegroundColor Cyan
# 与 dir 阶段同样会回写 exe 的 asar 完整性，同样可能撞上 EPERM；失败就挪开半成品重试。
$nsisOk = $false
for ($try = 1; $try -le 3 -and -not $nsisOk; $try++) {
  & cmd /c "npx electron-builder --win nsis --x64"
  if ($LASTEXITCODE -eq 0) { $nsisOk = $true; break }
  Write-Host ("[3/3] 第 " + $try + " 次 nsis 失败，挪开半成品后重试…") -ForegroundColor Yellow
  Start-Sleep -Seconds 5
  $half = Join-Path $root "release\win-unpacked"
  if (Test-Path $half) {
    $stale = "_stale-win-unpacked-nsis" + $try + "-" + (Get-Date -Format 'HHmmss')
    try { Rename-Item -LiteralPath $half -NewName $stale -Force } catch { Write-Host ("  挪开失败：" + $_.Exception.Message) -ForegroundColor Yellow }
  }
}
if (-not $nsisOk) { throw "nsis build failed" }
# 断言：安装包同级/win-unpacked 的更新器必须已嵌入配置
$up = Join-Path $root "release\update\FuFumidi.update.exe"
if (-not (Test-Path $up)) { throw ("[断言失败] 更新器不存在：" + $up) }
$bytes = [System.IO.File]::ReadAllBytes($up)
$s = [System.Text.Encoding]::GetEncoding(28591).GetString($bytes)
# ★ 只查 "FuFumidi" 不够（文件名/图标里就有这串），必须查**嵌入配置里的特征字段**：
#   2026-10-18 事故就是更新器没嵌配置（embedded_config={}），用户更新报「安装包损坏」。
if ($s.IndexOf("FuFumidiData") -lt 0 -or $s.IndexOf("FuFumidi.exe") -lt 0) {
  throw ("[断言失败] " + $up + " 没有嵌入应用配置（缺 FuFumidiData / FuFumidi.exe 标记），用户更新会报「安装包损坏」")
}
Write-Host "[ok] 更新器已嵌入配置：" $up -ForegroundColor Green
Write-Host "[ok] 安装包：" (Get-ChildItem (Join-Path $root "release") -Filter "*.exe" | Where-Object { $_.Name -like "*Setup*" } | ForEach-Object { $_.FullName }) -ForegroundColor Green
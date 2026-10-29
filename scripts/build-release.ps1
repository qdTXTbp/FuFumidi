# 一键发布构建：前端 → win-unpacked → kachina(更新器+离线包) → NSIS 安装包
# ★ 顺序不能换：kachina 的 gen 才把应用配置嵌进更新器，NSIS 必须在这之后重新打包，
#   否则安装包内嵌的是「无配置更新器」，用户点更新会报「安装包损坏，请重新下载」。
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-release.ps1 -Version 5.2.3
param([Parameter(Mandatory=$true)][string]$Version, [switch]$SkipUi)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not $SkipUi) { & npm --prefix frontend run build; if ($LASTEXITCODE -ne 0) { throw "frontend build failed" } }
Write-Host "[1/3] electron-builder --win dir" -ForegroundColor Cyan
& npx electron-builder --win dir --x64; if ($LASTEXITCODE -ne 0) { throw "dir build failed" }
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
& npx electron-builder --win nsis --x64; if ($LASTEXITCODE -ne 0) { throw "nsis build failed" }
# 断言：安装包同级/win-unpacked 的更新器必须已嵌入配置
$up = Join-Path $root "release\update\FuFumidi.update.exe"
$bytes = [System.IO.File]::ReadAllBytes($up)
$s = [System.Text.Encoding]::GetEncoding(28591).GetString($bytes)
# ★ 只查 "FuFumidi" 不够（文件名/图标里就有这串），必须查**嵌入配置里的特征字段**：
#   2026-10-18 事故就是更新器没嵌配置（embedded_config={}），用户更新报「安装包损坏」。
if ($s.IndexOf("FuFumidiData") -lt 0 -or $s.IndexOf("FuFumidi.exe") -lt 0) {
  throw ("[断言失败] " + $up + " 没有嵌入应用配置（缺 FuFumidiData / FuFumidi.exe 标记），用户更新会报「安装包损坏」")
}
Write-Host "[ok] 更新器已嵌入配置：" $up -ForegroundColor Green
Write-Host "[ok] 安装包：" (Get-ChildItem (Join-Path $root "release") -Filter "*.exe" | Where-Object { $_.Name -like "*Setup*" } | ForEach-Object { $_.FullName }) -ForegroundColor Green
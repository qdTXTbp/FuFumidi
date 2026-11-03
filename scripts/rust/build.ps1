# FuFumidi Rust workspace 构建脚本（crates/Cargo.toml）
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust/build.ps1
#   powershell ... -File scripts/rust/build.ps1 -NoInstall     # 只构建，不复制到 resources/
#   powershell ... -File scripts/rust/build.ps1 -Profile debug
#   powershell ... -File scripts/rust/build.ps1 -Target x86_64-pc-windows-msvc
#
# 产物与安装位置：
#   crates/target/<target>/<profile>/fufumidi-engine.exe     构建产物
#   resources/rust-core/fufumidi-engine.exe                  正式 sidecar 文件名
#   resources/rust-core/fufumidi-core.exe                    兼容别名（同一字节，供 main/rust.js 发现）
#
# 默认优先 x86_64-pc-windows-gnu（与旧 scripts/build-rust.ps1 一致，无需 MSVC linker）。
# 旧的 rust-core/ 与 scripts/build-rust.ps1 保持不动，本脚本只服务 crates/ workspace。
param(
    [ValidateSet('release', 'debug')]
    [string]$Profile = 'release',
    [string]$Target = '',
    [switch]$NoInstall
)

$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$manifest = Join-Path $root 'crates/Cargo.toml'
if (-not (Test-Path $manifest)) {
    throw "workspace manifest not found: $manifest"
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw 'cargo was not found in PATH'
}

if (-not $Target) {
    if ($env:FUFUMIDI_RUST_GNU -eq '0') {
        $Target = ''
    } elseif (Get-Command gcc -ErrorAction SilentlyContinue) {
        $Target = 'x86_64-pc-windows-gnu'
    } else {
        $Target = ''
    }
}
if ($Target -eq 'x86_64-pc-windows-gnu') {
    if (-not (Get-Command gcc -ErrorAction SilentlyContinue)) {
        throw 'gcc is required for the x86_64-pc-windows-gnu target'
    }
    $env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = 'gcc'
}

$targetLabel = if ($Target) { $Target } else { 'host default' }
Write-Output "[rust] rustc: $((& rustc --version) -join ' ')"
Write-Output "[rust] workspace: $manifest"
Write-Output "[rust] profile: $Profile; target: $targetLabel"

$arguments = @('build', '--manifest-path', $manifest)
if ($Profile -eq 'release') {
    $arguments += '--release'
}
if ($Target) {
    $arguments += @('--target', $Target)
}

& cargo @arguments
if ($LASTEXITCODE -ne 0) {
    throw "cargo build failed with exit code $LASTEXITCODE"
}

$outDir = if ($Target) {
    Join-Path $root "crates/target/$Target/$Profile"
} else {
    Join-Path $root "crates/target/$Profile"
}
$exe = Join-Path $outDir 'fufumidi-engine.exe'
if (-not (Test-Path $exe)) {
    $exe = Join-Path $outDir 'fufumidi-engine'
}
if (-not (Test-Path $exe)) {
    throw "engine binary not found under $outDir"
}
$size = (Get-Item $exe).Length
Write-Output "[rust] built: $exe ($([math]::Round($size / 1KB, 1)) KB)"

if ($NoInstall) {
    Write-Output '[rust] -NoInstall: skipped copying into resources/rust-core'
    return
}

$destination = Join-Path $root 'resources/rust-core'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
Copy-Item $exe (Join-Path $destination 'fufumidi-engine.exe') -Force
Copy-Item $exe (Join-Path $destination 'fufumidi-core.exe') -Force
Write-Output "[rust] installed: $destination/fufumidi-engine.exe"
Write-Output "[rust] compat alias: $destination/fufumidi-core.exe (main/rust.js 自动发现)"

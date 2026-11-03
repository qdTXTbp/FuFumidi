# FuFumidi Rust workspace 测试脚本（crates/Cargo.toml）
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust/test.ps1
#   powershell ... -File scripts/rust/test.ps1 -SkipFmt -SkipClippy
#   powershell ... -File scripts/rust/test.ps1 -Target x86_64-pc-windows-msvc
#
# 顺序：cargo test -> cargo fmt --check -> cargo clippy（clippy 只拦错误，警告可容忍）。
# 未安装 rustfmt / clippy 时给出警告并跳过对应步骤，不让测试脚本整体失败。
param(
    [string]$Target = '',
    [switch]$SkipFmt,
    [switch]$SkipClippy
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
Write-Output "[rust-test] workspace: $manifest; target: $targetLabel"

$testArguments = @('test', '--manifest-path', $manifest)
if ($Target) {
    $testArguments += @('--target', $Target)
}
& cargo @testArguments
if ($LASTEXITCODE -ne 0) {
    throw "cargo test failed with exit code $LASTEXITCODE"
}

if (-not $SkipFmt) {
    & cargo fmt --version *> $null
    if ($LASTEXITCODE -eq 0) {
        & cargo fmt --manifest-path $manifest --all -- --check
        if ($LASTEXITCODE -ne 0) {
            throw 'cargo fmt --check failed'
        }
        Write-Output '[rust-test] fmt: clean'
    } else {
        Write-Warning 'rustfmt not installed; skipping format check (rustup component add rustfmt)'
    }
}

if (-not $SkipClippy) {
    & cargo clippy --version *> $null
    if ($LASTEXITCODE -eq 0) {
        $clippyArguments = @('clippy', '--manifest-path', $manifest, '--all-targets')
        if ($Target) {
            $clippyArguments += @('--target', $Target)
        }
        & cargo @clippyArguments
        if ($LASTEXITCODE -ne 0) {
            throw "cargo clippy failed with exit code $LASTEXITCODE"
        }
        Write-Output '[rust-test] clippy: no errors (warnings are tolerated)'
    } else {
        Write-Warning 'clippy not installed; skipping lint (rustup component add clippy)'
    }
}

Write-Output '[rust-test] all checks passed'

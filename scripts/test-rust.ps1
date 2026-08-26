# 运行 Rust 核心单元测试（GNU 工具链）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = 'gcc'
Push-Location $root
try {
  cargo test --manifest-path "$root\rust-core\Cargo.toml" --target x86_64-pc-windows-gnu
} finally {
  Pop-Location
}

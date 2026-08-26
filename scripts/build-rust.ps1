# 构建可选 Rust 性能核心并在本地安装
# 默认优先使用 GNU 工具链（无需 MSVC linker）；设 FUFUMIDI_RUST_GNU=0 可回退 MSVC
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
$useGnu = ($env:FUFUMIDI_RUST_GNU -ne '0')
try {
  if ($useGnu) {
    Write-Output '[rust] building with x86_64-pc-windows-gnu ...'
    if (Get-Command gcc -ErrorAction SilentlyContinue) {
      $env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = 'gcc'
    }
    cargo build --release --target x86_64-pc-windows-gnu --manifest-path "$root\rust-core\Cargo.toml"
    $exe = "$root\rust-core\target\x86_64-pc-windows-gnu\release\fufumidi-core.exe"
  } else {
    Write-Output '[rust] building with default (msvc) toolchain ...'
    cargo build --release --manifest-path "$root\rust-core\Cargo.toml"
    $exe = "$root\rust-core\target\release\fufumidi-core.exe"
  }
  if (-not (Test-Path $exe)) {
    $exe = "$root\rust-core\target\x86_64-pc-windows-gnu\release\fufumidi-core"
  }
  if (-not (Test-Path $exe)) {
    $exe = "$root\rust-core\target\release\fufumidi-core"
  }
  if (-not (Test-Path $exe)) {
    throw 'Rust binary was not produced'
  }
  $dst = "$root\resources\rust-core"
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  Copy-Item $exe "$dst\fufumidi-core.exe" -Force
  Write-Output "Rust core installed to $dst\fufumidi-core.exe"
} finally {
  Pop-Location
}
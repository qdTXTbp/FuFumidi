# 构建可选 Rust 性能核心并在本地安装
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  cargo build --release --manifest-path "$root\rust-core\Cargo.toml"
  $exe = "$root\rust-core\target\release\fufumidi-core.exe"
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

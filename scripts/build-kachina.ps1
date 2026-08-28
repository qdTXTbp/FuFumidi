# ============================================================
# kachina updater / offline package build script (BetterGI style)
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/build-kachina.ps1 -Version 3.2.0
# Optional:
#   -OldDirs "D:\old\v3.1.0, D:\old\v3.1.1"  old version dirs (comma separated, for diff patches)
#   -KeepStaging  keep intermediate dirs (debug)
# Outputs:
#   release/update/FuFumidi.update.exe      updater (embedded in portable build)
#   release/update/FuFumidi.Install.<ver>.exe   offline package (upload to GitHub Releases)
# ============================================================
param(
  [Parameter(Mandatory=$true)][string]$Version,
  [string]$OldDirs = "",
  [switch]$KeepStaging
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$builder = Join-Path $root 'tools\kachina-builder.exe'
$config = Join-Path $root 'Build\kachina.config.json'
$winUnpacked = Join-Path $root 'release\win-unpacked'

if (!(Test-Path $builder)) { throw "kachina-builder.exe not found: $builder" }
if (!(Test-Path $config)) { throw "kachina.config.json not found: $config" }
if (!(Test-Path $winUnpacked)) { throw "win-unpacked not found: $winUnpacked (run electron-builder --win dir first)" }

$staging = Join-Path $root "release\update\staging-$Version"
$metaOut = Join-Path $root "release\update\hashed-$Version"
$outDir  = Join-Path $root 'release\update'
$leftImg = Join-Path $root 'Build\updater-left.webp'   # 更新器左侧品牌图

if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Force -Path $staging | Out-Null
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Write-Host "[1/4] Copying app body to staging (excluding python/models/wallpapers) ..."
robocopy $winUnpacked $staging /E /NFL /NDL /NJH /NJS /NP `
  /XD "$winUnpacked\resources\python" `
     "$winUnpacked\resources\models" `
     "$winUnpacked\resources\wallpapers" `
     "$winUnpacked\resources\wallpaper-thumbs" | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed, code $LASTEXITCODE" }

Write-Host "[2/4] Generating updater FuFumidi.update.exe ..."
$packArgs = @('pack', '-c', $config, '-o', (Join-Path $staging 'FuFumidi.update.exe'), '--icon', (Join-Path $root 'build\icon.ico'))
if (Test-Path $leftImg) { $packArgs += '-t'; $packArgs += $leftImg }
& $builder @packArgs
if ($LASTEXITCODE -ne 0) { throw "pack updater failed" }

Copy-Item (Join-Path $staging 'FuFumidi.update.exe') (Join-Path $winUnpacked 'FuFumidi.update.exe') -Force

Write-Host "[3/4] gen: scanning files, generating metadata + hashes + diff patches ..."
$diffArgs = @()
if ($OldDirs) {
  foreach ($d in ($OldDirs -split ',')) {
    $d = $d.Trim()
    if ($d -and (Test-Path $d)) { $diffArgs += "--diff-vers"; $diffArgs += $d }
  }
}
& $builder gen -j 4 -i $staging -m (Join-Path $outDir "metadata-$Version.json") `
  -o $metaOut -r qdTXTbp/FuFumidi -t $Version `
  @diffArgs `
  -u (Join-Path $staging 'FuFumidi.update.exe') -p 'FuFumidi.update.exe'
if ($LASTEXITCODE -ne 0) { throw "gen failed" }

Write-Host "[4/4] pack: generating offline package FuFumidi.Install.$Version.exe ..."
$offArgs = @('pack', '-c', $config, '-m', (Join-Path $outDir "metadata-$Version.json"), '-d', $metaOut, '-o', (Join-Path $outDir "FuFumidi.Install.$Version.exe"), '--icon', (Join-Path $root 'build\icon.ico'))
if (Test-Path $leftImg) { $offArgs += '-t'; $offArgs += $leftImg }
& $builder @offArgs
if ($LASTEXITCODE -ne 0) { throw "pack offline failed" }

if (-not $KeepStaging) {
  Remove-Item $staging -Recurse -Force
  Remove-Item $metaOut -Recurse -Force
}

$install = Join-Path $outDir "FuFumidi.Install.$Version.exe"
$updater = Join-Path $winUnpacked 'FuFumidi.update.exe'
Write-Host ""
Write-Host "Done:"
Write-Host ("  offline: {0} ({1:N1} MB)" -f $install, ((Get-Item $install).Length/1MB))
Write-Host ("  updater: {0} ({1:N1} MB)" -f $updater, ((Get-Item $updater).Length/1MB))
Write-Host ""
Write-Host "Next: upload offline package to GitHub Releases (v$Version). Updater is embedded in portable build."

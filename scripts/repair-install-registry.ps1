<#
  修复「程序还在、但 设置 → 应用 里没有条目」的状态。

  为什么会丢：electron-builder 的安装器在 .onInit 最早期（build/nsis-custom.nsh 的
  preInit）就先删掉本应用的卸载注册表项，装完再写回。**中途取消 / 中断的安装**，
  以及用预览包走一遍卸载向导，都会留下「程序还在、条目没了」的状态。

  本脚本按 electron-builder 在 templates/nsis/include/installer.nsh
  ::registryAddInstallInfo 里的**同一组值**重建两处键：
    HKCU\Software\<APP_GUID>                                          InstallLocation 等
    HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<APP_GUID>
  APP_GUID 由 appId 经 UUID v5 派生（NsisTarget.js:157，命名空间
  50e065bc-3134-11e6-9bab-38c9862bdaf3）—— 对 com.fufumidi.app 恒为
  ee90ae64-4313-5a31-857b-d4c295bf71e7，不随版本变。

  只写注册表，不动任何文件；重复执行是幂等的。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\repair-install-registry.ps1
    powershell ... -File scripts\repair-install-registry.ps1 -DryRun
#>
param(
  [string]$InstallDir = 'E:\Midi\FuFumidi',
  [string]$Publisher,
  [string]$Comments,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$AppGuid = 'ee90ae64-4313-5a31-857b-d4c295bf71e7'
$InstallKey  = "HKCU:\Software\$AppGuid"
$UninstKey   = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppGuid"

if (-not (Test-Path -LiteralPath $InstallDir)) { throw "安装目录不存在: $InstallDir" }
$exe = Join-Path $InstallDir "FuFumidi.exe"
$un  = Join-Path $InstallDir "Uninstall FuFumidi.exe"
if (-not (Test-Path -LiteralPath $exe)) { throw "找不到 $exe" }
if (-not (Test-Path -LiteralPath $un))  { throw "找不到 $un" }

$vi = (Get-Item -LiteralPath $exe).VersionInfo
$version = $vi.FileVersion
if (-not $version) { $version = $vi.ProductVersion }
if (-not $Publisher) { $Publisher = if ($vi.CompanyName) { $vi.CompanyName } else { "FuFumidi" } }
if (-not $Comments)  { $Comments  = $vi.FileDescription }

# 大小只算程序本身：FuFumidiData（模型 / 声库 / 曲库）是用户数据，不算进"应用大小"
$sizeKb = 0
Get-ChildItem -LiteralPath $InstallDir -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notlike (Join-Path $InstallDir "FuFumidiData\*") } |
  ForEach-Object { $sizeKb += [int]($_.Length / 1KB) }
$sizeKb = [int]$sizeKb

"安装目录 : $InstallDir"
"版本     : $version"
"发布者   : $Publisher"
"大小(KB) : $sizeKb"
"安装键   : $InstallKey"
"卸载键   : $UninstKey"
if ($DryRun) { "DryRun：只显示，不写入。"; return }

New-Item -Path $InstallKey -Force | Out-Null
New-ItemProperty -Path $InstallKey -Name InstallLocation -Value $InstallDir -PropertyType String -Force | Out-Null
New-ItemProperty -Path $InstallKey -Name KeepShortcuts   -Value "true"      -PropertyType String -Force | Out-Null
New-ItemProperty -Path $InstallKey -Name ShortcutName    -Value "FuFumidi"  -PropertyType String -Force | Out-Null

New-Item -Path $UninstKey -Force | Out-Null
New-ItemProperty -Path $UninstKey -Name DisplayName           -Value "FuFumidi" -PropertyType String -Force | Out-Null
New-ItemProperty -Path $UninstKey -Name DisplayVersion        -Value $version  -PropertyType String -Force | Out-Null
New-ItemProperty -Path $UninstKey -Name Publisher             -Value $Publisher -PropertyType String -Force | Out-Null
New-ItemProperty -Path $UninstKey -Name DisplayIcon           -Value "$exe,0"  -PropertyType String -Force | Out-Null
New-ItemProperty -Path $UninstKey -Name UninstallString       -Value "`"$un`" /currentuser"    -PropertyType String -Force | Out-Null
New-ItemProperty -Path $UninstKey -Name QuietUninstallString  -Value "`"$un`" /currentuser /S" -PropertyType String -Force | Out-Null
if ($Comments) { New-ItemProperty -Path $UninstKey -Name Comments -Value $Comments -PropertyType String -Force | Out-Null }
New-ItemProperty -Path $UninstKey -Name NoModify     -Value 1        -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $UninstKey -Name NoRepair     -Value 1        -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $UninstKey -Name EstimatedSize -Value $sizeKb -PropertyType DWord -Force | Out-Null

"已写入。回读："
Get-ItemProperty -Path $UninstKey | Select-Object DisplayName,DisplayVersion,Publisher,UninstallString,EstimatedSize | Format-List | Out-String -Width 200

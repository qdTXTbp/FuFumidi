param(
  [string]$File = "E:/Midi/FuFumidi/FuFumidi.exe",
  [string]$Pfx = $env:FUFUMIDI_SIGN_PFX,
  [string]$Password = $env:FUFUMIDI_SIGN_PASSWORD,
  [string]$Timestamp = "http://timestamp.digicert.com"
)
$ErrorActionPreference = "Stop"
if (!(Test-Path $File)) { throw "missing file: $File" }
$signtool = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
if (!$signtool) { throw "signtool.exe not found (install Windows SDK)" }
Write-Output "signtool=$($signtool.FullName)"
if (!$Pfx) {
  Write-Output "NO_PFX: dry-run only; provide FUFUMIDI_SIGN_PFX and FUFUMIDI_SIGN_PASSWORD"
  $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  $out = & $signtool.FullName verify /pa $File 2>&1 | Out-String
  $ErrorActionPreference = $old
  Write-Output $out
  Write-Output "DRY_RUN_OK (unsigned/SmartScreen warning expected)"
  exit 0
}
$args = @("sign","/fd","sha256","/f",$Pfx,"/p",$Password,"/tr",$Timestamp,"/td","sha256",$File)
& $signtool.FullName @args
& $signtool.FullName verify /pa $File

# Host side: copy release artifacts into the test guest (needed by the l3/l4 guest scripts).
# Usage: $env:FUFUMIDI_VM_PASSWORD=...; powershell -File scripts/vm/copy-to-guest.ps1 -Source "E:\path\setup.exe"
# NOTE: this VBoxManage (7.2.x) does NOT accept --target-directory for copyto; the working form
#       (same as guest-run.ps1) is: copyto @auth <host-src> <full-guest-dest-path>.
param(
  [Parameter(Mandatory = $true)][string[]]$Source,
  [string]$VmName = 'FuFumidiTest',
  [string]$UserName = 'tester',
  [string]$Password = $(if ($env:FUFUMIDI_VM_PASSWORD) { $env:FUFUMIDI_VM_PASSWORD } else { throw "missing env FUFUMIDI_VM_PASSWORD" }),
  [string]$GuestDir = 'C:\Users\tester\fufumidi-guest'
)
$vbox = 'C:\Program Files\Oracle\VirtualBox\VBoxManage.exe'
if (-not (Test-Path $vbox)) { throw 'VBoxManage.exe not found' }
$auth = @(('--username=' + $UserName), ('--password=' + $Password))
& $vbox guestcontrol $VmName mkdir --parents @auth $GuestDir 2>&1 | Out-Null
foreach ($f in $Source) {
  if (-not (Test-Path $f)) { throw ("missing source: " + $f) }
  $name = Split-Path $f -Leaf
  $dest = Join-Path $GuestDir $name
  $sw = [Diagnostics.Stopwatch]::StartNew()
  & $vbox guestcontrol $VmName copyto @auth $f $dest 2>&1 | ForEach-Object { if ($_ -match "error|warning") { Write-Output ("  vbox: " + $_) } }
  $code = $LASTEXITCODE
  $sw.Stop()
  $size = (Get-Item $f).Length
  Write-Output ("copied {0} ({1:N1} MB) exit={2} {3:N1}s" -f $name, ($size / 1MB), $code, $sw.Elapsed.TotalSeconds)
}
& $vbox guestcontrol $VmName list @auth $GuestDir 2>&1 | Where-Object { $_ -match '\.exe' } | ForEach-Object { '  guest: ' + $_.Trim() }

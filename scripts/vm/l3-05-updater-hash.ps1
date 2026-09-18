# One-off: verify the installed updater matches this build (byte-identical).
# Pure ASCII only -- the guest reads .ps1 as ANSI when there is no BOM.
$ErrorActionPreference = 'Continue'
$inst = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'),
  (Join-Path $env:ProgramFiles 'FuFumidi')
) | Where-Object { Test-Path (Join-Path $_ 'FuFumidi.exe') } | Select-Object -First 1
$upd = Join-Path $inst 'FuFumidi.update.exe'
'setup.size = ' + (Get-Item 'C:\Users\tester\fufumidi-guest\setup-4.3.0.exe').Length
'updater.exists = ' + (Test-Path $upd)
'updater.size = ' + (Get-Item $upd).Length
'updater.sha256 = ' + (Get-FileHash $upd -Algorithm SHA256).Hash
'done = 1'
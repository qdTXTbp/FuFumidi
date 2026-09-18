# L4: run the generated daemon manually with the same arguments to see whether the script itself
# works (vs. the app's detached spawn killing it).
# Pure ASCII only.
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }

$inst = Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'
$daemon = Join-Path $inst 'FuFumidiData\temp\fufumidi-restart.ps1'
$log = Join-Path $inst 'FuFumidiData\temp\fufumidi-restart.log'
Say 'daemon.bytes' (Get-Item $daemon).Length
$errs = $null; $tokens = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($daemon, [ref]$tokens, [ref]$errs)
Say 'parse.errorCount' (@($errs).Count)
if (@($errs).Count -gt 0) { Say 'parse.first' $errs[0].Message }
Say 'log.before.bytes' ($(if (Test-Path $log) { (Get-Item $log).Length } else { -1 }))

$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$p = Start-Process -FilePath $ps -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $daemon) -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 8
Say 'manual.pid' $p.Id
Say 'manual.hasExited' $p.HasExited
if ($p.HasExited) { Say 'manual.exitCode' $p.ExitCode }
Say 'log.after.bytes' ($(if (Test-Path $log) { (Get-Item $log).Length } else { -1 }))
if (Test-Path $log) { Say 'log.tail' ((Get-Content $log -Raw).Trim() -replace "`r?`n", ' | ') }
Say 'updater.running' (@(Get-CimInstance Win32_Process -Filter "Name='FuFumidi.update.exe'" -ErrorAction SilentlyContinue).Count)
Say 'done' '1'
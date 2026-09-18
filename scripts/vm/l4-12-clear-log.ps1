# L4: clear the guard log before a fresh update attempt so the timeline is readable.
# Pure ASCII only.
$inst = Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'
$log = Join-Path $inst 'FuFumidiData\temp\fufumidi-restart.log'
if (Test-Path $log) { Remove-Item $log -Force }
'log.cleared = ' + (-not (Test-Path $log))
'app.running = ' + (@(Get-CimInstance Win32_Process -Filter "Name='FuFumidi.exe'" -ErrorAction SilentlyContinue).Count)
'updater.running = ' + (@(Get-CimInstance Win32_Process -Filter "Name='FuFumidi.update.exe'" -ErrorAction SilentlyContinue).Count)
'done = 1'
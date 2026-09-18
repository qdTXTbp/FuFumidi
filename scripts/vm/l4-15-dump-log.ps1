# L4: dump the update-flow diagnostic log.
# Pure ASCII only.
$inst = Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'
$log = Join-Path $inst 'FuFumidiData\temp\fufumidi-restart.log'
'log.exists = ' + (Test-Path $log)
if (Test-Path $log) { '--- log ---'; Get-Content $log -Raw }
'app.running = ' + (@(Get-CimInstance Win32_Process -Filter "Name='FuFumidi.exe'" -ErrorAction SilentlyContinue).Count)
'updater.running = ' + (@(Get-CimInstance Win32_Process -Filter "Name='FuFumidi.update.exe'" -ErrorAction SilentlyContinue).Count)
'ps.guard = ' + (@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*fufumidi-restart*' }).Count)
'done = 1'
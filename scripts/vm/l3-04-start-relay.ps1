# L3: start the guest-side CDP relay as a detached process (host reaches the page via reverse tunnel).
# NOTE: pure ASCII only.
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }

$py = 'C:\Users\tester\AppData\Local\Programs\FuFumidi\resources\python\python.exe'
$relay = 'C:\Users\tester\fufumidi-guest\guest-cdp-relay.py'
$log = 'C:\Users\tester\fufumidi-guest\relay.log'
Say 'python.exists' (Test-Path $py)
Say 'relay.exists' (Test-Path $relay)
if (-not (Test-Path $py) -or -not (Test-Path $relay)) { Say 'done' '0'; exit 2 }

# already running?
$existing = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like '*guest-cdp-relay*' })
Say 'relay.alreadyRunning' $existing.Count
if ($existing.Count -eq 0) {
  # VirtualBox NAT: the host is reachable from the guest at 10.0.2.2
  $args = @($relay, '--tunnel', '10.0.2.2', '9226', '9225')
  Start-Process -FilePath $py -ArgumentList $args -RedirectStandardOutput $log -RedirectStandardError ($log + '.err') -WindowStyle Hidden
  Start-Sleep -Seconds 6
}
$now = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like '*guest-cdp-relay*' })
Say 'relay.processCount' $now.Count
if (Test-Path $log) { Say 'relay.log' ((Get-Content $log -TotalCount 6) -join ' | ') }
if (Test-Path ($log + '.err')) { Say 'relay.err' ((Get-Content ($log + '.err') -TotalCount 6) -join ' | ') }
Say 'done' '1'
# L4: check whether the running app has a CDP endpoint, and dump its command line.
# Pure ASCII only.
$ErrorActionPreference = 'Continue'
Get-CimInstance Win32_Process -Filter "Name='FuFumidi.exe'" | ForEach-Object { 'cmdline: ' + $_.CommandLine }
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 5 -UseBasicParsing
  'cdp.status = ' + $r.StatusCode
  'cdp.body = ' + $r.Content.Substring(0, [Math]::Min(120, $r.Content.Length))
} catch { 'cdp.error = ' + $_.Exception.Message }
try {
  $r2 = Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json' -TimeoutSec 5 -UseBasicParsing
  'cdp.pages = ' + (($r2.Content | ConvertFrom-Json) | Where-Object { $_.type -eq 'page' }).Count
} catch { 'cdp.pages.error = ' + $_.Exception.Message }
'done = 1'
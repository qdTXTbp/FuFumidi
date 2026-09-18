# L4: reproduce the daemon's Start-Process path handling.
# The daemon is generated from a JS template literal; backslashes get doubled/re-quadrupled,
# so this checks whether Start-Process tolerates "C:\\\\Users\\\\..." style paths.
# Pure ASCII only.
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }

Get-Process FuFumidi,FuFumidi.update -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 4

$quad = 'C:\\\\Users\\\\tester\\\\AppData\\\\Local\\\\Programs\\\\FuFumidi\\\\FuFumidi.exe'
$dbl = 'C:\\Users\\tester\\AppData\\Local\\Programs\\FuFumidi\\FuFumidi.exe'
$sgl = 'C:\Users\tester\AppData\Local\Programs\FuFumidi\FuFumidi.exe'
Say 'quad.literal' $quad
Say 'dbl.literal' $dbl
Say 'sgl.literal' $sgl

# 1) quadruple backslashes (what the generated daemon currently contains)
try { Start-Process -FilePath $quad -WorkingDirectory 'C:\\Users\\tester\\AppData\\Local\\Programs\\FuFumidi'; Say 'quad.started' 'True' }
catch { Say 'quad.started' ('False: ' + $_.Exception.Message) }
Start-Sleep -Seconds 5
Say 'quad.procCount' (@(Get-CimInstance Win32_Process -Filter "Name='FuFumidi.exe'" -ErrorAction SilentlyContinue).Count)
Get-Process FuFumidi -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

# 2) plain single-backslash path (what a hand-written script would use)
try { Start-Process -FilePath $sgl -WorkingDirectory $sgl.Replace('\FuFumidi.exe', ''); Say 'single.started' 'True' }
catch { Say 'single.started' ('False: ' + $_.Exception.Message) }
Start-Sleep -Seconds 5
Say 'single.procCount' (@(Get-CimInstance Win32_Process -Filter "Name='FuFumidi.exe'" -ErrorAction SilentlyContinue).Count)
Get-Process FuFumidi -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Say 'done' '1'
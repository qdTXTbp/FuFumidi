# L4: dump the guest process list (names only) to see what is still alive.
# Pure ASCII only.
$ErrorActionPreference = 'Continue'
'--- all processes ---'
Get-Process | Sort-Object Name | ForEach-Object { $_.Name + '#' + $_.Id } | Out-String
'--- windows with FuFumidi in title ---'
Get-Process | Where-Object { $_.MainWindowTitle -like '*FuFumidi*' } | ForEach-Object { $_.Name + ' | ' + $_.MainWindowTitle } | Out-String
'--- temp dir ---'
$d = Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi\FuFumidiData\temp'
if (Test-Path $d) { (Get-ChildItem $d -Force | Select-Object -ExpandProperty Name) -join ',' } else { 'missing' }
'done = 1'
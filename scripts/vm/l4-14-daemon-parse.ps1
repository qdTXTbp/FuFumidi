# L4: is the generated daemon script parseable, and can bare "powershell.exe" be resolved?
# Pure ASCII only.
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }

$inst = Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'
$daemon = Join-Path $inst 'FuFumidiData\temp\fufumidi-restart.ps1'
Say 'daemon.exists' (Test-Path $daemon)
if (Test-Path $daemon) {
  Say 'daemon.bytes' (Get-Item $daemon).Length
  $errs = $null
  $tokens = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($daemon, [ref]$tokens, [ref]$errs)
  Say 'parse.errorCount' (@($errs).Count)
  if ($errs -and @($errs).Count -gt 0) { Say 'parse.first' ($errs[0].Message + ' @line ' + $errs[0].Extent.StartLineNumber) }
  # the asar path must have a real backslash (template-literal escaping used to eat it)
  $txt = Get-Content $daemon -Raw
  Say 'daemon.hasResourcesAppAsar' ($txt -like '*resourcesapp.asar*')
  Say 'daemon.hasResourcesBackslashAppAsar' ($txt -like '*resources\app.asar*')
}
Say 'powershell.bareName' (@(Get-Command powershell.exe -ErrorAction SilentlyContinue).Count)
Say 'systemRoot' $env:SystemRoot
Say 'psFullPath.exists' (Test-Path (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
Say 'envPath' $env:PATH.Substring(0, [Math]::Min(200, $env:PATH.Length))
Say 'done' '1'
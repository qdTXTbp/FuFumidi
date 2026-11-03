param(
  [Parameter(Mandatory=$true)][string]$Exe,
  [string]$ShotPath = "",
  [int]$MaxWaitSec = 20
)
$ErrorActionPreference = "Continue"
# DPI-aware so GetWindowRect / CopyFromScreen use physical pixels (this box runs at 250%)
if (-not ("DpiAware" -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DpiAware {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
}
[void][DpiAware]::SetProcessDPIAware()

$result = [ordered]@{}
$result.webview2_procs_before = @(Get-Process msedgewebview2 -ErrorAction SilentlyContinue).Count

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $Exe -PassThru
$handle = 0
while ($sw.Elapsed.TotalSeconds -lt $MaxWaitSec) {
  Start-Sleep -Milliseconds 100
  $p.Refresh()
  if ($p.HasExited) { break }
  if ($p.MainWindowHandle -ne 0) { $handle = $p.MainWindowHandle; break }
}
$result.time_to_window_s = [math]::Round($sw.Elapsed.TotalSeconds, 2)
$result.has_exited = $p.HasExited

# Wait 4s after the window appears so the webview JS finishes its IPC round trips.
Start-Sleep -Seconds 4
$p.Refresh()
$result.window_handle = [string]$handle
$result.window_title = $p.MainWindowTitle
$result.working_set_mb = [math]::Round($p.WorkingSet64 / 1MB, 1)
$result.private_mb = [math]::Round($p.PrivateMemorySize64 / 1MB, 1)
$result.threads = $p.Threads.Count
$wv = @(Get-Process msedgewebview2 -ErrorAction SilentlyContinue)
$result.webview2_procs_after = $wv.Count
if ($wv.Count -gt 0) {
  $result.webview2_working_set_mb = [math]::Round((($wv | Measure-Object WorkingSet64 -Sum).Sum) / 1MB, 1)
}
$result.window_present = ($p.HasExited -eq $false -and $handle -ne 0)

if ($p.HasExited -eq $false -and $handle -ne 0 -and $ShotPath -ne "") {
  Add-Type -AssemblyName System.Drawing
  if (-not ("Win32Shot" -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Shot {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
}
"@
  }
  # Bring our own window to the front + topmost, otherwise CopyFromScreen captures whatever covers it.
  [void][Win32Shot]::ShowWindow([IntPtr]$handle, 9)
  [void][Win32Shot]::SetWindowPos([IntPtr]$handle, [IntPtr](-1), 0, 0, 0, 0, 0x0043)
  [void][Win32Shot]::SetForegroundWindow([IntPtr]$handle)
  Start-Sleep -Milliseconds 900

  $r = New-Object Win32Shot+RECT
  [void][Win32Shot]::GetWindowRect([IntPtr]$handle, [ref]$r)
  $w = $r.Right - $r.Left
  $h = $r.Bottom - $r.Top
  $result.window_rect = "$($r.Left),$($r.Top) ${w}x${h}"
  $result.screenshot_method = ""
  if ($w -gt 0 -and $h -gt 0) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $ok = [Win32Shot]::PrintWindow([IntPtr]$handle, $hdc, 2)
    $g.ReleaseHdc($hdc)
    if ($ok) { $result.screenshot_method = "PrintWindow" }
    else {
      $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
      $result.screenshot_method = "CopyFromScreen"
    }
    $bmp.Save($ShotPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    $result.screenshot = $ShotPath
  }
}

if ($p.HasExited -eq $false) { Stop-Process -Id $p.Id -Force }
Start-Sleep -Milliseconds 900
$result.webview2_procs_after_kill = @(Get-Process msedgewebview2 -ErrorAction SilentlyContinue).Count
$result | ConvertTo-Json -Compress

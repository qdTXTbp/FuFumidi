# 测试虚拟机环境自检：在 guest 内运行，输出落到 guest-run.ps1 取回的 out.txt。
# 用于每轮测试前确认「干净基线」是否符合 docs/TESTING.md 第 2 节的规格。
$ErrorActionPreference = 'Continue'

'=== OS ==='
$os = Get-CimInstance Win32_OperatingSystem
'Caption  : ' + $os.Caption
'Version  : ' + $os.Version + '  (Build ' + $os.BuildNumber + ')'
'Arch     : ' + $os.OSArchitecture
'Install  : ' + $os.InstallDate

'=== 身份 ==='
'User     : ' + $env:USERNAME
'Computer : ' + $env:COMPUTERNAME
'Admin    : ' + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

'=== 时间 ==='
'TimeZone : ' + (Get-TimeZone).Id
'Local    : ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
'Utc      : ' + (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss')
'w32time  : ' + (Get-Service w32time).Status

'=== 硬件 ==='
$cs = Get-CimInstance Win32_ComputerSystem
'CPU      : ' + (Get-CimInstance Win32_Processor).Name
'vCPU     : ' + $cs.NumberOfLogicalProcessors
'RAM(GB)  : ' + [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
$d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
'C: 总/剩余(GB): ' + [math]::Round($d.Size / 1GB, 1) + ' / ' + [math]::Round($d.FreeSpace / 1GB, 1)

'=== 显示 ==='
Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
'Resolution: ' + $b.Width + 'x' + $b.Height

'=== 网络 ==='
$ip = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -ne '127.0.0.1' } | Select-Object -First 1
'IPv4     : ' + $ip.IPAddress
$dns = Get-DnsClientServerAddress -AddressFamily IPv4 | Where-Object { $_.ServerAddresses } | Select-Object -First 1
'DNS      : ' + ($dns.ServerAddresses -join ', ')

function Test-Url([string]$u) {
  try {
    $r = Invoke-WebRequest -Uri $u -Method Head -TimeoutSec 20 -UseBasicParsing
    return 'HTTP ' + [int]$r.StatusCode
  } catch {
    return '失败: ' + $_.Exception.Message
  }
}
'github.com     : ' + (Test-Url 'https://github.com')
'huggingface.co : ' + (Test-Url 'https://huggingface.co')
'objects.githubusercontent.com : ' + (Test-Url 'https://objects.githubusercontent.com')

'=== 待测环境（应为空）==='
$paths = @(
  "$env:LOCALAPPDATA\Programs\FuFumidi",
  "$env:ProgramFiles\FuFumidi",
  "$env:APPDATA\FuFumidi"
)
foreach ($p in $paths) { $p + ' -> ' + (Test-Path $p) }
'已安装程序（含 FuFumidi）:'
Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
                 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName } | Select-Object -ExpandProperty DisplayName | Sort-Object

'=== Guest Additions ==='
$ga = 'C:\Program Files\Oracle\VirtualBox Guest Additions\VBoxService.exe'
'VBoxService: ' + (Test-Path $ga) + '  运行: ' + ((Get-Service VBoxService -ErrorAction SilentlyContinue).Status)

'=== 安全 ==='
(Get-MpComputerStatus -ErrorAction SilentlyContinue | Select-Object -Property AMServiceEnabled, RealTimeProtectionEnabled, AntivirusEnabled | Format-List | Out-String)

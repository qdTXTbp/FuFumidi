# L3 step: run EVERY transcription model once and report a per-model verdict.
# Why this step exists: "installed" != "usable". A model can need CUDA (Aria-AMT) or its wheel can be
# built for a different Python ABI; only a real run proves it. Output is machine-readable:
#   model.<name>.ok / model.<name>.notes / model.<name>.error, plus torch+cuda and ONNX providers.
$ErrorActionPreference = "Continue"

$cands = @()
$cands += Join-Path $env:LOCALAPPDATA "Programs\FuFumidi"
$cands += Join-Path $env:ProgramFiles "FuFumidi"
$app = $null
foreach ($c in $cands) { if (Test-Path (Join-Path $c "resources\python\python.exe")) { $app = $c; break } }
if (-not $app) {
  $k = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*","HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue |
       Where-Object { $_.DisplayName -like "*FuFumidi*" } | Select-Object -First 1
  if ($k -and $k.InstallLocation -and (Test-Path (Join-Path $k.InstallLocation.TrimEnd("\") "resources\python\python.exe"))) { $app = $k.InstallLocation.TrimEnd("\") }
}
if (-not $app) { Write-Output "model.app = 0"; Write-Output "done = 1"; exit 0 }
Write-Output ("model.app = " + $app)
$py  = Join-Path $app "resources\python\python.exe"
$eng = Join-Path $app "resources\app.asar.unpacked\engine\music2midi.py"
if (-not (Test-Path $eng)) { Write-Output "model.engine = 0"; Write-Output "done = 1"; exit 0 }

# --- runtime state: torch/CUDA and ONNX providers (is the GPU pack really usable?) ---
$statePy = Join-Path $env:TEMP "fufumidi-state.py"
@'
import json
d = {}
try:
    import torch
    d["torch"] = torch.__version__
    d["cuda"] = bool(torch.cuda.is_available())
except Exception as e:
    d["torch"] = "ERR: " + str(e)[:80]
    d["cuda"] = False
try:
    import onnxruntime as o
    d["ort"] = o.get_available_providers()
except Exception as e:
    d["ort"] = []
print("###STATE" + json.dumps(d))
'@ | Set-Content -LiteralPath $statePy -Encoding ASCII
$st = (& $py $statePy 2>&1 | Where-Object { $_ -like "###STATE*" }) -replace "###STATE", ""
Write-Output ("model.torch = " + $st)

# --- synthesize a 6 s test tone (no external asset needed on the guest) ---
$wav = Join-Path $env:TEMP "fufumidi-model-test.wav"
$genPy = Join-Path $env:TEMP "fufumidi-make-audio.py"
@'
import sys
import numpy as np
import soundfile as sf
sr = 22050
t = np.arange(int(sr * 6)) / sr
y = np.zeros_like(t)
for f in (261.63, 329.63, 392.0):
    y = y + 0.25 * np.sin(2 * np.pi * f * t) * np.exp(-2.0 * (t % 1.0))
sf.write(sys.argv[1], y.astype("float32"), sr)
print("wrote")
'@ | Set-Content -LiteralPath $genPy -Encoding ASCII
$null = & $py $genPy $wav 2>&1
if (-not (Test-Path $wav)) { Write-Output "model.audio = 0"; Write-Output "done = 1"; exit 0 }
Write-Output "model.audio = 1"

$out = Join-Path $env:TEMP "fufumidi-model-out"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$cases = @(
  @{ name = "universal_basic";      args = @("--mode","universal");                                            needCuda = $false },
  @{ name = "universal_muscriptor"; args = @("--mode","universal","--model","muscriptor","--model-size","small"); needCuda = $false },
  @{ name = "piano_pt";             args = @("--mode","piano","--model","piano_pt");                            needCuda = $false },
  @{ name = "piano_transkun";       args = @("--mode","piano","--model","transkun");                            needCuda = $false },
  @{ name = "piano_aria";           args = @("--mode","piano","--model","aria");                                needCuda = $true  }
)
foreach ($c in $cases) {
  $mid = Join-Path $out ($c.name + ".mid")
  if (Test-Path $mid) { Remove-Item $mid -Force }
  $a = @("convert", $wav, "-o", $mid) + $c.args
  $log = (& $py $eng @a 2>&1 | Out-String)
  $m = [regex]::Match($log, "###RESULT (\{.*\})")
  $notes = 0
  if ($m.Success) { try { $notes = [int](($m.Groups[1].Value | ConvertFrom-Json).note_count) } catch { $notes = 0 } }
  Write-Output ("model." + $c.name + ".ok = " + $(if ($notes -gt 0) { 1 } else { 0 }))
  Write-Output ("model." + $c.name + ".notes = " + $notes)
  if ($notes -le 0) {
    $tail = ($log -split "`n" | Where-Object { $_ -match "Error|error|Assertion|No module" } | Select-Object -Last 1)
    Write-Output ("model." + $c.name + ".error = " + ([string]$tail).Trim())
    # Aria-AMT needs CUDA. A GPU-less guest has no passthrough, so failure here is EXPECTED --
    # but it must fail cleanly (no crash, no silent empty output).
    $pack = Join-Path $app "FuFumidiData\gpu-enhancements\cuda"
    if ($c.needCuda -and -not (Test-Path $pack)) { Write-Output ("model." + $c.name + ".expected = needs-cuda-no-gpu-pack") }
  }
}
Write-Output "done = 1"

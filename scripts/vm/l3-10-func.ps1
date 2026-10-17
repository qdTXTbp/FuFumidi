# L3 step: functional plumbing for transcribe / tuning / cover (pure ASCII).
# The offline VM has no downloaded models, so this step proves the packaged runtime and
# engine modules are loadable, and reports which model assets are missing.
$ErrorActionPreference = 'Continue'
function Say($k, $v) { Write-Output ($k + ' = ' + $v) }
$cands = @((Join-Path $env:LOCALAPPDATA 'Programs\FuFumidi'), (Join-Path $env:ProgramFiles 'FuFumidi'))
$inst = $cands | Where-Object { Test-Path (Join-Path $_ 'FuFumidi.exe') } | Select-Object -First 1
Say 'func.app' ($inst)
if (-not $inst) { Say 'done' '0'; exit 2 }
$py = Join-Path $inst 'resources\python\python.exe'
Say 'func.python.exists' (Test-Path $py)
Say 'func.runtime.dll312' (Test-Path (Join-Path $inst 'resources\python\python312.dll'))
Say 'func.runtime.dll311' (Test-Path (Join-Path $inst 'resources\python\python311.dll'))
$v = & $py -V 2>&1 | Out-String
Say 'func.python.version' ($v.Trim())
$eng = Join-Path $inst 'resources\app.asar.unpacked\engine'
if (-not (Test-Path $eng)) { $eng = Join-Path $inst 'resources\engine' }
Say 'func.engine.dir' $eng
$pyFile = Join-Path $env:TEMP 'fufumidi-func-check.py'
$lines = @()
$lines += 'import sys, os'
$lines += 'eng = sys.argv[1]'
$lines += 'sys.path.insert(0, eng)'
$lines += 'mods = ["engine_diffsinger", "engine_gpt_sovits", "engine_cover", "engine_msst", "engine_omr"]'
$lines += 'for m in mods:'
$lines += '    try:'
$lines += '        __import__(m)'
$lines += '        print("func.mod." + m + " = 1")'
$lines += '    except Exception as e:'
$lines += '        print("func.mod." + m + " = 0")'
$lines += '        print("func.mod." + m + ".error = " + str(e)[:150].replace(chr(10), " "))'
$lines += 'md = os.environ.get("FUFUMIDI_MODELS_DIR", "")'
$lines += 'print("func.modelsDir = " + md)'
$lines += 'for sub in ["hnsep", "gpt-sovits", "diffsinger"]:'
$lines += '    p = os.path.join(md, sub) if md else ""'
$lines += '    print("func.asset." + sub + " = " + ("1" if p and os.path.isdir(p) else "0"))'
[System.IO.File]::WriteAllLines($pyFile, $lines)
$env:FUFUMIDI_MODELS_DIR = Join-Path $inst 'FuFumidiData\models'
Say 'func.modelsDir' $env:FUFUMIDI_MODELS_DIR
& $py $pyFile $eng 2>&1 | ForEach-Object { Write-Output ('    ' + $_) }
Say 'done' '1'

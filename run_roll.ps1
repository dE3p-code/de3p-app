# Launcher voor de wekelijkse schema-roll (maandag). Voert de roll echt uit.
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

$venvPy = Join-Path $dir ".venv\Scripts\python.exe"
if (Test-Path $venvPy) {
    $py = $venvPy
} else {
    $py = "C:\Users\jensd\AppData\Local\Programs\Python\Python312\python.exe"
}

$env:PYTHONIOENCODING = "utf-8"
& $py (Join-Path $dir "weekly_roll.py") --apply
exit $LASTEXITCODE

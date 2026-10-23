# Launcher voor de Windows Taakplanner. Draait 1 sync-cyclus.
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

$venvPy = Join-Path $dir ".venv\Scripts\python.exe"
if (Test-Path $venvPy) {
    $py = $venvPy
} else {
    $py = "C:\Users\jensd\AppData\Local\Programs\Python\Python312\python.exe"
}

& $py (Join-Path $dir "strava_sync.py") --once
exit $LASTEXITCODE

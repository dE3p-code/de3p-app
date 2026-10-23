# Bouwt dE3p als Windows-programma (geen Python nodig bij de gebruiker).
#
#   powershell -ExecutionPolicy Bypass -File build_windows.ps1
#
# Resultaat:
#   dist\dE3p\dE3p.exe                    (map met het programma)
#   release\dE3p-Windows.zip              (dit geef je door, met de handleiding erin)
#   release\dE3p-Strava-Sync-Windows.zip  (zelfde, + dE3p Strava Sync.exe: voor 'Nu bijwerken' in versies <= 1.9.6)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (Test-Path 'app\_mock') { throw 'Verwijder eerst app\_mock (testdata hoort niet in het pakket).' }
$py = '.\.venv\Scripts\python.exe'
& $py -m pip install --quiet --disable-pip-version-check pyinstaller segno cryptography
if ($LASTEXITCODE) { throw 'PyInstaller installeren mislukt.' }

$version = (& $py -c "import userdata; print(userdata.VERSION)").Trim()
Write-Host "dE3p $version bouwen..."
# handleiding eerst: die gaat mee in het programma (knop in Instellingen) en in de zip
& $py 'docs\build_handleiding.py'
if ($LASTEXITCODE) { throw 'Handleiding bouwen mislukt.' }
& $py -m PyInstaller --noconfirm --clean --windowed --log-level WARN `
    --name 'dE3p' --icon 'assets\de3p-logo.ico' `
    --add-data 'app;app' --add-data 'assets;assets' --add-data 'docs\Handleiding.html;docs' `
    --exclude-module tkinter --exclude-module notion_api --exclude-module weekly_roll `
    app.py
if ($LASTEXITCODE) { throw 'Bouwen mislukt.' }

# zip: programmamap + handleiding
$stage = 'release\stage'
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item 'dist\dE3p' $stage -Recurse
Copy-Item 'docs\Handleiding.html' "$stage\Handleiding dE3p.html"
$zip = 'release\dE3p-Windows.zip'
Remove-Item $zip, 'release\dE3p-Strava-Sync-Windows.zip' -Force -ErrorAction SilentlyContinue
# Python i.p.v. Compress-Archive: die schrijft paden met '\', wat andere uitpakkers verkeerd lezen
& $py -c "import shutil; shutil.make_archive(r'release\dE3p-Windows', 'zip', r'$stage')"
if ($LASTEXITCODE) { throw 'Zip maken mislukt.' }
# oude versies zoeken bij 'Nu bijwerken' dE3p-Strava-Sync-Windows.zip met 'dE3p Strava Sync.exe' en starten die daarna
Copy-Item "$stage\dE3p\dE3p.exe" "$stage\dE3p\dE3p Strava Sync.exe"
& $py -c "import shutil; shutil.make_archive(r'release\dE3p-Strava-Sync-Windows', 'zip', r'$stage')"
if ($LASTEXITCODE) { throw 'Zip maken mislukt.' }
Remove-Item $stage -Recurse -Force
$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "Klaar: $zip ($mb MB)"

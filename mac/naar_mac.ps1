# Verzamelt alles van dE3p dat NIET op GitHub staat (je sleutels, gegevens, Garmin- en gsm-koppeling)
# en je recap-kaarten in een map, bv. op je USB-stick. Op de Mac zet je die map terug in strava-automation
# (zie mac/VERHUIS-NAAR-MAC.md). Doe dit als laatste op de pc, vlak voor je hem wist of weggeeft.
#
#   powershell -ExecutionPolicy Bypass -File mac\naar_mac.ps1 E:\dE3p-naar-mac
param([string]$Doel = "E:\dE3p-naar-mac")
$ErrorActionPreference = "Stop"
$src = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
New-Item -ItemType Directory -Force $Doel | Out-Null
Write-Host "dE3p -> $Doel"

$bestanden = ".env", "config.json", "state.json", "blocks.json", "cache.json", "extra.json", "plan.json",
             "garmin.json", "gsm_gezondheid.json", "gsm_inbox.json"
foreach ($f in $bestanden) {
    $p = Join-Path $src $f
    if (Test-Path $p) { Copy-Item $p $Doel -Force; Write-Host "  ok  $f" }
}
$g = Join-Path $src "garmin"
if (Test-Path $g) {
    robocopy $g (Join-Path $Doel "garmin") /E /NFL /NDL /NJH /NJS | Out-Null
    Write-Host "  ok  garmin\ (Garmin-koppeling)"
}

# je recap-kaarten: de map uit je instellingen (installeer.sh zet ze op de Mac in ~/Pictures/dE3p)
$cfg = Get-Content (Join-Path $src "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if ($cfg.cards_dir -and (Test-Path $cfg.cards_dir)) {
    robocopy $cfg.cards_dir (Join-Path $Doel "kaarten-van-pc") /E /NFL /NDL /NJH /NJS | Out-Null
    Write-Host "  ok  kaarten"
}

$mb = [math]::Round(((Get-ChildItem $Doel -Recurse -Force | Measure-Object Length -Sum).Sum) / 1MB, 1)
Write-Host ""
Write-Host "Klaar ($mb MB). Let op: hierin staan je sleutels (.env) - wis de map van de stick na de verhuis."
Write-Host "Gebruik dE3p daarna niet meer op deze pc, anders werken pc en Mac tegelijk."
exit 0

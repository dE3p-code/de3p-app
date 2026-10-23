# Registreert twee geplande taken:
#   1. StravaAutoSync   -> elke 15 min: titels zetten + trainingen loggen
#   2. StravaWeeklyRoll -> elke maandag 05:30: week archiveren + nieuwe weken genereren
# Run eenmalig:  powershell -ExecutionPolicy Bypass -File install_task.ps1
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -MultipleInstances IgnoreNew

# --- Taak 1: sync elke 15 minuten ---
$syncName = "StravaAutoSync"
$syncAction = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $dir 'run.ps1')`""
$syncTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 15)
if (Get-ScheduledTask -TaskName $syncName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $syncName -Confirm:$false
}
Register-ScheduledTask -TaskName $syncName -Action $syncAction -Trigger $syncTrigger `
    -Settings $settings -Description "Zet Strava-titels en logt naar Notion (elke 15 min)" | Out-Null
Write-Host "Taak '$syncName' geinstalleerd (elke 15 min)."

# --- Taak 2: wekelijkse roll, maandag 05:30 ---
$rollName = "StravaWeeklyRoll"
$rollAction = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $dir 'run_roll.ps1')`""
$rollTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 5:30AM
if (Get-ScheduledTask -TaskName $rollName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $rollName -Confirm:$false
}
Register-ScheduledTask -TaskName $rollName -Action $rollAction -Trigger $rollTrigger `
    -Settings $settings -Description "Archiveert de week en genereert nieuwe weken (maandag)" | Out-Null
Write-Host "Taak '$rollName' geinstalleerd (maandag 05:30)."

Write-Host ""
Write-Host "Testen:  Start-ScheduledTask -TaskName $syncName"
Write-Host "         python weekly_roll.py --dry-run   (roll eerst droog testen!)"
Write-Host "Verwijderen:  Unregister-ScheduledTask -TaskName <naam> -Confirm:`$false"

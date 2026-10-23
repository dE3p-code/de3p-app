@echo off
title Strava Sync - dE3p
cd /d "%~dp0"
echo ==================================================
echo    STRAVA SYNC  -  titels zetten + Notion loggen
echo ==================================================
echo.
echo Bezig met synchroniseren met Strava...
echo.
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" strava_sync.py --once
) else (
  python strava_sync.py --once
)
echo.
echo ==================================================
echo    Klaar. Druk op een toets om dit venster te sluiten.
echo ==================================================
pause >nul

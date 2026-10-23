# Strava → automatische titel + Notion-marathonschema

Draait lokaal op deze PC. Telkens er een nieuwe Strava-activiteit is:

1. leest de echte cijfers + PR's van Strava;
2. zet een beschrijvende titel in jouw stijl
   (harde cijfers via vaste regels, verwoording via lokale **Ollama / mistral-nemo**);
3. logt de training in het juiste dag-vak van de **huidige week** in je Notion-schema.

> Temperatuur staat niet in de auto-titels: de Strava-API levert geen weerdata.

---

## Eenmalige setup

### 1. Python-omgeving
```powershell
cd D:\strava-automation
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

### 2. Config
Kopieer `.env.example` naar `.env` (al gedaan als `.env` bestaat) en vul aan.

### 3. Strava API (alleen jij kan dit)
1. Ga naar <https://www.strava.com/settings/api> en maak een applicatie.
2. **Authorization Callback Domain** → `localhost`.
3. Zet **Client ID** en **Client Secret** in `.env`.
4. Haal je refresh token op:
   ```powershell
   .\.venv\Scripts\python.exe get_strava_token.py
   ```
   Er opent een browser → **Authorize**. De token wordt naar `.env` geschreven.

### 4. Notion API
1. Ga naar <https://www.notion.so/my-integrations> → **New integration** (intern).
2. Kopieer het **Internal Integration Secret** → `NOTION_TOKEN` in `.env`.
3. Open de pagina *Marathon Antwerpen — Trainingsschema* in Notion →
   `•••` → **Connections** → voeg je integratie toe.
   (`NOTION_PAGE_ID` staat al ingevuld.)

### 5. Testen (schrijft niets weg)
```powershell
.\.venv\Scripts\python.exe strava_sync.py --once --dry-run
.\.venv\Scripts\python.exe strava_sync.py --backfill 3 --dry-run
```
Tevreden? Laat `--dry-run` weg om het echt te doen.

### 6. Automatisch laten draaien (elke 15 min)
```powershell
powershell -ExecutionPolicy Bypass -File install_task.ps1
```

---

## Wekelijkse roll (archiveren + nieuwe weken)
`weekly_roll.py` houdt het schema automatisch 2 weken vooruit. Zodra een nieuwe
week begint (maandag):
1. archiveert de afgewerkte week als subpagina onder *Voltooide weken* (met de
   echte, ingevulde tabel);
2. genereert vers de nieuwe huidige + volgende week via `marathon_plan.py`
   (deterministische marathonopbouw met cutback-weken en automatische taper naar
   18 okt — inclusief een racedag-rij).

Het doet **niets** zolang de getoonde huidige week nog actueel is.

> ⚠️ De plan-opbouw is regelgebaseerd (`marathon_plan.py` bovenaan aanpasbaar:
> volume, paces, piek). De fijne coaching-bijsturing op je gevoel blijft mensen-/
> Claude-werk; dit genereert een verstandig standaardplan dat je kan tweaken.

## Gebruik / commando's
| Commando | Wat |
|---|---|
| `strava_sync.py --once` | één sync-cyclus (Taakplanner) |
| `strava_sync.py --once --dry-run` | tonen, niets wegschrijven |
| `strava_sync.py --backfill 5` | laatste 5 dagen opnieuw bekijken |
| `weekly_roll.py --preview` | toon de 2 gegenereerde weken (geen Notion) |
| `weekly_roll.py --dry-run` | lees Notion, toon wat de roll zou doen |
| `weekly_roll.py --apply` | voer de roll echt uit |
| `marathon_plan.py` | print het plan van de komende 6 weken |
| `Start-ScheduledTask -TaskName StravaAutoSync` | sync nu één keer draaien |

Logs: `logs\sync.log`. Verwerkte activiteiten: `state.json`.
**Test de roll eerst droog:** `python weekly_roll.py --dry-run` voor je hem laat
draaien — hij herschrijft de actieve weken op de hoofdpagina.

## Veiligheidsregels in de code
- Titel wordt **alleen overschreven** als de huidige naam nog een Strava-standaardnaam
  is (bv. "Morning Ride", "Ochtendloop") — handmatige titels blijven staan.
- Ollama mag enkel verwoorden; een titel zonder de correcte afstand/pace/snelheid
  wordt verworpen en vervangen door de kanonieke (vaste-regel) titel.
- Een Notion-dagrij die al `✅` heeft, wordt niet overschreven.
- De **schema-opbouw + coaching** (volgende weken aanpassen) blijft handwerk/AI —
  de automation vult enkel de afgewerkte training in.

## Wat dit (nog) niet doet
- Temperatuur in titels (geen weerdata via Strava-API).
- Fijne coaching-bijsturing op je gevoel/vermoeidheid: de roll genereert een
  verstandig regel-plan; nuance-aanpassingen blijven mensen-/Claude-werk.

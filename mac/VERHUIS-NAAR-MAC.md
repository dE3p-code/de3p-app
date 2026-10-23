# dE3p verhuizen van de pc naar je MacBook

Alles wat je nu op de pc hebt, werkt daarna op de Mac:
- het programma, met je koppelingen (Strava, Garmin, Notion);
- de kopie naar je gsm (de koppeling met je gsm verhuist mee);
- elk half uur syncen;
- maandag je schema doorschuiven en zondag je weekrapport;
- je recap-kaarten en de lokale AI.

De code staat op GitHub (`dE3p-code/strava-automation`). Je sleutels en gegevens staan daar níét op, die neem je mee op je USB-stick.

## A. Op de pc: als laatste, vlak voor je hem wist of weggeeft

1. Steek je USB-stick in de pc.
2. Open PowerShell en voer uit:
   ```
   cd D:\PROJECT\strava-automation
   powershell -ExecutionPolicy Bypass -File mac\naar_mac.ps1 E:\dE3p-naar-mac
   ```
   `E:` is je stick; pas de letter aan als het een andere is. Het script kopieert:
   - `.env` (je sleutels);
   - je gegevens (`config.json`, `state.json`, …);
   - de Garmin-koppeling (map `garmin\`);
   - je kaarten.

   Samen enkele MB.
3. Gebruik dE3p daarna niet meer op de pc.

## B. Op de MacBook

1. **Homebrew**: open *Terminal* en plak de installatieregel van https://brew.sh. Volg wat het zegt: op het einde moet je nog 2 regels plakken.
2. **Git en GitHub**:
   ```
   brew install git gh node
   gh auth login
   ```
   Bij `gh auth login` kies je GitHub.com en log je in via de browser.
3. **De code ophalen**:
   ```
   mkdir -p ~/dE3p && cd ~/dE3p
   gh repo clone dE3p-code/strava-automation
   gh repo clone dE3p-code/de3p-be
   ```
4. **Je gegevens van de stick erin**. Steek de stick in de Mac; hij heet bv. `KINGSTON`:
   ```
   cp -R /Volumes/KINGSTON/dE3p-naar-mac/. ~/dE3p/strava-automation/
   ```
   De `/.` op het einde zorgt dat ook het verborgen bestand `.env` meegaat.
5. **Installeren**: dit duurt 5 à 10 minuten, de lokale AI is ±7 GB.
   ```
   cd ~/dE3p/strava-automation
   bash mac/installeer.sh
   ```
6. **Openen**: in Finder → *Apps* in je thuismap → **dE3p**. Sleep het naar je Dock.
   - Druk één keer op *Bijwerken*.
   - Op je gsm moet daarna "bijgewerkt" de tijd van nu tonen.
7. **De stick leegmaken**: wis de map `dE3p-naar-mac` van de stick, want daar staan je sleutels in.

### Als iets niet lukt
- **Garmin vraagt opnieuw in te loggen**: tandwiel → Koppelingen → Garmin.
- **De website deployen** (www.de3p.be): log één keer in met `npx wrangler login`. Daarna gaat het zoals op de pc.
- **De echte iPhone-app** (Apple Watch): zie `mobile/LEESMIJ.md`. Daarvoor heb je Xcode nodig, en dat kan nu op je Mac.
- **Claude Code**: installeer de Claude-app voor Mac (claude.ai/download). Open dan de map `~/dE3p`, en Claude kan verder zoals op de pc.

## Wat er niet mee verhuist
Wat op de pc nog van het gamen was, verdwijnt met de pc:
- de Minecraft-server en -back-ups;
- de Discord-bot;
- de tellers (TikTok, donaties, speeltijd);
- de KV-back-up van de oude website.

Voor dE3p heb je die niet nodig.

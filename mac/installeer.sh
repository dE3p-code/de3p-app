#!/usr/bin/env bash
# dE3p op je eigen Mac, vanaf de broncode (zoals op de pc). Eén keer uitvoeren, in Terminal:
#
#   cd ~/dE3p/strava-automation
#   bash mac/installeer.sh
#
# Wat het doet:
#   1. Python 3.12 (Homebrew) en een eigen Python-omgeving (.venv) met alle pakketten
#   2. je gegevens van de pc controleren (.env, config.json, …) en je kaarten in ~/Pictures/dE3p zetten
#   3. Ollama + het taalmodel voor titels en doelen in je eigen woorden
#   4. de vaste taken (launchd), zoals de Taakplanner op de pc:
#        - elk half uur syncen (Strava, Garmin, Notion, kopie naar je gsm)
#        - maandag 05:30 je Notion-schema een week doorschuiven
#        - zondag 20:30 je weekrapport
#   5. dE3p in je map Apps (met het dE3p-logo), zodat je het in het Dock kan zetten
#   6. een controle (--check)
#
# Opnieuw uitvoeren mag altijd: het slaat over wat er al is.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="$(pwd)"
UIDN="$(id -u)"
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
let_op() { printf '  \033[33m!\033[0m %s\n' "$1"; }
stap() { printf '\n\033[1m%s\033[0m\n' "$1"; }

stap "1. Python"
if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew ontbreekt. Installeer het eerst (één regel, zie https://brew.sh) en voer dit script opnieuw uit."
  exit 1
fi
brew list python@3.12 >/dev/null 2>&1 || brew install python@3.12
PY="$(brew --prefix python@3.12)/bin/python3.12"
[ -x .venv/bin/python ] || "$PY" -m venv .venv
.venv/bin/python -m pip install --quiet --disable-pip-version-check --upgrade pip
.venv/bin/python -m pip install --quiet --disable-pip-version-check -r requirements.txt
ok "Python $(.venv/bin/python -c 'import sys; print(sys.version.split()[0])') met alle pakketten"

stap "2. Je gegevens van de pc"
missing=0
for f in .env config.json state.json; do
  if [ -f "$f" ]; then ok "$f"; else let_op "$f ontbreekt"; missing=1; fi
done
[ -d garmin ] && ok "Garmin-koppeling" || let_op "map garmin ontbreekt (Garmin opnieuw koppelen in dE3p kan ook)"
if [ "$missing" = 1 ]; then
  let_op "Zet eerst de verhuismap van je USB-stick in deze map (zie mac/VERHUIS-NAAR-MAC.md)."
fi
CARDS="$HOME/Pictures/dE3p"
mkdir -p "$CARDS"
if [ -d "kaarten-van-pc" ]; then                          # meegebracht door naar_mac.ps1
  rsync -a "kaarten-van-pc/" "$CARDS/" && rm -rf "kaarten-van-pc"
  ok "kaarten verhuisd naar $CARDS"
fi
# het Windows-pad van je kaartenmap vervangen door die op de Mac
.venv/bin/python - "$CARDS" <<'EOF'
import json, re, sys
from pathlib import Path
p, cards = Path("config.json"), sys.argv[1]
if p.exists():
    c = json.loads(p.read_text(encoding="utf-8"))
    if re.match(r"^[A-Za-z]:[\\/]", str(c.get("cards_dir") or "")) or not c.get("cards_dir"):
        c["cards_dir"] = cards
        p.write_text(json.dumps(c, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"  \033[32m✓\033[0m kaartenmap: {cards}")
EOF

stap "3. Lokale AI (titels en doelen in je eigen woorden)"
if ! command -v ollama >/dev/null 2>&1; then
  brew install ollama
fi
brew services start ollama >/dev/null 2>&1 || true
sleep 2
if ollama list 2>/dev/null | grep -q "mistral-nemo"; then ok "mistral-nemo staat er al"
else ollama pull mistral-nemo && ok "mistral-nemo gedownload" || let_op "mistral-nemo niet gedownload (later: ollama pull mistral-nemo)"; fi

stap "4. Vaste taken"
# elk half uur syncen: zelfde code als de knop in dE3p (Instellingen → Programma)
.venv/bin/python -c "import app; app.Api(False).set_auto_sync(True)" && ok "elk half uur syncen"
taak() {   # label, weekdag (0 = zondag), uur, minuut, script [argumenten]
  local label="$1" wd="$2" h="$3" m="$4"; shift 4
  local plist="$HOME/Library/LaunchAgents/$label.plist"
  local args=""
  for a in "$DIR/.venv/bin/python" "$@"; do args="$args<string>$a</string>"; done
  mkdir -p "$HOME/Library/LaunchAgents" "$DIR/logs"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>$args</array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict><key>PYTHONIOENCODING</key><string>utf-8</string></dict>
  <key>StartCalendarInterval</key><dict><key>Weekday</key><integer>$wd</integer><key>Hour</key><integer>$h</integer><key>Minute</key><integer>$m</integer></dict>
  <key>StandardOutPath</key><string>$DIR/logs/$label.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/$label.log</string>
</dict></plist>
PLIST
  launchctl bootout "gui/$UIDN" "$plist" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$UIDN" "$plist" 2>/dev/null || launchctl load -w "$plist"
}
taak be.de3p.weekroll 1 5 30 "$DIR/weekly_roll.py" --apply && ok "maandag 05:30: schema een week doorschuiven"
taak be.de3p.weekrapport 0 20 30 "$DIR/week_report.py" && ok "zondag 20:30: weekrapport"
echo "    (Gemist omdat je Mac dicht was? launchd doet het zodra hij weer wakker is.)"

stap "5. dE3p in je map Apps"
APP="$HOME/Applications/dE3p.app"
mkdir -p "$HOME/Applications"
rm -rf "$APP"
osacompile -o "$APP" -e "do shell script \"cd '$DIR' && nohup .venv/bin/python app.py >/dev/null 2>&1 &\"" >/dev/null
.venv/bin/python - "$APP" <<'EOF'
import sys
from pathlib import Path
from PIL import Image
app = Path(sys.argv[1])
Image.open("assets/icon.png").convert("RGBA").save(app / "Contents/Resources/applet.icns",
                                                    sizes=[(s, s) for s in (16, 32, 64, 128, 256, 512, 1024)])
EOF
touch "$APP"
ok "dE3p staat in ~/Applications (sleep het naar je Dock)"

stap "6. Controle"
if .venv/bin/python app.py --check >/dev/null 2>&1 && grep -q '"ok": true' logs/check.txt 2>/dev/null; then
  ok "alles werkt ($(cat logs/check.txt))"
else
  let_op "controle niet geslaagd, zie logs/check.txt"
fi
printf '\n\033[1mKlaar.\033[0m Open dE3p uit je map Apps (of: .venv/bin/python app.py).\n'

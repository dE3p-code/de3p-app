#!/usr/bin/env bash
# Bouwt dE3p als Mac-app (geen Python nodig bij de gebruiker).
# Enkel op een Mac; gebeurt automatisch via .github/workflows/mac.yml.
#
#   bash build_mac.sh
#
# Resultaat:
#   dist/dE3p.app
#   release/dE3p-Mac.zip        (app + handleiding)
set -euo pipefail
cd "$(dirname "$0")"

[ -d app/_mock ] && { echo "Verwijder eerst app/_mock (testdata hoort niet in het pakket)."; exit 1; }
PY=${PY:-python3}
$PY -m pip install --quiet --disable-pip-version-check -r requirements.txt pyinstaller

VERSION=$($PY -c "import userdata; print(userdata.VERSION)")
echo "dE3p $VERSION bouwen (Mac, $(uname -m))..."
$PY docs/build_handleiding.py

# Mac-icoon uit assets/icon.png
$PY - <<'EOF'
from PIL import Image
im = Image.open("assets/icon.png").convert("RGBA")
im.save("assets/de3p.icns", sizes=[(s, s) for s in (16, 32, 64, 128, 256, 512, 1024)])
EOF

$PY -m PyInstaller --noconfirm --clean --windowed --log-level WARN \
    --name "dE3p" --icon assets/de3p.icns \
    --osx-bundle-identifier be.de3p.stravasync \
    --add-data "app:app" --add-data "assets:assets" --add-data "docs/Handleiding.html:docs" \
    --exclude-module tkinter --exclude-module notion_api --exclude-module weekly_roll \
    app.py

# versie in Info.plist (Finder → Toon info)
PLIST="dist/dE3p.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string $VERSION" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :LSMinimumSystemVersion string 12.0" "$PLIST" 2>/dev/null || true
# na het aanpassen van Info.plist opnieuw (ad hoc) ondertekenen, anders weigert macOS de app
codesign --force --deep --sign - "dist/dE3p.app"

rm -rf release/stage && mkdir -p release/stage
cp -R "dist/dE3p.app" release/stage/
cp docs/Handleiding.html "release/stage/Handleiding dE3p.html"
rm -f release/dE3p-Mac.zip
# ditto bewaart de rechten en symlinks van de app (zip -r doet dat niet goed)
(cd release/stage && ditto -c -k --sequesterRsrc . ../dE3p-Mac.zip)
rm -rf release/stage
echo "Klaar: release/dE3p-Mac.zip ($(du -h release/dE3p-Mac.zip | cut -f1))"

"""
Bouwt de gsm-app dE3p (www.de3p.be) uit dezelfde schermen als het programma (app/).
Enkel web/bridge.js en co. zijn anders: die doen in de browser wat app.py op de computer doet.

  python web/build_web.py D:/dE3p/de3p-be/public --root   # de app op www.de3p.be zelf
  python web/build_web.py <map>                            # losse map (bv. voor de prentjes)
  python web/build_web.py mobile/www --native              # de echte app (iPhone, Capacitor): zie mobile/LEESMIJ.md

--root: enkel de bestanden van de app worden vervangen; de rest van de site (download/, assets/,
_headers, _redirects) blijft staan.
--native: zonder service worker en manifest, met Capacitor en de plugins (Apple Gezondheid, Browser)
uit mobile/node_modules als gewone scripts (geen bundler nodig).

Daarna in D:/dE3p/de3p-be: npx wrangler pages deploy public --project-name=de3p-be --branch=main
(functions/api/{strava,koppel,paar,spiegel} staan in de repo de3p-be).
"""
from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"
WEB = ROOT / "web"
sys.path.insert(0, str(ROOT))
import userdata  # noqa: E402

HEAD = """  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#0a0a0a">
  <meta name="color-scheme" content="dark light">
  <style>html { background: #0a0a0a; } @media (prefers-color-scheme: light) { html { background: #f6f6f5; } }</style>
  <meta name="description" content="dE3p: je trainingen, schema, recap-kaarten en gezondheid op je gsm. Van je computer of rechtstreeks van Strava.">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black">
  <meta name="apple-mobile-web-app-title" content="dE3p">
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="icon" href="app-192.png">
  <link rel="apple-touch-icon" href="apple-touch-icon.png">
"""
# de echte app: Capacitor zelf + plugins als gewone scripts (globals capacitorExports, capacitorHealth, capacitorBrowser)
NATIVE_HEAD = """  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark light">
  <style>html { background: #0a0a0a; } @media (prefers-color-scheme: light) { html { background: #f6f6f5; } }</style>
  <script src="capacitor.js"></script>
  <script src="web/vendor/browser.js"></script>
  <script src="web/vendor/health.js"></script>
"""
VENDOR = {"capacitor.js": "@capacitor/core/dist/capacitor.js",
          "web/vendor/browser.js": "@capacitor/browser/dist/plugin.js",
          "web/vendor/health.js": "@capgo/capacitor-health/dist/plugin.js"}

MANIFEST = {
    "id": "./", "name": "dE3p", "short_name": "dE3p", "lang": "nl",
    "description": "Je trainingen, schema, recap-kaarten en gezondheid op je gsm.",
    "start_url": "./", "scope": "./", "display": "standalone",
    "background_color": "#0a0a0a", "theme_color": "#0a0a0a",
    "icons": [
        {"src": "app-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
        {"src": "app-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
        {"src": "app-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
    ],
}


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    target = Path(args[0]) if args else ROOT / "build" / "web"
    into_root = "--root" in sys.argv
    native = "--native" in sys.argv
    if native and not target.is_absolute():
        target = Path.cwd() / target
    out = ROOT / "build" / "web" if into_root else target
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    for name in ("app.js", "app.css", "logo.png"):
        shutil.copy2(APP / name, out / name)
    shutil.copytree(APP / "fonts", out / "fonts")
    shutil.copytree(APP / "js", out / "js")
    shutil.copytree(APP / "img" / "strava", out / "img" / "strava")   # officiële Strava-knop en -logo (merkregels)
    (out / "web").mkdir()
    for f in WEB.glob("*"):
        if f.suffix in (".js", ".json", ".jpg") and f.name != "sw.js":
            shutil.copy2(f, out / "web" / f.name)
    for f in (WEB / "icons").glob("*.png"):
        shutil.copy2(f, out / f.name)
    if native:                                       # de app: Capacitor en plugins erbij, geen service worker
        mods = ROOT / "mobile" / "node_modules"
        for dst, src in VENDOR.items():
            if not (mods / src).exists():
                sys.exit(f"Ontbreekt: {mods / src}. Doe eerst 'npm install' in de map mobile.")
            (out / dst).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(mods / src, out / dst)
    else:
        shutil.copy2(WEB / "sw.js", out / "sw.js")          # offline; moet naast index.html staan
        (out / "manifest.webmanifest").write_text(json.dumps(MANIFEST, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    html = (APP / "index.html").read_text(encoding="utf-8")
    html = html.replace('<link rel="stylesheet" href="app.css">', (NATIVE_HEAD if native else HEAD) + '  <link rel="stylesheet" href="app.css">')
    html = html.replace('<script type="module" src="app.js"></script>',
                        f'<script type="module" src="web/bridge.js?v={userdata.VERSION}"></script>\n'
                        f'  <script type="module" src="app.js?v={userdata.VERSION}"></script>')
    assert "web/bridge.js" in html and ("capacitor.js" in html if native else "manifest.webmanifest" in html)
    (out / "index.html").write_text(html, encoding="utf-8")
    n = sum(1 for _ in out.rglob("*") if _.is_file())
    if into_root:                                   # in de site zetten zonder de rest te raken
        for item in out.iterdir():
            dst = target / item.name
            if dst.is_dir():
                shutil.rmtree(dst)
            elif dst.exists():
                dst.unlink()
            (shutil.copytree if item.is_dir() else shutil.copy2)(item, dst)
    print(f"gsm-app dE3p -> {target} ({n} bestanden)")


if __name__ == "__main__":
    main()

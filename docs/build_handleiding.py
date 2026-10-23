"""
Bouwt de handleiding uit handleiding.src.html. Afbeeldingen (docs/img) en de
lettertypes van het programma gaan in het bestand zelf, zodat het ook offline werkt.

  python docs/build_handleiding.py                 # → docs/Handleiding.html (gaat mee in de zip)
  python docs/build_handleiding.py --fragment X    # ook de losse pagina om online te delen
  python docs/build_handleiding.py --web MAP --size-win "41 MB" --size-mac "35 MB"
                                                   # webversie (index.html + img/) met downloadknoppen en video

Blokken tussen <!--web-->...<!--/web--> staan enkel in de webversie,
<!--offline-->...<!--/offline--> enkel in de handleiding die bij het programma zit.
"""
from __future__ import annotations

import argparse
import base64
import re
import shutil
import sys
from pathlib import Path

import segno

DOCS = Path(__file__).resolve().parent
ROOT = DOCS.parent
sys.path.insert(0, str(ROOT))
import userdata  # noqa: E402

FONTS = {"archivo": ROOT / "app" / "fonts" / "archivo-latin.woff2",
         "martian": ROOT / "app" / "fonts" / "martian-mono-latin.woff2"}
DOWNLOAD = "https://github.com/dE3p-code/strava-sync/releases/latest/download/dE3p-{}.zip"
QR = {"run": "https://www.de3p.be/"}
MIME = {".webp": "image/webp", ".png": "image/png", ".woff2": "font/woff2"}


def data_uri(p: Path) -> str:
    return f"data:{MIME[p.suffix]};base64,{base64.b64encode(p.read_bytes()).decode()}"


def only(src: str, keep: str) -> str:
    """Houd de blokken van `keep` ('web' of 'offline'), schrap die van de andere versie."""
    drop = "offline" if keep == "web" else "web"
    src = re.sub(rf"<!--{drop}-->.*?<!--/{drop}-->\n?", "", src, flags=re.S)
    return src.replace(f"<!--{keep}-->", "").replace(f"<!--/{keep}-->", "")


def qr_svg(url: str) -> str:
    svg = segno.make(url, error="m").svg_inline(scale=4, border=3, dark="#0A0A0A", light="#FFFFFF")
    return svg.replace("<svg ", '<svg role="img" aria-label="QR-code naar www.de3p.be" ', 1)


def fill(src: str, sizes: dict | None = None, img_dir: Path | None = None) -> str:
    """Vul de plaatshouders in. Met img_dir (webversie) worden de prentjes losse bestanden,
    zodat een gsm enkel de prentjes van het gekozen toestel laadt; anders zitten ze in het bestand."""
    def sub(m: re.Match) -> str:
        kind, name = m[1], m[2]
        if kind == "font":
            return data_uri(FONTS[name])
        if kind == "qr":
            return qr_svg(QR[name])
        p = next((DOCS / "img").glob(f"{name}.*"))
        if img_dir:
            shutil.copy2(p, img_dir / p.name)
            return f"img/{p.name}"
        return data_uri(p)
    sizes = sizes or {}
    names = {"windows": "Windows", "mac": "Mac", "mac-intel": "Mac-Intel"}
    src = re.sub(r"\{\{download:(windows|mac|mac-intel)\}\}", lambda m: DOWNLOAD.format(names[m[1]]), src)
    src = re.sub(r"\{\{size:(windows|mac)\}\}", lambda m: sizes.get(m[1], ""), src)
    out = re.sub(r"\{\{(img|font|qr):([\w-]+)\}\}", sub, src)
    out = out.replace("{{version:mac}}", sizes.get("mac_version") or userdata.VERSION).replace("{{version}}", userdata.VERSION)
    if "{{" in out:
        raise SystemExit("Onbekende plaatshouder in handleiding.src.html")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fragment", type=Path, help="ook een fragment zonder <html>/<head> schrijven")
    ap.add_argument("--web", type=Path, help="map voor de webversie (index.html)")
    ap.add_argument("--size-win", default="")
    ap.add_argument("--size-mac", default="")
    ap.add_argument("--mac-version", default="", help="als de Mac-download (nog) een oudere versie is")
    args = ap.parse_args()
    src = (DOCS / "handleiding.src.html").read_text(encoding="utf-8")
    if args.web:
        wsrc = only(src, "web")
        if not args.size_mac:   # nog geen Mac-download: geen dode link tonen
            wsrc = re.sub(r'<a class="dl-knop" id="dl-mac" href="\{\{download:mac\}\}">.*?</a>',
                          '<span class="dl-knop">Mac-versie volgt binnenkort</span>', wsrc, flags=re.S)
        img_dir = args.web / "img"
        shutil.rmtree(img_dir, ignore_errors=True)
        img_dir.mkdir(parents=True)
        web = fill(wsrc, {"windows": args.size_win, "mac": args.size_mac, "mac_version": args.mac_version}, img_dir)
        web = web.replace("<title>Handleiding dE3p</title>",
                          "<title>dE3p · gratis download en handleiding</title>")
        whead, wbody = web.split("<header", 1)
        args.web.mkdir(parents=True, exist_ok=True)
        (args.web / "index.html").write_text(
            '<!doctype html>\n<html lang="nl">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            '<meta name="description" content="dE3p: gratis voor Windows en Mac, en als app '
            'voor iPhone en Android. Je runs van Strava, een schema op maat en een recap-kaart van elke run.">\n'
            f"{whead}</head>\n<body>\n<header{wbody}\n</body>\n</html>\n", encoding="utf-8")
        print(f"{args.web / 'index.html'} ({len(web) // 1024} KB)")
    page = fill(only(src, "offline"))
    head, body = page.split("<header", 1)
    full = ('<!doctype html>\n<html lang="nl">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            f"{head}</head>\n<body>\n<header{body}\n</body>\n</html>\n")
    (DOCS / "Handleiding.html").write_text(full, encoding="utf-8")
    print(f"docs/Handleiding.html ({len(full) // 1024} KB)")
    if args.fragment:
        args.fragment.write_text(page, encoding="utf-8")
        print(f"{args.fragment} ({len(page) // 1024} KB)")


if __name__ == "__main__":
    main()

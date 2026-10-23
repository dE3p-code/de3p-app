"""
dE3p — desktopprogramma in een eigen venster (geen browser).

  pythonw app.py              # openen; synct automatisch bij het openen
  pythonw app.py --no-sync    # openen zonder automatische sync
  python  app.py --selftest   # venster openen, controleren en weer sluiten

Het venster draait via pywebview (Windows: Edge WebView2, macOS: WebKit). De
interface staat in app/ (HTML/CSS/JS); deze kant levert de data, voert de sync
uit, koppelt Strava (OAuth via de browser) en opent kaarten/mappen.

Iedereen gebruikt zijn eigen Strava API-app: de opstartwizard vraagt Client ID en
Client Secret, en alles blijft in de gebruikersmap op die computer (zie userdata.py).
Het schema komt uit Notion (Jens) of uit het eigen schema dat de app maakt (plan.json).
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

import requests

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))
import userdata    # noqa: E402  (gegevensmap, config.json)
import localplan   # noqa: E402  (eigen schema)
import localextra  # noqa: E402  (je doelen: meerdere tegelijk, elk met schema's per sport)
import dashboard as db   # noqa: E402  (datahelpers: Notion-schema, Strava-runs, sync-log)
import sports            # noqa: E402  (sporten: groepen en Nederlandse namen)
import wearables         # noqa: E402  (Whoop, Oura, Polar, Withings, intervals.icu)
import mirror            # noqa: E402  (versleutelde kopie voor de gsm-app dE3p)
import goalai            # noqa: E402  (je doel in je eigen woorden, met de lokale AI)

UI = userdata.RES / "app" / "index.html"
CACHE = userdata.CACHE
LOG = userdata.LOGS / "app.log"
HISTORY_WEEKS = 26
CARD_RE = re.compile(r"(\d{2})-(\d{2})-(\d{4}) ")

OAUTH_PORT = 8721
REDIRECT_URI = f"http://localhost:{OAUTH_PORT}/callback"
SCOPE = "read,activity:read_all,activity:write"
AUTHORIZE_URL = "https://www.strava.com/oauth/authorize"
TOKEN_URL = "https://www.strava.com/oauth/token"

# Windows: snelkoppelingen met dezelfde AppUserModelID als het venster, zodat het
# programma op de taakbalk één knop is met het dE3p-logo (ook als je het vastmaakt).
APP_ID = "dE3p.StravaSync"
TASK = "dE3p"                      # Taakplanner (Windows): elk half uur syncen op de achtergrond
WATCH_EVERY = 15                   # s: zo vaak kijkt het open venster of de gsm om Bijwerken vroeg
OLD_TASK = "dE3p Strava Sync"      # zo heette die taak vroeger (wordt bij het opstarten omgezet)
EXE = "dE3p.exe"                   # Windows-pakket; vroeger "dE3p Strava Sync.exe"
AGENT = "be.de3p.stravasync"       # launchd (Mac): hetzelfde
AGENT_PLIST = Path.home() / "Library" / "LaunchAgents" / f"{AGENT}.plist"
SYNC_EVERY = 30                    # minuten
SYNC_LOCK = userdata.DATA / "sync.lock"
_LNK_PS = r"""
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class De3pLnk {
  [StructLayout(LayoutKind.Sequential)] public struct PropKey { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit, Size = 24)] public struct PropVar { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    [PreserveSig] int GetCount(out uint c);
    [PreserveSig] int GetAt(uint i, out PropKey k);
    [PreserveSig] int GetValue(ref PropKey k, out PropVar v);
    [PreserveSig] int SetValue(ref PropKey k, ref PropVar v);
    [PreserveSig] int Commit();
  }
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink {}
  public static void SetAppId(string path, string id) {
    object link = new CShellLink();
    IPersistFile pf = (IPersistFile)link;
    pf.Load(path, 2);
    IPropertyStore ps = (IPropertyStore)link;
    PropKey key = new PropKey(); key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); key.pid = 5;
    PropVar v = new PropVar(); v.vt = 31; v.p = Marshal.StringToCoTaskMemUni(id);
    try {
      Marshal.ThrowExceptionForHR(ps.SetValue(ref key, ref v));
      Marshal.ThrowExceptionForHR(ps.Commit());
      pf.Save(path, true);
    } finally { Marshal.FreeCoTaskMem(v.p); }
  }
}
'@
foreach ($p in $env:LNKS.Split('|')) {
  New-Item -ItemType Directory -Force (Split-Path $p) | Out-Null
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($p)
  $s.TargetPath = $env:T; $s.Arguments = $env:A; $s.WorkingDirectory = $env:W; $s.IconLocation = $env:I
  $s.Description = 'dE3p'; $s.Save()
  [De3pLnk]::SetAppId($p, $env:ID)
}
"""


def _launch() -> tuple[str, str, str]:
    """(programma, argumenten, werkmap) om dE3p te starten."""
    if userdata.FROZEN:
        exe = Path(sys.executable)
        if sys.platform == "win32" and exe.name != EXE and (exe.parent / EXE).exists():
            exe = exe.parent / EXE                     # bijgewerkt van een versie met de oude naam
        return str(exe), "", str(exe.parent)
    py = Path(sys.executable).with_name("pythonw.exe") if sys.platform == "win32" else Path(sys.executable)
    return str(py), f'"{BASE / "app.py"}"', str(BASE)


def _ps(script: str, env: dict | None = None, timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
                          env={**os.environ, **(env or {})}, capture_output=True, text=True, timeout=timeout,
                          creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def shortcut_paths() -> list[Path]:
    desk = Path(os.environ.get("USERPROFILE", Path.home())) / "Desktop"
    try:
        import ctypes
        buf = ctypes.create_unicode_buffer(260)
        if ctypes.windll.shell32.SHGetFolderPathW(None, 0x10, None, 0, buf) == 0 and buf.value:   # CSIDL_DESKTOPDIRECTORY
            desk = Path(buf.value)
    except Exception:
        pass
    start = Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs"
    return [desk / "dE3p.lnk", start / "dE3p.lnk"]


def write_shortcuts(paths: list[Path]) -> None:
    target, args, workdir = _launch()
    out = _ps(_LNK_PS, {"LNKS": "|".join(str(p) for p in paths), "T": target, "A": args, "W": workdir,
                        "I": f"{userdata.RES / 'assets' / 'de3p-logo.ico'},0", "ID": APP_ID})
    if out.returncode:
        raise RuntimeError("Snelkoppeling maken mislukt.")


def titlebar(dark: bool) -> None:
    """Windows 11: de titelbalk in de kleur van het programma (zwart of wit) i.p.v. het standaard-wit."""
    if sys.platform != "win32":
        return
    try:
        import ctypes
        hwnd = ctypes.windll.user32.FindWindowW(None, "dE3p")
        if not hwnd:
            return
        dwm = ctypes.windll.dwmapi
        for attr, val in ((20, 1 if dark else 0),                     # donkere modus
                          (35, 0x000A0A0A if dark else 0x00F5F6F6),   # titelbalk = achtergrond (COLORREF 0x00BBGGRR)
                          (36, 0x00FAFAFA if dark else 0x000A0A0A)):  # tekst
            v = ctypes.c_int(val)
            dwm.DwmSetWindowAttribute(hwnd, attr, ctypes.byref(v), 4)
    except Exception:
        pass


def health_source() -> str | None:
    """Waar Gezondheid zijn cijfers haalt: Garmin, anders Whoop, Oura, Polar, Withings of intervals.icu."""
    import garmin
    if garmin.connected():
        return "garmin"
    act = wearables.active()
    return act[0] if act else None


def health_error(src: str, exc: Exception) -> str:
    name = "Garmin" if src == "garmin" else wearables.PROVIDERS[src]["name"]
    msg = str(exc)
    if "opnieuw te koppelen" in msg:
        return msg
    return f"{name} gaf geen antwoord. Probeer later opnieuw of koppel opnieuw in Instellingen."


def sync_locked() -> bool:
    """Loopt er al een sync (venster of achtergrond)? Een slot ouder dan 15 min telt niet."""
    try:
        return time.time() - SYNC_LOCK.stat().st_mtime < 15 * 60
    except OSError:
        return False


def log_note(msg: str) -> None:
    """Iets om te weten (geen fout), in het synclogboek (logs/sync.log) als dat open staat."""
    import logging
    logging.getLogger("strava_sync").info(msg)


def log_error(where: str) -> None:
    with LOG.open("a", encoding="utf-8") as f:
        f.write(f"{dt.datetime.now():%Y-%m-%d %H:%M:%S}  {where}\n{traceback.format_exc()}\n")


def reveal(path: Path) -> None:
    """Bestand of map openen met het standaardprogramma (Foto's, Verkenner, Finder)."""
    if sys.platform == "win32":
        os.startfile(path)  # noqa: S606
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


# --------------------------------------------------------------------------- #
# Links openen in het juiste browserprofiel (daar waar je op Strava bent ingelogd)
# --------------------------------------------------------------------------- #
def _chromium_browsers() -> list[tuple[str, list[Path], Path]]:
    """(naam, mogelijke programma-paden, map met 'Local State') per Chromium-browser."""
    home = Path.home()
    if sys.platform == "darwin":
        sup = home / "Library" / "Application Support"
        return [("Chrome", [Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")], sup / "Google" / "Chrome"),
                ("Edge", [Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")], sup / "Microsoft Edge"),
                ("Brave", [Path("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser")], sup / "BraveSoftware" / "Brave-Browser")]
    pf, pf86 = Path(os.getenv("ProgramFiles", r"C:\Program Files")), Path(os.getenv("ProgramFiles(x86)", r"C:\Program Files (x86)"))
    lad = Path(os.getenv("LOCALAPPDATA", str(home / "AppData" / "Local")))
    return [
        ("Chrome", [p / "Google/Chrome/Application/chrome.exe" for p in (pf, pf86, lad)], lad / "Google/Chrome/User Data"),
        ("Edge", [p / "Microsoft/Edge/Application/msedge.exe" for p in (pf86, pf)], lad / "Microsoft/Edge/User Data"),
        ("Brave", [p / "BraveSoftware/Brave-Browser/Application/brave.exe" for p in (pf, lad)], lad / "BraveSoftware/Brave-Browser/User Data"),
    ]


def browser_profiles() -> list[dict]:
    """Geïnstalleerde browserprofielen, bv. 'Chrome · Jouw Chrome'. Enkel de namen, niets anders."""
    out = []
    for name, exes, data in _chromium_browsers():
        exe = next((p for p in exes if p.exists()), None)
        if not exe:
            continue
        cache = (userdata.read_json(data / "Local State", {}).get("profile") or {}).get("info_cache") or {}
        for folder, info in sorted(cache.items(), key=lambda kv: (kv[0] != "Default", kv[0])):
            out.append({"id": f"{name}|{folder}", "label": f"{name} · {info.get('name') or folder}",
                        "exe": str(exe), "profile": folder})
    return out


def open_link(url: str) -> None:
    """In het gekozen browserprofiel openen, anders in de standaardbrowser."""
    b = userdata.load().get("browser") or {}
    exe = b.get("exe")
    if exe and Path(exe).exists():
        args = [exe, f"--profile-directory={b['profile']}", url] if b.get("profile") else [exe, url]
        subprocess.Popen(args, close_fds=True)
    else:
        webbrowser.open(url)


def is_connected() -> bool:
    if userdata.LEGACY:
        return True                            # sleutels staan in .env
    f = userdata.load()
    return bool(f.get("client_id") and f.get("client_secret") and f.get("refresh_token"))


def scope_ok(scope: str) -> bool:
    return "activity:read_all" in (scope or "") and "activity:write" in (scope or "")


# --------------------------------------------------------------------------- #
# Kaartenmap: per maand ordenen + index op datum
# --------------------------------------------------------------------------- #
def cards_root() -> Path:
    return userdata.cards_dir()


def organize_cards() -> int:
    """Losse kaarten in de hoofdmap verhuizen naar hun maandmap."""
    root, moved = cards_root(), 0
    if not root.exists():
        return 0
    if db.rc is None:
        db.load_modules()
    for p in list(root.glob("*.png")):
        m = CARD_RE.match(p.name)
        if not m:
            continue
        d = dt.date(int(m[3]), int(m[2]), int(m[1]))
        dst = root / db.rc.month_folder(d) / p.name
        dst.parent.mkdir(exist_ok=True)
        if dst.exists():
            dst.unlink()
        p.replace(dst)
        moved += 1
    return moved


def card_index() -> dict[str, list[dict]]:
    idx: dict[str, list[dict]] = {}
    root = cards_root()
    if root.exists():
        for p in root.rglob("*.png"):
            m = CARD_RE.match(p.name)
            if m:
                idx.setdefault(f"{m[3]}-{m[2]}-{m[1]}", []).append({"path": str(p), "name": p.stem[11:]})
    return idx


def inside_cards(path: str) -> Path:
    p = Path(path).resolve()
    if cards_root().resolve() not in p.parents:
        raise ValueError("Pad ligt buiten de kaartenmap.")
    return p


# --------------------------------------------------------------------------- #
# Data voor de interface
# --------------------------------------------------------------------------- #
def clean_name(name: str) -> tuple[str, str]:
    """Strava-naam → (training, structuur). Ruimt oude automatische titels op."""
    title, struct = db.split_training(name)
    title = title.lstrip("—– ").strip()
    if re.search(r"\d+[,.]\d+ km", title):                  # "Rustige ochtendloop 7,1 km @ 5:44/km · …"
        title = re.split(r"\s\d", title, maxsplit=1)[0]
    title = re.sub(r"[\s·|•,—–-]+$", "", title)            # eigen titel: "Ochtendloop · 10,2 km · …"
    if re.search(r"PR'?s|bpm|onderbreking", struct):
        struct = ""
    return title or "Run", struct


def run_json(a: dict) -> dict:
    """Eén activiteit voor de interface (elke sport). 'sport' = groep uit sports.py."""
    grp = sports.group(a)
    km = (a.get("distance") or 0) / 1000
    t = a.get("moving_time", 0)
    title, struct = clean_name(a.get("name", "")) if grp == "run" else (a.get("name") or sports.name(a), "")
    return {
        "id": a["id"], "date": a["start_date_local"][:10], "start": a["start_date_local"][:19],
        "name": a.get("name", ""), "sport": grp, "sportName": sports.name(a),
        "title": title, "structure": struct, "km": round(km, 2),
        "time": t, "pace": t / km if km else None,
        "speed": km / (t / 3600) if km and t else None,               # fietsen (km/u)
        "pace100": t / (km * 10) if grp == "swim" and km else None,   # zwemmen (s per 100 m)
        "hr": a.get("average_heartrate"), "maxhr": a.get("max_heartrate"),
        "elev": a.get("total_elevation_gain"),
        "cadence": (a.get("average_cadence") or 0) * 2 or None if grp == "run" else None,
        "watts": a.get("average_watts"), "kj": a.get("kilojoules"),
    }


SCALE = userdata.DATA / "weegschaal.json"     # wat je zelf invult: {datum: {kg, fat, src, at}}


SCALE_BRANDS = {"garmin": "Garmin-weegschaal", "withings": "Withings", "apple": "Apple Gezondheid", "manual": "Zelf invullen"}


def scale_brand() -> str:
    """De weegschaal die je koppelde (Instellingen → Weegschaal); '' = nog niet: dan geen gewicht op het Overzicht."""
    b = userdata.load().get("scale_brand") or ""
    return b if b in SCALE_BRANDS else ""


def scale_list() -> list[dict]:
    """Al je wegingen, oudste eerst, één per dag: Garmin (Index-weegschaal of Garmin Connect), Withings, en wat je
    zelf in dE3p invulde (dat gaat voor op dezelfde dag)."""
    by_day: dict = {}
    if health_source() == "garmin":
        try:
            import garmin
            by_day.update({w["date"]: w for w in garmin.weights()})
        except Exception:
            pass
    if wearables.connected("withings"):
        try:
            got = wearables._ensure("withings", dt.date.today() - dt.timedelta(days=90)).get("days") or {}
            for d, v in got.items():
                w = v.get("weight") or {}
                if w.get("kg"):
                    by_day[d] = {"date": d, "kg": w["kg"], "fat": w.get("fat"), "src": "Withings"}
        except Exception:
            pass
    for d, v in userdata.read_json(SCALE, {}).items():
        if v.get("kg"):
            by_day[d] = {"date": d, "kg": v["kg"], "fat": v.get("fat"), "src": "zelf ingevuld"}
    return [by_day[d] for d in sorted(by_day)]


def with_scale(rec: dict) -> dict:
    """Je gewicht in de dagen van Gezondheid (enkel waar nog geen gewicht van Withings e.d. staat)."""
    if not isinstance(rec, dict) or rec.get("error"):
        return rec
    sl = {w["date"]: w for w in scale_list()}
    for d in [rec.get("today") or {}, *(rec.get("history") or [])]:
        w = sl.get(d.get("date"))
        if w and not d.get("weight"):
            d["weight"] = {k: w[k] for k in ("kg", "fat", "muscle", "water", "bone", "src") if w.get(k) is not None}
    return rec


def with_garmin(acts: list[dict], fresh: bool = False) -> list[dict]:
    """Je trainingen van Strava naast die van je horloge (Garmin) leggen, op starttijd (± 3 min).
    Zelfde training: de cijfers van Strava blijven (die zijn gelijk aan de timer van je horloge), wat Strava mist
    vult Garmin aan, en een groot verschil komt in het logboek. Staat een training (nog) niet op Strava, dan komt
    ze er meteen van Garmin bij; zodra Strava ze heeft, wordt het weer één training."""
    import garmin
    if not garmin.connected():
        return acts
    try:
        gl = garmin.activities(garmin.ACT_DAYS, force=fresh)
    except Exception:
        log_error("garmin_activities")
        return acts
    first = (dt.date.today() - dt.timedelta(days=garmin.ACT_DAYS - 1)).isoformat()
    free = list(gl)
    for a in acts:
        if a["date"] < first or not a.get("start"):
            continue
        g = garmin.match(free, a["start"])
        if not g:
            continue
        free.remove(g)
        a.update(garmin=g["gid"], src="beide")
        if not a.get("km") and g["km"]:                     # binnen getraind: afstand van je horloge
            a["km"] = round(g["km"], 2)
        if not a.get("time") and g["time"]:
            a["time"] = g["time"]
        for k, gk in (("hr", "hr"), ("maxhr", "maxhr"), ("elev", "elev"), ("watts", "watts")):
            if a.get(k) is None and g[gk] is not None:
                a[k] = g[gk]
        if a["sport"] == "run" and not a.get("cadence") and g["cad"]:
            a["cadence"] = g["cad"]
        km, t = a.get("km") or 0, a.get("time") or 0
        a.update(pace=t / km if km else None, speed=km / (t / 3600) if km and t else None,
                 pace100=t / (km * 10) if a["sport"] == "swim" and km else None)
        recent = a["date"] >= (dt.date.today() - dt.timedelta(days=2)).isoformat()
        if fresh and recent and ((km and abs(g["km"] - km) > max(0.1, 0.02 * km)) or (t and abs(g["time"] - t) > 60)):
            log_note(f"Strava en Garmin verschillen bij {a['start'][:16]}: {km:.2f} km/{t // 60} min (Strava) "
                     f"tegenover {g['km']:.2f} km/{g['time'] // 60} min (Garmin)")
    for g in free:                                          # (nog) niet op Strava
        s = {"sport_type": g["sport_type"], "type": g["sport_type"]}
        grp, km, t = sports.group(s), g["km"], g["time"]
        acts.append({
            "id": f"g{g['gid']}", "garmin": g["gid"], "src": "garmin", "date": g["start"][:10], "start": g["start"],
            "name": g["name"], "sport": grp, "sportName": sports.name(s), "title": g["name"] or sports.name(s),
            "structure": "", "km": round(km, 2), "time": t, "pace": t / km if km else None,
            "speed": km / (t / 3600) if km and t else None, "pace100": t / (km * 10) if grp == "swim" and km else None,
            "hr": g["hr"], "maxhr": g["maxhr"], "elev": g["elev"], "cadence": g["cad"] if grp == "run" else None,
            "watts": g["watts"], "kj": None,
        })
    return acts


def notion_schema(cfg: dict, today: dt.date) -> list[dict]:
    weeks = db.notion_weeks(cfg)
    days = db.plan_days(weeks, today)
    schema = []
    for w in weeks:
        rows = [{k: (v.isoformat() if k == "date" else v) for k, v in d.items() if k != "week"}
                for d in days if d["week"] is w]
        schema.append({"num": w["num"], "label": w["label"], "marker": w["marker"],
                       "focus": w["focus"], "target": w["target"], "rows": rows})
    return schema


def build_state(cfg: dict, sync: dict | None = None, fresh: bool = False) -> dict:
    today = dt.date.today()
    problems: list[str] = []
    schema: list[dict] = []
    if cfg.get("notion_token") and cfg.get("notion_page_id"):
        source, race = "notion", userdata.load().get("race")
        try:
            schema = notion_schema(cfg, today)
        except Exception as exc:
            problems.append(f"Notion-schema niet gelezen: {exc}")
    else:
        plan = localplan.load()
        source, race = ("plan" if plan else ""), localplan.race(plan)
        schema = localplan.ui_weeks(plan, today)

    acts: list[dict] = []
    try:
        acts = [run_json(a) for a in db.strava_activities(cfg, weeks_back=HISTORY_WEEKS)]
    except Exception as exc:
        problems.append(f"Strava-activiteiten niet opgehaald: {exc}")
    acts = with_garmin(acts, fresh)                         # ook wat je horloge al heeft en Strava nog niet
    acts.sort(key=lambda r: r.get("start") or r["date"], reverse=True)
    runs = [a for a in acts if a["sport"] == "run"]      # overzicht en schema gaan over lopen
    if sync and sync.get("ran"):
        if not sync.get("ok", True):
            problems.append(f"Sync mislukt: {sync.get('error', '')}")
        problems += [t for k, t in db.sync_events(sync.get("records", [])) if k == "warn"]

    return {
        "generated": dt.datetime.now().isoformat(timespec="minutes"),
        "today": today.isoformat(),
        "race": race,
        "source": source,
        "schema": schema,
        "runs": runs,
        "acts": acts,                                       # alle sporten: vorige trainingen + agenda
        "extra": localextra.rows(),                         # geplande trainingen van al je doelen
        "cards": card_index(),
        "cardsDir": str(cards_root()),
        "sync": ({"ok": sync.get("ok", True), "error": sync.get("error", ""),
                  "events": db.sync_events(sync.get("records", []))}
                 if sync and sync.get("ran") else None),
        "lastSync": userdata.load().get("last_sync"),
        "problems": problems,
    }


def block_view(b: dict | None) -> dict:
    import blocks
    if not b:
        return {"found": False}
    return {**b, "found": True, "paceTxt": blocks.fmt_pace(b["pace"]), "targetTxt": blocks.fmt_pace(b["target"]),
            "timeTxt": blocks.fmt_time(b["secs"]), "verdict": blocks.verdict(b), "short": blocks.short(b)}


def migrate_names() -> None:
    """Van 'dE3p Strava Sync' naar 'dE3p': snelkoppelingen, Taakplanner-taak en Mac-agent wijzen naar dit programma."""
    try:
        if sys.platform == "win32":
            old = [p.with_name("dE3p Strava Sync.lnk") for p in shortcut_paths()]
            found = [p for p in old if p.exists()]
            if found:
                write_shortcuts([p.with_name("dE3p.lnk") for p in found])
                for p in found:
                    p.unlink(missing_ok=True)
            if _ps(f'schtasks /Query /TN "{OLD_TASK}" | Out-Null; exit $LASTEXITCODE').returncode == 0:
                Api(False).set_auto_sync(True)
                subprocess.run(["schtasks", "/Delete", "/F", "/TN", OLD_TASK], capture_output=True, timeout=30,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        elif sys.platform == "darwin" and userdata.FROZEN and AGENT_PLIST.exists():
            import plistlib
            prog = (plistlib.loads(AGENT_PLIST.read_bytes()).get("ProgramArguments") or [""])[0]
            if prog != _launch()[0]:                       # agent wijst nog naar de oude app
                Api(False).set_auto_sync(True)
    except Exception:
        log_error("naam omzetten")


def callback_page(ok: bool, msg: str, name: str = "Strava") -> bytes:
    title = f"Gekoppeld met {name}" if ok else "Koppelen mislukt"
    return f"""<!doctype html><meta charset="utf-8"><title>dE3p</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0A0A0A;color:#FAFAFA;
font:16px/1.5 'Segoe UI',system-ui,sans-serif;text-align:center"><div style="max-width:440px;padding:24px">
<div style="font:600 11px ui-monospace,Consolas,monospace;letter-spacing:.14em;text-transform:uppercase;color:#8C8C8C">dE3p</div>
<h1 style="font-size:30px;margin:10px 0">{title}</h1><p style="color:#CFCFCF">{msg}</p></div></body>""".encode("utf-8")


# --------------------------------------------------------------------------- #
# API voor JavaScript (window.pywebview.api.*)
# --------------------------------------------------------------------------- #
class Api:
    def __init__(self, autosync: bool, selftest: bool = False) -> None:
        self._autosync = autosync
        self._selftest = selftest
        self._lock = threading.Lock()
        self._cfg: dict | None = None
        self._window = None                    # privé: niet blootstellen aan JavaScript
        self._oauth_cancel = threading.Event()
        self._push_lock = threading.Lock()     # één kopie tegelijk naar de gsm
        self._push_force = False               # de gsm vroeg erom: ook versturen als er niets veranderde

    def _config(self) -> dict:
        if self._cfg is None:                  # één dict hergebruiken (geroteerde Strava-token)
            import strava_sync                 # licht: zonder matplotlib, dus snel bij het opstarten
            self._cfg = strava_sync.load_config()
        return self._cfg

    def _cfg_full(self) -> dict:
        """Config + alle modules (sync, kaarten) voor het echte werk."""
        if db.ss is None:
            db.load_modules()
        return self._config()

    def settings(self) -> dict:
        f = userdata.load()
        plan = localplan.load()
        notion = False
        if is_connected():
            try:
                cfg = self._config()
                notion = bool(cfg.get("notion_token") and cfg.get("notion_page_id"))
            except BaseException:
                pass
        return {
            "autosync": self._autosync, "selftest": self._selftest,
            "connected": is_connected(), "legacy": userdata.LEGACY,
            "athlete": f.get("athlete", ""), "scopeOk": userdata.LEGACY or scope_ok(f.get("scope", "")),
            "clientId": f.get("client_id", ""),
            "rename": bool(f.get("rename", True)), "cardsDir": str(cards_root()),
            "notion": notion, "plan": (plan or {}).get("config"), "goals": localextra.goals(),
            "platform": sys.platform, "version": userdata.VERSION, "dataDir": str(userdata.DATA),
            "theme": f.get("theme", "dark"), "histView": f.get("hist_view", "lijst"),
            "histSport": f.get("hist_sport", "all"), "healthDays": f.get("health_days", "dag"),
            "canUpdate": sys.platform == "win32" and userdata.FROZEN,
            "cardSports": list(f.get("card_sports") or sports.DEFAULT_CARDS),
            "cardChoices": [{"id": k, "label": v} for k, v in sports.CARD_CHOICES],
            "lastSync": f.get("last_sync"),
            "titleInstruction": f.get("title_instruction", ""), "titleTemplate": f.get("title_template", ""),
            "browsers": [{"id": x["id"], "label": x["label"]} for x in browser_profiles()],
            "garmin": (userdata.DATA / "garmin").is_dir() and any((userdata.DATA / "garmin").iterdir()),
            "wear": {k: wearables.connected(k) for k in wearables.ORDER},
            "health": health_source(),
            "body": self.body(),
            "scale": self.scale(),
            "vitals": self.vitals(),
            "vorm": self.vorm(),
            "browser": (f.get("browser") or {}).get("id", ""),
            "phone": mirror.status(),
        }

    def cached(self):
        if not is_connected():
            return None
        return userdata.read_json(CACHE, None)

    def _save(self, state: dict) -> dict:
        userdata.write_json(CACHE, state)
        return state

    def refresh(self) -> dict:
        try:
            cfg = self._cfg_full()
            organize_cards()
            return self._phone_later(self._save(build_state(cfg)))
        except BaseException as exc:            # ook SystemExit (Strava nog niet gekoppeld)
            log_error("refresh")
            raise RuntimeError(str(exc)) from None

    def sync(self, now: bool = False) -> dict:
        """Strava, Notion en je gezondheid van vandaag bijwerken. 'now' komt van de gsm-versie van het scherm
        (Bijwerken met de hand); hier synct Bijwerken altijd meteen."""
        if not self._lock.acquire(blocking=False):
            raise RuntimeError("Er loopt al een sync.")
        if sync_locked():
            self._lock.release()
            raise RuntimeError("Er loopt al een sync op de achtergrond. Probeer zo opnieuw.")
        try:
            SYNC_LOCK.write_text(str(os.getpid()), encoding="utf-8")
            cfg = self._cfg_full()
            result = db.run_sync(cfg)
            if result.get("ok"):
                userdata.update(last_sync=dt.datetime.now().isoformat(timespec="minutes"))
            organize_cards()
            self._health_today()
            self._vorm_sync(cfg)
            return self._phone_later(self._save(build_state(cfg, result, fresh=True)))
        except BaseException as exc:
            log_error("sync")
            raise RuntimeError(str(exc)) from None
        finally:
            SYNC_LOCK.unlink(missing_ok=True)
            self._lock.release()

    # ---- Strava koppelen ------------------------------------------------------
    def strava_connect(self, client_id: str, client_secret: str) -> dict:
        """Browser opent Strava → gebruiker keurt goed → Strava stuurt terug naar
        http://localhost:8721/callback → code omwisselen voor een refresh token."""
        if userdata.LEGACY:
            raise RuntimeError("In de ontwikkelmap komen de Strava-sleutels uit .env.")
        cid, sec = str(client_id).strip(), str(client_secret).strip()
        if not cid.isdigit():
            raise RuntimeError("De Client ID bestaat enkel uit cijfers.")
        if len(sec) < 20:
            raise RuntimeError("Die Client Secret lijkt niet volledig: kopieer hem opnieuw.")

        state, got, done = secrets.token_urlsafe(16), {}, threading.Event()

        class Callback(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                u = urlparse(self.path)
                if u.path != "/callback":
                    self.send_response(404)
                    self.end_headers()
                    return
                q = parse_qs(u.query)
                if q.get("state", [""])[0] != state:
                    ok, msg = False, "Deze aanvraag kwam niet van dE3p. Probeer opnieuw vanuit het programma."
                elif "error" in q or "code" not in q:
                    got["error"] = "Je hebt de toegang geweigerd op Strava."
                    ok, msg = False, "Je hebt de toegang geweigerd. Ga terug naar het programma en probeer opnieuw."
                else:
                    got["code"], got["scope"] = q["code"][0], q.get("scope", [""])[0]
                    ok, msg = True, "Je kan dit tabblad sluiten en teruggaan naar dE3p."
                body = callback_page(ok, msg)
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                if ok or "error" in got:
                    done.set()

            def log_message(self, *args):  # stil
                pass

        try:
            srv = HTTPServer(("127.0.0.1", OAUTH_PORT), Callback)
        except OSError:
            raise RuntimeError(f"Poort {OAUTH_PORT} is bezet. Sluit andere vensters van dit programma en probeer opnieuw.") from None
        srv.timeout = 0.5
        self._oauth_cancel.clear()
        open_link(AUTHORIZE_URL + "?" + urlencode({
            "client_id": cid, "response_type": "code", "redirect_uri": REDIRECT_URI,
            "approval_prompt": "auto", "scope": SCOPE, "state": state}))
        deadline = time.time() + 600
        try:
            while not done.is_set() and not self._oauth_cancel.is_set() and time.time() < deadline:
                srv.handle_request()
        finally:
            srv.server_close()
        if self._oauth_cancel.is_set():
            raise RuntimeError("Koppelen geannuleerd.")
        if not done.is_set():
            raise RuntimeError("Geen antwoord van Strava binnen 10 minuten. Probeer opnieuw.")
        if "error" in got:
            raise RuntimeError(got["error"])

        r = requests.post(TOKEN_URL, data={"client_id": cid, "client_secret": sec, "code": got["code"],
                                           "grant_type": "authorization_code"}, timeout=30)
        if r.status_code in (400, 401, 403):
            raise RuntimeError("Strava weigert de sleutel: controleer je Client ID en Client Secret.")
        r.raise_for_status()
        data = r.json()
        athlete = (data.get("athlete") or {}).get("firstname", "")
        userdata.update(client_id=cid, client_secret=sec, refresh_token=data["refresh_token"],
                        athlete=athlete, athlete_id=(data.get("athlete") or {}).get("id"), scope=got["scope"])
        userdata.STATE.unlink(missing_ok=True)   # nieuwe koppeling = nieuwe start
        self._cfg = None
        return {"athlete": athlete, "scopeOk": scope_ok(got["scope"])}

    def strava_cancel(self) -> None:
        self._oauth_cancel.set()

    def strava_disconnect(self) -> None:
        if userdata.LEGACY:
            raise RuntimeError("In de ontwikkelmap komen de Strava-sleutels uit .env.")
        try:                                   # toegang ook bij Strava intrekken
            tok = db.ss.strava_access_token(self._cfg_full())
            requests.post("https://www.strava.com/oauth/deauthorize", data={"access_token": tok}, timeout=20)
        except BaseException:
            pass
        userdata.update(refresh_token=None, athlete=None, scope=None)
        CACHE.unlink(missing_ok=True)
        self._cfg = None

    # ---- schema & instellingen --------------------------------------------------
    def save_plan(self, plan: dict) -> None:
        localplan.save(plan)

    def delete_plan(self) -> None:
        localplan.delete()

    def save_goal(self, profile: dict, plans: dict, gid: str | None = None) -> str:
        """Doel bewaren: met gid vervang je dat doel, zonder komt het erbij (meerdere doelen tegelijk)."""
        return localextra.save_goal(profile, plans, gid)

    def delete_goal(self, gid: str) -> None:
        localextra.delete_goal(str(gid))

    PREFS = {"theme": {"dark", "light"}, "hist_view": {"lijst", "agenda"},
             "hist_sport": {"all", "run", "ride", "swim", "walk", "racket", "other"},
             "health_days": {"dag", "wk", "kal", "alles", "maand", "7", "30"}}

    def body(self) -> dict:
        """Voor je lichaamsleeftijd: geboortedatum en geslacht (wat je zelf invult gaat voor), lengte en gewicht."""
        own = userdata.load().get("body") or {}
        prof = {}
        if health_source() == "garmin":
            try:
                import garmin
                prof = garmin.profile()
            except Exception:
                prof = {}
        out = {**prof, **{k: v for k, v in own.items() if v}}
        out["source"] = "eigen" if own.get("birth") else ("garmin" if prof.get("birth") else "")
        out["heightSrc"] = "eigen" if own.get("heightCm") else ("garmin" if prof.get("heightCm") else "")   # voor je BMI
        last = (scale_list() or [None])[-1]                # je echte laatste weging gaat voor op je profiel
        if last and last.get("kg"):
            out["weightKg"] = last["kg"]
        return out

    # ---- weegschaal (Instellingen → Koppelingen → Weegschaal) ---------------------------
    def scale(self) -> dict:
        """Je laatste weging, waar ze vandaan komt, en welke bronnen er zijn."""
        sl = scale_list()
        last = sl[-1] if sl else None
        prev = next((w for w in reversed(sl[:-1]) if w.get("kg")), None) if last else None
        brand = scale_brand()
        return {"brand": brand, "brandName": SCALE_BRANDS.get(brand, ""),
                "last": last, "delta": round(last["kg"] - prev["kg"], 1) if last and prev else None,
                "n": len(sl), "garmin": health_source() == "garmin", "withings": wearables.connected("withings")}

    def set_scale(self, brand: str = "") -> dict:
        """Je weegschaal koppelen: 'garmin' (Index, via je Garmin-koppeling), 'withings', 'apple' (iPhone-app) of
        'manual' (een gewone weegschaal: zelf invullen); '' = ontkoppelen. Daarna staat je gewicht op het Overzicht."""
        brand = str(brand or "")
        if brand and brand not in SCALE_BRANDS:
            raise RuntimeError("Onbekende weegschaal.")
        if brand == "garmin" and health_source() != "garmin":
            raise RuntimeError("Koppel eerst Garmin (hierboven bij Koppelingen). Je Garmin Index-weegschaal stuurt je gewicht naar Garmin Connect.")
        if brand == "withings" and not wearables.connected("withings"):
            raise RuntimeError("Koppel eerst Withings (bij Koppelingen → Meer koppelingen).")
        userdata.update(scale_brand=brand)
        if brand == "garmin":
            try:
                import garmin
                garmin.weights(force=True)
            except Exception:
                pass
        return self.scale()

    def add_weight(self, kg, fat=None, date: str = "") -> dict:
        """Zelf je gewicht invullen (een gewone weegschaal); vandaag, of op 'date' (JJJJ-MM-DD)."""
        try:
            kg = round(float(str(kg).replace(",", ".")), 1)
            fat = round(float(str(fat).replace(",", ".")), 1) if fat not in (None, "", 0) else None
        except ValueError:
            raise RuntimeError("Vul je gewicht in als getal, bv. 72,4.") from None
        if not 25 <= kg <= 300 or (fat is not None and not 2 <= fat <= 70):
            raise RuntimeError("Dat gewicht of vetpercentage klopt niet. Kijk het nog eens na.")
        day = date if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(date or "")) else dt.date.today().isoformat()
        own = userdata.read_json(SCALE, {})
        own[day] = {"kg": kg, "fat": fat, "at": dt.datetime.now().isoformat(timespec="minutes")}
        userdata.write_json(SCALE, own)
        return self.scale()

    # ---- bloedsuiker en bloeddruk (Instellingen → Bloedsuiker & bloeddruk) ----------------
    def vitals(self) -> dict:
        import vitals
        return vitals.status()

    def set_vitals(self, kind: str, on: bool) -> dict:
        import vitals
        vitals.set_tracking(str(kind), bool(on))
        return vitals.status()

    def add_glucose(self, mgdl, ctx: str = "los", at: str = "") -> dict:
        import vitals
        return vitals.add_glucose(mgdl, str(ctx or "los"), at or None)

    def add_bp(self, sys_, dia, pulse=None, at: str = "") -> dict:
        import vitals
        return vitals.add_bp(sys_, dia, pulse, at or None)

    def add_waist(self, cm, at: str = "") -> dict:
        import vitals
        return vitals.add_waist(cm, at or None)

    def add_sweat(self, start: str, before, after, drank=0, secs=0) -> dict:
        import vitals
        return vitals.add_sweat(str(start), before, after, drank, secs)

    # ---- je vorm: records en loopschoenen (Strava), wedstrijdvoorspelling en lactaatdrempel (Garmin) ----
    def vorm(self) -> dict:
        import prestaties
        out = prestaties.status()
        try:
            import garmin
            if garmin.connected():                      # enkel wat al opgehaald is: de sync werkt het bij
                c = userdata.read_json(garmin.CACHE, {})
                out["race"] = (c.get("race") or {}).get("v") or out.get("race")   # Garmin gaat voor op je snelste tijden
                out["lt"] = (c.get("lt") or {}).get("v")
        except Exception:
            pass
        return out

    def hr_zones(self, start: str):
        """Tijd per hartslagzone van de training die toen begon (Garmin), of None."""
        try:
            import garmin
            return garmin.hr_zones(str(start)) if garmin.connected() else None
        except Exception:
            return None

    def _vorm_sync(self, cfg: dict) -> None:
        """Bij elke sync: je oudere loopjes stap voor stap voor je records (op de achtergrond meer, als je
        wacht maar een paar), en Garmin's voorspelling en lactaatdrempel."""
        bg = getattr(self, "_bg", False)
        try:
            import prestaties
            prestaties.backfill(db.ss.strava_access_token(cfg), budget_s=40 if bg else 4, limit=60 if bg else 8)
        except Exception:
            log_error("records")
        try:
            import garmin
            if garmin.connected():
                garmin.race_predictions()
                garmin.threshold()
        except Exception:
            pass

    def del_weight(self, date: str) -> dict:
        own = userdata.read_json(SCALE, {})
        own.pop(str(date), None)
        userdata.write_json(SCALE, own)
        return self.scale()

    def set_body(self, birth: str, sex: str) -> dict:
        import re
        birth, sex = str(birth or "").strip(), str(sex or "").strip()
        if not re.fullmatch(r"(19[2-9]\d|20[0-2]\d)(-\d{2}-\d{2})?", birth) or sex not in ("m", "f"):
            raise ValueError("Vul je geboortejaar (bv. 1995) en man of vrouw in.")
        userdata.update(body={**(userdata.load().get("body") or {}), "birth": birth, "sex": sex})
        return self.body()

    def set_height(self, cm="") -> dict:
        """Je lengte (voor je BMI). Leeg = weer die uit je Garmin-profiel gebruiken."""
        own = dict(userdata.load().get("body") or {})
        if str(cm or "").strip() == "":
            own.pop("heightCm", None)
        else:
            try:
                x = float(str(cm).replace(",", "."))
            except ValueError:
                raise ValueError("Vul je lengte in centimeter in, bv. 172.") from None
            v = round(x * 100 if x < 3 else x)              # 1,72 (meter) mag ook
            if not 100 <= v <= 230:
                raise ValueError("Vul je lengte in centimeter in, bv. 172.")
            own["heightCm"] = v
        userdata.update(body=own)
        return self.body()

    def set_pref(self, key: str, value: str) -> None:
        if value not in self.PREFS.get(key, ()):
            raise ValueError("Onbekende instelling.")
        userdata.update(**{key: value})
        if key == "theme":
            titlebar(value == "dark")

    # ---- eigen titel via lokale AI ------------------------------------------------
    def _preview_vals(self, template: str) -> str:
        """Sjabloon ingevuld met je laatste run (uit de cache), als voorbeeld."""
        import titles
        runs = (userdata.read_json(CACHE, {}) or {}).get("runs") or []
        r = runs[0] if runs else {"km": 10.2, "time": 3000, "hr": 152, "maxhr": 171, "elev": 24,
                                  "cadence": 170, "date": dt.date.today().isoformat(), "title": "Rustige duurloop", "structure": ""}
        d = dt.date.fromisoformat(r["date"])
        vals = titles.values(km=r["km"], secs=r["time"], hr=r.get("hr"), maxhr=r.get("maxhr"), elev=r.get("elev"),
                             cadence=r.get("cadence"), date=d, daypart="Ochtend", weekday=db.DAYS[d.weekday()].capitalize(),
                             training=r["title"], structuur=r.get("structure", ""))
        return titles.fill(template, vals)

    def _ollama(self) -> tuple[str, str]:
        """Adres en model van de lokale AI (Ollama)."""
        f = userdata.load()
        url, model = "http://localhost:11434", "mistral-nemo:latest"
        if userdata.LEGACY:
            try:
                cfg = self._config()
                url, model = cfg["ollama_url"], cfg["ollama_model"]
            except BaseException:
                pass
        return f.get("ollama_url", url), f.get("ollama_model", model)

    def ai_status(self) -> dict:
        """Draait Ollama op deze computer, en is het model er? (Instellingen → Lokale AI)"""
        url, model = self._ollama()
        try:
            r = requests.get(f"{url}/api/tags", timeout=2)
            names = [m.get("name", "") for m in r.json().get("models", [])]
        except Exception:
            return {"running": False, "model": model}
        return {"running": True, "model": model, "hasModel": model in names or f"{model}:latest" in names}

    RELEASES = "https://api.github.com/repos/dE3p-code/strava-sync/releases/latest"

    def update_check(self, force: bool = False) -> dict:
        """Is er een nieuwere versie? Hoogstens twee keer per dag aan GitHub gevraagd."""
        info = userdata.load().get("update") or {}
        if force or time.time() - info.get("at", 0) > 12 * 3600:
            try:
                r = requests.get(self.RELEASES, timeout=6, headers={"Accept": "application/vnd.github+json"})
                r.raise_for_status()
                info = {"at": time.time(), "latest": (r.json().get("tag_name") or "").lstrip("v")}
                userdata.update(update=info)
            except Exception:
                pass

        def ver(v: str) -> tuple:
            return tuple(int(x) for x in re.findall(r"\d+", v or "")[:3])

        latest = info.get("latest") or ""
        return {"current": userdata.VERSION, "latest": latest, "newer": bool(latest) and ver(latest) > ver(userdata.VERSION)}

    def goal_ai(self, text: str) -> dict:
        """Je doel in je eigen woorden → antwoorden voor de vragenlijst, met de lokale AI (Ollama).
        {"ok": True, "answers": {...}} of {"ok": False}: dan begrijpt het venster je tekst met trefwoorden."""
        url, model = self._ollama()
        try:
            return {"ok": True, "answers": goalai.understand(str(text), url, model)}
        except Exception as e:      # Ollama niet bereikbaar of antwoord ongeldig
            return {"ok": False, "error": str(e)[:200]}

    def title_suggest(self, instruction: str) -> dict:
        import titles
        url, model = self._ollama()
        template, source = titles.suggest(str(instruction), url, model)
        return {"template": template, "source": source, "preview": self._preview_vals(template)}

    def title_preview(self, template: str) -> dict:
        import titles
        try:
            t = titles.validate(template)
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
        return {"ok": True, "preview": self._preview_vals(t)}

    def title_save(self, instruction: str, template: str) -> str:
        import titles
        t = titles.validate(template)
        userdata.update(title_instruction=str(instruction).strip(), title_template=t)
        self._cfg = None
        return self._preview_vals(t)

    def title_clear(self) -> None:
        userdata.update(title_instruction=None, title_template=None)
        self._cfg = None

    def title_apply_last(self) -> str:
        """Het sjabloon meteen op je laatste run op Strava zetten (op jouw klik)."""
        cfg = self._cfg_full()
        if not cfg.get("title_template"):
            raise RuntimeError("Er is nog geen eigen titel ingesteld.")
        tok = db.ss.strava_access_token(cfg)
        runs = sorted(db.strava_runs(cfg, weeks_back=4), key=lambda a: a["start_date"], reverse=True)
        if not runs:
            raise RuntimeError("Geen recente run gevonden.")
        detail = db.ss.strava_activity_detail(tok, runs[0]["id"])
        f = db.ss.extract_facts(detail)
        planned_full, _ = db.ss.planned_info(cfg, f)
        current = runs[0].get("name", "")
        base = planned_full or ("" if db.ss.is_default_name(current) else current)
        if base:                                # ✅ uit Notion en oude cijfers eruit, enkel training + opbouw
            t, st = clean_name(base)
            base = f"{t} — {st}" if st else t
        name = db.ss.templated_name(cfg, f, detail, base or None)
        db.ss.strava_update_activity(tok, f["id"], name, None, False)
        return name

    def set_card_sports(self, keys: list) -> None:
        """Voor welke sporten de sync automatisch een recap-kaart maakt."""
        valid = {k for k, _ in sports.CARD_CHOICES}
        userdata.update(card_sports=[k for k in keys if k in valid])
        self._cfg = None

    def set_rename(self, on: bool) -> None:
        userdata.update(rename=bool(on))
        self._cfg = None

    def pick_folder(self) -> str | None:
        import webview
        start = cards_root() if cards_root().exists() else cards_root().parent
        res = self._window.create_file_dialog(webview.FileDialog.FOLDER, directory=str(start))
        if not res:
            return None
        path = res[0] if isinstance(res, (list, tuple)) else res
        userdata.update(cards_dir=str(path))
        return str(path)

    def make_shortcut(self) -> str:
        """Snelkoppeling 'dE3p' op het bureaublad en in het Startmenu (Windows)."""
        if sys.platform != "win32":
            raise RuntimeError("Snelkoppeling maken kan enkel op Windows. Op een Mac: sleep de app naar je Dock.")
        paths = shortcut_paths()
        write_shortcuts(paths)
        return str(paths[0])

    # ---- automatisch syncen (Windows Taakplanner) en zelf bijwerken -------------------
    def auto_sync(self) -> bool:
        if sys.platform == "darwin":
            return AGENT_PLIST.exists()
        if sys.platform != "win32":
            return False
        return _ps(f'schtasks /Query /TN "{TASK}" | Out-Null; exit $LASTEXITCODE').returncode == 0

    def _mac_auto_sync(self, on: bool) -> bool:
        """launchd-agent: elk half uur 'dE3p --sync-only', enkel als je aangemeld bent."""
        import plistlib
        domain = f"gui/{os.getuid()}"
        subprocess.run(["launchctl", "bootout", domain, str(AGENT_PLIST)], capture_output=True, timeout=30)
        if not on:
            AGENT_PLIST.unlink(missing_ok=True)
            return False
        target, args, cwd = _launch()
        prog = [target] + ([args.strip('"')] if args else []) + ["--sync-only"]
        AGENT_PLIST.parent.mkdir(parents=True, exist_ok=True)
        with open(AGENT_PLIST, "wb") as fh:
            plistlib.dump({"Label": AGENT, "ProgramArguments": prog, "WorkingDirectory": cwd,
                           "StartInterval": SYNC_EVERY * 60, "RunAtLoad": False, "ProcessType": "Background",
                           "StandardOutPath": "/dev/null", "StandardErrorPath": "/dev/null"}, fh)
        out = subprocess.run(["launchctl", "bootstrap", domain, str(AGENT_PLIST)], capture_output=True, text=True, timeout=30)
        if out.returncode:                                   # oudere macOS of geen GUI-domein
            out = subprocess.run(["launchctl", "load", "-w", str(AGENT_PLIST)], capture_output=True, text=True, timeout=30)
        if out.returncode:
            AGENT_PLIST.unlink(missing_ok=True)
            raise RuntimeError("Automatisch syncen aanzetten mislukt.")
        return True

    def set_auto_sync(self, on: bool) -> bool:
        """Elk half uur syncen op de achtergrond, ook als het venster dicht is (enkel als je aangemeld bent).
        Elke sync stuurt ook een verse kopie naar je gsm, als die gekoppeld is."""
        if sys.platform == "darwin":
            return self._mac_auto_sync(bool(on))
        if sys.platform != "win32":
            raise RuntimeError("Automatisch syncen kan enkel op Windows en Mac.")
        if on:
            target, args, _ = _launch()
            tr = " ".join(x for x in (f'"{target}"', args, "--sync-only") if x)
            start = (dt.datetime.now() + dt.timedelta(minutes=2)).strftime("%H:%M")
            cmd = ["schtasks", "/Create", "/F", "/SC", "MINUTE", "/MO", str(SYNC_EVERY), "/ST", start, "/TN", TASK, "/TR", tr]
        else:
            cmd = ["schtasks", "/Delete", "/F", "/TN", TASK]
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if out.returncode and on:
            raise RuntimeError("Automatisch syncen aanzetten mislukt.")
        return self.auto_sync()

    def update_install(self) -> str:
        """Nieuwe versie downloaden, het programma vervangen en opnieuw starten (Windows-pakket)."""
        import zipfile
        if not (sys.platform == "win32" and userdata.FROZEN):
            raise RuntimeError("Download de nieuwe versie op de website.")
        rel = requests.get(self.RELEASES, timeout=10, headers={"Accept": "application/vnd.github+json"})
        rel.raise_for_status()
        assets = {a.get("name"): a for a in rel.json().get("assets", [])}
        asset = assets.get("dE3p-Windows.zip") or assets.get("dE3p-Strava-Sync-Windows.zip")
        if not asset:
            raise RuntimeError("Geen Windows-download gevonden. Download de nieuwe versie op de website.")
        app_dir = Path(sys.executable).parent
        work = app_dir.parent / f"{app_dir.name}.nieuw"           # zelfde schijf: verplaatsen gaat meteen
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True)
        zpath = work / "update.zip"
        with requests.get(asset["browser_download_url"], stream=True, timeout=60) as r:
            r.raise_for_status()
            with zpath.open("wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
        with zipfile.ZipFile(zpath) as z:
            z.extractall(work)
        new_exe = next(work.glob(f"*/{EXE}"), None) or next(work.glob("*/dE3p Strava Sync.exe"), None)
        new = new_exe.parent if new_exe else None
        if not new:
            shutil.rmtree(work, ignore_errors=True)
            raise RuntimeError("De download is niet volledig. Probeer later opnieuw.")
        manual = next(work.glob("*.html"), None)
        script = work / "bijwerken.ps1"
        script.write_text(r"""param($procId, $app, $src, $exe, $work, $manual, $start)
try { Wait-Process -Id $procId -Timeout 60 -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Milliseconds 800
$old = "$app.oud"
Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
try { Rename-Item -LiteralPath $app -NewName (Split-Path $old -Leaf) -ErrorAction Stop }
catch { Start-Process -FilePath $exe; exit 1 }
try { Move-Item -LiteralPath $src -Destination $app -ErrorAction Stop }
catch { Rename-Item -LiteralPath $old -NewName (Split-Path $app -Leaf); Start-Process -FilePath $exe; exit 1 }
if ($manual -and (Test-Path -LiteralPath $manual)) { Copy-Item -LiteralPath $manual -Destination (Split-Path $app) -Force -ErrorAction SilentlyContinue }
Start-Process -FilePath $start -WorkingDirectory $app
Start-Sleep -Seconds 2
Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
""", encoding="utf-8")
        # eigen procesgroep, zonder venster; NIET 'detached': dan start PowerShell niet vanuit het pakket
        flags = 0x00000200 | 0x08000000                  # CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        subprocess.Popen(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
                          "-File", str(script), str(os.getpid()), str(app_dir), str(new), str(sys.executable),
                          str(work), str(manual or ""), str(app_dir / new_exe.name)], creationflags=flags, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
        if self._window:
            threading.Timer(1.0, self._window.destroy).start()
        return (rel.json().get("tag_name") or "").lstrip("v")

    def save_icon(self) -> str:
        """dE3p-icoon in Downloads zetten (Strava vraagt een icoon voor je API-app)."""
        dl = Path.home() / "Downloads"
        dst = (dl if dl.exists() else Path.home()) / "dE3p-icoon.png"
        shutil.copy2(userdata.RES / "assets" / "icon.png", dst)
        reveal(dst.parent)
        return str(dst)

    # ---- kaarten & openen ------------------------------------------------------
    def card(self, path: str) -> str:
        p = inside_cards(path)
        return "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode()

    def make_card(self, run_id: int, title: str, target: str = "") -> dict:
        """Kaart (opnieuw) maken voor een run; komt in de juiste maandmap."""
        cfg = self._cfg_full()
        tok = db.ss.strava_access_token(cfg)
        # wat het schema die dag vroeg (bv. de versnellingen), ook als de rij al afgevinkt is ('Schema: …')
        st = userdata.read_json(CACHE, {}) or {}
        act = next((a for a in st.get("acts") or [] if str(a.get("id")) == str(run_id)), None)
        row = next((r for w in st.get("schema") or [] for r in w.get("rows") or []
                    if act and r.get("date") == act["date"] and not r.get("rest")), None) if act else None
        note = db.rc.plan_note((row or {}).get("details")) if act and act.get("sport") == "run" else None
        path = db.rc.generate(tok, int(run_id), title or None, target or None, note=note)
        return {"path": str(path), "data": self.card(str(path))}

    def open_file(self, path: str) -> None:
        reveal(inside_cards(path))

    def open_folder(self, path: str = "") -> None:
        target = inside_cards(path).parent if path else cards_root()
        target.mkdir(parents=True, exist_ok=True)
        reveal(target)

    def open_data_folder(self) -> None:
        reveal(userdata.DATA)

    def strava_profile_url(self) -> str:
        """Link naar je eigen Strava-profiel; het atleet-id wordt één keer opgevraagd en onthouden."""
        aid = userdata.load().get("athlete_id")
        if not aid:
            cfg = self._cfg_full()
            tok = db.ss.strava_access_token(cfg)
            r = requests.get(f"{db.ss.STRAVA_API}/athlete", headers={"Authorization": f"Bearer {tok}"}, timeout=20)
            r.raise_for_status()
            aid = r.json().get("id")
            if not aid:
                raise RuntimeError("Strava gaf geen profiel terug.")
            userdata.update(athlete_id=aid)
        return f"https://www.strava.com/athletes/{int(aid)}"

    def run_block(self, run_id: int, structure: str):
        """Kernblok van een run: wat je liep naast het doel. Uit het geheugen, anders één keer via Strava."""
        import blocks
        structure = str(structure or "")
        if not blocks.has_block(structure):
            return None
        found, b = blocks.recall(run_id, structure)
        if not found:
            cfg = self._cfg_full()
            tok = db.ss.strava_access_token(cfg)
            b = blocks.analyze(structure, db.ss.strava_activity_detail(tok, int(run_id)))
            blocks.remember(run_id, structure, b)
        return block_view(b)

    # ---- gsm-app dE3p: koppelen en een versleutelde kopie sturen ------------------------
    def phone_pair(self, new: bool = False) -> dict:
        """Koppelcode (7 dagen geldig, verlengd bij elke sync) + QR-code die de gsm-app met die code opent."""
        import segno
        try:
            res = mirror.pair(bool(new))
        except requests.RequestException as exc:
            raise RuntimeError(f"Geen verbinding met de3p.be ({type(exc).__name__}). Ben je online?") from None
        res["qr"] = segno.make(res["url"], error="m").svg_inline(scale=5, border=2, dark="#0A0A0A", light="#FFFFFF")
        threading.Thread(target=self._phone_push_now, daemon=False).start()
        return res

    def phone_unpair(self) -> None:
        mirror.unpair()

    def phone_push(self) -> dict:
        self._health_today()
        self._phone_push_now()
        return mirror.status()

    def _phone_extra(self) -> dict:
        """Wat de gsm naast de trainingen nodig heeft: koppelingen, gezondheid en berekende kernblokken."""
        import blocks
        s = self.settings()
        sub = {k: s.get(k) for k in ("athlete", "health", "garmin", "wear", "notion", "plan", "rename", "scopeOk", "version", "goals", "body", "scale", "vitals", "vorm")}
        # welke wijzigingen van de gsm hier al verwerkt zijn: dan vergeet de gsm ze
        sub["goalsApplied"] = (userdata.read_json(userdata.DATA / "gsm_inbox.json", {}).get("applied") or [])[-300:]
        health = {}
        if s.get("health"):
            # tot 400 dagen: per dag terugbladeren. Hapert Garmin even: één keer opnieuw, anders de vorige goede
            # gegevens meesturen i.p.v. een foutmelding (de gsm toont dan wat hij al had).
            keep_file = userdata.DATA / "gsm_gezondheid.json"
            keep = userdata.read_json(keep_file, {})
            fresh = {}
            for k, fetch in (("rec", lambda: self.garmin_recovery(False, 400)), ("months", lambda: self.garmin_months(False))):
                v = fetch()
                if not v or v.get("error"):
                    time.sleep(5)
                    v = fetch()
                ok = bool(v) and not v.get("error")
                if ok:
                    fresh[k] = v
                health[k] = v if ok else (keep.get(k) or v)
            if fresh:
                userdata.write_json(keep_file, {**keep, **fresh})
        state = userdata.read_json(CACHE, {}) or {}
        runs = (state.get("runs") or [])[:80]
        # kernblokken van de laatste 6 weken: zelfde keuze als het scherm (structuur van de run,
        # anders die van het schema); nieuwe één keer via Strava, daarna uit het geheugen
        planned = {r["date"]: r.get("structure") or "" for w in state.get("schema") or [] for r in w.get("rows") or []
                   if not r.get("rest") and not r.get("done")}
        since = (dt.date.today() - dt.timedelta(days=42)).isoformat()
        for r in runs:
            struct = r.get("structure") or ""
            if not blocks.has_block(struct):
                struct = planned.get(r["date"], "")
            if r["date"] >= since and blocks.has_block(struct) and r.get("src") != "garmin":   # kernblok = via Strava
                try:
                    self.run_block(r["id"], struct)
                except Exception:
                    pass
        mem = userdata.read_json(blocks.CACHE, {})
        ids = {str(r["id"]) for r in runs}
        kern = {i: {"structure": v.get("structure"), "result": block_view(v.get("block"))}
                for i, v in mem.items() if i in ids and v.get("v") == blocks.CACHE_VERSION}
        # gevoel na de training (Garmin), voor de recentste runs; Garmin wordt per run maar één keer gevraagd
        feel = {}
        if s.get("garmin"):
            for r in runs[:25]:
                f = self.garmin_feel(r.get("start") or "", r.get("time") or 0) if r.get("start") else None
                if f:
                    feel[r["start"]] = f
        # je krachttrainingen (Garmin): oefeningen, vorige keer en volgende keer, ook voor de gsm
        fit = {}
        if s.get("garmin"):
            try:
                import garmin
                strength = [g for g in garmin.activities() if g["type"] == "strength_training"]
            except Exception:
                strength = []
            for a in (state.get("acts") or [])[:150]:
                if strength and a.get("sport") == "other" and a.get("start") and garmin.match(strength, a["start"]):
                    res = self.fitness_session(a["start"])
                    if res:
                        fit[a["start"]] = res
        # hartslagzones van je loopjes van de laatste 3 weken (Garmin vraagt elke training maar één keer)
        zones = {}
        if s.get("garmin"):
            since = (dt.date.today() - dt.timedelta(days=21)).isoformat()
            for r in runs[:40]:
                if r.get("start") and r.get("date", "") >= since:
                    z = self.hr_zones(r["start"])
                    if z:
                        zones[r["start"]] = z
        return {"settings": sub, "health": health, "blocks": kern, "feel": feel, "fitness": fit, "zones": zones}

    def _phone_inbox(self) -> None:
        """Doelen die je op de gsm maakte, wijzigde of verwijderde: hier overnemen (één keer per wijziging)."""
        import re
        done_file = userdata.DATA / "gsm_inbox.json"
        done = userdata.read_json(done_file, {}).get("applied") or []
        ops = mirror.inbox()
        new = 0
        for o in sorted(ops, key=lambda x: str(x.get("at") or "")):
            oid, gid = str(o.get("oid") or ""), str(o.get("id") or "")
            if not re.fullmatch(r"[\w-]{6,64}", oid) or oid in done:
                continue
            if o.get("op") in ("weight", "scale", "glucose", "bp", "vitals", "waist", "sweat"):   # lichaam, van de gsm
                try:
                    if o["op"] == "weight":
                        self.add_weight(o.get("kg"), o.get("fat"), str(o.get("date") or ""))
                    elif o["op"] == "scale":
                        self.set_scale(str(o.get("brand") or ""))
                    elif o["op"] == "glucose":
                        self.add_glucose(o.get("mgdl"), str(o.get("ctx") or "los"), str(o.get("at") or ""))
                    elif o["op"] == "bp":
                        self.add_bp(o.get("sys"), o.get("dia"), o.get("pulse"), str(o.get("at") or ""))
                    elif o["op"] == "waist":
                        self.add_waist(o.get("cm"), str(o.get("at") or ""))
                    elif o["op"] == "sweat":
                        self.add_sweat(str(o.get("start") or ""), o.get("before"), o.get("after"), o.get("drank") or 0, o.get("secs") or 0)
                    else:
                        self.set_vitals(str(o.get("kind") or ""), bool(o.get("on")))
                except Exception:
                    pass
                done.append(oid)
                new += 1
                continue
            if not re.fullmatch(r"[\w-]{2,64}", gid):
                continue
            if o.get("op") == "delete":
                localextra.delete_goal(gid)
            elif o.get("op") == "save" and isinstance(o.get("profile"), dict) and isinstance(o.get("plans"), dict):
                plans = {sp: pl for sp, pl in o["plans"].items() if sp in localextra.SPORTS and isinstance(pl, dict)
                         and isinstance(pl.get("sessions"), list) and pl["sessions"]}
                if not plans:
                    continue
                localextra.save_goal(o["profile"], plans, gid)
            else:
                continue
            done.append(oid)
            new += 1
        if ops:
            mirror.clear_inbox()
        if new:
            userdata.write_json(done_file, {"applied": done[-300:]})

    def _phone_push_now(self) -> None:
        if not mirror.paired():
            return
        with self._push_lock:
            force, self._push_force = self._push_force, False
            try:
                self._phone_inbox()
            except Exception:
                log_error("phone_inbox")
            try:
                state = userdata.read_json(CACHE, None)
                if state:
                    mirror.push(state, self._phone_extra(), force=force)
            except Exception:
                log_error("phone_push")

    def _watch_phone(self) -> None:
        """Bijwerken op de gsm: de gsm legt een seintje in de brievenbus. Zolang dit venster openstaat, kijkt dE3p
        elke WATCH_EVERY s of er een ligt en synct dan meteen (Strava, Notion, Body Battery), waarna de gsm de
        nieuwe kopie ophaalt. Een doel dat je op de gsm maakte, wordt zo ook meteen overgenomen."""
        seen: set[str] = set()
        while True:
            time.sleep(WATCH_EVERY)
            if not mirror.paired():
                continue
            try:
                ops = mirror.inbox()
            except Exception:
                continue                               # even geen internet: straks opnieuw
            if not ops:
                continue
            asks = [str(o.get("oid") or "") for o in ops if o.get("op") == "sync"]
            new = [a for a in asks if a not in seen]
            if asks and not new:
                continue                               # al bezig met dat seintje (de kopie gaat zo weg)
            if new:
                if self._lock.locked() or sync_locked():
                    continue                           # er loopt al een sync: die stuurt zo een kopie, anders straks opnieuw
                seen.update(new)
                self._push_force = True
                try:
                    self.sync()                        # stuurt daarna zelf de kopie (_phone_later)
                except Exception:
                    self._push_force = True            # sync mislukt (bv. Strava hapert): toch een verse kopie,
                    self._phone_push_now()             # zodat de gsm niet blijft wachten
                try:
                    if self._window:                   # en het venster hier toont de nieuwe cijfers ook
                        self._window.evaluate_js("window.de3pRemote && window.de3pRemote()")
                except Exception:
                    pass
            else:
                self._phone_push_now()                 # enkel doelen van de gsm: meteen overnemen

    def _phone_later(self, state: dict) -> dict:
        if mirror.paired():
            self._phone_thread = threading.Thread(target=self._phone_push_now, daemon=False)
            self._phone_thread.start()
        return state

    # ---- Garmin: slaap, Body Battery, HRV, gereedheid, gevoel na een training ----------
    def garmin_login(self, email: str, password: str) -> str:
        """'ok' of 'mfa'. Het wachtwoord gaat enkel naar Garmin en wordt nergens bewaard."""
        import garmin
        try:
            return garmin.start_login(str(email), str(password))
        except Exception as exc:
            raise RuntimeError(f"Inloggen bij Garmin mislukt: {type(exc).__name__}. Controleer je e-mail en wachtwoord.") from None

    def garmin_mfa(self, code: str) -> str:
        import garmin
        try:
            garmin.finish_mfa(str(code))
        except Exception:
            raise RuntimeError("Die code klopt niet of is verlopen. Probeer opnieuw.") from None
        return "ok"

    def garmin_disconnect(self) -> None:
        import garmin
        garmin.disconnect()

    def garmin_recovery(self, force: bool = False, days: int = 7):
        """Herstel (Overzicht, 7 dagen) of het tabblad Gezondheid (7 of 30 dagen), van Garmin of
        anders van Whoop, Oura, Polar, Withings of intervals.icu. Je gewicht (Withings, intervals.icu) komt er altijd bij."""
        import garmin
        src = health_source()
        if not src:
            return None
        days = min(max(int(days or 7), 1), 400 if src == "garmin" else 45)   # Garmin: zie garmin.KEEP
        try:
            if src == "garmin":
                if days > garmin.FETCH:                # oudere dagen komen uit het jaaroverzicht
                    try:
                        garmin.months(garmin.MONTHS)
                    except Exception:
                        pass
                rec = garmin.recovery(days, bool(force), after=_last_start_today())
            else:
                rec = wearables.recovery(src, days, bool(force))
            import vitals
            return vitals.with_vitals(with_scale(wearables.add_weight(rec, src, min(days, 45))))
        except Exception as exc:
            log_error("garmin_recovery")
            return {"error": health_error(src, exc)}

    def _health_today(self) -> None:
        """Bij elke sync: de cijfers van vandaag (Body Battery, stress, stappen…) opnieuw ophalen, niet pas na
        een half uur. Enkel vandaag: oudere dagen veranderen niet meer."""
        src = health_source()
        if not src:
            return
        try:
            if src == "garmin":
                import garmin
                garmin.recovery(1, True, after=_last_start_today())
                try:
                    garmin.weights(force=True)             # net gewogen? meteen in dE3p
                    import vitals
                    if vitals.tracking()["bp"]:
                        garmin.blood_pressure(force=True)  # bloeddruk gemeten? ook meteen
                except Exception:
                    pass
            else:
                wearables.recovery(src, 1, True)
        except Exception:
            log_error("health_today")

    def garmin_months(self, force: bool = False):
        """Tabblad Gezondheid, per maand: gemiddelden van de laatste 12 maanden."""
        import garmin
        src = health_source()
        if not src:
            return None
        try:
            if src == "garmin":
                return garmin.months(garmin.MONTHS, bool(force))
            return wearables.months(src, bool(force))
        except Exception as exc:
            log_error("garmin_months")
            return {"error": health_error(src, exc)}

    # ---- Whoop, Oura, Polar, Withings: eigen app per gebruiker, zoals de Strava-sleutel ----------
    def wear_connect(self, k: str, client_id: str, client_secret: str) -> str:
        if k not in wearables.PROVIDERS:
            raise RuntimeError("Onbekende koppeling.")
        name = wearables.PROVIDERS[k]["name"]
        cid, sec = str(client_id).strip(), str(client_secret).strip()
        if len(cid) < 4 or len(sec) < 8:
            raise RuntimeError("Vul je Client ID en Client Secret volledig in.")
        state = secrets.token_urlsafe(16)
        code = self._oauth_code(wearables.authorize_url(k, cid, state), state, name)
        wearables.finish(k, cid, sec, code)
        return name

    def wear_connect_key(self, k: str, athlete_id: str, api_key: str) -> str:
        """intervals.icu: geen app nodig, enkel je atleet-ID en API-sleutel."""
        if not wearables.PROVIDERS.get(k, {}).get("key"):
            raise RuntimeError("Onbekende koppeling.")
        aid, key = str(athlete_id).strip(), str(api_key).strip()
        if len(aid) < 2 or len(key) < 8:
            raise RuntimeError("Vul je atleet-ID en API-sleutel volledig in.")
        wearables.connect_key(k, aid, key)
        return wearables.PROVIDERS[k]["name"]

    def wear_disconnect(self, k: str) -> None:
        if k in wearables.PROVIDERS:
            wearables.disconnect(k)

    def _oauth_code(self, url: str, state: str, name: str) -> str:
        """Browser opent de dienst → toestemming → terug naar http://localhost:8721/callback → code."""
        got, done = {}, threading.Event()

        class Callback(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                u = urlparse(self.path)
                if u.path != "/callback":
                    self.send_response(404)
                    self.end_headers()
                    return
                q = parse_qs(u.query)
                if q.get("state", [""])[0] != state:
                    ok, msg = False, "Deze aanvraag kwam niet van dE3p. Probeer opnieuw vanuit het programma."
                elif "error" in q or "code" not in q:
                    got["error"] = f"Je hebt de toegang geweigerd bij {name}."
                    ok, msg = False, "Je hebt de toegang geweigerd. Ga terug naar het programma en probeer opnieuw."
                else:
                    got["code"] = q["code"][0]
                    ok, msg = True, "Je kan dit tabblad sluiten en teruggaan naar dE3p."
                body = callback_page(ok, msg, name)
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                if ok or "error" in got:
                    done.set()

            def log_message(self, *args):  # stil
                pass

        try:
            srv = HTTPServer(("127.0.0.1", OAUTH_PORT), Callback)
        except OSError:
            raise RuntimeError(f"Poort {OAUTH_PORT} is bezet. Sluit andere vensters van dit programma en probeer opnieuw.") from None
        srv.timeout = 0.5
        self._oauth_cancel.clear()
        open_link(url)
        deadline = time.time() + 600
        try:
            while not done.is_set() and not self._oauth_cancel.is_set() and time.time() < deadline:
                srv.handle_request()
        finally:
            srv.server_close()
        if self._oauth_cancel.is_set():
            raise RuntimeError("Koppelen geannuleerd.")
        if not done.is_set():
            raise RuntimeError(f"Geen antwoord van {name} binnen 10 minuten. Probeer opnieuw.")
        if "error" in got:
            raise RuntimeError(got["error"])
        return got["code"]

    def fitness_session(self, start_local: str):
        """Je krachttraining van dat moment (Garmin), uitgelezen en geïnterpreteerd: per oefening wat je deed,
        tegenover de vorige keer, en wat je volgende keer neemt (fitness.py)."""
        import garmin
        if not garmin.connected() or not start_local:
            return None
        try:
            import fitness
            return fitness.session_for(str(start_local))
        except Exception:
            log_error("fitness_session")
            return None

    def garmin_feel(self, start_local: str, secs: int = 0):
        import garmin
        if not garmin.connected() or not start_local:
            return None
        try:
            return garmin.activity_feel(str(start_local), int(secs or 0))
        except Exception:
            log_error("garmin_feel")
            return None

    def set_browser(self, bid: str) -> None:
        """Browserprofiel kiezen voor Strava/Notion-links; '' = standaardbrowser."""
        if not bid:
            userdata.update(browser=None)
            return
        match = next((b for b in browser_profiles() if b["id"] == bid), None)
        if not match:
            raise ValueError("Onbekend browserprofiel.")
        userdata.update(browser={"id": match["id"], "exe": match["exe"], "profile": match["profile"]})

    def open_manual(self) -> None:
        """De handleiding (installeren, opstartstappen, gebruik) openen in de browser."""
        for p in (userdata.RES / "docs" / "Handleiding.html", userdata.CODE / "docs" / "Handleiding.html"):
            if p.exists():
                webbrowser.open(p.resolve().as_uri())
                return
        raise RuntimeError("De handleiding zit niet bij dit programma.")

    def open_url(self, url: str) -> None:
        if re.match(r"^https://(www\.)?(strava\.com|connect\.garmin\.com|notion\.so|de3p\.be|ollama\.com|developer-dashboard\.whoop\.com"
                    r"|cloud\.ouraring\.com|admin\.polaraccesslink\.com)/", url):
            open_link(url)

    def notion_url(self) -> str:
        pid = (self._config().get("notion_page_id") or "").replace("-", "")
        return f"https://www.notion.so/{pid}" if pid else ""

    def ready(self, info=None) -> None:        # selftest: interface draait → verslag + venster sluiten
        if self._selftest and self._window:
            report = {"ok": dt.datetime.now().strftime("%H:%M:%S"), **(info or {})}
            (userdata.LOGS / "selftest.txt").write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
            threading.Timer(1.5, self._window.destroy).start()


def fallback_browser(autosync: bool) -> None:
    """Geen venster mogelijk → HTML-overzicht in de browser (oude werking)."""
    if not is_connected():
        return
    db.write(db.loading_page())
    webbrowser.open(db.OUT.as_uri())
    db.load_modules()
    cfg = db.ss.load_config()
    db.write(db.build(db.run_sync(cfg) if autosync else {"ran": False}, cfg))


def check_package() -> None:
    """--check: zonder venster nagaan of het pakket compleet is (kaart tekenen met
    matplotlib, HTTPS naar Strava). Verslag in logs/check.txt."""
    import tempfile
    report = {}
    try:
        db.load_modules()
        splits = [{"split": i + 1, "distance": 1000, "moving_time": 300, "average_speed": 1000 / 300} for i in range(5)]
        demo = {"sport_type": "Run", "distance": 5000, "moving_time": 1500, "start_date_local": dt.date.today().isoformat() + "T08:00:00Z",
                "average_heartrate": 150, "max_heartrate": 170, "splits_metric": splits}
        card = db.rc.build_card(demo, {}, "Controle — pakket", "5:00/km", out_dir=Path(tempfile.mkdtemp()))
        report["card"] = card.stat().st_size
        # een fietsrit op een loopdag mag nooit de naam van de geplande run krijgen
        ride = db.ss.extract_facts(dict(demo, sport_type="Ride", type="Ride"))
        real = db.ss.notion_planned_info
        db.ss.notion_planned_info = lambda cfg, f: ("Duurloop — 8 km", "5:00/km")   # elke dag een run gepland
        try:
            if db.ss.planned_info({"notion_token": "x", "notion_page_id": "x"}, ride) != (None, None):
                raise RuntimeError("fietsrit kreeg het loopschema")
        finally:
            db.ss.notion_planned_info = real
        report["ride_not_planned"] = True
        report["strava_https"] = requests.get("https://www.strava.com/api/v3/athlete", timeout=20).status_code
        # Garmin-koppeling: bibliotheek + curl_cffi (native onderdeel) moeten in het pakket zitten
        from garminconnect import Garmin
        Garmin()
        import curl_cffi.requests
        report["garmin_https"] = curl_cffi.requests.get("https://connect.garmin.com", timeout=20).status_code
        report["ok"] = True
    except Exception as exc:
        report.update(ok=False, error=f"{type(exc).__name__}: {exc}")
        log_error("check")
    (userdata.LOGS / "check.txt").write_text(json.dumps(report), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description="dE3p")
    ap.add_argument("--no-sync", action="store_true", help="niet automatisch syncen bij het openen")
    ap.add_argument("--selftest", action="store_true", help="venster openen, controleren en sluiten")
    ap.add_argument("--check", action="store_true", help="pakket controleren zonder venster")
    ap.add_argument("--sync-only", action="store_true", help="enkel syncen, zonder venster (Taakplanner)")
    ap.add_argument("--update", action="store_true", help="nieuwste versie installeren en opnieuw starten (Windows-pakket)")
    args = ap.parse_args()
    if args.check:
        return check_package()
    if args.update:
        print(Api(False).update_install())
        return None
    if args.sync_only:
        if is_connected() and not sync_locked():
            api = Api(False)
            api._bg = True                             # niemand wacht: meer oude loopjes per keer voor je records
            try:
                api.sync()
            except Exception:
                pass                                   # al gelogd in sync()
            # de gsm-kopie hier afwachten: anders sluit Python al af terwijl Garmin nog laadt
            # ("can't register atexit after shutdown") en mist de gsm de maandcijfers
            t = getattr(api, "_phone_thread", None)
            if t:
                t.join(timeout=900)
        return None
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)
        except Exception:
            pass
    autosync = not args.no_sync and not args.selftest
    if not args.selftest:
        threading.Thread(target=migrate_names, daemon=True).start()

    try:
        import webview
    except Exception:
        log_error("pywebview ontbreekt")
        return fallback_browser(autosync)

    api = Api(autosync, args.selftest)
    try:
        api._window = webview.create_window(
            "dE3p", str(UI), js_api=api, width=1320, height=900,
            min_size=(960, 660), text_select=True,
            background_color="#F6F6F5" if userdata.load().get("theme") == "light" else "#0A0A0A")
        api._window.events.shown += lambda: titlebar(userdata.load().get("theme") != "light")
        if autosync:                                   # Bijwerken op de gsm = hier meteen syncen
            threading.Thread(target=api._watch_phone, daemon=True).start()
        if sys.platform == "win32":                    # dE3p-logo op het venster en de taakbalk
            webview.start(http_server=True, gui="edgechromium", icon=str(userdata.RES / "assets" / "de3p-logo.ico"))
        else:
            webview.start(http_server=True)
    except Exception:
        log_error("venster starten")
        fallback_browser(autosync)


def _last_start_today() -> str | None:
    """Start van je laatste training vandaag (lokaal, 'JJJJ-MM-DDTHH:MM'), om te weten of Garmin je dagwaarden al heeft."""
    acts = (userdata.read_json(CACHE, {}) or {}).get("acts") or []
    td = dt.date.today().isoformat()
    starts = [str(a.get("start") or "")[:16] for a in acts if a.get("date") == td and a.get("start")]
    return max(starts) if starts else None


if __name__ == "__main__":
    main()

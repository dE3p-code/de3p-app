"""
Waar dE3p zijn gegevens bewaart.

Twee standen:
  * ontwikkelmap: er staat een .env naast de code (Jens' pc). Sleutels komen uit
    .env, gegevens (state, cache, logs) blijven naast de code, zoals altijd.
  * geïnstalleerd: het .exe/.app-pakket, of geen .env. Alles per gebruiker in
      Windows  %APPDATA%\\dE3p
      macOS    ~/Library/Application Support/dE3p
    (wie al installeerde toen het programma nog 'dE3p Strava Sync' heette, houdt die map)
    en de sleutels in config.json daar (verlaten de pc nooit).

DE3P_DATA_DIR=<map> forceert een gegevensmap, bv. om als nieuwe gebruiker te testen.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

APP_NAME = "dE3p"
OLD_NAME = "dE3p Strava Sync"          # vroegere naam: bestaande mappen blijven gewoon in gebruik
VERSION = "2.19.5"

FROZEN = bool(getattr(sys, "frozen", False))
CODE = Path(__file__).resolve().parent
RES = Path(getattr(sys, "_MEIPASS", CODE))        # meegeleverde bestanden: app/, assets/
ENV_PATH = CODE / ".env"


def named(base: Path) -> Path:
    """base/dE3p, of base/dE3p Strava Sync als die er van vroeger al staat."""
    old = base / OLD_NAME
    return old if old.exists() else base / APP_NAME


def _user_dir() -> Path:
    if sys.platform == "win32":
        return named(Path(os.getenv("APPDATA") or Path.home() / "AppData" / "Roaming"))
    if sys.platform == "darwin":
        return named(Path.home() / "Library" / "Application Support")
    return named(Path(os.getenv("XDG_DATA_HOME") or Path.home() / ".local" / "share"))


_forced = os.getenv("DE3P_DATA_DIR", "").strip()
LEGACY = not _forced and not FROZEN and ENV_PATH.exists()
DATA = Path(_forced) if _forced else (CODE if LEGACY else _user_dir())
DATA.mkdir(parents=True, exist_ok=True)

CONFIG = DATA / "config.json"      # instellingen (+ sleutels in de geïnstalleerde stand)
STATE = DATA / "state.json"        # welke activiteiten al verwerkt zijn
CACHE = DATA / "cache.json"        # laatste stand voor het venster (snel opstarten)
PLAN = DATA / "plan.json"          # eigen schema (als er geen Notion-schema is)
LOGS = DATA / "logs"
LOGS.mkdir(exist_ok=True)


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(path: Path, obj) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def load() -> dict:
    return read_json(CONFIG, {})


def update(**values) -> dict:
    """Waarden in config.json zetten; None verwijdert een sleutel."""
    cfg = load()
    for k, v in values.items():
        if v is None:
            cfg.pop(k, None)
        else:
            cfg[k] = v
    write_json(CONFIG, cfg)
    return cfg


def _pictures() -> Path:
    """De echte map Afbeeldingen (op Windows vaak omgeleid naar OneDrive)."""
    if sys.platform == "win32":
        try:
            import ctypes
            buf = ctypes.create_unicode_buffer(260)
            if ctypes.windll.shell32.SHGetFolderPathW(None, 0x27, None, 0, buf) == 0 and buf.value:  # CSIDL_MYPICTURES
                return Path(buf.value)
        except Exception:
            pass
    pics = Path.home() / "Pictures"
    return pics if pics.exists() else Path.home()


def default_cards_dir() -> Path:
    return named(_pictures())


def cards_dir() -> Path:
    v = os.getenv("RECAP_DIR") or load().get("cards_dir")
    if v and sys.platform != "win32" and re.match(r"^[A-Za-z]:[\\/]", v):
        v = None                     # verhuisd van Windows naar Mac: 'C:\…' bestaat hier niet → standaardmap
    return Path(v) if v else default_cards_dir()

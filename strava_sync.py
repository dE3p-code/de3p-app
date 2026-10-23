"""
Strava -> automatische titel + Notion-marathonschema logger.

Flow (zie README.md):
  1. Vernieuw Strava access token (refresh token).
  2. Haal nieuwe activiteiten op sinds de laatste run.
  3. Per activiteit: lees de echte cijfers + PR's (detail-endpoint).
  4. Bouw een beschrijvende titel (vaste regels = harde cijfers) en laat
     Ollama/mistral-nemo de verwoording verzorgen (nooit getallen verzinnen).
  5. Zet de titel op Strava (alleen als de naam nog een standaardnaam is).
  6. Log de training in het juiste dag-vak van de huidige week in Notion.

Veilig draaien:
  python strava_sync.py --once            # 1 cyclus (voor de Taakplanner)
  python strava_sync.py --once --dry-run   # niks wegschrijven, enkel tonen
  python strava_sync.py --backfill 5       # laatste 5 dagen opnieuw bekijken
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import requests

try:
    from dotenv import load_dotenv
except Exception:  # python-dotenv optioneel; .env wordt anders handmatig gelezen
    load_dotenv = None

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))
import userdata  # noqa: E402  (waar sleutels/state/logs staan: ontwikkelmap of per gebruiker)

ENV_PATH = userdata.ENV_PATH
STATE_PATH = userdata.STATE
LOG_DIR = userdata.LOGS

STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token"
# Gedeelde dE3p-sleutel: het geheim staat enkel op de server, die het bij de token-aanvraag invult
SHARED_TOKEN_URL = "https://www.de3p.be/api/strava/oauth/token"
SHARED_CONFIG_URL = "https://www.de3p.be/api/strava/config"
STRAVA_API = "https://www.strava.com/api/v3"
NOTION_API = "https://api.notion.com/v1"
NOTION_VERSION = "2022-06-28"

WEEKDAYS_NL = ["Maandag", "Dinsdag", "Woensdag", "Donderdag", "Vrijdag", "Zaterdag", "Zondag"]

log = logging.getLogger("strava_sync")


# --------------------------------------------------------------------------- #
# Config & state
# --------------------------------------------------------------------------- #
def setup_logging() -> None:
    log.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s  %(levelname)-7s %(message)s", "%Y-%m-%d %H:%M:%S")
    fh = logging.FileHandler(LOG_DIR / "sync.log", encoding="utf-8")
    fh.setFormatter(fmt)
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    log.handlers = [fh, sh]


def load_config() -> dict:
    """Ontwikkelmap: sleutels uit .env (zoals altijd). Geïnstalleerd: alles uit
    config.json in de gebruikersmap, ingevuld via de opstartwizard."""
    legacy = userdata.LEGACY
    if legacy and load_dotenv and ENV_PATH.exists():
        load_dotenv(ENV_PATH)
    f = userdata.load()

    def get(env_key: str, file_key: str, default: str = "") -> str:
        v = os.getenv(env_key, "") if legacy else ""
        return str(v or f.get(file_key) or default).strip()

    cfg = {
        "client_id": get("STRAVA_CLIENT_ID", "client_id"),
        "client_secret": get("STRAVA_CLIENT_SECRET", "client_secret"),
        "refresh_token": get("STRAVA_REFRESH_TOKEN", "refresh_token"),
        "notion_token": get("NOTION_TOKEN", "notion_token"),
        "notion_page_id": get("NOTION_PAGE_ID", "notion_page_id"),
        "ollama_url": get("OLLAMA_URL", "ollama_url", "http://localhost:11434").rstrip("/"),
        "ollama_model": get("OLLAMA_MODEL", "ollama_model", "mistral-nemo:latest"),
        # Ollama (lokale AI-naam) enkel waar het geïnstalleerd is: Jens' ontwikkelmap
        "use_ollama": legacy and os.getenv("USE_OLLAMA", "true").lower() != "false",
        "log_to_notion": os.getenv("LOG_TO_NOTION", "true").lower() != "false",
        "lookback_days": int(get("POLL_LOOKBACK_DAYS", "lookback_days", "3")),
        # Strava-naam aanpassen: geplande runs → trainingstype. Ongeplande runs en de
        # beschrijving (cijfers + tussentijden) enkel in de ontwikkelmap, andere
        # gebruikers houden hun Strava zo proper mogelijk.
        "rename": bool(f.get("rename", True)),
        # eigen titel in gewone taal → sjabloon (titles.py), bv. "{training} · {km} · {hr}"
        "title_template": str(f.get("title_template") or "").strip(),
        "card_sports": set(f.get("card_sports") or __import__("sports").DEFAULT_CARDS),
        "rename_unplanned": legacy,
        "write_description": legacy,
    }
    need = ("client_id", "refresh_token") if f.get("strava_shared") and not legacy else ("client_id", "client_secret", "refresh_token")
    missing = [k for k in need if not cfg[k]]
    if missing:
        raise SystemExit("Strava is nog niet gekoppeld." if not legacy else
                         f"Ontbrekende Strava-config in .env: {', '.join(missing)} (run get_strava_token.py)")
    return cfg


def save_refresh_token(token: str) -> None:
    if userdata.LEGACY:
        update_env_var("STRAVA_REFRESH_TOKEN", token)
    else:
        userdata.update(refresh_token=token)


def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except Exception:
            log.warning("state.json onleesbaar, start vers")
    return {"processed_ids": [], "last_start_epoch": 0}


def save_state(state: dict) -> None:
    state["processed_ids"] = state["processed_ids"][-300:]
    STATE_PATH.write_text(json.dumps(state, indent=2), encoding="utf-8")


def update_env_var(key: str, value: str) -> None:
    """Bewaar een (geroteerde) refresh token terug naar .env."""
    lines = ENV_PATH.read_text(encoding="utf-8").splitlines() if ENV_PATH.exists() else []
    out, found = [], False
    for ln in lines:
        if ln.strip().startswith(f"{key}="):
            out.append(f"{key}={value}")
            found = True
        else:
            out.append(ln)
    if not found:
        out.append(f"{key}={value}")
    ENV_PATH.write_text("\n".join(out) + "\n", encoding="utf-8")


# --------------------------------------------------------------------------- #
# Strava
# --------------------------------------------------------------------------- #
def strava_access_token(cfg: dict) -> str:
    shared = not cfg.get("client_secret")              # gedeelde dE3p-sleutel (geen eigen Strava-abonnement nodig)
    data = {"client_id": cfg["client_id"], "grant_type": "refresh_token", "refresh_token": cfg["refresh_token"]}
    if not shared:
        data["client_secret"] = cfg["client_secret"]
    r = requests.post(SHARED_TOKEN_URL if shared else STRAVA_TOKEN_URL, data=data, timeout=30)
    r.raise_for_status()
    data = r.json()
    new_refresh = data.get("refresh_token")
    if new_refresh and new_refresh != cfg["refresh_token"]:
        log.info("Strava refresh token geroteerd -> bewaard")
        save_refresh_token(new_refresh)
        cfg["refresh_token"] = new_refresh
    return data["access_token"]


def strava_recent_activities(token: str, after_epoch: int) -> list[dict]:
    r = requests.get(f"{STRAVA_API}/athlete/activities",
                     headers={"Authorization": f"Bearer {token}"},
                     params={"after": after_epoch, "per_page": 50}, timeout=30)
    r.raise_for_status()
    return r.json()


def strava_activity_detail(token: str, activity_id: int) -> dict:
    r = requests.get(f"{STRAVA_API}/activities/{activity_id}",
                     headers={"Authorization": f"Bearer {token}"},
                     params={"include_all_efforts": "true"}, timeout=30)
    r.raise_for_status()
    return r.json()


def strava_update_activity(token: str, activity_id: int, name: str,
                           description: str | None, dry_run: bool) -> None:
    if dry_run:
        log.info("[dry-run] zou Strava-titel zetten: %s", name)
        if description:
            log.info("[dry-run] zou beschrijving zetten: %s", description.replace("\n", " | "))
        return
    data = {"name": name}
    if description:
        data["description"] = description
    r = requests.put(f"{STRAVA_API}/activities/{activity_id}",
                     headers={"Authorization": f"Bearer {token}"},
                     data=data, timeout=30)
    r.raise_for_status()
    log.info("Strava-titel gezet: %s", name)
    if description:
        log.info("Strava-beschrijving gezet (%d tekens)", len(description))


DEFAULT_NAME_RE = re.compile(
    r"^(ochtend|namiddag|middag|avond|nacht|lunch|morning|afternoon|evening|night|lunch)"
    r"\s*(loop|rit|run|ride|walk|wandeling|hardloopsessie|fietsrit|workout|activiteit|"
    r"swim|zwemmen|zwemsessie|zwembeurt|zwemtraining|weight training|krachttraining|gewichtstraining|training|"
    r"tennis|padel|hike|e-?bike|e-?bikerit|gravelrit|mountainbikerit)?$"
    # ook "Zwemmen in de ochtend", "Krachttraining in de avond"
    r"|^(zwemmen|zwemsessie|krachttraining|gewichtstraining|training|workout)(\s+in de\s+(ochtend|middag|namiddag|avond|nacht))?$",
    re.IGNORECASE,
)


def is_default_name(name: str) -> bool:
    n = (name or "").strip()
    if not n:
        return True
    return bool(DEFAULT_NAME_RE.match(n))


# --------------------------------------------------------------------------- #
# Cijfers uit een activiteit halen (de "harde regels")
# --------------------------------------------------------------------------- #
def fmt_nl(value: float, decimals: int = 1) -> str:
    return f"{value:.{decimals}f}".replace(".", ",")


def fmt_duration(seconds: float) -> str:
    s = int(round(seconds))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def fmt_pace(moving_time: float, dist_km: float) -> str:
    if dist_km <= 0:
        return "0:00"
    total = moving_time / dist_km
    m, s = divmod(int(round(total)), 60)
    return f"{m}:{s:02d}"


def daypart(hour: int) -> str:
    if hour < 5:
        return "Nacht"
    if hour < 12:
        return "Ochtend"
    if hour < 18:
        return "Namiddag"
    return "Avond"


def extract_facts(d: dict) -> dict:
    sport = (d.get("sport_type") or d.get("type") or "").lower()
    is_run = "run" in sport
    is_ride = "ride" in sport or "bike" in sport
    dist_km = (d.get("distance") or 0) / 1000.0
    moving = d.get("moving_time") or 0
    elapsed = d.get("elapsed_time") or 0
    local = d.get("start_date_local") or d.get("start_date") or ""
    dt = None
    for parse in (local.replace("Z", ""), local):
        try:
            dt = datetime.fromisoformat(parse)
            break
        except Exception:
            continue

    efforts = d.get("segment_efforts") or []
    pr_names = [e.get("name") or (e.get("segment") or {}).get("name", "?")
                for e in efforts if e.get("pr_rank") == 1]

    cadence = d.get("average_cadence")
    cad_spm = None
    if cadence:
        cad_spm = round(cadence * 2) if (is_run and cadence < 130) else round(cadence)

    splits = []
    for i, sp in enumerate(d.get("splits_metric") or [], start=1):
        sdist = sp.get("distance") or 0
        smt = sp.get("moving_time") or sp.get("elapsed_time") or 0
        if sdist <= 0 or smt <= 0:
            continue
        km = sdist / 1000
        partial = sdist < 950
        label = f"km{i}" if not partial else f"+{fmt_nl(km, 1)} km"
        splits.append({"label": label, "pace": fmt_pace(smt, km),
                       "sec": round(smt / km), "km": km, "partial": partial})

    import sports
    swim_m = (d.get("distance") or 0)
    f = {
        "id": d.get("id"),
        "sport": sports.group(d),                  # run / ride / swim / walk / strength / racket / other
        "sport_name": sports.name(d),              # bv. "Tennis", "Krachttraining"
        "pace100": fmt_duration(moving / (swim_m / 100)) if swim_m and moving else None,   # zwemmen
        "calories": round(d["calories"]) if d.get("calories") else None,
        "current_name": d.get("name", ""),
        "dist_km": dist_km,
        "moving_time": moving,
        "elapsed_time": elapsed,
        "pace": fmt_pace(moving, dist_km),
        "speed_kmh": (d.get("average_speed") or 0) * 3.6,
        "max_speed_kmh": (d.get("max_speed") or 0) * 3.6,
        "hr": round(d["average_heartrate"]) if d.get("average_heartrate") else None,
        "watts": round(d["average_watts"]) if d.get("average_watts") else None,
        "device_watts": bool(d.get("device_watts")),
        "kj": round(d["kilojoules"]) if d.get("kilojoules") else None,
        "cadence": cad_spm,
        "elev": round(d.get("total_elevation_gain") or 0),
        "pr_count": len(pr_names),
        "pr_names": pr_names,
        "splits": splits,
        "gear": (d.get("gear") or {}).get("name"),
        "datetime": dt,
        "daypart": daypart(dt.hour) if dt else "Ochtend",
        "date_ddmm": dt.strftime("%d/%m") if dt else "",
        "weekday_nl": WEEKDAYS_NL[dt.weekday()] if dt else "",
    }
    return f


# --------------------------------------------------------------------------- #
# Titel bouwen
# --------------------------------------------------------------------------- #
def run_descriptor(f: dict) -> str:
    return f"{f['daypart'].lower()}loop"  # bv. ochtendloop


def ride_descriptor(f: dict) -> str:
    if f["dist_km"] >= 60:
        return "duurrit"
    return f"{f['daypart'].lower()}rit"


def default_descriptor(f: dict) -> str:
    if f["sport"] == "run":
        return run_descriptor(f).capitalize()   # Ochtendloop
    if f["sport"] == "ride":
        return ride_descriptor(f)               # duurrit / ochtendrit
    if f["sport"] == "swim":
        return f"{f['daypart']}zwembeurt"       # Ochtendzwembeurt
    if f["sport"] == "walk":
        return f"{f['daypart']}wandeling"       # Avondwandeling
    return f.get("sport_name") or f"{f['daypart']}training"   # Tennis, Krachttraining


def assemble_title(f: dict, descriptor: str) -> str:
    """Bouw de titel; de CIJFERS komen altijd hieruit (vaste regels)."""
    dist = fmt_nl(f["dist_km"], 1)
    if f["sport"] == "run":
        t = f"{descriptor} {dist} km @ {f['pace']}/km"
        if f["hr"]:
            t += f" · {f['hr']} bpm"
        if f["pr_count"]:
            t += f" — {f['pr_count']} PR's gepakt"
        return t
    if f["sport"] == "ride":
        t = f"{dist} km {descriptor} @ {fmt_nl(f['speed_kmh'], 1)} km/u"
        if f["watts"]:
            t += f" · {f['watts']} W"
        if f["pr_count"]:
            t += f" — {f['pr_count']} sprint-PR's gepakt"
        return t
    if f["sport"] == "swim":
        meters = f"{round(f['dist_km'] * 1000):,}".replace(",", ".")
        return f"{descriptor} {meters} m @ {f['pace100']}/100 m" if f["pace100"] else f"{descriptor} {meters} m"
    if f["sport"] == "walk":
        return f"{descriptor} {dist} km · {fmt_duration(f['moving_time'])}"
    t = f"{descriptor} · {fmt_duration(f['moving_time'])}"
    if f["hr"]:
        t += f" · {f['hr']} bpm"
    return t


def canonical_title(f: dict) -> str:
    return assemble_title(f, default_descriptor(f))


DESCRIPTOR_RE = re.compile(r"^[A-Za-zÀ-ÿ'’\- ]{2,28}$")


def valid_descriptor(desc: str | None, f: dict) -> str | None:
    """Alleen een kort, cijfervrij woordje toelaten; anders verwerpen."""
    desc = (desc or "").strip()
    if not DESCRIPTOR_RE.match(desc):
        return None
    low = desc.lower()
    if f["sport"] == "run" and "loop" not in low:
        return None
    if f["sport"] == "ride" and "rit" not in low:
        return None
    return desc


def intensity_hint(f: dict) -> str:
    """Grove intensiteit uit pace/snelheid zodat het bijvoeglijk nw. past."""
    if f["sport"] == "run":
        try:
            mm, ss = f["pace"].split(":")
            pace_s = int(mm) * 60 + int(ss)
        except Exception:
            return "vlot"
        if pace_s >= 310:      # >= 5:10/km
            return "rustig"
        if pace_s >= 270:      # 4:30-5:10/km
            return "vlot"
        return "stevig"
    if f["sport"] == "ride":
        spd = f["speed_kmh"]
        if spd >= 34:
            return "stevig"
        if spd >= 27:
            return "vlot"
        return "rustig"
    return "vlot"


OLLAMA_SYSTEM = (
    "Je verzint korte, natuurlijke omschrijvingen voor Strava-activiteiten in het "
    "Nederlands. Je krijgt de feiten + een suggestie en intensiteit. Geef:\n"
    "- 'descriptor': 1-3 woorden, MET het woord 'loop' (lopen) of 'rit' (fietsen). "
    "GEEN cijfers, GEEN plaatsnamen. Blijf dicht bij 'type_suggestie' en gebruik een "
    "bijvoeglijk naamwoord dat past bij 'intensiteit' (rustig/vlot/stevig). "
    "Voorbeelden: 'Rustige ochtendloop', 'Vlotte duurloop', 'Stevige duurrit', "
    "'Lange duurrit'.\n"
    "Geef GEEN coachingzin, GEEN motiverende opmerking, GEEN complimenten.\n"
    "Antwoord ALLEEN met JSON: {\"descriptor\": \"...\"}"
)


def ollama_descriptor(f: dict, cfg: dict) -> tuple[str | None, str]:
    payload = {
        "sport": "lopen" if f["sport"] == "run" else "fietsen" if f["sport"] == "ride" else f["sport"],
        "type_suggestie": default_descriptor(f),
        "intensiteit": intensity_hint(f),
        "dagdeel": f["daypart"],
        "afstand_km": fmt_nl(f["dist_km"], 1),
        "pace_per_km": f["pace"] if f["sport"] == "run" else None,
        "snelheid_kmh": fmt_nl(f["speed_kmh"], 1) if f["sport"] == "ride" else None,
        "hartslag_bpm": f["hr"],
        "vermogen_w": f["watts"] if f["sport"] == "ride" else None,
        "duur_min": round(f["moving_time"] / 60),
        "pr_aantal": f["pr_count"],
    }
    try:
        r = requests.post(f"{cfg['ollama_url']}/api/chat", timeout=60, json={
            "model": cfg["ollama_model"],
            "stream": False,
            "format": "json",
            "options": {"temperature": 0.5},
            "messages": [
                {"role": "system", "content": OLLAMA_SYSTEM},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ],
        })
        r.raise_for_status()
        obj = json.loads(r.json()["message"]["content"])
        # Coachingzin (note) bewust uitgeschakeld: geen motiverende slotzin
        # meer op Strava of in Notion. Enkel de descriptor (benaming) gebruiken.
        return obj.get("descriptor"), ""
    except Exception as exc:
        log.warning("Ollama niet gebruikt (%s) -> vaste omschrijving", exc)
        return None, ""


def _km_label(total_km: float, partial: bool = False) -> str:
    if abs(total_km - round(total_km)) < 0.05:
        s = f"{int(round(total_km))} km"
    else:
        s = f"{fmt_nl(total_km, 1)} km"
    return ("~" + s) if partial else s


def structured_title(f: dict, planned_type: str | None) -> str | None:
    """Bouw een breakdown-titel (inlopen → reps → uitlopen) uit de tussentijden."""
    splits = f.get("splits") or []
    full = [s for s in splits if not s["partial"]]
    partials = [s for s in splits if s["partial"]]
    if f["sport"] != "run" or len(full) < 4:
        return None
    secs = [s["sec"] for s in full]
    spread = max(secs) - min(secs)
    plan_structured = bool(planned_type) and any(
        w in planned_type.lower() for w in ("interval", "tempo"))
    # zonder plan: enkel bij duidelijke variatie als workout behandelen
    if not plan_structured and spread < 75:
        return None

    avg = sum(secs) / len(secs)
    fast = [s < avg * 0.95 for s in secs]
    if not any(fast):
        return None
    first = fast.index(True)
    last = len(fast) - 1 - fast[::-1].index(True)
    reps = full[first:last + 1]
    warm = full[:first]
    cool = full[last + 1:] + partials
    if not reps or (not warm and not cool):
        return None

    is_tempo = bool(planned_type) and "tempo" in planned_type.lower()
    label = re.split(r"\s[—-]\s", (planned_type or "Intervaltraining"), 1)[0].strip() \
        or "Intervaltraining"

    parts = []
    if warm:
        parts.append(f"{_km_label(sum(s['km'] for s in warm))} inlopen "
                     f"({'/'.join(s['pace'] for s in warm)})")
    if is_tempo:
        tot_t = sum(s["sec"] * s["km"] for s in reps)
        tot_k = sum(s["km"] for s in reps)
        parts.append(f"{_km_label(tot_k)} @ {fmt_pace(tot_t, tot_k)} (tempoblok)")
    else:
        parts.append(f"{len(reps)}×1 km ({'/'.join(s['pace'] for s in reps)})")
    if cool:
        parts.append(f"{_km_label(sum(s['km'] for s in cool), partial=bool(partials))} "
                     f"uitlopen ({'/'.join(s['pace'] for s in cool)})")

    title = f"{label} — " + " → ".join(parts)
    tail = []
    if f["hr"]:
        tail.append(f"HR {f['hr']}")
    if f["pr_count"]:
        tail.append(f"{f['pr_count']} PR's")
    if tail:
        title += " — " + ", ".join(tail)
    return title if len(title) <= 250 else None


def build_title(f: dict, cfg: dict, planned_type: str | None = None) -> tuple[str, str]:
    note = ""
    ai_desc = None
    if cfg["use_ollama"]:
        ai_desc, note = ollama_descriptor(f, cfg)
    structured = structured_title(f, planned_type)
    if structured:
        return structured, note
    descriptor = default_descriptor(f)
    good = valid_descriptor(ai_desc, f)
    if good:
        descriptor = good[0].upper() + good[1:] if f["sport"] == "run" \
            else good[0].lower() + good[1:]
    return assemble_title(f, descriptor), note


def build_description(f: dict, note: str, block_line: str = "") -> str:
    """Beschrijving = korte samenvatting + kernblok (gelopen vs doel) + tussentijden per km."""
    parts = []
    if note:
        parts.append(note)
    stat = []
    if f["sport"] == "run":
        if f["hr"]:
            stat.append(f"HR {f['hr']} gem.")
        if f["cadence"]:
            stat.append(f"cadans {f['cadence']} spm")
    else:
        if f["watts"]:
            stat.append(f"{f['watts']} W gem.")
        if f["kj"]:
            stat.append(f"{f['kj']} kJ")
        if f["elev"]:
            stat.append(f"{f['elev']} hm")
    if f["pr_count"]:
        stat.append(f"{f['pr_count']} PR's")
    if stat:
        parts.append(" · ".join(stat))
    desc = " ".join(parts).strip()
    if block_line:
        desc += ("\n" if desc else "") + block_line
    if f["splits"]:
        desc += ("\n" if desc else "") + "Tussentijden: " + \
            " · ".join(f"{s['label']} {s['pace']}" for s in f["splits"])
    return desc.strip()


# --------------------------------------------------------------------------- #
# Notion logging (vul het juiste dag-vak van de huidige week)
# --------------------------------------------------------------------------- #
def notion_headers(cfg: dict) -> dict:
    return {
        "Authorization": f"Bearer {cfg['notion_token']}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }


def notion_children(cfg: dict, block_id: str) -> list[dict]:
    blocks, cursor = [], None
    while True:
        params = {"page_size": 100}
        if cursor:
            params["start_cursor"] = cursor
        r = requests.get(f"{NOTION_API}/blocks/{block_id}/children",
                         headers=notion_headers(cfg), params=params, timeout=30)
        r.raise_for_status()
        data = r.json()
        blocks.extend(data["results"])
        if not data.get("has_more"):
            break
        cursor = data["next_cursor"]
    return blocks


def _plain(block: dict) -> str:
    rt = block.get(block.get("type", ""), {}).get("rich_text", [])
    return "".join(x.get("plain_text", "") for x in rt)


def _cell_text(cell: list[dict]) -> str:
    return "".join(x.get("plain_text", "") for x in cell)


def _rt(text: str) -> list[dict]:
    return [{"type": "text", "text": {"content": text[:1990]}}]


def find_current_week_table(cfg: dict, page_id: str) -> str | None:
    children = notion_children(cfg, page_id)
    seen_current = False
    for blk in children:
        if blk["type"] in ("heading_2", "heading_1", "heading_3"):
            txt = _plain(blk).lower()
            if "huidige week" in txt:
                seen_current = True
                continue
            if seen_current and "week" in txt:  # volgende week-kop -> gestopt
                break
        if seen_current and blk["type"] == "table":
            return blk["id"]
    return None


def _plan_head(pt: str) -> str:
    """Begin van de trainingscel zonder ✅🛑🚲🏁🏋️🏊, in kleine letters ('🚲 Fiets of rust' -> 'fiets of rust')."""
    return re.sub(r"^[\s✅🛑🚲🏁🏋🏊️]+", "", pt or "").strip().lower()


def _is_gym_day(pt: str) -> bool:
    """Een fitness-/zwemdag (Wezenberg): begint met 🏋️/🏊 of 'Fitness'/'Zwem', of noemt Wezenberg
    ('🚲 Fiets (of Wezenberg)'). Daar mag een zwembeurt of krachttraining in de rij, nooit een loop."""
    s = (pt or "").strip()
    return (s.lstrip("✅ ").startswith(("🏋", "🏊")) or _plan_head(s).startswith(("fitness", "zwem", "kracht"))
            or "wezenberg" in s.lower())


def _is_rest_day(pt: str) -> bool:
    """Een echte rustdag: begint met 🛑 of met 'Rust' ('Rust', 'Rustdag', 'Rust of wandelen').
    Enkel het begin telt (zoals dashboard.is_rest): 'Heel losjes (of rust)' is GEEN rustdag maar een
    (optionele) loop, en 'Rustige duurloop' ook niet."""
    return (pt or "").strip().startswith("🛑") or bool(re.match(r"rust(dag)?\b", _plan_head(pt)))


def _is_bike_day(pt: str) -> bool:
    """Een fietsdag in het schema: begint met 🚲 of 'Fiets'. De enige dag waar een fietsrit in de rij mag.
    'Rustig + 6 versnellingen (of fiets)' is een loopdag."""
    return (pt or "").strip().startswith("🚲") or _plan_head(pt).startswith("fiets")


def _is_plan_training(pt: str | None) -> bool:
    """True als de trainingscel een (loop)training is, ook een optionele ('Heel losjes (of rust)').

    Géén rustdag (🛑 / begint met 'Rust', maar wél 'Rustige duurloop'!), géén fietsdag
    (🚲 / 'fiets'), en niet al afgevinkt (✅).
    """
    if not pt:
        return False
    return "✅" not in pt and not _is_bike_day(pt) and not _is_rest_day(pt) and not _is_gym_day(pt)


GYM_NAMES = ("krachttraining", "workout", "crossfit", "hiit", "functionele training")


def _is_gym_sport(f: dict) -> bool:
    """Een krachttraining/workout (fitness), geen tennis of yoga op een andere dag."""
    return any(n in (f.get("sport_name") or "").lower() for n in GYM_NAMES)


def _gym_text(f: dict) -> tuple[str, str, str]:
    """(kort, afstand-cel, details) voor een zwembeurt of een fitnesstraining."""
    t = f["moving_time"] or f["elapsed_time"] or 0
    if f["sport"] == "swim":
        ms = f"{round(f['dist_km'] * 1000):,}".replace(",", ".")
        kort, cel = f"zwemmen {ms} m", f"{ms} m"
        det = f"Zwemmen: {ms} m in {fmt_duration(t)}" + (f" ({f['pace100']}/100 m)" if f.get("pace100") else "") + "."
    else:
        kort, cel = f"fitness {round(t / 60)} min", f"{round(t / 60)} min"
        det = f"{f.get('sport_name') or 'Fitness'}: {fmt_duration(t)}."
        try:                                             # je sets van je horloge: wat je deed en wat volgende keer
            import fitness
            res = fitness.session_for(f["datetime"].isoformat()[:19]) if f.get("datetime") else None
            if res:
                det += f" {fitness.summary(res)}."
        except Exception as exc:
            log.warning("Sets van Garmin niet gelezen: %s", exc)
    if f.get("hr"):
        det += f" HR {f['hr']} gem."
    return kort, cel, det


def _notion_log_gym(cfg: dict, f: dict, target: dict, cells: list, dry_run: bool) -> None:
    """Zwemmen of fitness (Wezenberg) in de dag-rij, enkel op een fitness-/zwemdag. Doe je beide op één dag,
    dan komen ze samen in die rij: '✅ 🏋️ Fitness + 🏊 zwemmen — fitness 45 min + zwemmen 1.000 m'."""
    planned = _cell_text(cells[1]) if len(cells) > 1 else ""
    what = f.get("sport_name") or f["sport"]
    if not _is_gym_day(planned):
        log.info("Dag-rij %s: geen fitness-/zwemdag in het schema (%s) -> %s niet in die rij gelogd",
                 f["date_ddmm"], planned or "leeg", what)
        return
    kort, cel, det = _gym_text(f)
    if "✅" in planned:                                   # al iets van die dag (bv. fitness): zwemmen erbij
        done = planned.split("—", 1)[1].lower() if "—" in planned else ""
        if kort.split()[0] in done:
            log.info("Dag-rij %s heeft al %s -> niet dubbel", f["date_ddmm"], kort.split()[0])
            return
        prev_cel = _cell_text(cells[2]).strip() if len(cells) > 2 else ""
        training = f"{planned} + {kort}"
        afstand = f"{prev_cel} + {cel}" if prev_cel and prev_cel != "—" else cel
        details = f"{_cell_text(cells[4]).strip() if len(cells) > 4 else ''} {det}".strip()
    else:
        label = re.split(r"\s[—-]\s", planned, 1)[0].strip()
        orig = _cell_text(cells[4]).strip() if len(cells) > 4 else ""
        training, afstand = f"✅ {label} — {kort}", cel
        details = det + (f" Gepland: {label}." if label else "") + (f" Schema: {orig}" if orig else "")
    new_cells = [_rt(_cell_text(c)) for c in cells]
    while len(new_cells) < 5:
        new_cells.append(_rt(""))
    new_cells[1], new_cells[2], new_cells[4] = _rt(training), _rt(afstand), _rt(details)
    if dry_run:
        log.info("[dry-run] zou Notion-rij %s invullen: %s | %s", f["date_ddmm"], training, details)
        return
    r = requests.patch(f"{NOTION_API}/blocks/{target['id']}", headers=notion_headers(cfg),
                       json={"table_row": {"cells": new_cells}}, timeout=30)
    r.raise_for_status()
    log.info("Notion bijgewerkt: %s -> %s", f["date_ddmm"], training)


def notion_log(cfg: dict, f: dict, title: str, note: str, dry_run: bool, skipped: str | None = None) -> None:
    if not (cfg["notion_token"] and cfg["notion_page_id"]):
        log.info("Notion niet geconfigureerd -> loggen overgeslagen")
        return
    gym = f["sport"] == "swim" or (f["sport"] == "other" and _is_gym_sport(f))   # Wezenberg: zwemmen of fitness
    if f["sport"] not in ("run", "ride") and not gym:
        return

    table_id = find_current_week_table(cfg, cfg["notion_page_id"])
    if not table_id:
        log.warning("Huidige-week-tabel niet gevonden in Notion -> niet gelogd")
        return

    rows = notion_children(cfg, table_id)
    target = None
    for row in rows:
        if row["type"] != "table_row":
            continue
        cells = row["table_row"]["cells"]
        if cells and f["date_ddmm"] and f["date_ddmm"] in _cell_text(cells[0]):
            target = row
            break
    if not target:
        log.warning("Geen dag-rij voor %s in de huidige week -> niet gelogd", f["date_ddmm"])
        return

    cells = target["table_row"]["cells"]
    if gym:
        _notion_log_gym(cfg, f, target, cells, dry_run)
        return
    if "✅" in _cell_text(cells[1] if len(cells) > 1 else []):
        log.info("Dag-rij %s is al ingevuld (✅) -> niet overschreven", f["date_ddmm"])
        return

    dist = fmt_nl(f["dist_km"], 1)
    # wat stond er gepland voor deze dag?
    planned = _cell_text(cells[1]) if len(cells) > 1 else ""
    planned_type = re.split(r"\s[—-]\s", planned, 1)[0].strip()
    plan_is_training = _is_plan_training(planned_type)
    # het schema is een loopschema: een fietsrit komt enkel in de rij als er die dag fietsen gepland stond
    # (🚲). Een loop, ook een optionele, of een rustdag blijft staan; de rit staat wel in Strava en in dE3p.
    if f["sport"] != "run" and not _is_bike_day(planned_type):
        log.info("Dag-rij %s: geen fietsdag in het schema (%s) -> fietsrit niet in die rij gelogd",
                 f["date_ddmm"], planned_type or "leeg")
        return

    if f["sport"] == "run":
        label = "Rustige duurloop" if skipped else planned_type if plan_is_training else run_descriptor(f).capitalize()
        training = f"✅ {label} — {dist} km @ {f['pace']}/km"
        details = f"{fmt_duration(f['moving_time'])} looptijd ({fmt_duration(f['elapsed_time'])} verstreken)."
        if f["hr"]:
            details += f" HR {f['hr']} gem."
        if f["cadence"]:
            details += f" cadence {f['cadence']} spm."
    else:
        training = f"✅ Fietsrit — {dist} km @ {fmt_nl(f['speed_kmh'], 1)} km/u"
        details = f"{fmt_duration(f['moving_time'])} bewegingstijd ({fmt_duration(f['elapsed_time'])} verstreken)."
        if f["watts"]:
            details += f" {f['watts']} W gem."
        if f["kj"]:
            details += f" {f['kj']} kJ."
        details += f" {f['elev']} hm, max {fmt_nl(f['max_speed_kmh'], 1)} km/u."
    if f["gear"]:
        details += f" {f['gear']}."
    if f["splits"]:
        details += " Tussentijden: " + \
            " · ".join(f"{s['label']} {s['pace']}" for s in f["splits"]) + "."
    if f["pr_count"]:
        details += f" \U0001f3c5 {f['pr_count']} PR's: " + ", ".join(f["pr_names"][:4]) + "."
    if skipped:
        details += f" Rustig gelopen i.p.v. de geplande {skipped[:1].lower() + skipped[1:]}."
    elif plan_is_training and planned:
        details += f" Gepland: {planned}."
        orig = _cell_text(cells[4]).strip() if len(cells) > 4 else ""
        if orig:                                    # wat het schema erbij zei (bv. hoe snel de versnellingen) blijft staan
            details += f" Schema: {orig}"
    if note:
        details += f" {note}"

    new_cells = list(cells)
    while len(new_cells) < 5:
        new_cells.append([])
    new_cells[1] = _rt(training)
    new_cells[2] = _rt(f"{dist} km")
    new_cells[4] = _rt(details)
    # overige cellen plat terugzetten zodat de PATCH geldig is
    new_cells[0] = _rt(_cell_text(cells[0]))
    new_cells[3] = _rt("rustig" if skipped else _cell_text(cells[3]) if len(cells) > 3 else "")

    if dry_run:
        log.info("[dry-run] zou Notion-rij %s invullen: %s | %s", f["date_ddmm"], training, details)
        return

    r = requests.patch(f"{NOTION_API}/blocks/{target['id']}",
                       headers=notion_headers(cfg),
                       json={"table_row": {"cells": new_cells[:len(cells) if len(cells) >= 5 else 5]}},
                       timeout=30)
    r.raise_for_status()
    log.info("Notion bijgewerkt: %s -> %s", f["date_ddmm"], training)


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def notion_planned_type(cfg: dict, f: dict) -> str | None:
    """Lees het geplande trainingstype voor de dag van deze activiteit (of None)."""
    if not (cfg["notion_token"] and cfg["notion_page_id"] and f["date_ddmm"]):
        return None
    try:
        table_id = find_current_week_table(cfg, cfg["notion_page_id"])
        if not table_id:
            return None
        for row in notion_children(cfg, table_id):
            if row["type"] != "table_row":
                continue
            cells = row["table_row"]["cells"]
            if cells and f["date_ddmm"] in _cell_text(cells[0]):
                planned = _cell_text(cells[1]) if len(cells) > 1 else ""
                pt = re.split(r"\s[—-]\s", planned, 1)[0].strip()
                return pt if _is_plan_training(pt) else None
        return None
    except Exception as exc:
        log.warning("Geplande type niet opgehaald: %s", exc)
        return None


def notion_planned_info(cfg: dict, f: dict) -> tuple[str | None, str | None]:
    """(volledige geplande training, doelpace) voor de dag van deze activiteit.

    Lees dit VÓÓR notion_log(), want dat overschrijft de trainingscel met '✅ ...'.
    """
    if not (cfg["notion_token"] and cfg["notion_page_id"] and f["date_ddmm"]):
        return None, None
    try:
        table_id = find_current_week_table(cfg, cfg["notion_page_id"])
        if not table_id:
            return None, None
        for row in notion_children(cfg, table_id):
            if row["type"] != "table_row":
                continue
            cells = row["table_row"]["cells"]
            if cells and f["date_ddmm"] in _cell_text(cells[0]):
                planned = _cell_text(cells[1]) if len(cells) > 1 else ""
                doelpace = _cell_text(cells[3]) if len(cells) > 3 else ""
                pt = re.split(r"\s[—-]\s", planned, 1)[0].strip()
                if not _is_plan_training(pt):
                    return None, None
                return planned, (doelpace.strip() or None)
        return None, None
    except Exception as exc:
        log.warning("Geplande info niet opgehaald: %s", exc)
        return None, None


def notion_planned_details(cfg: dict, f: dict) -> str:
    """De uitleg die bij de geplande training van die dag stond (kolom Details), bv. hoe je de
    versnellingen loopt. Lees dit VÓÓR notion_log(), dat die cel invult met wat je liep."""
    if not (cfg["notion_token"] and cfg["notion_page_id"] and f["date_ddmm"]):
        return ""
    try:
        table_id = find_current_week_table(cfg, cfg["notion_page_id"])
        for row in notion_children(cfg, table_id) if table_id else []:
            cells = row.get("table_row", {}).get("cells") or []
            if row["type"] == "table_row" and cells and f["date_ddmm"] in _cell_text(cells[0]):
                return _cell_text(cells[4]).strip() if len(cells) > 4 else ""
    except Exception as exc:
        log.warning("Uitleg uit het schema niet opgehaald: %s", exc)
    return ""


def planned_info(cfg: dict, f: dict) -> tuple[str | None, str | None]:
    """Geplande training voor de dag van deze activiteit: uit Notion (Jens) of
    uit het eigen schema van de app (plan.json)."""
    if f["sport"] != "run" or not f["datetime"]:   # het schema gaat over lopen: een fietsrit, zwembeurt
        return None, None                           # of tennis op een loopdag krijgt niet de naam van die run
    if cfg["notion_token"] and cfg["notion_page_id"]:
        return notion_planned_info(cfg, f)
    import localplan
    return localplan.planned_info(f["datetime"].date().isoformat())


def templated_name(cfg: dict, f: dict, detail: dict, planned_full: str | None,
                   fallback: str | None = None) -> str | None:
    """Naam volgens het eigen titelsjabloon (enkel runs), of None zonder sjabloon."""
    if not cfg.get("title_template") or f["sport"] != "run":
        return None
    import titles
    parts = re.split(r"\s[—–-]\s", planned_full, 1) if planned_full else []
    training = parts[0].strip() if parts else (fallback or default_descriptor(f))
    structuur = parts[1].strip() if len(parts) > 1 else ""
    return titles.fill(cfg["title_template"], titles.values_from_facts(f, detail, training, structuur)) or None


SKIP_SLOWER = 15        # s/km trager dan het doel ...
SKIP_EFFORT = 15        # ... en niet minstens zoveel sneller dan de rest van je loop = training niet gelopen


def skipped_plan(block: dict | None, f: dict) -> bool:
    """Liep je de geplande kerntraining niet (bv. een tune-up gewoon rustig gelopen)? Dan mag de run niet de
    naam van het schema krijgen. Ja als het kernblok meer dan 15 s/km trager was dan het doel EN niet
    duidelijk sneller dan de rest van je loop (je deed er geen moeite voor). Wel moeite gedaan maar het doel
    niet gehaald? Dan blijft het de geplande training, met 'X s/km trager' in de beschrijving."""
    if not block or block.get("delta") is None or block["delta"] <= SKIP_SLOWER:
        return False
    rest_km = f["dist_km"] - (block.get("km") or 0)
    if rest_km >= 0.5:
        rest_pace = (f["moving_time"] - block["secs"]) / rest_km
        if rest_pace - block["pace"] >= SKIP_EFFORT:
            return False
    return True


def process_activity(token: str, cfg: dict, summary: dict, dry_run: bool) -> None:
    detail = strava_activity_detail(token, summary["id"])
    try:
        import prestaties                           # je records en loopschoenen bijwerken
        prestaties.learn(detail)
    except Exception as exc:
        log.warning("Records niet bijgewerkt: %s", exc)
    f = extract_facts(detail)
    log.info("Activiteit %s (%s, %s km) verwerken", f["id"], f["sport"], fmt_nl(f["dist_km"], 2))

    planned_full, doelpace = planned_info(cfg, f)
    # de uitleg bij die training (bv. 3× ±20 s aan ±5 km-tempo): voor de kaart, vóór Notion ze overschrijft
    plan_text = notion_planned_details(cfg, f) if planned_full and f["sport"] == "run" and cfg["notion_token"] else ""
    extra_detail = None
    if not planned_full and f["sport"] in ("swim", "strength", "run", "ride") and f["datetime"]:
        import localextra                           # extra schema (zwemmen, kracht, conditie): naam + training als beschrijving
        planned_full, extra_detail = localextra.planned_for(f["datetime"].date().isoformat(), f["sport"])
    planned_type = re.split(r"\s[—-]\s", planned_full, 1)[0].strip() if planned_full else None
    title, note = build_title(f, cfg, planned_type)

    # Wat je in het kernblok echt liep, naast het doel ("5 km @ 4:28 · doel 4:20")
    import blocks
    block = None
    if f["sport"] == "run" and planned_full:
        structure = (re.split(r"\s[—–-]\s", planned_full, maxsplit=1) + [""])[1]
        block = blocks.analyze(structure, detail)
        if block:
            log.info("Kernblok: %s", blocks.description_line(block))

    # Geplande kerntraining niet gelopen (gewoon rustig)? Dan heet de run naar wat je liep, niet naar het schema.
    skipped = planned_full if f["sport"] == "run" and planned_full and skipped_plan(block, f) else None
    if skipped:
        log.info("Gepland '%s' niet gelopen (kernblok %s s/km trager, geen versnelling) -> %s", skipped, block["delta"], "Rustige duurloop")
        planned_full, planned_type, doelpace, block = None, None, None, None
        title = "Rustige duurloop"
    elif block:
        blocks.remember(f["id"], structure, block)

    # Geplande training? Dan de Strava-naam gelijk aan het schema-type (bv.
    # "Eerste marathonpace-blok — 2 km IL + 4 km @ ±4:30 + 2 km UL").
    strava_name = "Rustige duurloop" if skipped else planned_full or (title if cfg["rename_unplanned"] else None)
    # Eigen titelsjabloon? Dan dat, voor elke run met een standaardnaam.
    descriptor = re.split(r"\s\d", title, maxsplit=1)[0].strip(" ·—-") if title else None   # "Vlotte namiddagloop"
    strava_name = templated_name(cfg, f, detail, planned_full, "Rustige duurloop" if skipped else descriptor) or strava_name
    if not cfg["rename"] or not strava_name:
        pass
    elif is_default_name(f["current_name"]):
        # beschrijving enkel zetten als er nog geen staat (handmatige notities niet overschrijven)
        description = (build_description(f, note, blocks.description_line(block) if block
                                          else f"Rustig gelopen i.p.v. gepland: {skipped}" if skipped
                                          else f"Gepland: {extra_detail}" if extra_detail else "")
                       if cfg["write_description"]
                       and not (detail.get("description") or "").strip() else None)
        strava_update_activity(token, f["id"], strava_name, description, dry_run)
    else:
        log.info("Naam '%s' is geen standaardnaam -> titel/beschrijving niet overschreven", f["current_name"])

    if cfg["log_to_notion"] and cfg["notion_token"]:
        try:
            notion_log(cfg, f, title, note, dry_run, skipped)
        except Exception as exc:
            log.error("Notion loggen mislukt: %s", exc)

    # Recap-kaart (TikTok) voor de gekozen sporten: PNG met 'dd-mm-jjjj Trainingstype' als naam.
    import sports
    if not dry_run and sports.card_key(detail) in cfg["card_sports"]:
        try:
            import recap_card
            streams = recap_card.strava_streams(token, f["id"])
            recap_title = "Rustige duurloop" if skipped else planned_full or default_descriptor(f)
            card_note = None if skipped else recap_card.plan_note(plan_text)
            path = recap_card.build_card(detail, streams, recap_title, target_pace=doelpace, note=card_note)
            log.info("Recap-kaart gemaakt: %s", path.name)
        except Exception as exc:
            log.warning("Recap-kaart niet gemaakt: %s", exc)


def run_once(cfg: dict, dry_run: bool, backfill_days: int | None) -> None:
    state = load_state()
    token = strava_access_token(cfg)

    lookback = backfill_days if backfill_days is not None else cfg["lookback_days"]
    after = max(0, int(time.time()) - lookback * 86400)
    after = min(after, state.get("last_start_epoch", 0) or after) if backfill_days is None else after

    activities = strava_recent_activities(token, after)
    activities.sort(key=lambda a: a.get("start_date", ""))
    processed = set(state["processed_ids"])

    new = [a for a in activities if a["id"] not in processed]
    if not new:
        log.info("Geen nieuwe activiteiten")
        return

    for summary in new:
        try:
            process_activity(token, cfg, summary, dry_run)
        except requests.HTTPError as exc:
            log.error("HTTP-fout bij activiteit %s: %s", summary.get("id"), exc)
            continue
        except Exception as exc:
            log.error("Fout bij activiteit %s: %s", summary.get("id"), exc)
            continue
        if not dry_run:
            state["processed_ids"].append(summary["id"])
            epoch = int(datetime.fromisoformat(
                summary["start_date"].replace("Z", "+00:00")).timestamp())
            state["last_start_epoch"] = max(state.get("last_start_epoch", 0), epoch)
            save_state(state)
        time.sleep(1)  # vriendelijk voor de rate limit


def main() -> None:
    ap = argparse.ArgumentParser(description="Strava auto-titel + Notion logger")
    ap.add_argument("--once", action="store_true", help="1 cyclus en stoppen (Taakplanner)")
    ap.add_argument("--dry-run", action="store_true", help="niks wegschrijven, enkel tonen")
    ap.add_argument("--backfill", type=int, metavar="DAGEN",
                    help="herbekijk de laatste N dagen (negeert state-filter op tijd)")
    ap.add_argument("--interval", type=int, default=900,
                    help="seconden tussen cycli als --once niet gegeven is (default 900)")
    args = ap.parse_args()

    setup_logging()
    cfg = load_config()

    if args.once or args.backfill is not None:
        run_once(cfg, args.dry_run, args.backfill)
        return

    log.info("Loop gestart, interval %ss (Ctrl+C om te stoppen)", args.interval)
    while True:
        try:
            run_once(cfg, args.dry_run, None)
        except Exception as exc:
            log.error("Cyclus mislukt: %s", exc)
        time.sleep(args.interval)


if __name__ == "__main__":
    main()

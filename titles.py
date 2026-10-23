"""
Eigen titel voor runs op Strava, gevraagd in gewone taal.

  "ik wil de kilometers, de tijd en mijn gemiddelde hartslag in de titel"
     → de lokale AI (Ollama) maakt er één keer een sjabloon van:
       "{training} · {km} · {tijd} · {hr}"
     → bij elke sync vult het programma dat in met de echte cijfers van Strava.

De AI schrijft dus nooit zelf getallen. Geen Ollama? Dan maken vaste regels het sjabloon.
"""
from __future__ import annotations

import json
import re

import requests

FIELDS = {
    "training": ("trainingstype of soort run", "Tempoduurloop"),
    "structuur": ("opbouw van de training", "2 km IL + 6 km @ 4:25 + 2 km UL"),
    "km": ("afstand", "10,2 km"),
    "tijd": ("looptijd", "50:00"),
    "tempo": ("gemiddeld tempo per km", "4:54/km"),
    "blok": ("wat je in het kernblok echt liep", "5 km @ 4:28"),
    "snelheid": ("gemiddelde snelheid", "12,2 km/u"),
    "hr": ("gemiddelde hartslag", "161 bpm"),
    "maxhr": ("maximale hartslag", "183 bpm"),
    "hoogte": ("hoogtemeters", "24 hm"),
    "cadans": ("cadans", "170 spm"),
    "dagdeel": ("deel van de dag", "Ochtend"),
    "weekdag": ("dag van de week", "Dinsdag"),
    "datum": ("datum", "22/09"),
}
TOKEN_RE = re.compile(r"\{(\w+)\}")
SEP = " · "

# vaste regels (zonder AI): trefwoorden → veld, in de volgorde van de zin
RULES = [
    (r"structuur|opbouw|schema", "structuur"),
    (r"\bblok\b|kernblok|tempoblok|wat ik (echt )?liep|echte? tempo|gelopen tempo|hoe snel", "blok"),
    (r"kilometer|afstand|\bkm\b(?!\s*/\s*u|\s*per)", "km"),
    (r"km\s*/\s*u|km per uur|kilometers? per uur|snelheid", "snelheid"),
    (r"\btijd\b|\bduur\b|looptijd|hoe lang", "tijd"),
    (r"tempo|pace|min(uten)?\s*per\s*km|/km", "tempo"),
    (r"max(imale)?\s*(hartslag|hr|bpm)", "maxhr"),
    (r"(gemiddelde?\s*)?(hartslag|\bhr\b|bpm)", "hr"),
    (r"hoogte|klim|hoogtemeters", "hoogte"),
    (r"cadans|passen", "cadans"),
    (r"dagdeel|ochtend|avond|middag", "dagdeel"),
    (r"weekdag|welke dag", "weekdag"),
    (r"datum", "datum"),
]

AI_SYSTEM = (
    "Je maakt een titelsjabloon voor een hardloopactiviteit op Strava. De gebruiker zegt in "
    "gewone taal wat er in de titel moet. Gebruik ENKEL deze velden tussen accolades:\n"
    + "\n".join(f"{{{k}}} = {v[0]} (bv. {v[1]})" for k, v in FIELDS.items())
    + "\nRegels: schrijf nooit zelf getallen, enkel velden. Elk veld bevat al zijn eenheid (km, bpm, "
    "/km, km/u): zet er geen eenheid achter. Begin met {training}. Gebruik daarna ENKEL de velden waar "
    "de gebruiker om vraagt, niets extra. Zet velden achter elkaar met ' · ' "
    "als scheiding. Kort en leesbaar, "
    "hooguit een paar woorden extra tekst (mag een emoji). Antwoord als JSON: {\"sjabloon\": \"...\"}."
)


# ---- invullen -----------------------------------------------------------------------
def _nl(v: float, d: int = 1) -> str:
    return f"{v:.{d}f}".replace(".", ",")


def _dur(sec: float) -> str:
    sec = int(round(sec or 0))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _pace(sec_per_km: float) -> str:
    m, s = divmod(int(round(sec_per_km)), 60)
    return f"{m}:{s:02d}/km"


def values(*, km: float, secs: float, hr=None, maxhr=None, elev=None, cadence=None,
           date=None, daypart: str = "", weekday: str = "", training: str = "", structuur: str = "",
           blok: str = "") -> dict:
    """Alle velden als tekst; ontbrekende waarden worden een lege string."""
    return {
        "training": training, "structuur": structuur, "blok": blok,
        "km": f"{_nl(km)} km" if km else "",
        "tijd": _dur(secs) if secs else "",
        "tempo": _pace(secs / km) if km and secs else "",
        "snelheid": f"{_nl(km / (secs / 3600))} km/u" if km and secs else "",
        "hr": f"{round(hr)} bpm" if hr else "",
        "maxhr": f"{round(maxhr)} bpm" if maxhr else "",
        "hoogte": f"{round(elev)} hm" if elev else "",
        "cadans": f"{round(cadence)} spm" if cadence else "",
        "dagdeel": daypart, "weekdag": weekday,
        "datum": date.strftime("%d/%m") if date else "",
    }


def values_from_facts(f: dict, detail: dict, training: str, structuur: str = "") -> dict:
    """Velden uit strava_sync.extract_facts() + de ruwe Strava-activiteit."""
    dtm = f.get("datetime")
    import blocks
    b = blocks.analyze(structuur, detail) if structuur else None
    return values(blok=blocks.short(b) if b else "", km=f["dist_km"], secs=f["moving_time"], hr=f.get("hr"), maxhr=detail.get("max_heartrate"),
                  elev=f.get("elev"), cadence=f.get("cadence"), date=dtm.date() if dtm else None,
                  daypart=f.get("daypart", ""), weekday=f.get("weekday_nl", ""),
                  training=training, structuur=structuur)


def fill(template: str, vals: dict) -> str:
    """Sjabloon invullen; lege velden en hun scheidingstekens verdwijnen."""
    out = TOKEN_RE.sub(lambda m: vals.get(m[1], ""), template)
    out = re.sub(r"(\s*[·|•,—–-]\s*)(?=\s*[·|•,—–-]|\s*$)", "", out)   # scheiding zonder waarde erna
    out = re.sub(r"^\s*[·|•,—–-]\s*", "", out)
    return re.sub(r"\s{2,}", " ", out).strip()


UNIT_AFTER = re.compile(r"(\{(?:km|tijd|tempo|snelheid|hr|maxhr|hoogte|cadans)\})\s*"
                        r"(?:bpm(?:/h)?|km/u|km/h|min/km|/km|km|hm|spm|m|min|u|per uur|/uur|/h)(?![\w/])")


def normalize(template: str) -> str:
    """Eenheden achter velden weg (het veld heeft ze al) en {training} vooraan."""
    t = UNIT_AFTER.sub(r"\1", (template or "").strip().strip('"'))
    if "{training}" not in t:
        t = "{training}" + SEP + t
    return re.sub(r"\s{2,}", " ", t).strip()


def validate(template: str) -> str:
    t = (template or "").strip().strip('"')
    names = TOKEN_RE.findall(t)
    if not names:
        raise ValueError("Het sjabloon moet minstens één veld bevatten, bv. {km}.")
    unknown = [n for n in names if n not in FIELDS]
    if unknown:
        raise ValueError(f"Onbekend veld: {{{unknown[0]}}}.")
    if re.search(r"\d", TOKEN_RE.sub("", t)):
        raise ValueError("Zet geen getallen in het sjabloon zelf: die komen uit Strava.")
    if len(t) > 120:
        raise ValueError("Het sjabloon is te lang.")
    return t


# ---- sjabloon maken -----------------------------------------------------------------
def from_rules(instruction: str) -> str:
    low = (instruction or "").lower()
    hits = []
    for pattern, field in RULES:
        m = re.search(pattern, low)
        if m and field not in [f for _, f in hits]:
            hits.append((m.start(), field))
    if any(f == "snelheid" for _, f in hits):          # "kilometers per uur" is snelheid, niet afstand
        km_pos = [p for p, f in hits if f == "km"]
        sp_pos = [p for p, f in hits if f == "snelheid"]
        if km_pos and sp_pos and abs(km_pos[0] - sp_pos[0]) < 3:
            hits = [h for h in hits if h[1] != "km"]
    fields = [f for _, f in sorted(hits)]
    if "training" not in fields:
        fields.insert(0, "training")
    return SEP.join(f"{{{f}}}" for f in fields)


EXAMPLES = [
    ("afstand en hartslag", "{training} · {km} · {hr}"),
    ("mijn tempo met een vuurtje", "{training} · {tempo} 🔥"),
    ("hoe snel in km per uur en hoe lang", "{training} · {snelheid} · {tijd}"),
]
# velden die een model graag 'extra' toevoegt: enkel houden als de zin ze echt noemt
EXTRA = {"maxhr", "structuur", "datum", "weekdag", "dagdeel", "hoogte", "cadans"}


def _rule_fields(instruction: str) -> set[str]:
    return set(TOKEN_RE.findall(from_rules(instruction)))


def from_ai(instruction: str, url: str = "http://localhost:11434", model: str = "mistral-nemo:latest") -> str:
    shots = []
    for q, a in EXAMPLES:
        shots += [{"role": "user", "content": q}, {"role": "assistant", "content": json.dumps({"sjabloon": a}, ensure_ascii=False)}]
    r = requests.post(f"{url.rstrip('/')}/api/chat", timeout=60, json={
        "model": model, "stream": False, "format": "json", "options": {"temperature": 0.1},
        "messages": [{"role": "system", "content": AI_SYSTEM}, *shots, {"role": "user", "content": instruction}],
    })
    r.raise_for_status()
    t = normalize(json.loads(r.json()["message"]["content"]).get("sjabloon", ""))
    asked = _rule_fields(instruction)
    parts = [p for p in re.split(r"\s*·\s*", t)
             if not any(f in EXTRA and f not in asked for f in TOKEN_RE.findall(p))]
    return validate(SEP.join(p for p in parts if p))


def suggest(instruction: str, url: str = "http://localhost:11434", model: str = "mistral-nemo:latest") -> tuple[str, str]:
    """(sjabloon, bron). Bron is 'ai' of 'regels' (Ollama niet bereikbaar of antwoord ongeldig)."""
    if not (instruction or "").strip():
        raise ValueError("Schrijf eerst wat je in de titel wil.")
    try:
        return from_ai(instruction, url, model), "ai"
    except Exception:
        return from_rules(instruction), "regels"

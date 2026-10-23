"""
Je doel in je eigen woorden → de antwoorden van de doel-vragenlijst, met de lokale AI (Ollama).

De AI vult enkel KEUZES in (welk doel, hoe fit, welke dagen, hoe lang, waar, welke sport,
hoeveel weken, blessure, eventueel een wedstrijd). Het schema zelf maakt dE3p daarna met vaste
regels (app/js/extra.js en plan.js); de AI verzint dus geen trainingen of tempo's.
Alles wat de AI teruggeeft, wordt hier nagekeken en begrensd. Zonder Ollama (of als het antwoord
niet deugt) begrijpt het venster je tekst met trefwoorden, zoals vroeger.
"""
from __future__ import annotations

import datetime as dt
import json
import re

import requests

GOALS = {"slank", "gezond", "lopen", "zwemmen"}          # dE3p = duursporten
LEVELS = {"start", "soms", "vaak"}
CARDIO = ("run", "ride", "swim")
DISTANCES = {"5k", "10k", "half", "marathon"}
MINUTES = (30, 45, 60, 75)
SPREAD = {2: [1, 4], 3: [0, 2, 5], 4: [0, 2, 4, 6], 5: [0, 1, 3, 4, 6], 6: [0, 1, 2, 4, 5, 6]}   # zelfde als app.js

SYSTEM = """Je helpt in dE3p, een trainingsapp. Iemand schrijft in het Nederlands (soms Vlaams, met typfouten) wat hij of zij wil bereiken.
Zet dat om in JSON. Neem ENKEL over wat er echt staat; verzin niets. Laat een veld weg als de tekst er niets over zegt.
Velden:
- goal: "slank" (fitter, afvallen, conditie), "gezond" (in vorm blijven, gezond bewegen),
  "lopen" (een loopwedstrijd of sneller/verder lopen), "zwemmen" (beter of verder zwemmen)
- level: "start" (begint van nul of na lange stop), "soms" (sport af en toe), "vaak" (sport regelmatig)
- days: weekdagen als getallen, 0 = maandag … 6 = zondag (bv. "in het weekend" = [5, 6])
- days_per_week: een getal als enkel het aantal dagen genoemd wordt
- minutes: minuten per training
- cardio: sporten voor de conditie, uit "run" (lopen), "ride" (fietsen), "swim" (zwemmen)
- weeks: aantal weken; of until: een datum "JJJJ-MM-DD" als er een moment genoemd wordt (vandaag is {today})
- careful: true bij een blessure, pijn of iets dat gevoelig is
- race: alleen bij een loopwedstrijd: {"name": naam of null, "distance": "5k"|"10k"|"half"|"marathon", "date": "JJJJ-MM-DD" of null, "time": "u:mm:ss" of null}
- summary: één korte zin in het Nederlands, in de jij-vorm, met wat je begrepen hebt (zonder te verzinnen)
Antwoord enkel met één JSON-object."""

EXAMPLES = [
    ("Ik wil tegen de zomer een paar kilo kwijt. Ik kan maandag, woensdag en vrijdag, max 45 min, liefst lopen en fietsen.",
     {"goal": "slank", "days": [0, 2, 4], "minutes": 45, "cardio": ["run", "ride"], "until": "{summer}",
      "summary": "Je wil tegen de zomer een paar kilo kwijt, 3 keer per week lopen en fietsen, telkens zo'n 45 minuten."}),
    ("halve marathon in maart onder 1u40, ik loop nu 3x per week, knie soms wat gevoelig",
     {"goal": "lopen", "level": "vaak", "days_per_week": 3, "careful": True,
      "race": {"name": None, "distance": "half", "date": "{march}", "time": "1:40:00"},
      "summary": "Je traint voor een halve marathon in maart en wil onder 1u40 lopen; je loopt nu 3 keer per week en je knie is soms gevoelig."}),
    ("gewoon wat fitter worden, ik begin van nul, fietsen en zwemmen vind ik leuk, in het weekend",
     {"goal": "slank", "level": "start", "cardio": ["ride", "swim"], "days": [5, 6],
      "summary": "Je begint van nul en wil fitter worden met fietsen en zwemmen, in het weekend."}),
]


def _next(month: int, day: int, today: dt.date) -> dt.date:
    d = dt.date(today.year, month, day)
    return d if d > today else dt.date(today.year + 1, month, day)


def _shots(today: dt.date) -> list[dict]:
    fill = {"{summer}": _next(6, 21, today).isoformat(), "{march}": _next(3, 22, today).isoformat()}
    out = []
    for q, a in EXAMPLES:
        txt = json.dumps(a, ensure_ascii=False)
        for k, v in fill.items():
            txt = txt.replace(k, v)
        out += [{"role": "user", "content": q}, {"role": "assistant", "content": txt}]
    return out


def _time(s) -> int | None:
    """'1:40:00', '1u40', '45:00' → seconden."""
    m = re.fullmatch(r"\s*(\d{1,2})\s*[:u]\s*(\d{1,2})(?:\s*[:']\s*(\d{1,2}))?\s*", str(s or ""))
    if not m:
        return None
    a, b, c = int(m[1]), int(m[2]), int(m[3] or 0)
    hours = m[3] is not None or "u" in str(s) or a <= 6           # "3:30" bij een marathon = 3u30, "45:00" = 45 min
    secs = a * 3600 + b * 60 + c if hours else a * 60 + b
    return secs if 600 <= secs <= 8 * 3600 else None


def _date(s, today: dt.date) -> dt.date | None:
    try:
        d = dt.date.fromisoformat(str(s)[:10])
    except (TypeError, ValueError):
        return None
    return d if today < d <= today + dt.timedelta(days=730) else None


def clean(raw: dict, today: dt.date | None = None) -> dict:
    """Wat de AI teruggaf → enkel geldige antwoorden (de rest valt weg)."""
    today = today or dt.date.today()
    out: dict = {}
    if raw.get("goal") in GOALS:
        out["goal"] = raw["goal"]
    if raw.get("level") in LEVELS:
        out["level"] = raw["level"]
    days = raw.get("days")
    if isinstance(days, list):
        ds = sorted({int(d) for d in days if isinstance(d, (int, float)) and 0 <= int(d) <= 6})
        if 2 <= len(ds) <= 6:
            out["days"] = ds
    if "days" not in out and isinstance(raw.get("days_per_week"), (int, float)):
        out["days"] = SPREAD[max(2, min(6, int(raw["days_per_week"])))]
    if isinstance(raw.get("minutes"), (int, float)) and raw["minutes"] > 0:
        out["minutes"] = min(MINUTES, key=lambda m: abs(m - raw["minutes"]))
    if isinstance(raw.get("cardio"), list):
        c = [s for s in CARDIO if s in raw["cardio"]]
        if c:
            out["cardio"] = c
    weeks = raw.get("weeks")
    until = _date(raw.get("until"), today)
    if isinstance(weeks, (int, float)) and weeks > 0:
        out["weeks"] = max(4, min(52, int(round(weeks))))
    elif until:
        out["weeks"] = max(4, min(52, round((until - today).days / 7)))
        out["until"] = until.isoformat()
    if raw.get("careful") is True:
        out["careful"] = True
    race = raw.get("race")
    if isinstance(race, dict) and race.get("distance") in DISTANCES:
        r = {"distance": race["distance"]}
        d = _date(race.get("date"), today)
        if d and d >= today + dt.timedelta(days=7):
            r["date"] = d.isoformat()
        t = _time(race.get("time"))
        if t:
            r["goalSec"] = t
        if isinstance(race.get("name"), str) and race["name"].strip():
            r["name"] = race["name"].strip()[:60]
        out["race"] = r
        out["goal"] = "lopen"
    s = raw.get("summary")
    if isinstance(s, str) and s.strip():
        out["summary"] = re.sub(r"\s+", " ", s.strip())[:240]
    return out


# ---- wat exact moet kloppen, met vaste regels (de AI haalt soms dagen door elkaar) ----------------------
WEEKDAYS = {"maandag": 0, "dinsdag": 1, "woensdag": 2, "donderdag": 3, "vrijdag": 4, "zaterdag": 5, "zondag": 6}
MONTHS = {"jan": 1, "feb": 2, "maa": 3, "mrt": 3, "apr": 4, "mei": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "okt": 10, "nov": 11, "dec": 12}
# de AI vult soms dagen, minuten of sporten in die nergens staan: enkel houden als je tekst erover gaat
DAY_WORDS = re.compile(r"dag|weekend|week|keer|\d\s*x\b|\b[2-7]\b", re.I)
MIN_WORDS = re.compile(r"\d|min|uur|kwartier", re.I)
CARDIO_WORDS = re.compile(r"lop|loop|run|jog|fiets|wielren|mtb|bike|koers|zwem", re.I)
LEVEL_WORDS = re.compile(r"van nul|begin|beginner|af en toe|sport soms|loop soms|regelmatig|train vaak|loop vaak|sport vaak|keer per week|x per week|\d\s*x\b|loop nu|train nu|sport nu|lang niet|stilgestaan", re.I)


def rules(text: str, today: dt.date) -> dict:
    s = (text or "").lower()
    out: dict = {}
    days = {i for w, i in WEEKDAYS.items() if re.search(rf"\b{w}(s|en)?\b", s)}
    if re.search(r"weekend", s):
        days |= {5, 6}
    if re.search(r"weekdag|werkdag|in de week\b", s):
        days |= {0, 1, 2, 3, 4}
    if 2 <= len(days) <= 6:
        out["days"] = sorted(days)
    m = re.search(r"(\d)\s*(?:dagen|keer|x)\b", s)
    if "days" not in out and m and 2 <= int(m[1]) <= 6:
        out["days"] = SPREAD[int(m[1])]
    mins = None
    for m in re.finditer(r"(\d{2,3})\s*(?:min|minuten|')", s):
        if not re.search(r"(onder|in|binnen|sub|rond)\s*$", s[max(0, m.start() - 9):m.start()]):   # "onder 45 min" = een doeltijd
            mins = int(m[1])
            break
    if mins:
        pass
    elif "half uur" in s or "halfuur" in s:
        mins = 30
    elif "kwartier" in s:
        mins = 30
    elif re.search(r"\b(een|1|één) uur\b", s):
        mins = 60
    if mins:
        out["minutes"] = min(MINUTES, key=lambda x: abs(x - mins))
    m = re.search(r"(\d{1,2})\s*weken", s)
    target = None
    if re.search(r"altijd|routine|doorlopend|blijvend|onbeperkt|geen einde|hele jaar|jaar rond|gewoonte", s):
        out["weeks"] = 52                                           # een vaste routine: een jaar, daarna vernieuwen
    elif m:
        out["weeks"] = max(4, min(52, int(m[1])))
    else:
        m = re.search(r"(\d{1,2})\s*maand", s)
        if m:
            out["weeks"] = max(4, min(52, round(int(m[1]) * 4.35)))
        elif "zomer" in s:
            target = _next(6, 21, today)
        elif "kerst" in s:
            target = _next(12, 25, today)
        else:
            m = re.search(r"(\d{1,2})\s*(jan|feb|maa|mrt|apr|mei|jun|jul|aug|sep|okt|nov|dec)", s)
            if m:
                try:
                    target = _next(MONTHS[m[2]], int(m[1]), today)
                except ValueError:
                    target = None
    if target:
        out["weeks"] = max(4, min(52, round((target - today).days / 7)))
        out["until"] = target.isoformat()
    race = race_rules(s)
    if race:
        if target and target >= today + dt.timedelta(days=7):
            race["date"] = target.isoformat()
        out["race"] = race
    return out


def race_rules(s: str) -> dict:
    """Afstand en doeltijd van een loopwedstrijd, met vaste regels ("10 km onder 45 min", "marathon in 3:15")."""
    r: dict = {}
    if re.search(r"halve\s*marathon|half\s*marathon|21[,.]1\s*km", s):
        r["distance"] = "half"
    elif re.search(r"marathon|42[,.]2", s):
        r["distance"] = "marathon"
    elif re.search(r"\b10\s*(km|k)\b", s):
        r["distance"] = "10k"
    elif re.search(r"\b5\s*(km|k)\b", s):
        r["distance"] = "5k"
    if not r:
        return r
    m = re.search(r"(?:onder|in|binnen|sub|rond)\s*(\d{1,2}\s*[:u]\s*\d{2}(?:\s*[:']\s*\d{2})?|\d{1,3}\s*(?:min|minuten)\b)", s)
    if m:
        t = m[1]
        secs = int(re.match(r"\d+", t)[0]) * 60 if "min" in t else _time(t)
        if secs and 600 <= secs <= 8 * 3600:
            r["goalSec"] = secs
    return r


def understand(text: str, url: str = "http://localhost:11434", model: str = "mistral-nemo:latest",
               today: dt.date | None = None) -> dict:
    """Je tekst → {goal, level, days, minutes, cardio, weeks, careful, race, summary} (enkel wat er echt in stond)."""
    text = (text or "").strip()
    if not text:
        raise ValueError("Schrijf eerst wat je wil bereiken.")
    today = today or dt.date.today()
    r = requests.post(f"{url.rstrip('/')}/api/chat", timeout=90, json={
        "model": model, "stream": False, "format": "json", "options": {"temperature": 0.1},
        "messages": [{"role": "system", "content": SYSTEM.replace("{today}", today.isoformat())}, *_shots(today),
                     {"role": "user", "content": text[:600]}],
    })
    r.raise_for_status()
    raw = json.loads(r.json()["message"]["content"])
    out = clean(raw if isinstance(raw, dict) else {}, today)
    if "level" in out and not LEVEL_WORDS.search(text):          # niveau enkel als je er iets over schreef
        out.pop("level")
    for key, words in (("days", DAY_WORDS), ("minutes", MIN_WORDS), ("cardio", CARDIO_WORDS)):
        if key in out and not words.search(text):
            out.pop(key)
    fixed = rules(text, today)
    if "weeks" in fixed:
        out.pop("until", None)
    race = {**(out.get("race") or {}), **fixed.pop("race", {})}   # afstand en doeltijd: de vaste regels gaan voor
    if race.get("distance"):
        out["race"] = race
        out["goal"] = "lopen"
    out.update(fixed)                                             # dagen, minuten en weken: de vaste regels gaan voor
    out.pop("summary", None)                                      # de samenvatting maakt het venster zelf (klopt altijd met de antwoorden)
    return out

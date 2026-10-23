"""
Eigen trainingsschema (plan.json) voor wie geen Notion-schema heeft.

Het schema zelf wordt in het venster gemaakt (app/js/plan.js, dezelfde generator
als dE3p Run) en hier enkel gelezen: voor het Schema-scherm en om bij een sync de
run te benoemen naar de geplande training ("Tempoduurloop — 2 km IL + …").
"""
from __future__ import annotations

import datetime as dt

import userdata

RUN_KINDS = {"recovery", "easy", "strides", "long", "tempo", "interval", "mp", "race"}
NAMED_WITH_DETAIL = {"interval", "tempo", "mp", "long"}
DIST_LABEL = {"marathon": "Marathon", "half": "Halve marathon", "10k": "10 km", "5k": "5 km"}
MONTHS = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"]
PHASE_FOCUS = {
    "Start": "Lopen en wandelen: elke week loop je wat langer, tot 30 minuten aan één stuk. Op praattempo, wandelen mag altijd.",
    "Basis": "Rustig volume opbouwen: vooral gesprekstempo, met versnellingen voor een soepele pas.",
    "Opbouw": "Kilometers geleidelijk omhoog (max. +10% per week) met één of twee kwaliteitstrainingen.",
    "Herstelweek": "Minder kilometers, zodat je lichaam de opbouw kan verwerken.",
    "Piek": "De zwaarste weken: lange duurloop met wedstrijdtempo op het einde.",
    "Taper": "Minder volume, tempo behouden: frisse benen voor de wedstrijd.",
    "Wedstrijdweek": "Rustig aan, benen wakker houden en goed slapen.",
}


def load() -> dict | None:
    plan = userdata.read_json(userdata.PLAN, None)
    return plan if isinstance(plan, dict) and isinstance(plan.get("weeks"), list) else None


def save(plan: dict) -> None:
    if not isinstance(plan, dict) or not isinstance(plan.get("weeks"), list) or not plan["weeks"]:
        raise ValueError("Ongeldig schema.")
    userdata.write_json(userdata.PLAN, plan)


def delete() -> None:
    userdata.PLAN.unlink(missing_ok=True)


# ---- opmaak --------------------------------------------------------------------
def fmt_pace(sec: float) -> str:
    m, s = divmod(round(sec), 60)
    return f"{m}:{s:02d}"


def fmt_time(sec: float) -> str:
    sec = round(sec or 0)
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def pace_text(p) -> str:
    if not p:
        return ""
    lo, hi = p
    return f"{fmt_pace(lo)}/km" if round(lo) == round(hi) else f"{fmt_pace(lo)}–{fmt_pace(hi)}/km"


def km_text(km: float) -> str:
    return f"{km:g} km".replace(".", ",") if km else "—"


def short(iso: str) -> str:
    d = dt.date.fromisoformat(iso)
    return f"{d.day} {MONTHS[d.month - 1]}"


# ---- opzoeken ------------------------------------------------------------------
def strava_name(day: dict) -> str:
    """'Herstelloop' of 'Tempoduurloop — 2 km IL + 6 km @ 4:03 + 2 km UL'."""
    if (day["kind"] in NAMED_WITH_DETAIL or day.get("walk")) and day.get("detail"):
        return f"{day['title']} — {day['detail']}"
    return day["title"]


def day_for(plan: dict | None, iso: str) -> dict | None:
    for w in (plan or {}).get("weeks", []):
        for d in w.get("days", []):
            if d.get("date") == iso:
                return d
    return None


def planned_info(iso: str) -> tuple[str | None, str | None]:
    """(naam voor Strava/kaart, doeltempo) als er op die dag een run gepland staat."""
    day = day_for(load(), iso)
    if not day or day.get("kind") not in RUN_KINDS:
        return None, None
    return strava_name(day), (pace_text(day.get("pace")) or None)


def race(plan: dict | None) -> dict | None:
    c = (plan or {}).get("config") or {}
    if not c.get("raceDate"):
        return None
    return {"name": c.get("raceName") or DIST_LABEL.get(c.get("distance"), "Wedstrijd"),
            "date": c["raceDate"], "goal": fmt_time(c["goalSec"]) if c.get("goalSec") and not c.get("goalAuto") else ""}


def ui_weeks(plan: dict | None, today: dt.date) -> list[dict]:
    """Schema in het formaat van het Schema-scherm, vanaf de huidige week."""
    if not plan:
        return []
    weeks = plan["weeks"]
    monday = today - dt.timedelta(days=today.weekday())
    out = []
    for w in weeks:
        if dt.date.fromisoformat(w["monday"]) < monday:
            continue
        rows = []
        for d in w["days"]:
            run = d["kind"] in RUN_KINDS
            rows.append({
                "date": d["date"], "title": d["title"], "kind": d["kind"],
                "structure": d.get("detail", "") if run else "",
                "km": km_text(d.get("km") or 0) if run else "—",
                "pace": "—" if d.get("walk") else (pace_text(d.get("pace")) or "—"),   # beginner: tijd telt, niet het tempo
                "details": "" if run else d.get("detail", ""),
                "done": False, "rest": not run,
            })
        out.append({"num": w.get("index", len(out) + 1), "total": len(weeks), "label": w["phase"],
                    "marker": f"{short(w['days'][0]['date'])} – {short(w['days'][-1]['date'])}" if w["days"] else "",
                    "focus": PHASE_FOCUS.get(w["phase"], ""), "target": w.get("km"), "rows": rows})
    return out

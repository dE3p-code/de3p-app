"""
Je doelen en de schema's die erbij horen (extra.json): meerdere doelen tegelijk.

Een doel = wat je wil bereiken (de antwoorden uit de vragenlijst, of een zwemschema)
+ per sport een schema (zwemmen, lopen, fietsen). Oude krachtschema's vallen weg (dE3p = duursporten). Gemaakt in het venster
(app/js/extra.js) en hier gelezen: voor de pagina (welke training op welke dag) en om bij
een sync een training met een standaardnaam te benoemen naar de geplande training.

Vorm (v2): {"v": 2, "goals": [{"id", "profile": {...}, "plans": {"swim": {...}, ...}}]}
Oud (v1, tot 2.5): {"swim": plan, ..., "goal": profiel} → wordt vanzelf omgezet.
Het loopschema naar een wedstrijd (plan.json of Notion) staat hier niet in.
"""
from __future__ import annotations

import time
import uuid

import userdata

EXTRA = userdata.DATA / "extra.json"
SPORTS = ("swim", "run", "ride")
LABEL = {"swim": "Zwemmen", "run": "Lopen", "ride": "Fietsen"}
KIND = {"swim": "zwemmen", "run": "lopen", "ride": "fietsen"}


def _plan_ok(p) -> bool:
    return isinstance(p, dict) and isinstance(p.get("sessions"), list) and bool(p["sessions"])


def _norm(data) -> dict:
    """Altijd v2; een oud bestand (één doel + losse schema's) wordt omgezet."""
    data = data if isinstance(data, dict) else {}
    if isinstance(data.get("goals"), list):
        goals = [g for g in data["goals"] if isinstance(g, dict) and g.get("id") and isinstance(g.get("plans"), dict)]
        for g in goals:
            g["plans"] = {k: v for k, v in g["plans"].items() if k in SPORTS and _plan_ok(v)}
            g.setdefault("profile", {})
        return {"v": 2, "goals": [g for g in goals if g["plans"]]}
    plans = {k: v for k, v in data.items() if k in SPORTS and _plan_ok(v)}
    prof = data.get("goal") if isinstance(data.get("goal"), dict) else None
    goals = []
    if prof:
        mine = {k: v for k, v in plans.items() if (v.get("config") or {}).get("fromGoal")}
        if mine:
            goals.append({"id": "g1", "profile": prof, "plans": mine})
    for k, v in plans.items():
        if prof and (v.get("config") or {}).get("fromGoal"):
            continue
        c = v.get("config") or {}
        goals.append({"id": f"x-{k}", "plans": {k: v},
                      "profile": {"kind": KIND[k], "standalone": True, "startDate": c.get("startDate") or v["sessions"][0]["date"],
                                  "weeks": v.get("weeks"), "days": c.get("days") or []}})
    return {"v": 2, "goals": goals}


def load() -> dict:
    return _norm(userdata.read_json(EXTRA, {}))


def _write(data: dict) -> None:
    userdata.write_json(EXTRA, {"v": 2, "goals": data["goals"]})


def goals() -> list[dict]:
    """Al je doelen, voor Instellingen en de pagina 'Je doelen': profiel + per sport doel en periode."""
    out = []
    for g in load()["goals"]:
        sports = {}
        for sp, p in g["plans"].items():
            ss = p["sessions"]
            sports[sp] = {"config": p.get("config", {}), "weeks": p.get("weeks"), "from": ss[0]["date"], "to": ss[-1]["date"],
                          "count": len(ss)}
        out.append({"id": g["id"], "profile": g.get("profile") or {}, "sports": sports})
    return out


def rows() -> list[dict]:
    """Alle geplande trainingen van al je doelen, voor de pagina (gesorteerd op datum)."""
    out = []
    for g in load()["goals"]:
        for sport, plan in g["plans"].items():
            for s in plan["sessions"]:
                out.append({"date": s["date"], "sport": sport, "goal": g["id"], "title": s.get("title", LABEL[sport]),
                            "name": s.get("name", ""), "detail": s.get("detail", ""), "minutes": s.get("minutes"),
                            "meters": s.get("meters"), "week": s.get("week"), "weeks": plan.get("weeks"),
                            "phase": s.get("phase", "")})
    return sorted(out, key=lambda r: (r["date"], r["sport"]))


def save_goal(profile: dict, plans: dict, gid: str | None = None) -> str:
    """Een doel bewaren: met gid vervang je dat ene doel, zonder komt het erbij. Geeft het id terug."""
    if not isinstance(profile, dict) or not isinstance(plans, dict) or not plans:
        raise ValueError("Ongeldig doel.")
    for sport, plan in plans.items():
        if sport not in SPORTS or not _plan_ok(plan):
            raise ValueError("Ongeldig schema.")
    data = load()
    gid = str(gid) if gid else f"g{int(time.time()):x}{uuid.uuid4().hex[:4]}"
    goal = {"id": gid, "profile": profile, "plans": plans}
    for i, g in enumerate(data["goals"]):
        if g["id"] == gid:
            data["goals"][i] = goal
            break
    else:
        data["goals"].append(goal)
    _write(data)
    return gid


def delete_goal(gid: str) -> None:
    data = load()
    data["goals"] = [g for g in data["goals"] if g["id"] != str(gid)]
    _write(data)


def planned_for(iso: str, sport: str) -> tuple[str | None, str | None]:
    """(naam voor Strava en de kaart, de training als beschrijving) als er die dag iets gepland staat."""
    for g in load()["goals"]:
        for s in (g["plans"].get(sport) or {}).get("sessions", []):
            if s.get("date") == iso:
                return s.get("name") or s.get("title"), s.get("detail") or None
    return None, None

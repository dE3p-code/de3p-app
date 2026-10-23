"""Fitness in Wezenberg: je twee vaste krachttrainingen (A = dinsdag, B = donderdag) als training op je
Garmin-horloge, en na afloop je sets uitlezen en interpreteren: wat je deed, tegenover de vorige keer,
en wat je de volgende keer neemt.

    python fitness.py --upload            # A en B naar Garmin Connect (bestaande dE3p-versie wordt vervangen)
    python fitness.py --schedule 6        # de komende 6 weken op di (A) en do (B) in je Garmin-agenda
    python fitness.py --last              # je laatste krachttraining, geïnterpreteerd

Oefeningen en uitleg: Notion-pagina 'Fitness Wezenberg — oefeningen'. De Garmin-namen (categorie +
oefening) komen uit de catalogus van garminconnect (garminconnect/exercises.py).
"""
from __future__ import annotations

import datetime as dt
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import userdata  # noqa: E402

# (Nederlandse naam, Garmin-categorie, Garmin-oefening, sets, herhalingen of None, seconden of None, rust (s),
#  uitleg op je horloge, stap in kg bij vooruitgang (None = eigen gewicht))
PROGRAM: dict[str, dict] = {
    "A": {"name": "dE3p Fitness A — benen + romp", "day": 1, "items": [
        ("Goblet squat", "SQUAT", "GOBLET_SQUAT", 3, 10, None, 90, "Borst omhoog, knieën in lijn met je tenen.", 2.0),
        ("Roemeense deadlift", "DEADLIFT", "ROMANIAN_DEADLIFT", 3, 10, None, 90, "Rug recht, heupen naar achter. Licht beginnen.", 2.0),
        ("Bulgaarse split squat", "LUNGE", "DUMBBELL_BULGARIAN_SPLIT_SQUAT", 3, 16, None, 75, "8 per been, achterste voet op de bank.", 2.0),
        ("Kuitheffen staand", "CALF_RAISE", "WEIGHTED_STANDING_CALF_RAISE", 3, 15, None, 60, "Op een step, 3 tellen traag zakken.", 2.0),
        ("Kuitheffen zittend", "CALF_RAISE", "WEIGHTED_SEATED_CALF_RAISE", 2, 15, None, 45, "Gebogen knie: de diepe kuitspier.", 2.5),
        ("Plank", "PLANK", "PLANK", 3, None, 40, 45, "Rechte lijn, buik aanspannen.", None),
        ("Zijplank", "PLANK", "SIDE_PLANK", 4, None, 30, 30, "Afwisselend links en rechts.", None),
        ("Dead bug", "HIP_STABILITY", "DEAD_BUG", 2, 20, None, 45, "10 per kant, onderrug tegen de grond.", None),
    ]},
    "B": {"name": "dE3p Fitness B — rug, romp, bovenlichaam", "day": 3, "items": [
        ("Lat pulldown", "PULL_UP", "LAT_PULLDOWN", 3, 10, None, 90, "Stang naar je borst, schouders laag.", 2.5),
        ("Zittend roeien (kabel)", "ROW", "SEATED_CABLE_ROW", 3, 10, None, 90, "Schouderbladen samen, niet achteroverleunen.", 2.5),
        ("Dumbbell bankdrukken", "BENCH_PRESS", "DUMBBELL_BENCH_PRESS", 3, 10, None, 90, "Gecontroleerd zakken.", 2.0),
        ("Face pulls", "ROW", "FACE_PULL", 2, 15, None, 60, "Touw naar je gezicht, ellebogen hoog.", 2.5),
        ("Rugstrekken (rugbank)", "HYPEREXTENSION", "HYPEREXTENSION", 3, 12, None, 60, "Rustig, niet verder dan recht.", None),
        ("Pallof press", "CORE", "CABLE_CORE_PRESS", 3, 20, None, 45, "10 per kant, romp stil houden.", 2.5),
        ("Bird dog", "HIP_STABILITY", "QUADRUPED_WITH_LEG_LIFT", 2, 20, None, 45, "10 per kant: arm + tegenovergesteld been.", None),
        ("Bilbrug", "HIP_RAISE", "HIP_RAISE", 2, 12, None, 60, "Licht: zaterdag lange duurloop.", None),
    ]},
}
STRENGTH = {"sportTypeId": 5, "sportTypeKey": "strength_training", "displayOrder": 5}
NO_TARGET = {"workoutTargetTypeId": 1, "workoutTargetTypeKey": "no.target", "displayOrder": 1}
KG = {"unitId": 8, "unitKey": "kilogram", "factor": 1000.0}
NAMES = {(c, e): nl for k in PROGRAM for (nl, c, e, *_) in PROGRAM[k]["items"]}


# ---- trainingen maken en plannen -------------------------------------------------------
def _step(order: int, item: tuple, weight: float | None = None) -> dict:
    nl, cat, ex, _sets, reps, secs, _rest, tip, _ = item
    s = {"type": "ExecutableStepDTO", "stepOrder": order,
         "stepType": {"stepTypeId": 3, "stepTypeKey": "interval", "displayOrder": 3},
         "targetType": NO_TARGET, "category": cat, "exerciseName": ex, "description": f"{nl}: {tip}"[:500]}
    if reps:
        s.update(endCondition={"conditionTypeId": 10, "conditionTypeKey": "reps", "displayOrder": 10, "displayable": True},
                 endConditionValue=float(reps))
    else:
        s.update(endCondition={"conditionTypeId": 2, "conditionTypeKey": "time", "displayOrder": 2, "displayable": True},
                 endConditionValue=float(secs))
    if weight:
        s.update(weightValue=float(weight) * 1000.0, weightUnit=KG)
    return s


def _rest(order: int, secs: int) -> dict:
    return {"type": "ExecutableStepDTO", "stepOrder": order,
            "stepType": {"stepTypeId": 5, "stepTypeKey": "rest", "displayOrder": 5},
            "endCondition": {"conditionTypeId": 2, "conditionTypeKey": "time", "displayOrder": 2, "displayable": True},
            "endConditionValue": float(secs), "targetType": NO_TARGET}


def workout(key: str, weights: dict | None = None) -> dict:
    """De Garmin-training voor A of B; weights = {Nederlandse naam: kg} als doelgewicht op je horloge."""
    p = PROGRAM[key]
    steps, order = [], 1
    for item in p["items"]:
        sets, rest = item[3], item[6]
        steps.append({"type": "RepeatGroupDTO", "stepOrder": order,
                      "stepType": {"stepTypeId": 6, "stepTypeKey": "repeat", "displayOrder": 6},
                      "numberOfIterations": sets, "smartRepeat": False,
                      "endCondition": {"conditionTypeId": 7, "conditionTypeKey": "iterations", "displayOrder": 7,
                                       "displayable": False},
                      "endConditionValue": float(sets),
                      "workoutSteps": [_step(order + 1, item, (weights or {}).get(item[0])), _rest(order + 2, rest)]})
        order += 3
    return {"workoutName": p["name"], "sportType": STRENGTH, "estimatedDurationInSecs": 45 * 60,
            "description": "Wezenberg. Uitleg per oefening: Notion 'Fitness Wezenberg — oefeningen'. Daarna zwemmen.",
            "workoutSegments": [{"segmentOrder": 1, "sportType": STRENGTH, "workoutSteps": steps}]}


def _ids() -> dict:
    return (userdata.read_json(_cache_path(), {}).get("fitness") or {}).get("workouts") or {}


def _cache_path() -> Path:
    import garmin
    return garmin.CACHE


def _save_fit(**kw) -> None:
    import garmin
    with garmin._lock:
        cache = userdata.read_json(garmin.CACHE, {})
        cache["fitness"] = {**(cache.get("fitness") or {}), **kw}
        userdata.write_json(garmin.CACHE, cache)


def upload(g=None, weights: dict | None = None) -> dict:
    """A en B naar Garmin Connect. Een vorige dE3p-versie wordt bijgewerkt (zelfde id: geplande dagen blijven)."""
    import garmin
    g = g or garmin.client()
    ids = dict(_ids())
    for key in PROGRAM:
        w = workout(key, (weights or {}).get(key))
        if ids.get(key):
            try:
                g.update_workout(ids[key], {**w, "workoutId": ids[key]})
                continue
            except Exception:
                pass                                   # gewist in Garmin Connect: opnieuw maken
        ids[key] = (g.upload_workout(w) or {}).get("workoutId")
    _save_fit(workouts=ids)
    return ids


def schedule(weeks: int = 6, start: dt.date | None = None, g=None) -> list[str]:
    """A op dinsdag en B op donderdag in je Garmin-agenda (je horloge toont ze die dag)."""
    import garmin
    g = g or garmin.client()
    ids = _ids() or upload(g)
    start = start or dt.date.today()
    monday = start - dt.timedelta(days=start.weekday())
    done = set((userdata.read_json(garmin.CACHE, {}).get("fitness") or {}).get("scheduled") or [])
    out = []
    for w in range(weeks + 1):
        for key, p in PROGRAM.items():
            d = monday + dt.timedelta(weeks=w, days=p["day"])
            tag = f"{key}:{d.isoformat()}"
            if d < start or tag in done:
                continue
            g.schedule_workout(ids[key], d.isoformat())
            done.add(tag)
            out.append(tag)
    _save_fit(scheduled=sorted(done))
    return out


# ---- na de training: uitlezen en interpreteren ---------------------------------------------
def _kg(w) -> float | None:
    if not isinstance(w, (int, float)) or w <= 0:
        return None
    return round(w / 1000, 1) if w > 400 else round(float(w), 1)     # Garmin geeft gram


def parse_sets(raw: dict) -> list[dict]:
    """Garmin 'exerciseSets' → per oefening (in volgorde): [{name, cat, ex, sets: [{reps, kg, secs}]}]."""
    out: list[dict] = []
    for s in (raw or {}).get("exerciseSets") or []:
        if str(s.get("setType") or "").upper() != "ACTIVE":
            continue
        exs = sorted(s.get("exercises") or [], key=lambda e: -(e.get("probability") or 0))
        cat, ex = (exs[0].get("category"), exs[0].get("name")) if exs else (None, None)
        name = NAMES.get((cat, ex)) or next((nl for (c, e), nl in NAMES.items() if c == cat), None) \
            or str(ex or cat or "Oefening").replace("_", " ").capitalize()
        one = {"reps": s.get("repetitionCount"), "kg": _kg(s.get("weight")), "secs": round(s.get("duration") or 0)}
        if out and out[-1]["name"] == name:
            out[-1]["sets"].append(one)
        else:
            out.append({"name": name, "cat": cat, "ex": ex, "sets": [one]})
    return out


def which(session: list[dict]) -> str | None:
    """A of B: welk programma lijkt het meest op wat je deed."""
    names = {x["name"] for x in session}
    best = max(PROGRAM, key=lambda k: len(names & {i[0] for i in PROGRAM[k]["items"]}))
    return best if names & {i[0] for i in PROGRAM[best]["items"]} else None


def _item(name: str) -> tuple | None:
    return next((i for k in PROGRAM for i in PROGRAM[k]["items"] if i[0] == name), None)


def advise(session: list[dict], previous: list[dict] | None = None) -> list[dict]:
    """Per oefening: wat je deed, tegenover de vorige keer, en wat je volgende keer neemt."""
    prev = {x["name"]: x for x in previous or []}
    out = []
    for x in session:
        item = _item(x["name"])
        sets = x["sets"]
        reps_t, secs_t, step = (item[4], item[5], item[8]) if item else (None, None, None)
        kgs = [s["kg"] for s in sets if s["kg"]]
        kg = max(kgs) if kgs else None
        did = (f"{len(sets)}× {round(sum(s['secs'] for s in sets) / len(sets))} s" if secs_t
               else f"{len(sets)}× {'/'.join(str(s['reps'] or 0) for s in sets)}") + (f" @ {_fmt(kg)} kg" if kg else "")
        p = prev.get(x["name"])
        pkg = max((s["kg"] for s in p["sets"] if s["kg"]), default=None) if p else None
        vs = "" if not p else (f"{'+' if kg - pkg > 0 else ''}{_fmt(kg - pkg)} kg t.o.v. vorige keer" if kg and pkg and kg != pkg
                                else "zelfde als vorige keer")
        full = all((s["secs"] >= secs_t - 2) if secs_t else ((s["reps"] or 0) >= (reps_t or 0)) for s in sets) if item else False
        short = any((s["reps"] or 0) < (reps_t or 0) - 2 for s in sets) if item and reps_t else False
        if not item:
            nxt = ""
        elif secs_t:
            nxt = f"volgende keer {secs_t + 10} s" if full else f"volgende keer opnieuw {secs_t} s"
        elif step is None:
            nxt = "volgende keer 2 herhalingen meer" if full else "volgende keer opnieuw zo"
        elif not kg:
            nxt = "vul je gewicht in (horloge of Garmin Connect), dan zegt dE3p wat je volgende keer neemt"
        elif full:
            nxt = f"volgende keer {_fmt(kg + step)} kg"
        elif short:
            nxt = f"volgende keer {_fmt(max(kg - step, step))} kg, eerst alle herhalingen"
        else:
            nxt = f"volgende keer opnieuw {_fmt(kg)} kg tot alle herhalingen lukken"
        out.append({"name": x["name"], "did": did, "kg": kg, "vs": vs, "next": nxt, "full": full})
    return out


def _fmt(v: float) -> str:
    return f"{v:g}".replace(".", ",")


def session_for(start_local: str, secs: int | None = None) -> dict | None:
    """Je krachttraining die op dat moment begon: {key, items: advies per oefening}. Eén keer gevraagd, daarna
    uit het geheugen (garmin.json 'fitness' → 'sessions'); de vorige sessie van hetzelfde programma telt mee."""
    import garmin
    cache = userdata.read_json(garmin.CACHE, {})
    fit = cache.get("fitness") or {}
    sessions = fit.get("sessions") or {}
    recent = start_local[:10] >= (dt.date.today() - dt.timedelta(days=3)).isoformat()
    if start_local in sessions and not recent:      # recent: opnieuw lezen (gewichten vul je vaak achteraf in)
        return sessions[start_local]
    g = garmin.match(garmin.activities(), start_local) or garmin.match(garmin.activities(force=True), start_local)
    if not g or g["type"] not in ("strength_training", "indoor_cardio", "hiit"):
        return None
    sets = parse_sets(garmin.client().get_activity_exercise_sets(g["gid"]) or {})
    if not sets:
        return None
    key = which(sets)
    before = sorted((s for st, s in sessions.items() if st < start_local and s.get("key") == key), key=lambda s: s["start"])
    res = {"start": start_local, "key": key, "sets": sets, "items": advise(sets, before[-1]["sets"] if before else None)}
    _save_fit(sessions={**sessions, start_local: res})
    return res


def summary(res: dict) -> str:
    """Eén regel voor Notion en Strava: 'Fitness A: goblet squat 3× 10/10/10 @ 16 kg (→ 18 kg) · …'."""
    parts = [f"{i['name']} {i['did']}" + (f" (→ {i['next'].replace('volgende keer ', '')})" if i["next"].startswith("volgende keer") else "")
             for i in res["items"]]
    return (f"Fitness {res['key']}: " if res.get("key") else "") + " · ".join(parts)


if __name__ == "__main__":
    if "--upload" in sys.argv:
        print("Garmin-trainingen:", upload())
    if "--schedule" in sys.argv:
        n = int(sys.argv[sys.argv.index("--schedule") + 1]) if len(sys.argv) > sys.argv.index("--schedule") + 1 else 6
        print("Gepland:", schedule(n))
    if "--last" in sys.argv:
        import garmin
        acts = [a for a in garmin.activities(force=True) if a["type"] == "strength_training"]
        print(summary(session_for(acts[0]["start"])) if acts else "Nog geen krachttraining op Garmin.")

"""Je persoonlijke records en je loopschoenen, uit Strava.

Strava geeft bij elke loop (de details) je snelste 1 km, 5 km, 10 km, halve en hele marathon binnen die loop
(best_efforts) en welke schoenen je droeg, met hun totale kilometers (gear). Nieuwe loopjes leert dit bij de sync
(strava_sync.process_activity); je oudere loopjes haalt backfill() stap voor stap op, binnen Strava's limiet.
Alles staat in prestaties.json in je gegevensmap.
"""
from __future__ import annotations

import datetime as dt
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import userdata  # noqa: E402

FILE = userdata.DATA / "prestaties.json"
API = "https://www.strava.com/api/v3"
DIST = {"1K": "1 km", "5K": "5 km", "10K": "10 km", "Half-Marathon": "Halve marathon", "Marathon": "Marathon"}
RUNS = {"Run", "TrailRun", "VirtualRun"}
SHOE_OLD, SHOE_DONE = 600, 800       # km: bijna op, vervangen
SHOE_DAYS = 120                      # schoenen die je de laatste 4 maanden droeg


def _load() -> dict:
    return userdata.read_json(FILE, {})


def _is_run(a: dict) -> bool:
    return (a.get("sport_type") or a.get("type")) in RUNS


def learn(detail: dict, data: dict | None = None) -> dict:
    """Eén loop (Strava-details) verwerken: records en schoenen bijwerken. Bewaart, tenzij data meegegeven."""
    save = data is None
    data = _load() if data is None else data
    aid = detail.get("id")
    seen = set(data.get("seen") or [])
    if not aid or not _is_run(detail):
        return data
    when = (detail.get("start_date_local") or "")[:10]
    best = data.setdefault("best", {})
    cut = (dt.date.today() - dt.timedelta(days=180)).isoformat()
    recent = [x for x in data.get("recent") or [] if x["date"] >= cut and x.get("id") != aid]
    for e in detail.get("best_efforts") or []:
        k, secs = e.get("name"), e.get("elapsed_time")
        if k in DIST and secs and (k not in best or secs < best[k]["secs"]):
            best[k] = {"secs": int(secs), "date": when, "id": aid}
        if k in DIST and k != "1K" and secs and when >= cut:          # voor de voorspelling (Riegel)
            recent.append({"k": k, "secs": int(secs), "date": when, "id": aid})
    data["recent"] = recent[-400:]
    g = detail.get("gear") or {}
    if g.get("id") and g.get("distance") is not None:
        shoes = data.setdefault("gear", {})
        old = shoes.get(g["id"])
        if not old or when >= old.get("last", ""):
            shoes[g["id"]] = {"name": g.get("name") or "Schoenen", "km": round(g["distance"] / 1000, 1), "last": when}
    seen.add(aid)
    data["seen"] = sorted(seen)
    data["todo"] = [x for x in data.get("todo") or [] if x != aid]
    if save:
        userdata.write_json(FILE, data)
    return data


def _get(token: str, path: str, **params):
    r = requests.get(f"{API}{path}", headers={"Authorization": f"Bearer {token}"}, params=params, timeout=30)
    if r.status_code == 429:
        raise TimeoutError("Strava-limiet")
    r.raise_for_status()
    return r.json()


def backfill(token: str, budget_s: float = 5, limit: int = 15) -> int:
    """Je oudere loopjes ophalen voor je records (enkel de eerste keer is er veel te doen). Geeft terug hoeveel er
    nog wachten. Stopt bij de tijds- of aantalslimiet, of als Strava 'te veel' zegt (dan een uur pauze)."""
    data = _load()
    if time.time() < data.get("pause", 0):
        return len(data.get("todo") or [])
    t0 = time.time()
    try:
        if not data.get("listed"):                          # één keer: al je activiteiten (200 per pagina)
            ids, page = [], 1
            while page <= 20:
                acts = _get(token, "/athlete/activities", per_page=200, page=page)
                ids += [a["id"] for a in acts if _is_run(a)]
                if len(acts) < 200:
                    break
                page += 1
            seen = set(data.get("seen") or [])
            data["todo"] = [i for i in ids if i not in seen]         # nieuwste eerst
            data["listed"] = dt.date.today().isoformat()
            userdata.write_json(FILE, data)
        n = 0
        while data.get("todo") and n < limit and time.time() - t0 < budget_s:
            aid = data["todo"][0]
            try:
                learn(_get(token, f"/activities/{aid}", include_all_efforts="true"), data)
            except requests.HTTPError:
                data["todo"] = data["todo"][1:]              # weg of privé van iemand anders: overslaan
            n += 1
        userdata.write_json(FILE, data)
    except TimeoutError:
        data["pause"] = time.time() + 3600
        userdata.write_json(FILE, data)
    except Exception:
        userdata.write_json(FILE, data)
    return len(data.get("todo") or [])


def record_note(detail: dict) -> str | None:
    """Voor de recap-kaart: 'Nieuw record: 10 km in 39:24' als deze loop een record was (de langste afstand)."""
    hits = [e for e in detail.get("best_efforts") or [] if e.get("pr_rank") == 1 and e.get("name") in DIST]
    if not hits:
        return None
    e = max(hits, key=lambda x: list(DIST).index(x["name"]))
    return f"Nieuw record: {DIST[e['name']].lower()} in {hms(e['elapsed_time'])}"


METERS = {"1K": 1000, "5K": 5000, "10K": 10000, "Half-Marathon": 21097.5, "Marathon": 42195}


def riegel(efforts: list[dict]) -> dict | None:
    """Voorspelling zonder Garmin: tijd op D uit tijd t op d = t × (D/d)^1,06; de snelste uitkomst telt."""
    out = {}
    for key, D in (("5k", 5000), ("10k", 10000), ("half", 21097.5), ("marathon", 42195)):
        ts = [e["secs"] * (D / METERS[e["k"]]) ** 1.06 for e in efforts if e["k"] in METERS]
        if ts:
            out[key] = round(min(ts))
    return out if out.get("marathon") else None


def hms(s: int) -> str:
    s = int(s)
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


def status() -> dict:
    """Voor het scherm (en de gsm): je records en je schoenen van de laatste maanden."""
    data = _load()
    today = dt.date.today()
    recs = [{"k": k, "label": lab, **data["best"][k], "new": (today - dt.date.fromisoformat(data["best"][k]["date"])).days <= 7}
            for k, lab in DIST.items() if k in (data.get("best") or {}) and data["best"][k].get("date")]
    since = (today - dt.timedelta(days=SHOE_DAYS)).isoformat()
    shoes = sorted(({**v, "id": k} for k, v in (data.get("gear") or {}).items() if v.get("last", "") >= since),
                   key=lambda x: x["last"], reverse=True)
    for s in shoes:
        s["lvl"] = "bad" if s["km"] >= SHOE_DONE else "mid" if s["km"] >= SHOE_OLD else "good"
    rec = data.get("recent") or []
    day = lambda n: (today - dt.timedelta(days=n)).isoformat()
    now = riegel([x for x in rec if x["date"] >= day(56)])
    before = riegel([x for x in rec if day(84) <= x["date"] < day(28)])
    race = {"now": {"date": today.isoformat(), **now}, "before": before, "src": "je snelste tijden"} if now else None
    return {"records": recs, "shoes": shoes, "todo": len(data.get("todo") or []), "listed": bool(data.get("listed")), "race": race}


if __name__ == "__main__":                                   # python prestaties.py → records en schoenen tonen
    import json
    print(json.dumps(status(), ensure_ascii=False, indent=1))

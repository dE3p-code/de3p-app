"""
Garmin Connect in dE3p: slaap, Body Battery, HRV, trainingsgereedheid/-status,
VO2max, rusthartslag, stappen, stress en hoe een training voelde (de vraag op je horloge na
een activiteit).

Onofficieel, via python-garminconnect: Garmin kan hier iets aan veranderen. Je logt één keer
in vanuit het programma (Instellingen → Garmin); je wachtwoord wordt nergens bewaard, enkel de
sleutel die Garmin teruggeeft (gegevensmap/garmin).

  python garmin.py              # vandaag + de laatste 7 dagen (voor de coaching)
  python garmin.py --days 14
"""
from __future__ import annotations

import datetime as dt
import shutil
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import userdata  # noqa: E402

TOKENS = userdata.DATA / "garmin"
CACHE = userdata.DATA / "garmin.json"
FRESH = 30 * 60          # vandaag opnieuw ophalen na 30 min
QUICK = 3 * 60           # ... of al na 3 min als je horloge je dagwaarden nog niet doorgaf sinds je laatste training
CACHE_V = 3              # ophogen als day() nieuwe velden krijgt: dan alles opnieuw ophalen
FETCH = 45               # zoveel dagen terug vraagt het programma zelf op bij Garmin
KEEP = 400               # zoveel dagen blijven bewaard: per dag terugbladeren, ook verder dan 45 dagen
FEEL = {0: "Heel zwak", 25: "Zwak", 50: "Normaal", 75: "Sterk", 100: "Heel sterk"}
READY = {"PRIME": "Topvorm", "HIGH": "Hoog", "MODERATE": "Gemiddeld", "LOW": "Laag", "POOR": "Slecht"}
# trainingsstatus (horloges zonder 'trainingsgereedheid', zoals de Forerunner 255): dezelfde namen als
# in de Nederlandse Garmin-handleiding ('Trainingsstatusniveaus')
STATUS = {"PRODUCTIVE": "Productief", "MAINTAINING": "Aanhouden", "PEAKING": "Piek", "RECOVERY": "Herstel",
          "UNPRODUCTIVE": "Niet productief", "DETRAINING": "Onttrainen", "OVERREACHING": "Te intensief",
          "STRAINED": "Gespannen", "NO_STATUS": "Geen status"}
OLD_STATUS = {"Onderhoud": "Aanhouden", "Onproductief": "Niet productief", "Afbouw": "Onttrainen", "Overbelast": "Te intensief"}
LOAD = {"OPTIMAL": "belasting optimaal", "HIGH": "belasting hoog", "LOW": "belasting laag", "VERY_HIGH": "belasting te hoog"}
HRV = {"BALANCED": "in balans", "UNBALANCED": "uit balans", "LOW": "laag", "POOR": "laag", "NONE": "nog geen baseline"}

_pending: dict = {}      # tussenstand bij een MFA-code (enkel in het geheugen)


# ---- koppelen ---------------------------------------------------------------------
def connected() -> bool:
    return TOKENS.is_dir() and any(TOKENS.iterdir())


def _save(g) -> None:
    TOKENS.mkdir(parents=True, exist_ok=True)
    g.client.dump(str(TOKENS))
    CACHE.unlink(missing_ok=True)


def start_login(email: str, password: str) -> str:
    """'ok' of 'mfa' (dan finish_mfa met de code uit je mail/sms)."""
    from garminconnect import Garmin
    g = Garmin(email.strip(), password, return_on_mfa=True)
    status, state = g.login()
    if status == "needs_mfa":
        _pending.update(g=g, state=state)
        return "mfa"
    _save(g)
    return "ok"


def finish_mfa(code: str) -> None:
    if "g" not in _pending:
        raise RuntimeError("Begin opnieuw met inloggen.")
    g, state = _pending.pop("g"), _pending.pop("state")
    g.resume_login(state, code.strip())
    _save(g)


def disconnect() -> None:
    shutil.rmtree(TOKENS, ignore_errors=True)
    CACHE.unlink(missing_ok=True)


def client():
    from garminconnect import Garmin
    if not connected():
        raise RuntimeError("Garmin is nog niet gekoppeld.")
    g = Garmin()
    g.login(tokenstore=str(TOKENS))
    g.client.dump(str(TOKENS))       # vernieuwde sleutel bewaren
    return g


# ---- gegevens -----------------------------------------------------------------------
def _try(f, *a):
    try:
        return f(*a)
    except Exception:
        return None


def _lite(iso: str, v: dict) -> dict:
    """Een dag van verder terug, met de waarden die het jaaroverzicht bewaart (minder details)."""
    out: dict = {"date": iso, "lite": True}
    if v.get("score") is not None or v.get("secs"):
        out["sleep"] = {"score": v.get("score"), "secs": v.get("secs")}
    if v.get("hrv") is not None:
        out["hrv"] = {"night": v["hrv"]}
    if v.get("rhr") is not None:
        out["rhr"] = round(v["rhr"])
    if v.get("bb") is not None:
        out["battery"] = {"high": v["bb"], "low": v.get("bblo")}
    if v.get("steps"):
        out["steps"] = {"n": v["steps"], "goal": v.get("goal")}
    if v.get("vo2"):                                   # voor je lichaamsleeftijd van maanden geleden
        out["status"] = {"label": None, "vo2max": round(v["vo2"], 1), "load": None, "ratio": None}
    return out


def day(g, iso: str, ready_ok: bool = True) -> dict:
    """Herstel en gezondheid van één dag (de nacht ervoor + de dag zelf)."""
    out: dict = {"date": iso}
    sleep = _try(g.get_sleep_data, iso) or {}
    s = sleep.get("dailySleepDTO") or {}
    if s.get("sleepTimeSeconds"):
        out["sleep"] = {
            "score": ((s.get("sleepScores") or {}).get("overall") or {}).get("value"),
            "secs": s.get("sleepTimeSeconds"), "deep": s.get("deepSleepSeconds"),
            "light": s.get("lightSleepSeconds"), "rem": s.get("remSleepSeconds"), "awake": s.get("awakeSleepSeconds"),
            "spo2": s.get("averageSpO2Value"), "spo2lo": s.get("lowestSpO2Value"),   # Pulse Ox 'tijdens slaap'
            "resp": s.get("averageRespirationValue"),
        }
    hrv = ((_try(g.get_hrv_data, iso) or {}).get("hrvSummary")) or {}
    if hrv.get("lastNightAvg"):
        out["hrv"] = {"night": hrv.get("lastNightAvg"), "week": hrv.get("weeklyAvg"),
                      "status": HRV.get(hrv.get("status") or "", (hrv.get("status") or "").lower())}
    ready = (_try(g.get_training_readiness, iso) or []) if ready_ok else []
    if isinstance(ready, list) and ready and ready[0].get("score") is not None:
        r = ready[0]
        out["readiness"] = {"score": r.get("score"), "level": READY.get(r.get("level") or "", r.get("level")),
                            "recovery_h": round((r.get("recoveryTime") or 0) / 60) or None}
    ts = _try(g.get_training_status, iso) or {}
    vo2 = ((ts.get("mostRecentVO2Max") or {}).get("generic") or {}).get("vo2MaxPreciseValue")
    latest = ((ts.get("mostRecentTrainingStatus") or {}).get("latestTrainingStatusData") or {})
    dev = next((v for v in latest.values() if v.get("primaryTrainingDevice")), None) or next(iter(latest.values()), {})
    if dev or vo2:
        phrase = (dev.get("trainingStatusFeedbackPhrase") or "").rsplit("_", 1)[0]
        acwr = dev.get("acuteTrainingLoadDTO") or {}
        out["status"] = {"label": STATUS.get(phrase, phrase.capitalize() or None), "vo2max": round(vo2, 1) if vo2 else None,
                         "load": LOAD.get(acwr.get("acwrStatus") or "", None), "ratio": acwr.get("dailyAcuteChronicWorkloadRatio")}
    st = _try(g.get_stats, iso) or {}
    if st:
        out["rhr"] = st.get("restingHeartRate")
        if st.get("bodyBatteryHighestValue") is not None:
            out["battery"] = {"now": st.get("bodyBatteryMostRecentValue"), "high": st.get("bodyBatteryHighestValue"),
                              "low": st.get("bodyBatteryLowestValue")}
        out["stress"] = st.get("averageStressLevel")
        if st.get("totalSteps") is not None:
            out["steps"] = {"n": st.get("totalSteps"), "goal": st.get("dailyStepGoal"),
                            "km": round((st.get("totalDistanceMeters") or 0) / 1000, 1)}
        out["kcal"] = {"total": st.get("totalKilocalories"), "active": st.get("activeKilocalories")}
        out["intensity"] = (st.get("moderateIntensityMinutes") or 0) + 2 * (st.get("vigorousIntensityMinutes") or 0)
        out["intensity_goal"] = st.get("intensityMinutesGoal")
        out["floors"] = round(st.get("floorsAscended") or 0)
        # tot wanneer je horloge je dagwaarden (Body Battery, stress, stappen) doorgaf: daarna weet Garmin nog niets
        out["synced"] = (st.get("wellnessEndTimeLocal") or "")[:16] or None
    return out


_lock = threading.Lock()


CORE = ("sleep", "hrv", "rhr", "battery", "steps")


def _has_data(v: dict) -> bool:
    """Heeft Garmin voor die dag echt iets teruggegeven? (bij een hapering komt alles leeg terug)"""
    return any(v.get(k) for k in CORE)


def recovery(days: int = 7, force: bool = False, after: str | None = None) -> dict:
    """Vandaag + vorige dagen, met een geheugen zodat het venster niet bij elke klik Garmin vraagt.
    Oude dagen veranderen niet meer: die worden één keer opgehaald, vandaag elk half uur. Een dag die nog liep
    toen hij werd opgehaald, wordt achteraf nog één keer opgehaald; een lege dag (Garmin haperde) later opnieuw."""
    with _lock:
        cache = userdata.read_json(CACHE, {})
        if cache.get("v") != CACHE_V:
            cache = {"v": CACHE_V, "feel": cache.get("feel", {})}
        today = dt.date.today().isoformat()
        need = [(dt.date.today() - dt.timedelta(days=k)).isoformat() for k in range(days)]
        now = time.time()
        stale = force or now - cache.get("at", 0) > FRESH
        # after = start van je laatste training vandaag ('JJJJ-MM-DDTHH:MM'): gaf je horloge daarna nog niets door,
        # dan klopt bv. Body Battery nog niet (100 na een lange loop) -> snel opnieuw kijken tot het wel klopt
        cur = cache.get("days", {}).get(today) or {}
        behind = "synced" not in cur or (cur["synced"] and cur["synced"] < after[:16]) if after else False
        if not stale and behind and now - cache.get("at", 0) > QUICK:   # geeft je horloge geen tijd door: niet blijven vragen
            stale = True
        recent = (dt.date.today() - dt.timedelta(days=3)).isoformat()

        def needs(d: str) -> bool:
            v = cache.get("days", {}).get(d)
            if v is None:
                return True
            if d == today:
                return stale
            if not _has_data(v):                       # Garmin haperde die dag: later nog eens proberen
                return now - v.get("_tried", 0) > FRESH
            return d >= recent and (v.get("_at") or "")[:10] <= d     # opgehaald terwijl de dag nog liep: 1x opnieuw

        todo = [d for d in need[:FETCH] if needs(d)]
        down = False
        if todo:
            try:
                g = client()
                for d in todo:
                    # horloges zonder trainingsgereedheid (bv. Forerunner 255): die vraag niet elke dag stellen
                    new = day(g, d, cache.get("ready", True))
                    old = cache.setdefault("days", {}).get(d)
                    if _has_data(new) or not old or not _has_data(old):
                        new["_at"] = dt.datetime.now().isoformat(timespec="minutes")
                        if not _has_data(new):
                            new["_tried"] = now
                        cache["days"][d] = new
                    else:                              # Garmin gaf niets terug: de vorige cijfers houden
                        old["_tried"] = now
                    if cache.get("ready") is None and len(cache["days"]) >= 3:
                        cache["ready"] = any(v.get("readiness") for v in cache["days"].values())
                cache["at"] = time.time()
            except Exception:
                if not cache.get("days"):
                    raise
                down = True                    # Garmin even onbereikbaar: de bewaarde dagen tonen
            cache["days"] = {d: cache["days"][d] for d in sorted(cache["days"])[-KEEP:]}
            userdata.write_json(CACHE, cache)
        full = cache["days"]
        lite = (cache.get("months") or {}).get("days") or {}      # verder terug: uit het jaaroverzicht
        if not cache.get("vo2_1") and lite:            # VO2max stond afgerond (59 i.p.v. 59,2): exacte waarde erbij
            for d, v in full.items():
                st, pv = v.get("status"), (lite.get(d) or {}).get("vo2")
                if st and st.get("vo2max") and pv:
                    st["vo2max"] = round(pv, 1)
            cache["vo2_1"] = True
            userdata.write_json(CACHE, cache)
        if not cache.get("status_nl"):                 # oude namen (Onderhoud, Afbouw…) → die van Garmin zelf
            for v in full.values():
                st = v.get("status")
                if st and st.get("label") in OLD_STATUS:
                    st["label"] = OLD_STATUS[st["label"]]
            cache["status_nl"] = True
            userdata.write_json(CACHE, cache)
        out = {"today": full.get(today, {"date": today}),
               "history": [full[d] if d in full else _lite(d, lite[d]) for d in sorted(need) if d in full or d in lite]}
        if down:
            out["stale"] = True
        return out


# ---- per maand: zie je echt vooruitgang ------------------------------------------------
# Bereik-aanvragen (een heel jaar in ±15 s) i.p.v. dag per dag. Oude dagen blijven bewaard,
# enkel de laatste week wordt opnieuw gevraagd.
MONTHS = 24              # 'Alles': tot twee jaar terug, per maand


def _month_start(n: int) -> dt.date:
    t = dt.date.today()
    y, m = t.year, t.month - (n - 1)
    while m <= 0:
        m, y = m + 12, y - 1
    return dt.date(y, m, 1)


def _chunks(a: dt.date, b: dt.date, size: int = 28):
    while a <= b:
        e = min(a + dt.timedelta(days=size - 1), b)
        yield a.isoformat(), e.isoformat()
        a = e + dt.timedelta(days=1)


def _fetch_span(g, a: dt.date, b: dt.date) -> tuple[dict, dict]:
    """Dagwaarden en weekwaarden tussen a en b."""
    S, E = a.isoformat(), b.isoformat()
    days: dict = {}
    weeks: dict = {}
    ok = 0

    def get(f, *args):
        nonlocal ok
        r = _try(f, *args)
        ok += r is not None
        return r

    def put(d, k, v):
        if d and v is not None:
            days.setdefault(d, {})[k] = v

    for r in get(g.get_daily_steps, S, E) or []:
        if r.get("totalSteps"):                       # 0 stappen = horloge niet gedragen
            put(r.get("calendarDate"), "steps", r["totalSteps"])
            put(r.get("calendarDate"), "goal", r.get("stepGoal"))
    for r in get(g.get_sleep_daily, S, E) or []:
        v = r.get("values") or {}
        put(r.get("calendarDate"), "score", v.get("sleepScore"))
        put(r.get("calendarDate"), "secs", v.get("totalSleepTimeInSeconds") or None)
    for r in get(g.get_rhr_daily, S, E) or []:
        put(r.get("calendarDate"), "rhr", r.get("value"))
    for r in (get(g.get_hrv_data_range, S, E) or {}).get("hrvSummaries") or []:
        put(r.get("calendarDate"), "hrv", r.get("lastNightAvg"))
    for r in get(g.get_max_metrics_range, S, E) or []:
        gen = (r or {}).get("generic") or {}
        put(gen.get("calendarDate"), "vo2", gen.get("vo2MaxPreciseValue"))
    for s, e in _chunks(a, b):                        # Body Battery: max 28 dagen per vraag
        for r in get(g.get_body_battery, s, e) or []:
            vals = [x[1] for x in r.get("bodyBatteryValuesArray") or []
                    if isinstance(x, list) and len(x) > 1 and x[1] is not None]
            if vals:
                put(r.get("date"), "bb", max(vals))
                put(r.get("date"), "bblo", min(vals))
    for r in get(g.get_weekly_stress, E, (b - a).days // 7 + 2) or []:
        if r.get("calendarDate") and r.get("value") is not None:
            weeks.setdefault(r["calendarDate"], {})["stress"] = r["value"]
    for r in get(g.get_weekly_intensity_minutes, S, E) or []:
        if r.get("calendarDate"):
            weeks.setdefault(r["calendarDate"], {}).update(
                im=(r.get("moderateValue") or 0) + 2 * (r.get("vigorousValue") or 0), imgoal=r.get("weeklyGoal"))
    if not ok:
        raise RuntimeError("Garmin gaf geen gegevens terug.")
    return days, weeks


def _aggregate(mo: dict, first: dt.date, today: dt.date) -> list[dict]:
    """Gemiddelde per maand + op hoeveel dagen (of weken) het gemeten is."""
    buckets: dict = {}

    def add(month, k, v):
        buckets.setdefault(month, {}).setdefault(k, []).append(v)

    for d, v in mo.get("days", {}).items():
        for k in ("score", "secs", "rhr", "hrv", "vo2", "bb", "bblo", "steps", "goal", "ready", "spo2", "weight", "glu", "sys", "dia"):
            if v.get(k) is not None:
                add(d[:7], k, v[k])
        if v.get("steps") and v.get("goal"):
            add(d[:7], "hit", 100 if v["steps"] >= v["goal"] else 0)
    for w, v in mo.get("weeks", {}).items():
        month = (dt.date.fromisoformat(w) + dt.timedelta(days=3)).isoformat()[:7]   # maand van de donderdag
        for k in ("stress", "im", "imgoal"):
            if v.get(k) is not None:
                add(month, k, v[k])
    out = []
    y, m = first.year, first.month
    while (y, m) <= (today.year, today.month):
        key = f"{y}-{m:02d}"
        b = buckets.get(key, {})
        out.append({"m": key, "partial": key == today.isoformat()[:7],
                    "v": {k: round(sum(xs) / len(xs), 1) for k, xs in b.items()},
                    "n": {k: len(xs) for k, xs in b.items()}})
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def weights(days: int = KEEP, force: bool = False) -> list[dict]:
    """Je wegingen in Garmin Connect (Index-weegschaal of zelf ingevuld), oudste eerst, één per dag (de laatste):
    [{date, kg, fat, water, muscle, bone, bmi, src}]. Opnieuw gevraagd bij force (elke sync) of na FRESH."""
    with _lock:
        w = userdata.read_json(CACHE, {}).get("weights") or {}
        stale = force or time.time() - w.get("at", 0) > FRESH or w.get("days") != days
    if stale:
        try:
            end = dt.date.today()
            r = client().get_body_composition((end - dt.timedelta(days=days)).isoformat(), end.isoformat()) or {}
            g = lambda v: round(v / 1000, 1) if isinstance(v, (int, float)) and v > 0 else None   # noqa: E731 gram → kg
            p = lambda v: round(v, 1) if isinstance(v, (int, float)) and v > 0 else None          # noqa: E731
            by_day = {}
            for x in sorted(r.get("dateWeightList") or [], key=lambda x: x.get("date") or 0):
                if x.get("calendarDate") and x.get("weight"):
                    by_day[x["calendarDate"]] = {
                        "date": x["calendarDate"], "kg": g(x["weight"]), "fat": p(x.get("bodyFat")), "water": p(x.get("bodyWater")),
                        "muscle": g(x.get("muscleMass")), "bone": g(x.get("boneMass")), "bmi": p(x.get("bmi")),
                        "src": "Garmin-weegschaal" if str(x.get("sourceType") or "").upper() not in ("MANUAL", "") else "Garmin Connect"}
            w = {"at": time.time(), "days": days, "list": [by_day[d] for d in sorted(by_day)]}
            with _lock:
                cache = userdata.read_json(CACHE, {})
                cache["weights"] = w
                userdata.write_json(CACHE, cache)
        except Exception:
            if not w.get("list"):
                raise
    return w.get("list") or []


def blood_pressure(days: int = 365, force: bool = False) -> list[dict]:
    """Je bloeddrukmetingen in Garmin Connect (Index BPM of zelf ingevuld), oudste eerst:
    [{at: 'JJJJ-MM-DDTHH:MM', sys, dia, pulse, src}]. Opnieuw gevraagd bij force (elke sync) of na FRESH."""
    with _lock:
        b = userdata.read_json(CACHE, {}).get("bp") or {}
        stale = force or time.time() - b.get("at", 0) > FRESH
    if stale:
        try:
            end = dt.date.today()
            r = client().get_blood_pressure((end - dt.timedelta(days=days)).isoformat(), end.isoformat()) or {}
            out = []
            for summ in r.get("measurementSummaries") or []:
                for m in summ.get("measurements") or [summ]:
                    s, d = m.get("systolic"), m.get("diastolic")
                    at = str(m.get("measurementTimestampLocal") or m.get("timestampLocal") or summ.get("startDate") or "")[:16]
                    if isinstance(s, (int, float)) and isinstance(d, (int, float)) and len(at) >= 10:
                        out.append({"at": at.replace(" ", "T"), "sys": round(s), "dia": round(d),
                                    "pulse": round(m["pulse"]) if isinstance(m.get("pulse"), (int, float)) else None,
                                    "src": "Garmin"})
            b = {"at": time.time(), "list": sorted(out, key=lambda x: x["at"])}
            with _lock:
                cache = userdata.read_json(CACHE, {})
                cache["bp"] = b
                userdata.write_json(CACHE, cache)
        except Exception:
            if not b.get("list"):
                raise
    return b.get("list") or []


def _with_spo2(mo: dict, cache: dict) -> dict:
    """Zuurstof (SpO2) 's nachts zit niet in de bereik-vragen van het jaaroverzicht: die komt uit de dagen die
    recovery() al ophaalde (tot KEEP dagen bewaard)."""
    days = {d: dict(v) for d, v in (mo.get("days") or {}).items()}
    for d, v in (cache.get("days") or {}).items():
        s = (v.get("sleep") or {}).get("spo2")
        if s:
            days.setdefault(d, {})["spo2"] = s
    # je gewicht per maand: wegingen van Garmin + wat je zelf in dE3p invulde (weegschaal.json)
    own = userdata.read_json(userdata.DATA / "weegschaal.json", {})
    for x in ((cache.get("weights") or {}).get("list") or []) + [{"date": d, **v} for d, v in own.items()]:
        if x.get("kg"):
            days.setdefault(x["date"], {})["weight"] = x["kg"]
    # bloedsuiker en bloeddruk per maand (gemiddelde per dag): zelf ingevuld (metingen.json) + Garmin-bloeddruk
    vit = userdata.read_json(userdata.DATA / "metingen.json", {})
    per: dict = {}
    for g in vit.get("glucose") or []:
        per.setdefault(g["at"][:10], {}).setdefault("glu", []).append(g["mgdl"])
    for p in ((cache.get("bp") or {}).get("list") or []) + (vit.get("bp") or []):
        per.setdefault(p["at"][:10], {}).setdefault("sys", []).append(p["sys"])
        per[p["at"][:10]].setdefault("dia", []).append(p["dia"])
    for d, v in per.items():
        for k, xs in v.items():
            days.setdefault(d, {})[k] = round(sum(xs) / len(xs), 1)
    return {**mo, "days": days}


def months(n: int = MONTHS, force: bool = False) -> dict:
    with _lock:
        cache = userdata.read_json(CACHE, {})
        if cache.get("v") != CACHE_V:
            cache = {"v": CACHE_V, "feel": cache.get("feel", {})}
        mo = cache.get("months") or {}
        today = dt.date.today()
        first = _month_start(n)
        if not mo.get("from") or mo["from"] > first.isoformat():
            mo, span = {}, (first, today)
        elif force or mo.get("to") != today.isoformat() or time.time() - mo.get("at", 0) > FRESH:
            span = (max(first, dt.date.fromisoformat(mo["to"]) - dt.timedelta(days=7)), today)
        else:
            span = None
        if span:
            try:
                days, weeks = _fetch_span(client(), *span)
            except Exception:
                if not mo.get("days"):
                    raise
                return {"months": _aggregate(_with_spo2(mo, cache), first, today), "today": today.isoformat(), "stale": True}
            for d, v in days.items():
                mo.setdefault("days", {}).setdefault(d, {}).update(v)
            for w, v in weeks.items():
                mo.setdefault("weeks", {}).setdefault(w, {}).update(v)
            keep = (first - dt.timedelta(days=7)).isoformat()
            mo["days"] = {d: v for d, v in mo.get("days", {}).items() if d >= first.isoformat()}
            mo["weeks"] = {w: v for w, v in mo.get("weeks", {}).items() if w >= keep}
            mo.update({"from": first.isoformat(), "to": today.isoformat(), "at": time.time()})
            cache["months"] = mo
            userdata.write_json(CACHE, cache)
        return {"months": _aggregate(_with_spo2(mo, cache), first, today), "today": today.isoformat()}


# ---- je trainingen zoals je horloge ze bewaarde: tweede bron naast Strava ---------------------
ACT_DAYS = 60            # zoveel dagen trainingen van Garmin naast die van Strava leggen
# Garmin-type → Strava-sporttype (voor sports.group/name: zelfde groepen en Nederlandse namen)
GTYPE = {
    "running": "Run", "street_running": "Run", "track_running": "Run", "treadmill_running": "VirtualRun",
    "indoor_running": "VirtualRun", "virtual_run": "VirtualRun", "trail_running": "TrailRun", "ultra_run": "TrailRun",
    "cycling": "Ride", "road_biking": "Ride", "cyclocross": "Ride", "track_cycling": "Ride", "recumbent_cycling": "Ride",
    "bmx": "Ride", "gravel_cycling": "GravelRide", "mountain_biking": "MountainBikeRide", "indoor_cycling": "VirtualRide",
    "virtual_ride": "VirtualRide", "e_bike_fitness": "EBikeRide", "e_bike_mountain": "EMountainBikeRide",
    "lap_swimming": "Swim", "open_water_swimming": "Swim", "swimming": "Swim",
    "walking": "Walk", "casual_walking": "Walk", "speed_walking": "Walk", "hiking": "Hike",
    "strength_training": "WeightTraining", "yoga": "Yoga", "pilates": "Pilates", "hiit": "HighIntensityIntervalTraining",
    "cardio": "Workout", "indoor_cardio": "Workout", "elliptical": "Elliptical", "stair_climbing": "StairStepper",
    "indoor_rowing": "Rowing", "rowing": "Rowing", "tennis": "Tennis", "padel": "Padel", "squash": "Squash",
    "badminton": "Badminton", "pickleball": "Pickleball", "table_tennis": "TableTennis",
}


def _act(a: dict) -> dict | None:
    """Eén Garmin-training, kort. 'time' = de timer van je horloge (wat het horloge zelf als tijd en tempo
    toont, en wat Strava als bewegingstijd overneemt), niet Garmins aparte 'bewegingstijd'."""
    start = str(a.get("startTimeLocal") or "").replace(" ", "T")[:19]
    if not a.get("activityId") or len(start) < 16:
        return None
    num = lambda k: a.get(k) if isinstance(a.get(k), (int, float)) else None   # noqa: E731
    typ = (a.get("activityType") or {}).get("typeKey") or ""
    return {"gid": a["activityId"], "start": start, "type": typ, "sport_type": GTYPE.get(typ, "Workout"),
            "name": a.get("activityName") or "", "km": round((num("distance") or 0) / 1000, 3),
            "time": round(num("duration") or num("movingDuration") or 0), "elapsed": round(num("elapsedDuration") or 0),
            "hr": num("averageHR"), "maxhr": num("maxHR"), "elev": num("elevationGain"),
            "cad": num("averageRunningCadenceInStepsPerMinute"), "watts": num("avgPower")}


def activities(days: int = ACT_DAYS, force: bool = False) -> list[dict]:
    """Je trainingen van de laatste `days` dagen zoals Garmin ze kent, nieuwste eerst. De laatste week wordt opnieuw
    gevraagd bij force (elke sync) of na FRESH; oudere trainingen veranderen niet meer. Garmin even weg: de bewaarde."""
    with _lock:
        ga = userdata.read_json(CACHE, {}).get("acts") or {}
        today = dt.date.today()
        first = today - dt.timedelta(days=days - 1)
        full = not ga.get("from") or ga["from"] > first.isoformat()
        span = first if full else (max(first, today - dt.timedelta(days=7))
                                   if force or time.time() - ga.get("at", 0) > FRESH else None)
        lst = ga.get("list") or {}
        if span:
            try:
                got = client().get_activities_by_date(span.isoformat(), today.isoformat()) or []
            except Exception:
                if not lst:
                    raise
                got = None
            if got is not None:
                # wat in die periode niet meer op Garmin staat (gewist), valt weg
                lst = {k: v for k, v in lst.items() if v["start"][:10] < span.isoformat()}
                for a in got:
                    x = _act(a)
                    if x:
                        lst[str(x["gid"])] = x
                lst = {k: v for k, v in lst.items() if v["start"][:10] >= first.isoformat()}
                cache = userdata.read_json(CACHE, {})
                cache["acts"] = {"from": first.isoformat() if full else ga["from"], "at": time.time(), "list": lst}
                userdata.write_json(CACHE, cache)
        return sorted(lst.values(), key=lambda v: v["start"], reverse=True)


def match(acts: list[dict], start_local: str, tol: int = 180) -> dict | None:
    """De Garmin-training die op hetzelfde moment begon (± tol s) als die van Strava, of None."""
    try:
        t0 = dt.datetime.fromisoformat(str(start_local)[:19])
    except ValueError:
        return None
    best = None
    for g in acts:
        try:
            d = abs((dt.datetime.fromisoformat(g["start"]) - t0).total_seconds())
        except (KeyError, ValueError):
            continue
        if d <= tol and (best is None or d < best[0]):
            best = (d, g)
    return best[1] if best else None


def activity_feel(start_local: str, secs: int | None = None) -> dict | None:
    """Gevoel + inspanning (RPE) die je na de activiteit op je horloge invulde.
    De Garmin-activiteit wordt gezocht op de starttijd (± 3 min)."""
    cache = userdata.read_json(CACHE, {})
    hit = cache.get("feel", {}).get(start_local)
    if hit is not None:
        return hit or None
    g = client()
    day_iso = start_local[:10]
    t0 = dt.datetime.fromisoformat(start_local.replace("Z", ""))
    found = {}
    for a in _try(g.get_activities_by_date, day_iso, day_iso) or []:
        try:
            ta = dt.datetime.fromisoformat(a["startTimeLocal"].replace(" ", "T"))
        except Exception:
            continue
        if abs((ta - t0).total_seconds()) <= 180:
            detail = _try(g.get_activity, str(a["activityId"])) or {}
            sm = detail.get("summaryDTO") or {}
            feel, rpe = sm.get("directWorkoutFeel"), sm.get("directWorkoutRpe")
            if feel is not None or rpe is not None:
                found = {"feel": FEEL.get(round((feel or 0) / 25) * 25) if feel is not None else None,
                         "rpe": round(rpe / 10) if rpe else None}
            break
    cache.setdefault("feel", {})[start_local] = found
    userdata.write_json(CACHE, cache)
    return found or None


# ---- voor de coaching ---------------------------------------------------------------
def _h(secs) -> str:
    return f"{secs // 3600}u{secs % 3600 // 60:02d}" if secs else "–"


def main() -> None:
    days = int(sys.argv[sys.argv.index("--days") + 1]) if "--days" in sys.argv else 7
    rec = recovery(days, force=True)
    print(f"{'datum':10}  {'slaap':>5} {'duur':>6}  {'HRV':>4} {'7d':>4} {'HRV-status':<11} {'klaar':>5} {'trainingsstatus':<15} {'VO2':>4} {'BB↑':>4} {'BB nu':>5} {'RHR':>4}")
    for d in rec["history"]:
        s, h, r, b = d.get("sleep") or {}, d.get("hrv") or {}, d.get("readiness") or {}, d.get("battery") or {}
        t = d.get("status") or {}
        print(f"{d['date']:10}  {s.get('score') or '–':>5} {_h(s.get('secs')):>6}  {h.get('night') or '–':>4} "
              f"{h.get('week') or '–':>4} {h.get('status') or '–':<11} {r.get('score') or '–':>5} "
              f"{t.get('label') or '–':<15} {t.get('vo2max') or '–':>4} "
              f"{b.get('high') or '–':>4} {b.get('now') or '–':>5} {d.get('rhr') or '–':>4}")


if __name__ == "__main__":
    main()


# ---- je profiel: geboortedatum, geslacht, lengte en gewicht (voor je lichaamsleeftijd) -------------
def profile(force: bool = False) -> dict:
    """{birth: 'JJJJ-MM-DD', sex: 'm'|'f', weightKg, heightCm} uit je Garmin-profiel; één keer per week gevraagd."""
    with _lock:
        cache = userdata.read_json(CACHE, {})
        p = cache.get("profile") or {}
        if p and not force and time.time() - p.get("at", 0) < 7 * 86400:
            return {k: v for k, v in p.items() if k != "at"}
    try:
        u = (client().get_user_profile() or {}).get("userData") or {}
    except Exception:
        return {k: v for k, v in p.items() if k != "at"}
    sex = {"MALE": "m", "FEMALE": "f"}.get(str(u.get("gender") or "").upper())
    new = {"birth": (u.get("birthDate") or "")[:10] or None, "sex": sex,
           "weightKg": round(u["weight"] / 1000, 1) if u.get("weight") else None,
           "heightCm": round(u["height"]) if u.get("height") else None}
    new = {k: v for k, v in new.items() if v}
    with _lock:
        cache = userdata.read_json(CACHE, {})
        cache["profile"] = {**new, "at": time.time()}
        userdata.write_json(CACHE, cache)
    return new


# ---- je vorm: wedstrijdvoorspelling, lactaatdrempel en hartslagzones per training ----------------------
def _cached(key: str, ttl: float, fetch, force: bool = False):
    """Waarde uit garmin.json (key), opnieuw gevraagd bij force of na ttl seconden. Garmin even weg: de bewaarde."""
    with _lock:
        c = userdata.read_json(CACHE, {}).get(key) or {}
    if force or time.time() - c.get("at", 0) > ttl:
        try:
            c = {"at": time.time(), "v": fetch()}
            with _lock:
                cache = userdata.read_json(CACHE, {})
                cache[key] = c
                userdata.write_json(CACHE, cache)
        except Exception:
            if "v" not in c:
                raise
    return c.get("v")


def race_predictions(force: bool = False) -> dict:
    """Garmin's voorspelling voor 5 km, 10 km, halve en hele marathon (seconden): nu en 4 weken geleden."""
    def fetch():
        end = dt.date.today()
        rows = client().get_race_predictions((end - dt.timedelta(days=35)).isoformat(), end.isoformat(), "daily") or []
        rows = [r for r in rows if r.get("timeMarathon")]
        if not rows:
            return {}
        pick = lambda r: {"date": r.get("calendarDate"), "5k": r.get("time5K"), "10k": r.get("time10K"),
                          "half": r.get("timeHalfMarathon"), "marathon": r.get("timeMarathon")}
        before = (end - dt.timedelta(days=28)).isoformat()
        old = [r for r in rows if r.get("calendarDate", "") <= before]
        return {"now": pick(rows[-1]), "before": pick(old[-1]) if old else None}
    return _cached("race", 6 * 3600, fetch, force)


def threshold(force: bool = False) -> dict:
    """Je lactaatdrempel (hartslag en tempo) volgens je horloge. Garmin geeft de snelheid in 10 m/s."""
    def fetch():
        r = (client().get_lactate_threshold(latest=True) or {}).get("speed_and_heart_rate") or {}
        sp = r.get("speed")
        return {"hr": r.get("heartRate"), "pace": round(100 / sp) if sp else None, "date": str(r.get("calendarDate") or "")[:10]}
    return _cached("lt", 24 * 3600, fetch, force)


def hr_zones(start_local: str) -> dict | None:
    """Hoeveel tijd je in elke hartslagzone liep (zones van je Garmin), voor de training die toen begon."""
    g = match(activities(), start_local)
    if not g:
        return None
    key = str(g["gid"])
    with _lock:
        zc = userdata.read_json(CACHE, {}).get("zones") or {}
    if key not in zc:
        z = client().get_activity_hr_in_timezones(g["gid"]) or []
        zs = [{"n": x.get("zoneNumber"), "secs": round(x.get("secsInZone") or 0), "from": x.get("zoneLowBoundary")}
              for x in z if x.get("zoneNumber")]
        if not zs:
            return None
        with _lock:
            cache = userdata.read_json(CACHE, {})
            zc = cache.get("zones") or {}
            zc[key] = zs
            cache["zones"] = dict(list(zc.items())[-300:])       # de laatste 300 trainingen bewaren
            userdata.write_json(CACHE, cache)
    return {"zones": zc[key], "lt": (threshold() or {}).get("hr")}

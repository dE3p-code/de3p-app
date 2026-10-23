"""
Whoop, Oura, Polar, Withings en intervals.icu in dE3p: slaap, HRV, rusthartslag, herstel,
stappen en (Withings, intervals.icu) gewicht voor het tabblad Gezondheid, in dezelfde vorm
als garmin.day().

Whoop, Oura, Polar en Withings: elke gebruiker maakt bij die dienst een eigen app (zoals de
Strava-sleutel) met als redirect-URL http://localhost:8721/callback. intervals.icu: je
atleet-ID en API-sleutel uit je instellingen daar (geen app nodig). Sleutels en tokens
blijven op deze computer (gegevensmap/koppelingen).

  python wearables.py whoop --days 7     # voor de coaching / om te testen
"""
from __future__ import annotations

import datetime as dt
import sys
import threading
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import userdata  # noqa: E402

DIR = userdata.DATA / "koppelingen"
REDIRECT = "http://localhost:8721/callback"
FRESH = 30 * 60
ORDER = ("whoop", "oura", "polar", "withings", "intervals")

PROVIDERS = {
    "whoop": {
        "name": "Whoop",
        "authorize": "https://api.prod.whoop.com/oauth/oauth2/auth",
        "token": "https://api.prod.whoop.com/oauth/oauth2/token",
        "scope": "offline read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement",
        "portal": "https://developer-dashboard.whoop.com/",
    },
    "oura": {
        "name": "Oura",
        "authorize": "https://cloud.ouraring.com/oauth/authorize",
        "token": "https://api.ouraring.com/oauth/token",
        "scope": "personal daily heartrate",
        "portal": "https://cloud.ouraring.com/oauth/applications",
    },
    "polar": {
        "name": "Polar",
        "authorize": "https://flow.polar.com/oauth2/authorization",
        "token": "https://polarremote.com/v2/oauth2/token",
        "scope": "accesslink.read_all",
        "portal": "https://admin.polaraccesslink.com/",
    },
    "withings": {
        "name": "Withings",
        "authorize": "https://account.withings.com/oauth2_user/authorize2",
        "token": "https://wbsapi.withings.net/v2/oauth2",
        "scope": "user.info,user.metrics,user.activity",
        "portal": "https://developer.withings.com/dashboard/",
    },
    # geen app nodig: je atleet-ID en API-sleutel (intervals.icu → Settings → Developer Settings)
    "intervals": {
        "name": "intervals.icu",
        "key": True,
        "portal": "https://intervals.icu/settings",
    },
}
WHOOP_API = "https://api.prod.whoop.com/developer/v2"
OURA_API = "https://api.ouraring.com/v2/usercollection"
POLAR_API = "https://www.polaraccesslink.com/v3"
WITHINGS_API = "https://wbsapi.withings.net"
INTERVALS_API = "https://intervals.icu/api/v1"

_lock = threading.Lock()


# ---- sleutels ---------------------------------------------------------------------------
def _file(k: str) -> Path:
    return DIR / f"{k}.json"


def _cache(k: str) -> Path:
    return userdata.DATA / f"{k}.json"


def connected(k: str) -> bool:
    return bool(userdata.read_json(_file(k), {}).get("access_token"))


def active() -> list[str]:
    return [k for k in ORDER if connected(k)]


def authorize_url(k: str, client_id: str, state: str) -> str:
    from urllib.parse import urlencode
    p = PROVIDERS[k]
    q = {"response_type": "code", "client_id": client_id, "redirect_uri": REDIRECT, "state": state}
    if k != "polar":
        q["scope"] = p["scope"]
    return p["authorize"] + "?" + urlencode(q)


def finish(k: str, client_id: str, client_secret: str, code: str) -> None:
    """Code omwisselen voor tokens en bewaren."""
    p = PROVIDERS[k]
    if k == "polar":
        r = requests.post(p["token"], auth=(client_id, client_secret), timeout=30,
                          headers={"Accept": "application/json"},
                          data={"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT})
    elif k == "withings":
        r = requests.post(p["token"], timeout=30, data={
            "action": "requesttoken", "grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT,
            "client_id": client_id, "client_secret": client_secret})
    else:
        r = requests.post(p["token"], timeout=30, data={
            "grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT,
            "client_id": client_id, "client_secret": client_secret})
    if r.status_code in (400, 401, 403):
        raise RuntimeError(f"{p['name']} weigert de sleutel: controleer je Client ID, Client Secret en de redirect-URL.")
    r.raise_for_status()
    j = r.json()
    if k == "withings":                                   # Withings: altijd 200, de fout zit in 'status'
        if j.get("status") != 0:
            raise RuntimeError("Withings weigert de sleutel: controleer je Client ID, Client Secret en de redirect-URL.")
        j = j.get("body") or {}
    tok = {"client_id": client_id, "client_secret": client_secret, "access_token": j["access_token"],
           "refresh_token": j.get("refresh_token"), "expires_at": time.time() + int(j.get("expires_in") or 3600 * 24 * 365)}
    if k == "polar":
        tok["user_id"] = j.get("x_user_id")
        # Polar: gebruiker eenmalig registreren bij AccessLink (409 = al geregistreerd)
        reg = requests.post(f"{POLAR_API}/users", json={"member-id": f"de3p-{j.get('x_user_id')}"}, timeout=30,
                            headers={"Authorization": f"Bearer {j['access_token']}", "Accept": "application/json"})
        if reg.status_code not in (200, 201, 409):
            reg.raise_for_status()
    DIR.mkdir(parents=True, exist_ok=True)
    userdata.write_json(_file(k), tok)
    _cache(k).unlink(missing_ok=True)


def connect_key(k: str, athlete_id: str, api_key: str) -> None:
    """intervals.icu: atleet-ID + API-sleutel nakijken en bewaren (Basic-auth met gebruiker 'API_KEY')."""
    aid = athlete_id.strip()
    if aid.isdigit():
        aid = f"i{aid}"                                   # intervals.icu toont 'i123456'
    r = requests.get(f"{INTERVALS_API}/athlete/{aid}", auth=("API_KEY", api_key.strip()), timeout=30)
    if r.status_code in (401, 403, 404):
        raise RuntimeError("intervals.icu kent die combinatie niet: controleer je atleet-ID (bv. i123456) en API-sleutel.")
    r.raise_for_status()
    DIR.mkdir(parents=True, exist_ok=True)
    userdata.write_json(_file(k), {"athlete_id": aid, "access_token": api_key.strip()})
    _cache(k).unlink(missing_ok=True)


def disconnect(k: str) -> None:
    _file(k).unlink(missing_ok=True)
    _cache(k).unlink(missing_ok=True)


def _token(k: str) -> str:
    tok = userdata.read_json(_file(k), {})
    if not tok.get("access_token"):
        raise RuntimeError(f"{PROVIDERS[k]['name']} is niet gekoppeld.")
    if tok.get("refresh_token") and time.time() > tok.get("expires_at", 0) - 120:
        data = {"grant_type": "refresh_token", "refresh_token": tok["refresh_token"],
                "client_id": tok["client_id"], "client_secret": tok["client_secret"]}
        if k == "whoop":
            data["scope"] = "offline"
        if k == "withings":
            data["action"] = "requesttoken"
        r = requests.post(PROVIDERS[k]["token"], data=data, timeout=30)
        if r.status_code in (400, 401):
            raise RuntimeError(f"{PROVIDERS[k]['name']} vraagt om opnieuw te koppelen (Instellingen).")
        r.raise_for_status()
        j = r.json()
        if k == "withings":
            if j.get("status") != 0:
                raise RuntimeError("Withings vraagt om opnieuw te koppelen (Instellingen).")
            j = j.get("body") or {}
        tok.update(access_token=j["access_token"], refresh_token=j.get("refresh_token") or tok["refresh_token"],
                   expires_at=time.time() + int(j.get("expires_in") or 3600))
        userdata.write_json(_file(k), tok)
    return tok["access_token"]


def _get(k: str, url: str, params: dict | None = None):
    r = requests.get(url, params=params, timeout=30,
                     headers={"Authorization": f"Bearer {_token(k)}", "Accept": "application/json"})
    if r.status_code in (204, 404):
        return None
    if r.status_code == 401:
        raise RuntimeError(f"{PROVIDERS[k]['name']} vraagt om opnieuw te koppelen (Instellingen).")
    r.raise_for_status()
    return r.json()


# ---- gegevens per dienst → dagen in de vorm van garmin.day() ----------------------------
def _local_date(ts: str | None, offset: str | None = None) -> str | None:
    """'2026-10-03T05:41:00.000Z' + '+02:00' → '2026-10-03' (lokale datum)."""
    if not ts:
        return None
    t = dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    if offset and t.tzinfo is not None:
        sign = -1 if offset.startswith("-") else 1
        hh, mm = (offset.lstrip("+-").split(":") + ["0"])[:2]
        t = t.astimezone(dt.timezone(sign * dt.timedelta(hours=int(hh), minutes=int(mm))))
    return t.date().isoformat()


def _whoop_all(path: str, a: dt.date, b: dt.date) -> list[dict]:
    out, nxt = [], None
    params = {"start": f"{a.isoformat()}T00:00:00.000Z", "end": f"{(b + dt.timedelta(days=1)).isoformat()}T00:00:00.000Z", "limit": 25}
    for _ in range(80):
        if nxt:
            params["nextToken"] = nxt
        j = _get("whoop", WHOOP_API + path, params) or {}
        out += j.get("records") or []
        nxt = j.get("next_token")
        if not nxt:
            break
    return out


def _level(score):
    if score is None:
        return ""
    return "Hoog" if score >= 67 else "Gemiddeld" if score >= 34 else "Laag"


def fetch_whoop(a: dt.date, b: dt.date) -> dict:
    days: dict = {}
    sleep_day = {}
    for s in _whoop_all("/activity/sleep", a, b):
        if s.get("nap"):
            continue
        d = _local_date(s.get("end"), s.get("timezone_offset"))
        sc = s.get("score") or {}
        st = sc.get("stage_summary") or {}
        ms = lambda key: round((st.get(key) or 0) / 1000)  # noqa: E731
        secs = ms("total_light_sleep_time_milli") + ms("total_slow_wave_sleep_time_milli") + ms("total_rem_sleep_time_milli")
        if not d or not secs:
            continue
        sleep_day[s.get("id")] = d
        days.setdefault(d, {"date": d})["sleep"] = {
            "score": round(sc["sleep_performance_percentage"]) if sc.get("sleep_performance_percentage") is not None else None,
            "secs": secs, "deep": ms("total_slow_wave_sleep_time_milli"), "light": ms("total_light_sleep_time_milli"),
            "rem": ms("total_rem_sleep_time_milli"), "awake": ms("total_awake_time_milli"), "resp": sc.get("respiratory_rate")}
    for r in _whoop_all("/recovery", a, b):
        sc = r.get("score") or {}
        d = sleep_day.get(r.get("sleep_id")) or _local_date(r.get("created_at"))
        if not d or not sc:
            continue
        day = days.setdefault(d, {"date": d})
        if sc.get("resting_heart_rate") is not None:
            day["rhr"] = round(sc["resting_heart_rate"])
        if sc.get("hrv_rmssd_milli") is not None:
            day["hrv"] = {"night": round(sc["hrv_rmssd_milli"]), "week": None, "status": ""}
        if sc.get("recovery_score") is not None:
            day["readiness"] = {"score": round(sc["recovery_score"]), "level": _level(sc["recovery_score"]), "recovery_h": None}
    for c in _whoop_all("/cycle", a, b):
        sc = c.get("score") or {}
        d = _local_date(c.get("start"), c.get("timezone_offset"))
        if d and sc.get("kilojoule"):
            days.setdefault(d, {"date": d})["kcal"] = {"total": round(sc["kilojoule"] / 4.184), "active": None}
    return days


def _oura_all(name: str, a: dt.date, b: dt.date) -> list[dict]:
    out, nxt = [], None
    params = {"start_date": a.isoformat(), "end_date": b.isoformat()}
    for _ in range(40):
        if nxt:
            params["next_token"] = nxt
        j = _get("oura", f"{OURA_API}/{name}", params) or {}
        out += j.get("data") or []
        nxt = j.get("next_token")
        if not nxt:
            break
    return out


def fetch_oura(a: dt.date, b: dt.date) -> dict:
    days: dict = {}
    day = lambda d: days.setdefault(d, {"date": d})  # noqa: E731
    longest: dict = {}
    for s in _oura_all("sleep", a, b):
        d = s.get("day")
        if d and (s.get("total_sleep_duration") or 0) > (longest.get(d, {}).get("total_sleep_duration") or 0):
            longest[d] = s
    for d, s in longest.items():
        day(d)["sleep"] = {"score": None, "secs": s.get("total_sleep_duration"), "deep": s.get("deep_sleep_duration"),
                           "light": s.get("light_sleep_duration"), "rem": s.get("rem_sleep_duration"),
                           "awake": s.get("awake_time"), "resp": s.get("average_breath")}
        if s.get("average_hrv"):
            day(d)["hrv"] = {"night": round(s["average_hrv"]), "week": None, "status": ""}
        if s.get("lowest_heart_rate"):
            day(d)["rhr"] = round(s["lowest_heart_rate"])
    for s in _oura_all("daily_sleep", a, b):
        if s.get("day") and s.get("score") is not None:
            day(s["day"]).setdefault("sleep", {"secs": None})["score"] = s["score"]
    for s in _oura_all("daily_readiness", a, b):
        if s.get("day") and s.get("score") is not None:
            day(s["day"])["readiness"] = {"score": s["score"], "level": _level(s["score"]), "recovery_h": None}
    for s in _oura_all("daily_activity", a, b):
        d = s.get("day")
        if not d:
            continue
        if s.get("steps"):
            day(d)["steps"] = {"n": s["steps"], "goal": None, "km": round((s.get("equivalent_walking_distance") or 0) / 1000, 1)}
        day(d)["kcal"] = {"total": s.get("total_calories"), "active": s.get("active_calories")}
        day(d)["intensity"] = round(((s.get("medium_activity_time") or 0) + 2 * (s.get("high_activity_time") or 0)) / 60)
    for s in _oura_all("vO2_max", a, b):
        if s.get("day") and s.get("vo2_max"):
            day(s["day"])["status"] = {"label": None, "vo2max": round(s["vo2_max"]), "load": None, "ratio": None}
    return days


def fetch_polar(a: dt.date, b: dt.date) -> dict:
    """Polar bewaart slaap en Nightly Recharge 28 dagen voor andere apps."""
    days: dict = {}
    for n in (_get("polar", f"{POLAR_API}/users/sleep") or {}).get("nights") or []:
        d = n.get("date")
        secs = (n.get("light_sleep") or 0) + (n.get("deep_sleep") or 0) + (n.get("rem_sleep") or 0)
        if d and secs:
            days.setdefault(d, {"date": d})["sleep"] = {
                "score": n.get("sleep_score"), "secs": secs, "deep": n.get("deep_sleep"), "light": n.get("light_sleep"),
                "rem": n.get("rem_sleep"), "awake": n.get("total_interruption_duration"), "resp": None}
    for n in (_get("polar", f"{POLAR_API}/users/nightly-recharge") or {}).get("recharges") or []:
        d = n.get("date")
        if not d:
            continue
        if n.get("heart_rate_variability_avg"):
            days.setdefault(d, {"date": d})["hrv"] = {"night": round(n["heart_rate_variability_avg"]), "week": None, "status": ""}
        if n.get("heart_rate_avg"):
            days.setdefault(d, {"date": d})["rhr"] = round(n["heart_rate_avg"])
    return {d: v for d, v in days.items() if a.isoformat() <= d <= b.isoformat()}


def _withings(path: str, data: dict) -> dict:
    """Withings: alles is POST, antwoord {status, body}; status 0 = goed."""
    r = requests.post(f"{WITHINGS_API}/{path}", data=data, timeout=30, headers={"Authorization": f"Bearer {_token('withings')}"})
    r.raise_for_status()
    j = r.json()
    if j.get("status") in (100, 101, 102, 200, 401):
        raise RuntimeError("Withings vraagt om opnieuw te koppelen (Instellingen).")
    if j.get("status") != 0:
        raise RuntimeError(f"Withings gaf fout {j.get('status')}.")
    return j.get("body") or {}


def _withings_all(path: str, data: dict, key: str) -> list[dict]:
    out, offset = [], None
    for _ in range(40):
        body = _withings(path, {**data, **({"offset": offset} if offset else {})})
        out += body.get(key) or []
        if not body.get("more"):
            break
        offset = body.get("offset")
    return out


def fetch_withings(a: dt.date, b: dt.date) -> dict:
    days: dict = {}
    day = lambda d: days.setdefault(d, {"date": d})  # noqa: E731
    ymd = {"startdateymd": a.isoformat(), "enddateymd": b.isoformat()}
    longest: dict = {}                                   # per nacht de langste slaap (geen dutjes)
    for s in _withings_all("v2/sleep", {"action": "getsummary", **ymd, "data_fields": (
            "sleep_score,total_sleep_time,asleepduration,deepsleepduration,lightsleepduration,"
            "remsleepduration,wakeupduration,hr_min,rr_average")}, "series"):
        d, v = s.get("date"), s.get("data") or {}
        secs = v.get("total_sleep_time") or v.get("asleepduration") or 0
        if d and secs > ((longest.get(d) or {}).get("secs") or 0):
            longest[d] = {"secs": secs, "v": v}
    for d, x in longest.items():
        v = x["v"]
        day(d)["sleep"] = {"score": v.get("sleep_score"), "secs": x["secs"], "deep": v.get("deepsleepduration"),
                           "light": v.get("lightsleepduration"), "rem": v.get("remsleepduration"),
                           "awake": v.get("wakeupduration"), "resp": v.get("rr_average")}
        if v.get("hr_min"):
            day(d)["rhr"] = round(v["hr_min"])
    for x in _withings_all("v2/measure", {"action": "getactivity", **ymd,
                                          "data_fields": "steps,distance,moderate,intense,totalcalories,calories"}, "activities"):
        d = x.get("date")
        if not d:
            continue
        if x.get("steps"):
            day(d)["steps"] = {"n": x["steps"], "goal": None, "km": round((x.get("distance") or 0) / 1000, 1)}
        if x.get("totalcalories"):
            day(d)["kcal"] = {"total": round(x["totalcalories"]), "active": round(x.get("calories") or 0)}
        day(d)["intensity"] = round(((x.get("moderate") or 0) + 2 * (x.get("intense") or 0)) / 60)
    # gewicht en vetpercentage: per dag de laatste meting (types 1 = gewicht, 6 = vet %)
    start = int(dt.datetime.combine(a, dt.time()).timestamp())
    end = int(dt.datetime.combine(b + dt.timedelta(days=1), dt.time()).timestamp())
    for g in sorted(_withings_all("measure", {"action": "getmeas", "meastypes": "1,6", "category": 1,
                                             "startdate": start, "enddate": end}, "measuregrps"), key=lambda g: g.get("date") or 0):
        d = dt.datetime.fromtimestamp(g.get("date") or 0).date().isoformat()
        for m in g.get("measures") or []:
            val = round(m["value"] * 10 ** m["unit"], 1)
            if m.get("type") == 1:
                day(d).setdefault("weight", {})["kg"] = val
            elif m.get("type") == 6:
                day(d).setdefault("weight", {})["fat"] = val
    return {d: v for d, v in days.items() if a.isoformat() <= d <= b.isoformat()}


def fetch_intervals(a: dt.date, b: dt.date) -> dict:
    """intervals.icu wellness: wat je horloge of ring daar binnenbrengt (Garmin, Coros, Suunto, Oura, ...),
    plus je fitheid (CTL) en vorm (CTL - ATL) uit je trainingen."""
    tok = userdata.read_json(_file("intervals"), {})
    if not tok.get("access_token"):
        raise RuntimeError("intervals.icu is niet gekoppeld.")
    r = requests.get(f"{INTERVALS_API}/athlete/{tok['athlete_id']}/wellness", timeout=30, auth=("API_KEY", tok["access_token"]),
                     params={"oldest": a.isoformat(), "newest": b.isoformat()})
    if r.status_code in (401, 403):
        raise RuntimeError("intervals.icu vraagt om opnieuw te koppelen (Instellingen).")
    r.raise_for_status()
    days: dict = {}
    for w in r.json() or []:
        d = w.get("id")
        if not d:
            continue
        x = {"date": d}
        if w.get("sleepSecs"):
            x["sleep"] = {"score": w.get("sleepScore"), "secs": w["sleepSecs"], "deep": None, "light": None, "rem": None,
                          "awake": None, "resp": w.get("respiration")}
        if w.get("hrv"):
            x["hrv"] = {"night": round(w["hrv"]), "week": None, "status": ""}
        if w.get("restingHR"):
            x["rhr"] = round(w["restingHR"])
        if w.get("steps"):
            x["steps"] = {"n": w["steps"], "goal": None, "km": None}
        if w.get("readiness") is not None:
            x["readiness"] = {"score": round(w["readiness"]), "level": _level(w["readiness"]), "recovery_h": None}
        ctl, atl = w.get("ctl"), w.get("atl")
        if w.get("vo2max") or ctl is not None:
            load = f"fitheid {round(ctl)} · vorm {round(ctl - atl):+d}" if ctl is not None and atl is not None else None
            x["status"] = {"label": None, "vo2max": round(w["vo2max"], 1) if w.get("vo2max") else None, "load": load, "ratio": None}
        if w.get("weight"):
            x["weight"] = {"kg": round(w["weight"], 1), **({"fat": round(w["bodyFat"], 1)} if w.get("bodyFat") else {})}
        if len(x) > 1:
            days[d] = x
    return days


FETCH = {"whoop": fetch_whoop, "oura": fetch_oura, "polar": fetch_polar, "withings": fetch_withings, "intervals": fetch_intervals}
WEIGHT = ("withings", "intervals")                       # diensten die ook je gewicht kennen


def _week_avg(days: dict) -> None:
    """HRV: ook het 7-daags gemiddelde, zoals bij Garmin."""
    ds = sorted(days)
    for i, d in enumerate(ds):
        h = days[d].get("hrv")
        if not h:
            continue
        vals = [days[x]["hrv"]["night"] for x in ds[max(0, i - 6):i + 1] if days[x].get("hrv")]
        h["week"] = round(sum(vals) / len(vals)) if vals else None


# ---- zelfde uitgang als garmin.recovery() en garmin.months() ---------------------------
def _ensure(k: str, first: dt.date, force: bool = False) -> dict:
    with _lock:
        cache = userdata.read_json(_cache(k), {})
        today = dt.date.today()
        days = cache.get("days") or {}
        if not cache.get("from") or cache["from"] > first.isoformat():
            span = (first, today)
        elif force or time.time() - cache.get("at", 0) > FRESH:
            span = (max(first, today - dt.timedelta(days=3)), today)
        else:
            span = None
        if span:
            new = FETCH[k](*span)
            for d, v in new.items():
                days[d] = v
            _week_avg(days)
            cache = {"from": min(first.isoformat(), cache.get("from") or first.isoformat()), "at": time.time(),
                     "days": {d: days[d] for d in sorted(days)[-400:]}}
            userdata.write_json(_cache(k), cache)
        return cache


def recovery(k: str, days: int = 7, force: bool = False) -> dict:
    today = dt.date.today()
    cache = _ensure(k, today - dt.timedelta(days=max(days, 7) - 1), force)
    need = [(today - dt.timedelta(days=i)).isoformat() for i in range(days)]
    all_days = cache.get("days") or {}
    return {"today": all_days.get(today.isoformat(), {"date": today.isoformat()}),
            "history": [all_days[d] for d in sorted(need) if d in all_days], "source": k}


def add_weight(rec: dict, src: str | None, days: int) -> dict:
    """Je gewicht van Withings of intervals.icu ook tonen als Gezondheid een andere bron gebruikt (bv. Garmin)."""
    for k in WEIGHT:
        if k == src or not connected(k) or not isinstance(rec, dict) or rec.get("error"):
            continue
        try:
            got = _ensure(k, dt.date.today() - dt.timedelta(days=max(days, 7) - 1)).get("days") or {}
        except Exception:
            continue
        for d in [rec.get("today") or {}, *(rec.get("history") or [])]:
            w = (got.get(d.get("date")) or {}).get("weight")
            if w and not d.get("weight"):
                d["weight"] = w
        break
    return rec


def months(k: str, force: bool = False) -> dict:
    import garmin
    first = garmin._month_start(garmin.MONTHS)
    today = dt.date.today()
    cache = _ensure(k, first, force)
    flat, weeks = {}, {}
    for d, v in (cache.get("days") or {}).items():
        f = {"score": (v.get("sleep") or {}).get("score"), "secs": (v.get("sleep") or {}).get("secs"), "rhr": v.get("rhr"),
             "hrv": (v.get("hrv") or {}).get("night"), "vo2": (v.get("status") or {}).get("vo2max"),
             "steps": (v.get("steps") or {}).get("n"), "ready": (v.get("readiness") or {}).get("score")}
        flat[d] = {x: y for x, y in f.items() if y is not None}
        if v.get("intensity") is not None:
            mon = (dt.date.fromisoformat(d) - dt.timedelta(days=dt.date.fromisoformat(d).weekday())).isoformat()
            w = weeks.setdefault(mon, {"im": 0, "imgoal": 150})
            w["im"] += v["intensity"]
    return {"months": garmin._aggregate({"days": flat, "weeks": weeks}, first, today), "today": today.isoformat(), "source": k}


def main() -> None:
    k = sys.argv[1] if len(sys.argv) > 1 else "whoop"
    days = int(sys.argv[sys.argv.index("--days") + 1]) if "--days" in sys.argv else 7
    for d in recovery(k, days, force=True)["history"]:
        s, h, r = d.get("sleep") or {}, d.get("hrv") or {}, d.get("readiness") or {}
        print(d["date"], s.get("score"), s.get("secs"), h.get("night"), d.get("rhr"), r.get("score"), (d.get("steps") or {}).get("n"),
              (d.get("weight") or {}).get("kg"))


if __name__ == "__main__":
    main()

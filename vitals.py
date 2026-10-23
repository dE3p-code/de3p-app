"""Bloedsuiker, bloeddruk, taille en zweetverlies: wat je zelf invult (metingen.json in je gegevensmap) en je bloeddruk uit Garmin
Connect (Index BPM of zelf ingevuld). Op de iPhone-app komt Apple Gezondheid erbij (web/health.js).

De categorieën zijn algemene grenzen (ESC voor bloeddruk, de gangbare grenzen voor bloedsuiker in mg/dL),
geen diagnose: wie twijfelt of hoge waarden heeft, bespreekt dat met de huisarts.
"""
from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import userdata  # noqa: E402

FILE = userdata.DATA / "metingen.json"
CTX = {"nuchter": "nuchter", "voor": "voor het eten", "na": "na het eten (2 u)", "los": "willekeurig"}
KEEP = 2000                          # zoveel metingen per soort blijven bewaard
MMOL = 18.016                        # 1 mmol/L bloedsuiker = 18 mg/dL


def _now() -> str:
    return dt.datetime.now().isoformat(timespec="minutes")


def tracking() -> dict:
    """Wat je volgt (Instellingen → Bloedsuiker & bloeddruk). Pas dan staat het op het Overzicht."""
    v = userdata.load().get("vitals") or {}
    return {"glucose": bool(v.get("glucose")), "bp": bool(v.get("bp"))}


def set_tracking(kind: str, on: bool) -> dict:
    if kind not in ("glucose", "bp"):
        raise RuntimeError("Onbekende meting.")
    v = {**tracking(), kind: bool(on)}
    userdata.update(vitals=v)
    return v


def _own() -> dict:
    return userdata.read_json(FILE, {})


def glucose_list() -> list[dict]:
    return sorted(_own().get("glucose") or [], key=lambda x: x["at"])


def bp_list() -> list[dict]:
    out = list(_own().get("bp") or [])
    try:
        import garmin
        if garmin.connected():
            out += garmin.blood_pressure()
    except Exception:
        pass
    return sorted(out, key=lambda x: x["at"])


def _at(at: str | None) -> str:
    return at[:16] if at and len(at) >= 16 else _now()          # lokale tijd, op de minuut


def add_glucose(mgdl, ctx: str = "los", at: str | None = None) -> dict:
    try:
        x = float(str(mgdl).replace(",", "."))
    except ValueError:
        raise RuntimeError("Vul je bloedsuiker in als getal in mg/dL, bv. 92.") from None
    v = round(x * MMOL if 1 <= x < 35 else x)      # 5,4 is mmol/L (zoals in Nederland): omrekenen naar mg/dL
    if not 20 <= v <= 600:
        raise RuntimeError("Dat lijkt geen bloedsuiker in mg/dL (normaal tussen 70 en 140). Kijk het nog eens na.")
    own = _own()
    own["glucose"] = (own.get("glucose") or []) + [{"at": _at(at), "mgdl": v, "ctx": ctx if ctx in CTX else "los", "src": "zelf ingevuld"}]
    own["glucose"] = own["glucose"][-KEEP:]
    userdata.write_json(FILE, own)
    return status()


def add_bp(sys_, dia, pulse=None, at: str | None = None) -> dict:
    try:
        s, d = round(float(sys_)), round(float(dia))
        p = round(float(pulse)) if pulse not in (None, "") else None
    except ValueError:
        raise RuntimeError("Vul je bloeddruk in als getallen, bv. 122 en 78.") from None
    if not (70 <= s <= 260 and 40 <= d <= 160 and s > d) or (p is not None and not 30 <= p <= 220):
        raise RuntimeError("Die bloeddruk klopt niet (bovendruk is het hoogste getal, bv. 122/78). Kijk het nog eens na.")
    own = _own()
    own["bp"] = ((own.get("bp") or []) + [{"at": _at(at), "sys": s, "dia": d, "pulse": p, "src": "zelf ingevuld"}])[-KEEP:]
    userdata.write_json(FILE, own)
    return status()


def glucose_cat(v: float, ctx: str = "los") -> tuple[str, str]:
    """(woord, niveau good/mid/bad) volgens de gangbare grenzen in mg/dL."""
    if v < 70:
        return "laag", "bad"
    if ctx == "nuchter" or ctx == "voor":
        return ("normaal", "good") if v < 100 else ("verhoogd", "mid") if v < 126 else ("hoog", "bad")
    return ("normaal", "good") if v < 140 else ("verhoogd", "mid") if v < 200 else ("hoog", "bad")


def bp_cat(s: float, d: float) -> tuple[str, str]:
    """(woord, niveau) volgens de ESC-indeling: optimaal < 120/80, normaal < 130/85, hoog-normaal < 140/90, hoog."""
    if s >= 140 or d >= 90:
        return "hoog", "bad"
    if s >= 130 or d >= 85:
        return "hoog-normaal", "mid"
    if s >= 120 or d >= 80:
        return "normaal", "good"
    return "optimaal", "good"


def status() -> dict:
    """Wat je volgt en je laatste metingen, met hun categorie (voor Instellingen en de gsm)."""
    g, b = glucose_list(), bp_list()
    lg = {**g[-1], **dict(zip(("cat", "lvl"), glucose_cat(g[-1]["mgdl"], g[-1].get("ctx", "los"))))} if g else None
    lb = {**b[-1], **dict(zip(("cat", "lvl"), bp_cat(b[-1]["sys"], b[-1]["dia"])))} if b else None
    own = _own()
    w = sorted(own.get("waist") or [], key=lambda x: x["at"])
    sw = sorted(own.get("sweat") or [], key=lambda x: x["start"])
    return {"track": tracking(), "glucose": {"last": lg, "n": len(g)}, "bp": {"last": lb, "n": len(b)},
            "garmin": _garmin_on(), "ctx": CTX, "waist": {"last": w[-1] if w else None, "n": len(w)},
            "sweat": sw[-30:], "sweatAvg": round(sum(x["rate"] for x in sw[-5:]) / len(sw[-5:]), 2) if sw else None}


def _garmin_on() -> bool:
    try:
        import garmin
        return garmin.connected()
    except Exception:
        return False


def with_vitals(rec: dict) -> dict:
    """Bloedsuiker en bloeddruk per dag in de dagen van Gezondheid: gemiddelde en laatste meting van die dag."""
    if not isinstance(rec, dict) or rec.get("error"):
        return rec
    glu: dict = {}
    for x in glucose_list():
        glu.setdefault(x["at"][:10], []).append(x)
    bp: dict = {}
    for x in bp_list():
        bp.setdefault(x["at"][:10], []).append(x)
    for d in [rec.get("today") or {}, *(rec.get("history") or [])]:
        day = d.get("date")
        if day in glu and not d.get("glucose"):
            xs = glu[day]
            d["glucose"] = {"avg": round(sum(x["mgdl"] for x in xs) / len(xs)), "last": xs[-1]["mgdl"],
                            "ctx": xs[-1].get("ctx", "los"), "n": len(xs), "at": xs[-1]["at"][11:16]}
        if day in bp and not d.get("bp"):
            x = bp[day][-1]
            d["bp"] = {"sys": x["sys"], "dia": x["dia"], "pulse": x.get("pulse"), "n": len(bp[day]), "at": x["at"][11:16],
                       "src": x.get("src")}
    return rec


# ---- taille (buikomtrek) en zweetverlies ------------------------------------------------------------------
def add_waist(cm, at: str | None = None) -> dict:
    """Je taille in cm (meetlint, ter hoogte van je navel). Taille gedeeld door lengte: best onder 0,5."""
    try:
        v = round(float(str(cm).replace(",", ".")), 1)
    except ValueError:
        raise RuntimeError("Vul je taille in centimeter in, bv. 78.") from None
    if not 40 <= v <= 200:
        raise RuntimeError("Vul je taille in centimeter in, bv. 78.")
    own = _own()
    own["waist"] = ((own.get("waist") or []) + [{"at": _at(at), "cm": v}])[-KEEP:]
    userdata.write_json(FILE, own)
    return status()


def add_sweat(start: str, before, after, drank=0, secs=0) -> dict:
    """Zweetverlies van één training: gewogen voor en na (kg), gedronken onderweg (ml), duur (s).
    Zweet per uur = (voor − na + gedronken) / uren; verlies in % van je gewicht (onder 2 % is goed)."""
    try:
        b, a = float(str(before).replace(",", ".")), float(str(after).replace(",", "."))
        ml = float(str(drank or 0).replace(",", ".")) if str(drank or "").strip() else 0.0
        hours = float(secs) / 3600
    except ValueError:
        raise RuntimeError("Vul je gewicht voor en na in kg in, bv. 63,2 en 62,1.") from None
    if not (25 <= b <= 300 and 25 <= a <= 300 and a <= b + 1 and 0 <= ml <= 5000):
        raise RuntimeError("Dat klopt niet: je gewicht na de training is meestal lager dan ervoor. Kijk het nog eens na.")
    if hours < 0.25:
        raise RuntimeError("Zweetverlies meten heeft pas zin vanaf een training van een kwartier.")
    rate = round((b - a + ml / 1000) / hours, 2)
    item = {"start": str(start)[:19], "at": _now(), "before": round(b, 1), "after": round(a, 1), "drank": round(ml),
            "secs": round(float(secs)), "rate": max(rate, 0.0), "pct": round((b - a) / b * 100, 1)}
    own = _own()
    own["sweat"] = ([x for x in own.get("sweat") or [] if x.get("start") != item["start"]] + [item])[-200:]
    userdata.write_json(FILE, own)
    return status()

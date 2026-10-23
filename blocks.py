"""
Wat je in het kernblok van een training echt liep, naast wat gepland was.

  "2 km IL + 5 km @ ±4:20 + 2 km UL" + tussentijden per km
     → 5 km @ 4:28/km (km 3–7) · 176 bpm · 8 s/km trager dan doel 4:20

Drie soorten blokken:
  blok    "5 km @ 4:20"            de snelste aaneengesloten 5 km (inlopen/uitlopen vallen vanzelf weg)
  finish  "laatste 5 km @ 4:35"    de laatste 5 volle km
  reps    "6×1 km @ 4:05"          de 6 snelste ronden (laps) van ongeveer 1 km
Getallen komen altijd uit Strava; zonder bruikbare tussentijden of ronden: None.
"""
from __future__ import annotations

import re

import userdata

PACE = r"±?\s*(\d{1,2}:\d{2})"
NUM = r"(\d+(?:[.,]\d+)?)"
# "@ 4:20", maar ook "op MP-gevoel ±4:40" of "aan 4:30": een paar woorden mogen ertussen
SEP = r"\s*(?:@|\bop\b|\baan\b)[^\d±+,;()]{0,30}?"
RE_REPS = re.compile(rf"(\d+)\s*[×x]\s*{NUM}\s*(km|m)\b[^@+]*?{SEP}{PACE}", re.I)
RE_FINISH = re.compile(rf"laatste\s+{NUM}\s*km{SEP}{PACE}", re.I)
RE_BLOCK = re.compile(rf"{NUM}\s*km{SEP}{PACE}", re.I)
CACHE = userdata.DATA / "blocks.json"


def _sec(mmss: str) -> int:
    m, s = mmss.split(":")
    return int(m) * 60 + int(s)


def _num(v: str) -> float:
    return float(v.replace(",", "."))


def fmt_pace(sec: float) -> str:
    m, s = divmod(int(round(sec)), 60)
    return f"{m}:{s:02d}"


def fmt_time(sec: float) -> str:
    sec = int(round(sec))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def has_block(structure: str) -> bool:
    return bool(RE_REPS.search(structure or "") or RE_FINISH.search(structure or "") or RE_BLOCK.search(structure or ""))


def _result(kind: str, label: str, parts: list[dict], target: int, where: str) -> dict:
    secs = sum(p.get("moving_time") or 0 for p in parts)
    dist = sum(p.get("distance") or 0 for p in parts)
    hr_t = [(p.get("average_heartrate"), p.get("moving_time") or 0) for p in parts if p.get("average_heartrate")]
    hr = sum(h * t for h, t in hr_t) / sum(t for _, t in hr_t) if hr_t and sum(t for _, t in hr_t) else None
    pace = secs / (dist / 1000) if dist else 0
    return {"kind": kind, "label": label, "where": where, "km": round(dist / 1000, 2), "secs": secs,
            "pace": round(pace, 1), "hr": round(hr) if hr else None, "target": target,
            "delta": round(pace - target, 1), "splits": [p.get("split") for p in parts if p.get("split")]}


def _pace(x: dict) -> float:
    return x["moving_time"] / (x["distance"] / 1000)


def _real_start(splits: list[dict], best: int, n: int, target: int) -> int:
    """Het blok begint bij de km waar je echt versnelt, niet waar de snelste N km toevallig beginnen.
    Valt het einde van een blok terug, dan schuift het snelste venster een km te vroeg (bv. km 11–18
    i.p.v. 12–19). Grens = halfweg tussen je rustige tempo (mediaan buiten het blok) en het doel."""
    outside = sorted(_pace(x) for i, x in enumerate(splits) if not best <= i < best + n)
    if not outside:
        return best
    easy = outside[len(outside) // 2]
    thr = (easy + target) / 2
    starts = [s for s in range(max(1, best - 2), min(len(splits) - n, best + 2) + 1)
              if _pace(splits[s]) <= thr < _pace(splits[s - 1])]
    return min(starts, key=lambda s: abs(s - best)) if starts else best


def analyze(structure: str, detail: dict) -> dict | None:
    """Kernblok uit de (geplande) structuur + de Strava-activiteit met splits_metric/laps."""
    s = structure or ""
    splits = [x for x in (detail.get("splits_metric") or []) if (x.get("distance") or 0) >= 900 and x.get("moving_time")]

    m = RE_REPS.search(s)
    if m:
        reps, rep_m = int(m[1]), _num(m[2]) * (1000 if m[3].lower() == "km" else 1)
        laps = [x for x in (detail.get("laps") or []) if x.get("moving_time")
                and abs((x.get("distance") or 0) - rep_m) <= rep_m * 0.2]
        if len(laps) < reps:
            return None
        fastest = sorted(laps, key=lambda x: x["moving_time"] / x["distance"])[:reps]
        fastest.sort(key=lambda x: x.get("lap_index") or 0)
        label = f"{reps}×{m[2]} {m[3]}"
        return _result("reps", label, fastest, _sec(m[4]), f"{reps} snelste ronden")

    m = RE_FINISH.search(s)
    if m:
        n = max(1, int(_num(m[1])))
        if len(splits) < n:
            return None
        part = splits[-n:]
        return _result("finish", f"laatste {n} km", part, _sec(m[2]), f"km {part[0]['split']}–{part[-1]['split']}")

    m = RE_BLOCK.search(s)
    if m:
        n = max(1, int(_num(m[1])))
        if len(splits) < n:
            return None
        best = min(range(len(splits) - n + 1),
                   key=lambda i: sum(x["moving_time"] for x in splits[i:i + n]) / sum(x["distance"] for x in splits[i:i + n]))
        best = _real_start(splits, best, n, _sec(m[2]))
        part = splits[best:best + n]
        where = f"km {part[0]['split']}–{part[-1]['split']}" if n > 1 else f"km {part[0]['split']}"
        return _result("blok", f"{n} km", part, _sec(m[2]), where)
    return None


# ---- tekst ------------------------------------------------------------------------
def verdict(b: dict) -> str:
    """'8 s/km trager', '3 s/km sneller' of 'op doel' (staat altijd naast het doel zelf)."""
    d = b["delta"]
    if abs(d) <= 3:
        return "op doel"
    return f"{abs(round(d))} s/km {'trager' if d > 0 else 'sneller'}"


def short(b: dict) -> str:
    """'5 km @ 4:28' (voor titels)."""
    return f"{b['label']} @ {fmt_pace(b['pace'])}"


def actual_structure(structure: str, b: dict) -> str:
    """De structuur met je echte tempo in plaats van het doel:
    '2 km IL + 5 km @ ±4:20 + 2 km UL' → '2 km IL + 5 km @ 4:28 + 2 km UL'."""
    for rx, grp in ((RE_REPS, 4), (RE_FINISH, 2), (RE_BLOCK, 2)):      # zelfde volgorde als analyze()
        m = rx.search(structure or "")
        if m:
            return f"{structure[:m.start(grp)].rstrip('± ')} {fmt_pace(b['pace'])}{structure[m.end(grp):]}"
    return structure


def card_line(b: dict) -> str:
    """'Doel 4:40/km · gelopen 4:54/km' (onder de geplande structuur op de recap-kaart)."""
    return f"Doel {fmt_pace(b['target'])}/km · gelopen {fmt_pace(b['pace'])}/km"


def description_line(b: dict) -> str:
    hr = f" · {b['hr']} bpm" if b.get("hr") else ""
    return (f"Kernblok: {b['label']} @ {fmt_pace(b['pace'])}/km in {fmt_time(b['secs'])}{hr} "
            f"({b['where']}) · doel {fmt_pace(b['target'])}, {verdict(b)}")


# ---- bewaren (zodat het venster niet elke keer Strava moet vragen) --------------------
CACHE_VERSION = 3   # ophogen als de herkenning verandert: oude uitkomsten worden opnieuw berekend


def remember(activity_id, structure: str, b: dict | None) -> None:
    cache = userdata.read_json(CACHE, {})
    cache[str(activity_id)] = {"structure": structure, "block": b, "v": CACHE_VERSION}
    userdata.write_json(CACHE, dict(list(cache.items())[-400:]))


def recall(activity_id, structure: str):
    """(gevonden, blok). Enkel geldig als de structuur én de herkenningsversie dezelfde zijn."""
    hit = userdata.read_json(CACHE, {}).get(str(activity_id))
    if hit and hit.get("structure") == structure and hit.get("v") == CACHE_VERSION:
        return True, hit.get("block")
    return False, None

"""
Visueel overzicht na een Strava-sync — voor de snelkoppeling "Strava Sync".

  pythonw dashboard.py --sync --open   # sync draaien en daarna het overzicht openen
  python  dashboard.py --open          # enkel het overzicht (zonder sync)

In de stijl van de recap-kaarten toont het: je laatste kaart, waar je staat
(dagen tot de marathon, deze week gepland vs. gelopen, volgende training met
doeltempo), wat de sync net deed, km per week en je laatste kaarten.
Schrijft naar dashboard/index.html (niet in git: bevat persoonlijke data).
"""
from __future__ import annotations

import argparse
import datetime as dt
import html
import logging
import re
import shutil
import sys
import traceback
import webbrowser
from pathlib import Path
from urllib.parse import quote

import requests

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

# Zware modules (matplotlib via recap_card) pas laden NA het tonen van het
# "bezig"-scherm, zodat er na het dubbelklikken meteen iets verschijnt.
ss = mp = rc = None


def load_modules() -> None:
    global ss, mp, rc
    import strava_sync as _ss
    import marathon_plan as _mp
    import recap_card as _rc
    ss, mp, rc = _ss, _mp, _rc

OUT_DIR = BASE / "dashboard"
OUT = OUT_DIR / "index.html"
RACE_NAME = "Marathon Antwerpen"
GOAL = "zo dicht mogelijk bij sub-3"

DAYS = ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"]
DAYS_SHORT = ["Ma", "Di", "Wo", "Do", "Vr", "Za", "Zo"]
MONTHS = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"]
RUN_TYPES = ("Run", "TrailRun", "VirtualRun")
e = html.escape


# --------------------------------------------------------------------------- #
# Kleine helpers
# --------------------------------------------------------------------------- #
def nl_date(d: dt.date) -> str:
    return f"{DAYS[d.weekday()]} {d.day} {MONTHS[d.month - 1]} {d.year}"


def km_nl(v: float, dec: int = 1) -> str:
    return f"{v:.{dec}f}".replace(".", ",")


def pace(sec_per_km: float) -> str:
    m, s = divmod(round(sec_per_km), 60)
    return f"{m}:{s:02d}"


def split_training(t: str) -> tuple[str, str]:
    """'✅ Rustige duurloop — 7,4 km @ 5:21/km' → ('Rustige duurloop', '7,4 km @ 5:21/km')."""
    t = re.sub(r"^[\s✅🛑🚲🏁]+", "", t or "").strip()
    parts = re.split(r"\s[—–]\s", t, maxsplit=1)
    return parts[0].strip(), (parts[1].strip() if len(parts) > 1 else "")


def is_rest(t: str) -> bool:
    """Geen loopdag (rust, fietsen, fitness of zwemmen)? Enkel op basis van het begin van de cel, anders is
    'Rustig + 6 versnellingen (of fiets)' ook een 'fietsdag'."""
    s = (t or "").strip()
    if s.lstrip("✅ ").startswith(("🛑", "🚲", "🏋", "🏊")):
        return True
    title = split_training(s)[0].lower()
    return title.startswith(("fiets", "fitness", "zwem", "kracht")) or bool(re.match(r"rust\b", title))


def short_label(title: str) -> str:
    low = title.lower()
    for key, lab in [("herstel", "Herstel"), ("interval", "Interval"), ("marathonpace", "MP-blok"),
                     ("lange", "Lang"), ("tempo", "Tempo"), ("rustig", "Rustig"), ("fiets", "Fiets"),
                     ("marathon antwerpen", "Race"), ("wedstrijd", "Race")]:
        if key in low:
            return lab
    if re.search(r"\brust\b", low):
        return "Rust"
    return title.split()[0] if title else "—"


# --------------------------------------------------------------------------- #
# Sync draaien en opvangen wat er gebeurt
# --------------------------------------------------------------------------- #
class Collect(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[tuple[int, str]] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append((record.levelno, record.getMessage()))


def run_sync(cfg: dict) -> dict:
    # Zelfde cfg-dict hergebruiken: run_once vervangt daarin een geroteerde Strava-token.
    col = Collect()
    fh = logging.FileHandler(ss.LOG_DIR / "sync.log", encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s  %(levelname)-7s %(message)s", "%Y-%m-%d %H:%M:%S"))
    ss.log.setLevel(logging.INFO)
    ss.log.handlers = [fh, col]
    try:
        ss.run_once(cfg, False, None)
        return {"ran": True, "ok": True, "records": col.records}
    except Exception as exc:
        ss.log.error("Sync mislukt: %s", exc)
        return {"ran": True, "ok": False, "error": str(exc), "records": col.records}
    finally:
        fh.close()                              # app kan meerdere keren syncen in één sessie


def sync_events(records: list[tuple[int, str]]) -> list[tuple[str, str]]:
    out = []
    for lvl, msg in records:
        m = re.match(r"Activiteit \d+ \((\w+), ([\d,]+) km\) verwerken", msg)
        if m:
            out.append(("run", f"Nieuwe {'run' if m[1] == 'run' else 'activiteit'} gevonden"
                                + (f" · {m[2]} km" if m[2] not in ("0", "0,00") else "")))
        elif msg.startswith("Strava-titel gezet: "):
            out.append(("ok", f"Naam op Strava: {msg.split(': ', 1)[1]}"))
        elif msg.startswith("Notion bijgewerkt: "):
            out.append(("ok", f"Notion-schema: {msg.split(': ', 1)[1].split(' -> ')[0]} afgevinkt"))
        elif msg.startswith("Recap-kaart gemaakt: "):
            out.append(("card", f"Recap-kaart klaar: {msg.split(': ', 1)[1]}"))
        elif msg == "Geen nieuwe activiteiten":
            out.append(("info", "Geen nieuwe runs sinds de vorige sync."))
        elif "geen standaardnaam" in msg:
            out.append(("info", "Naam op Strava stond al goed, niet overschreven."))
        elif msg.startswith("Ollama") or "beschrijving gezet" in msg:
            continue
        elif lvl >= logging.WARNING:
            out.append(("warn", msg))
    return out


# --------------------------------------------------------------------------- #
# Data ophalen
# --------------------------------------------------------------------------- #
WEEK_RE = re.compile(r"Week\s+(\d+)\s*[—-]\s*(.+?)(?:\s{2,}\((.+)\))?\s*$")


def notion_weeks(cfg: dict) -> list[dict]:
    """Actieve weken van de Notion-pagina (huidige + komende), met hun dag-rijen."""
    weeks, cur = [], None
    for b in ss.notion_children(cfg, cfg["notion_page_id"]):
        kind = b["type"]
        if kind.startswith("heading"):
            txt = ss._plain(b).strip()
            if "kilometeropbouw" in txt.lower():
                break
            m = WEEK_RE.search(txt)
            cur = {"num": int(m[1]), "label": m[2].strip(), "marker": (m[3] or "").strip(),
                   "focus": "", "target": None, "rows": []} if m else None
            if cur:
                weeks.append(cur)
            continue
        if not cur:
            continue
        if kind == "quote" and not cur["focus"]:
            cur["focus"] = re.sub(r"^\s*Focus:\s*", "", ss._plain(b)).strip()
        elif kind == "table":
            for r in ss.notion_children(cfg, b["id"]):
                if r["type"] == "table_row":
                    cur["rows"].append([ss._cell_text(c) for c in r["table_row"]["cells"]])
        elif kind == "paragraph" and cur["target"] is None:
            m2 = re.search(r"Weekkilometers.*?([\d]+(?:[,.]\d+)?)\s*km", ss._plain(b))
            if m2:
                cur["target"] = float(m2[1].replace(",", "."))
    return weeks


def plan_days(weeks: list[dict], today: dt.date) -> list[dict]:
    out = []
    for w in weeks:
        for r in w["rows"]:
            if not r or r[0].strip().lower() == "dag":
                continue
            m = re.search(r"(\d{1,2})/(\d{1,2})", r[0])
            if not m:
                continue
            day, month = int(m[1]), int(m[2])
            year = today.year + (1 if month < today.month - 6 else 0)
            training = r[1] if len(r) > 1 else ""
            title, structure = split_training(training)
            out.append({
                "date": dt.date(year, month, day), "week": w, "title": title, "structure": structure,
                "km": r[2] if len(r) > 2 else "", "pace": r[3] if len(r) > 3 else "",
                "details": r[4] if len(r) > 4 else "",
                "done": "✅" in training, "rest": is_rest(training),
            })
    return out


def strava_runs(cfg: dict, weeks_back: int = 9) -> list[dict]:
    return [a for a in strava_activities(cfg, weeks_back) if (a.get("sport_type") or a.get("type")) in RUN_TYPES]


def strava_activities(cfg: dict, weeks_back: int = 9) -> list[dict]:
    """Alle activiteiten (elke sport) van de laatste weken."""
    tok = ss.strava_access_token(cfg)
    after = int((dt.datetime.now() - dt.timedelta(weeks=weeks_back)).timestamp())
    out: list[dict] = []
    for page in range(1, 6):
        r = requests.get(f"{ss.STRAVA_API}/athlete/activities", headers={"Authorization": f"Bearer {tok}"},
                         params={"after": after, "per_page": 100, "page": page}, timeout=30)
        r.raise_for_status()
        batch = r.json()
        out += batch
        if len(batch) < 100:
            break
    return out


def latest_cards(n: int = 8) -> list[Path]:
    folder = rc.cards_dir()
    if not folder.exists():
        return []
    return sorted(folder.rglob("*.png"), key=lambda p: p.stat().st_mtime, reverse=True)[:n]


def card_caption(p: Path) -> tuple[str, str]:
    m = re.match(r"(\d{2})-(\d{2})-(\d{4}) (.+)\.png$", p.name)
    if not m:
        return p.stem, ""
    d = dt.date(int(m[3]), int(m[2]), int(m[1]))
    return m[4], nl_date(d)


# --------------------------------------------------------------------------- #
# HTML
# --------------------------------------------------------------------------- #
CSS = """
@font-face{font-family:Archivo;src:url(fonts/archivo-latin.woff2) format('woff2');font-weight:100 900;font-stretch:62% 125%}
@font-face{font-family:'Martian Mono';src:url(fonts/martian-mono-latin.woff2) format('woff2');font-weight:100 800}
:root{--bg:#0A0A0A;--panel:#141414;--border:#2A2A2A;--fg:#FAFAFA;--muted:#8C8C8C;--soft:#CFCFCF;--slow:#484848}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:400 16px/1.45 Archivo,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{max-width:1280px;margin:0 auto;padding:26px 28px 60px}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px}
.brand{display:flex;align-items:center;gap:14px}.logo{height:30px}
.label{font:500 11px/1.3 'Martian Mono',ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 420px;gap:20px;align-items:start}
.col{display:grid;gap:20px;min-width:0}
.panel{min-width:0}
@media (max-width:1000px){.grid{grid-template-columns:minmax(0,1fr)}}
.panel{background:var(--panel);border:1.5px solid var(--border);border-radius:20px;padding:24px}
.panel h2{margin:0 0 16px;font-size:20px;font-weight:700}
.hero{display:grid;grid-template-columns:auto 1fr;gap:28px;align-items:center}
.days{font:850 124px/.82 Archivo;font-stretch:125%;letter-spacing:-.05em;text-align:center}
.days small{display:block;margin-top:14px;font:600 12px 'Martian Mono',monospace;letter-spacing:.3em;text-transform:uppercase;color:var(--soft)}
.race{font-size:30px;font-weight:800;font-stretch:112%;line-height:1.05;margin:6px 0 4px}
.goal{color:var(--muted)}
.bar{height:8px;border-radius:8px;background:#232323;overflow:hidden;margin:10px 0 6px}.bar i{display:block;height:100%;background:var(--fg)}
.weekline{display:flex;justify-content:space-between;gap:12px;margin-top:18px;font-weight:700}
.focus{color:var(--muted);font-size:14px;margin-top:4px}
.tiles{display:grid;grid-template-columns:repeat(7,minmax(84px,1fr));gap:10px;overflow-x:auto;scrollbar-width:none}
.tiles::-webkit-scrollbar{display:none}
.tile{border:1.5px solid var(--border);border-radius:14px;padding:12px 10px;min-height:118px;display:flex;flex-direction:column;gap:6px;background:var(--bg)}
.tile .d{display:flex;justify-content:space-between;font:500 11px 'Martian Mono',monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.tile .t{font-weight:700;font-size:14px;line-height:1.2}
.tile .k{margin-top:auto;font:800 22px/1 Archivo;font-stretch:115%}.tile .k small{font:500 10px 'Martian Mono',monospace;color:var(--muted);margin-left:3px}
.tile.done{background:var(--fg);color:var(--bg);border-color:var(--fg)}.tile.done .d,.tile.done .k small{color:#6a6a6a}
.tile.today{border-color:var(--fg);box-shadow:inset 0 0 0 1px var(--fg)}
.tile.rest{opacity:.4;border-style:dashed}.tile.missed{opacity:.5}.tile.missed .k{text-decoration:line-through}
.next .title{font-size:34px;font-weight:800;font-stretch:112%;line-height:1.05;margin:6px 0 6px}
.next .struct{color:var(--muted);font-size:18px}
.next .target{color:var(--soft);font-size:17px;margin-top:6px}
.next .meta{display:flex;gap:26px;margin-top:16px}
.big{font:800 30px/1 Archivo;font-stretch:115%}
.events{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.events li{display:flex;gap:12px;align-items:baseline;overflow-wrap:anywhere}
.events li::before{content:'';flex:none;width:8px;height:8px;border-radius:50%;background:var(--muted);transform:translateY(-1px)}
.events li.ok::before,.events li.card::before,.events li.run::before{background:var(--fg)}
.events li.warn{color:var(--soft)}.events li.warn::before{background:none;border:1.5px solid var(--soft)}
.card img{width:100%;display:block;border-radius:16px;border:1.5px solid var(--border)}
.card .cap{display:flex;justify-content:space-between;gap:12px;margin-top:12px;font-size:14px}
.btns{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;padding:10px 16px;border-radius:999px;border:1.5px solid var(--border);font:600 11px 'Martian Mono',monospace;letter-spacing:.08em;text-transform:uppercase;text-decoration:none}
.btn:hover{border-color:var(--fg)}.btn.primary{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.thumbs{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:12px}
.thumbs a{display:block;text-decoration:none}.thumbs img{width:100%;display:block;border-radius:10px;border:1.5px solid var(--border)}
.thumbs span{display:block;margin-top:6px;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media (max-width:1000px){.thumbs{grid-template-columns:repeat(4,minmax(0,1fr))}.hero{grid-template-columns:1fr}}
.alert{border:1.5px solid var(--soft);border-radius:16px;padding:14px 18px;margin-bottom:20px;color:var(--soft)}
svg text{font:500 11px 'Martian Mono',monospace;fill:var(--muted)}
.foot{margin-top:28px;color:var(--muted);font-size:13px;text-align:center}
"""


def page(body: str, refresh: bool = False) -> str:
    meta = '<meta http-equiv="refresh" content="2">' if refresh else ""
    return f"""<!doctype html><html lang="nl"><head><meta charset="utf-8">{meta}
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Strava Sync · dE3p</title>
<link rel="icon" href="logo.png"><style>{CSS}</style></head><body><div class="wrap">{body}</div></body></html>"""


def head(now: dt.datetime) -> str:
    return (f'<header><div class="brand"><img class="logo" src="logo.png" alt="dE3p"><span class="label">Strava Sync</span></div>'
            f'<span class="label">{e(nl_date(now.date()))} · {now:%H:%M}</span></header>')


def loading_page() -> str:
    body = (head(dt.datetime.now()) + '<div class="panel" style="text-align:center;padding:80px 24px">'
            '<div class="days" style="font-size:64px">Sync…</div>'
            '<p class="goal" style="margin-top:18px">Nieuwe runs ophalen, Strava-namen zetten, Notion afvinken en recap-kaarten maken.</p></div>')
    return page(body, refresh=True)


def build(sync: dict, cfg: dict) -> str:
    now = dt.datetime.now()
    today = now.date()
    problems: list[str] = []

    weeks: list[dict] = []
    try:
        if cfg.get("notion_page_id"):
            weeks = notion_weeks(cfg)
    except Exception as exc:
        problems.append(f"Notion-schema niet gelezen: {exc}")
    days = plan_days(weeks, today)
    runs: list[dict] = []
    try:
        runs = strava_runs(cfg)
    except Exception as exc:
        problems.append(f"Strava-runs niet opgehaald: {exc}")

    by_date: dict[dt.date, dict] = {}
    for a in runs:
        d = dt.date.fromisoformat(a["start_date_local"][:10])
        if d not in by_date or a["distance"] > by_date[d]["distance"]:
            by_date[d] = a

    monday = today - dt.timedelta(days=today.weekday())
    week_done = sum(a["distance"] for d, a in by_date.items() if monday <= d <= monday + dt.timedelta(days=6)) / 1000
    cur_week = next((d["week"] for d in days if d["date"] == today), weeks[0] if weeks else None)

    # ---- waar sta je ------------------------------------------------------
    left = (mp.RACE_DATE - today).days
    target = cur_week["target"] if cur_week else None
    pct = min(100, week_done / target * 100) if target else 0
    hero = f"""<section class="panel hero">
      <div class="days">{max(left, 0)}<small>{'dag' if left == 1 else 'dagen'} te gaan</small></div>
      <div><div class="label">Waar sta je</div>
        <div class="race">{e(RACE_NAME)}</div>
        <div class="goal">{e(nl_date(mp.RACE_DATE))} · doel {e(GOAL)}</div>
        {f'''<div class="weekline"><span>Week {cur_week["num"]}</span><span>{km_nl(week_done)} / {km_nl(target, 0)} km</span></div>
        <div class="bar"><i style="width:{pct:.0f}%"></i></div>
        <div class="focus">{e(cur_week["focus"])}</div>''' if cur_week and target else ''}
      </div></section>"""

    # ---- deze week ----------------------------------------------------------
    tiles = []
    for i in range(7):
        d = monday + dt.timedelta(days=i)
        row = next((x for x in days if x["date"] == d), None)
        run = by_date.get(d)
        if run:
            cls, lab, km = "done", (short_label(row["title"]) if row and not row["rest"] else "Extra run"), run["distance"] / 1000
        elif row and row["rest"]:
            cls, lab, km = "rest", short_label(row["title"]), None
        elif row:
            m = re.search(r"([\d]+(?:,\d+)?)\s*km", row["km"])
            km = float(m[1].replace(",", ".")) if m else None
            cls, lab = ("missed" if d < today else "today" if d == today else "planned"), short_label(row["title"])
        else:
            cls, lab, km = "rest", "—", None
        if d == today and cls == "done":
            cls = "done today"
        tiles.append(f'<div class="tile {cls}"><div class="d"><span>{DAYS_SHORT[i]}</span><span>{d.day}</span></div>'
                     f'<div class="t">{e(lab)}</div><div class="k">{km_nl(km) + "<small>km</small>" if km else "—"}</div></div>')
    week_html = f'<section class="panel"><h2>Deze week</h2><div class="tiles">{"".join(tiles)}</div></section>'

    # ---- volgende training ----------------------------------------------------
    nxt = next((x for x in days if x["date"] >= today and not x["rest"] and not x["done"]
                and not (x["date"] == today and today in by_date)), None)
    if nxt:
        when = "vandaag" if nxt["date"] == today else "morgen" if nxt["date"] == today + dt.timedelta(days=1) else nl_date(nxt["date"])
        next_html = f"""<section class="panel next"><div class="label">Volgende training · {e(when)}</div>
          <div class="title">{e(nxt["title"])}</div>
          {f'<div class="struct">{e(nxt["structure"])}</div>' if nxt["structure"] else ''}
          {f'<div class="target">Doeltempo · {e(nxt["pace"])}</div>' if nxt["pace"] and nxt["pace"] != "—" else ''}
          <div class="meta"><div><div class="label">Afstand</div><div class="big">{e(nxt["km"] or "—")}</div></div>
          <div><div class="label">Dag</div><div class="big">{e(DAYS[nxt["date"].weekday()].capitalize())}</div></div></div></section>"""
    else:
        next_html = '<section class="panel next"><div class="label">Volgende training</div><div class="title">Niets gepland</div></section>'

    # ---- wat deed de sync -------------------------------------------------------
    if sync.get("ran"):
        evs = sync_events(sync.get("records", []))
        if not sync.get("ok"):
            evs.append(("warn", f"Sync mislukt: {sync.get('error', 'onbekende fout')}"))
        items = "".join(f'<li class="{k}">{e(t)}</li>' for k, t in evs) or '<li class="info">Niets te melden.</li>'
        sync_html = f'<section class="panel"><h2>Deze sync</h2><ul class="events">{items}</ul></section>'
    else:
        sync_html = ""

    # ---- km per week ---------------------------------------------------------------
    wk = []
    for i in range(7, -1, -1):
        m0 = monday - dt.timedelta(weeks=i)
        wk.append((m0, sum(a["distance"] for d, a in by_date.items() if m0 <= d <= m0 + dt.timedelta(days=6)) / 1000))
    top = max([10] + [v for _, v in wk] + ([target] if target else []))
    W, H, base = 640, 210, 180
    slot = W / len(wk)
    bars = []
    for i, (m0, v) in enumerate(wk):
        cx = slot * (i + 0.5)
        y = base - v / top * (base - 24)
        cur = m0 == monday
        if cur and target:
            yt = base - target / top * (base - 24)
            bars.append(f'<rect x="{cx - 20}" y="{yt:.1f}" width="40" height="{base - yt:.1f}" rx="6" fill="none" stroke="#FAFAFA" stroke-dasharray="4 4" stroke-width="1.4"/>')
        bars.append(f'<rect x="{cx - 20}" y="{y:.1f}" width="40" height="{base - y:.1f}" rx="6" fill="{"#FAFAFA" if cur else "#8C8C8C"}"/>')
        bars.append(f'<text x="{cx}" y="{y - 8:.1f}" text-anchor="middle" style="fill:#FAFAFA">{round(v)}</text>')
        bars.append(f'<text x="{cx}" y="{H - 6}" text-anchor="middle" style="{"fill:#FAFAFA;font-weight:700" if cur else ""}">{m0.day} {MONTHS[m0.month - 1]}</text>')
    chart = (f'<section class="panel"><h2>Kilometers per week</h2><svg viewBox="0 0 {W} {H}" width="100%" role="img" '
             f'aria-label="Kilometers per week"><line x1="0" x2="{W}" y1="{base}" y2="{base}" stroke="#2A2A2A"/>{"".join(bars)}</svg>'
             f'<div class="label" style="margin-top:10px">Wit = deze week · stippellijn = gepland deze week</div></section>')

    # ---- laatste kaart + galerij -------------------------------------------------------
    # Kopie naast index.html (relatief pad): werkt zo in elke browser, ook via een server.
    cards = latest_cards()
    cards_dir = OUT_DIR / "cards"
    cards_dir.mkdir(parents=True, exist_ok=True)
    for old in cards_dir.glob("*.png"):
        old.unlink()
    src = {}
    for p in cards:
        shutil.copy2(p, cards_dir / p.name)
        src[p] = f"cards/{quote(p.name)}"
    new_names = [re.sub(r"^Recap-kaart klaar: ", "", t) for k, t in sync_events(sync.get("records", [])) if k == "card"]
    feature = next((p for p in cards if p.name in new_names), cards[0] if cards else None)
    if feature:
        title, when = card_caption(feature)
        card_html = f"""<section class="panel card"><div class="label" style="margin-bottom:12px">{'Nieuwe kaart' if feature.name in new_names else 'Laatste training'}</div>
          <a href="{feature.as_uri()}"><img src="{src[feature]}" alt="{e(title)}"></a>
          <div class="cap"><strong>{e(title)}</strong><span class="goal">{e(when)}</span></div>
          <div class="btns"><a class="btn primary" href="{feature.as_uri()}">Open kaart</a>
          <a class="btn" href="{rc.cards_dir().as_uri()}">Map met kaarten</a></div></section>"""
    else:
        card_html = '<section class="panel card"><div class="label">Nog geen recap-kaarten</div></section>'
    thumbs = "".join(f'<a href="{p.as_uri()}"><img src="{src[p]}" alt=""><span>{e(card_caption(p)[0])}</span></a>' for p in cards)
    gallery = f'<section class="panel" style="margin-top:20px"><h2>Je laatste kaarten</h2><div class="thumbs">{thumbs}</div></section>' if cards else ""

    alert = "".join(f'<div class="alert">{e(p)}</div>' for p in problems)
    body = (head(now) + alert + f'<div class="grid"><div class="col">{hero}{week_html}{next_html}{sync_html}{chart}</div>'
            f'<div class="col">{card_html}</div></div>{gallery}'
            '<div class="foot">Dubbelklik opnieuw op “Strava Sync” om te verversen.</div>')
    return page(body)


def write(text: str) -> None:
    OUT_DIR.mkdir(exist_ok=True)
    OUT.write_text(text, encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description="Visueel overzicht na een Strava-sync")
    ap.add_argument("--sync", action="store_true", help="eerst de sync draaien")
    ap.add_argument("--open", action="store_true", help="overzicht openen in de browser")
    args = ap.parse_args()

    if args.open:
        write(loading_page())
        webbrowser.open(OUT.as_uri())
    try:
        load_modules()
        cfg = ss.load_config()                     # SystemExit bij ontbrekende .env-waarden
        sync = run_sync(cfg) if args.sync else {"ran": False}
        write(build(sync, cfg))
    except (Exception, SystemExit):
        write(page(head(dt.datetime.now()) + f'<div class="alert"><strong>Overzicht maken mislukt.</strong>'
                   f'<pre style="white-space:pre-wrap">{e(traceback.format_exc())}</pre></div>'))


if __name__ == "__main__":
    main()

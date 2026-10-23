"""
Genereert een verticale TikTok-recap-kaart (1080x1920) van een Strava-activiteit
(lopen, fietsen, zwemmen, kracht, tennis, ...) met kerncijfers + grafieken
(tempo of snelheid per km waar dat zinvol is, gedetailleerde hartslag).

Gebruik:
  python recap_card.py                       # laatste run
  python recap_card.py <activity_id>         # specifieke run
  python recap_card.py <activity_id> "Titel" # met korte titel (trainingstype)

Output: <kaartenmap>/<jjjj-mm maand>/dd-mm-jjjj Titel.png
Hergebruikt de Strava-toegang van strava_sync.py.
"""
from __future__ import annotations

import re
import sys
import datetime as dt
from pathlib import Path

import numpy as np
import requests
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from strava_sync import (load_config, strava_access_token, STRAVA_API,  # noqa: E402
                         strava_recent_activities, strava_activity_detail)

# ---- thema (zwart-wit) -----------------------------------------------------
BG = "#0A0A0A"
PANEL = "#141414"
BORDER = "#2A2A2A"
TXT = "#FAFAFA"
MUTED = "#8C8C8C"
ACCENT = "#FFFFFF"   # wit — snelle km
SLOW = "#484848"     # grijs — rustige km (in-/uitloop)
GRID = "#1E1E1E"

import userdata  # noqa: E402

LOGO_PATH = userdata.RES / "assets" / "logo.png"


def cards_dir() -> Path:
    """Map waar de recap-kaarten terechtkomen: 'cards_dir' in config.json (te kiezen
    in de app), env RECAP_DIR, anders Afbeeldingen/dE3p."""
    return userdata.cards_dir()


MONTHS_NL = ["", "jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"]
MONTHS_FULL = ["", "januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus",
               "september", "oktober", "november", "december"]
DAYS_NL = ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"]


def month_folder(d: dt.date) -> str:
    """Submap per maand, bv. '2026-09 september': mappen sorteren chronologisch en
    binnen een maand sorteren de 'dd-mm-jjjj'-namen ook op datum."""
    return f"{d:%Y-%m} {MONTHS_FULL[d.month]}"


def fmt_pace(sec_per_km: float) -> str:
    m = int(sec_per_km // 60)
    s = int(round(sec_per_km - m * 60))
    if s == 60:
        m, s = m + 1, 0
    return f"{m}:{s:02d}"


def fmt_time(sec: float) -> str:
    sec = int(sec)
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def nl_date(d: dt.date) -> str:
    return f"{DAYS_NL[d.weekday()]} {d.day} {MONTHS_NL[d.month]} {d.year}"


def split_title(name: str) -> tuple[str, str]:
    """Splits titel in (hoofdtype, detail). Detail = het stuk na ' — ' (bv. de structuur)."""
    parts = re.split(r"\s[—–]\s", name, maxsplit=1)
    main = parts[0].strip()
    if len(main) > 34:
        main = main[:33].rstrip() + "…"
    detail = parts[1].strip() if len(parts) > 1 else ""
    if len(detail) > 50:
        detail = detail[:49].rstrip() + "…"
    return (main or name), detail


def safe_filename(ddate: dt.date, title: str) -> str:
    """Bestandsnaam = 'dd-mm-jjjj <volledige training>.png' (Windows-veilig).

    ' — ' wordt een spatie en ':' wordt '.' (dubbele punt mag niet in een bestandsnaam).
    """
    stem = f"{ddate.strftime('%d-%m-%Y')} {title}"
    stem = stem.replace(" — ", " ").replace(" – ", " ").replace(":", ".")
    stem = re.sub(r'[\\/*?"<>|]+', "", stem)
    stem = re.sub(r"\s+", " ", stem).strip()
    return stem + ".png"


def strava_streams(token: str, aid: int) -> dict:
    try:
        r = requests.get(f"{STRAVA_API}/activities/{aid}/streams",
                         headers={"Authorization": f"Bearer {token}"},
                         params={"keys": "heartrate,distance,time", "key_by_type": "true"},
                         timeout=30)
        r.raise_for_status()
        return r.json()
    except Exception:
        return {}


def rounded_panel(fig, x, y, w, h, color=PANEL, radius=0.018):
    p = FancyBboxPatch((x, y), w, h,
                       boxstyle=f"round,pad=0,rounding_size={radius}",
                       transform=fig.transFigure, facecolor=color, edgecolor=BORDER,
                       linewidth=1.2, mutation_aspect=1920 / 1080, zorder=1)
    fig.add_artist(p)


def stat_tile(fig, x, y, w, h, value, label):
    rounded_panel(fig, x, y, w, h)
    fig.text(x + w / 2, y + h * 0.60, value, color=TXT, fontsize=42,
             fontweight="bold", ha="center", va="center")
    fig.text(x + w / 2, y + h * 0.24, label, color=MUTED, fontsize=20,
             ha="center", va="center")


def place_logo(fig, width_px: int, xo: int, yo: int, alpha: float = 1.0):
    if not LOGO_PATH.exists():
        return
    im = Image.open(LOGO_PATH).convert("RGBA")
    h = round(width_px * im.height / im.width)
    im = im.resize((width_px, h), Image.LANCZOS)
    fig.figimage(np.asarray(im), xo=xo, yo=yo, alpha=alpha, zorder=5)


def plan_note(text: str | None) -> str | None:
    """Wat het schema vroeg en ook op de kaart hoort, kort. Nu de versnellingen:
    'Versnellingen: 3× ±20 s aan ±5 km-tempo · 60–90 s wandelen of joggen ertussen'. Anders None."""
    t = text or ""
    if "versnell" not in t.lower():
        return None
    m = re.search(r"(\d+)\s*[×x]\s*(±?\s*\d+\s*s)\b[^(]*\(\s*(±?[^,)]+)", t)
    if not m:
        return None
    out = f"Versnellingen: {m.group(1)}× {m.group(2)} aan {m.group(3).strip()}"
    rest = re.search(r"(\d+(?:\s*[–-]\s*\d+)?\s*s)\s+(wandelen(?:\s+of\s+joggen)?|joggen)", t)
    if rest:
        out += f" · {rest.group(1)} {rest.group(2)} ertussen"
    return out


def fit_text(fig, x: float, y: float, s: str, size: float, width: float = 0.9, **kw):
    """Tekst die nooit breder is dan `width` van de kaart: anders kleiner (tot 12 pt)."""
    t = fig.text(x, y, s, fontsize=size, **kw)
    r = fig.canvas.get_renderer()
    while size > 12 and t.get_window_extent(r).width > fig.bbox.width * width:
        size -= 1
        t.set_fontsize(size)
    return t


def build_card(d: dict, streams: dict | None = None, title: str | None = None,
               target_pace: str | None = None, out_dir: Path | None = None, note: str | None = None) -> Path:
    import sports
    streams = streams or {}
    grp = sports.group(d)
    dist_km = (d.get("distance") or 0) / 1000
    mtime = d.get("moving_time") or 0
    avg_hr = d.get("average_heartrate")
    max_hr = d.get("max_heartrate")
    cad = d.get("average_cadence")
    spm = round(cad * 2) if cad else None
    prs = d.get("pr_count") or d.get("achievement_count") or 0
    elev = d.get("total_elevation_gain")
    avg_pace = (mtime / dist_km) if dist_km else 0
    avg_kmh = (dist_km / (mtime / 3600)) if mtime else 0

    start = d.get("start_date_local", "")[:10]
    try:
        ddate = dt.date.fromisoformat(start)
    except Exception:
        ddate = dt.date.today()

    raw_title = title or d.get("name") or sports.name(d)
    title_main, title_detail = split_title(raw_title)
    # wat je in het kernblok echt liep ("5 km @ 4:28 · doel 4:20"), niet enkel het doel
    import blocks
    full_detail = (re.split(r"\s[—–]\s", raw_title, maxsplit=1) + [""])[1]
    block = blocks.analyze(full_detail, d) if grp == "run" else None

    splits = d.get("splits_metric") or []
    idx = [s["split"] for s in splits]
    speeds = [(s.get("average_speed") or 0) * 3.6 for s in splits]  # km/u

    fig = plt.figure(figsize=(10.8, 19.2), dpi=100)
    fig.patch.set_facecolor(BG)

    # ---- header: titel + subtitel + doeltempo, gecentreerd ------------
    # met wat het schema vroeg (bv. de versnellingen) schuift alles een beetje hoger
    note = note if note and grp == "run" else None
    if grp == "run":                                         # nieuw persoonlijk record in deze loop? dan staat dat erbij
        try:
            import prestaties
            rec = prestaties.record_note(d)
            note = " · ".join(x for x in (rec, note) if x) or None
        except Exception:
            pass
    up = 0.010 if note else 0.0
    fig.text(0.5, 0.943 + up, title_main, color=TXT, fontsize=36, fontweight="bold",
             ha="center", va="center")
    if title_detail:
        fig.text(0.5, 0.908 + up, title_detail, color=MUTED, fontsize=23, ha="center", va="center")
    # Eerst het doel (de geplande structuur hierboven, of het doeltempo), dan wat je liep.
    perf = None
    if block:
        perf = blocks.card_line(block)                       # Gelopen · 5 km @ 4:28/km
    elif target_pace and grp == "run" and not blocks.has_block(full_detail):
        doel = re.sub(r"\s*/\s*km\s*$", "", target_pace.strip())
        unit = "/km" if re.search(r"\d", doel) else ""        # 'Rustig' is geen tempo: geen '/km' erachter
        doel = doel if unit else doel.lower()
        if title_detail:
            perf = f"Doel {doel}{unit} · gelopen {fmt_pace(avg_pace)}/km"
        else:
            title_detail = f"Doel · {doel}{unit}"
            perf = f"Gelopen · {fmt_pace(avg_pace)}/km"
            fig.text(0.5, 0.908 + up, title_detail, color=MUTED, fontsize=23, ha="center", va="center")
    elif target_pace and grp == "run":
        perf = f"Doeltempo · {target_pace}"                  # blok niet terug te vinden (bv. geen ronden)
    y = (0.878 if title_detail else 0.905) + up
    if perf:
        fig.text(0.5, y, perf, color="#CFCFCF", fontsize=22, ha="center", va="center")
    if note:                                                 # wat het schema vroeg: 3× ±20 s aan ±5 km-tempo …
        fit_text(fig, 0.5, y - 0.027 if perf else y, note, 19, color=MUTED, ha="center", va="center")

    # ---- hero: afstand, of de duur bij sporten zonder afstand ----------
    rounded_panel(fig, 0.07, 0.760, 0.86, 0.086)
    if grp == "swim":
        hero = f"{round(dist_km * 1000):,}".replace(",", ".") + " m"
    elif sports.has_distance(grp) and dist_km > 0.05:
        hero = f"{dist_km:.2f}".replace(".", ",") + " km"
    else:
        hero = fmt_time(mtime)
    fig.text(0.5, 0.803, hero, color=TXT, fontsize=66, fontweight="bold", ha="center", va="center")

    # ---- stat tiles (per sport de cijfers die ertoe doen) ---------------
    hr_t = (f"{int(round(avg_hr))}" if avg_hr else "–", "gem. HR (bpm)")
    mhr_t = (f"{int(round(max_hr))}" if max_hr else "–", "max HR (bpm)")
    elev_t = (f"{int(round(elev))}" if elev else "0", "hoogtemeters")
    kcal = d.get("calories") or d.get("kilojoules")   # fietsen: kJ arbeid ≈ kcal verbruikt
    kcal_t = (f"{int(round(kcal))}" if kcal else "–", "calorieën")
    watts = d.get("average_watts")
    swim100 = (mtime / (dist_km * 10)) if dist_km else 0
    if grp == "run":
        tiles = [(fmt_time(mtime), "looptijd"), hr_t, mhr_t, (f"{spm}" if spm else "–", "cadans (spm)"),
                 elev_t, (fmt_pace(avg_pace), "gem. tempo (/km)")]
    elif grp == "ride":
        tiles = [(fmt_time(mtime), "fietstijd"), (f"{avg_kmh:.1f}".replace(".", ","), "gem. km/u"), hr_t,
                 (f"{int(round(watts))}" if watts else "–", "vermogen (W)"), elev_t,
                 (f"{(d.get('max_speed') or 0) * 3.6:.1f}".replace(".", ","), "max km/u")]
    elif grp == "swim":
        tiles = [(fmt_time(mtime), "zwemtijd"), (fmt_pace(swim100) if swim100 else "–", "tempo (/100 m)"), hr_t,
                 mhr_t, kcal_t, (fmt_time(d.get("elapsed_time") or mtime), "totale tijd")]
    elif grp == "walk":
        tiles = [(fmt_time(mtime), "tijd"), (fmt_pace(avg_pace) if avg_pace else "–", "tempo (/km)"), hr_t,
                 mhr_t, elev_t, kcal_t]
    else:   # kracht, tennis, ... : geen afstand, wel inspanning
        tiles = [hr_t, mhr_t, kcal_t]
    tw, th, gap = 0.276, 0.078, 0.016
    x0, y0 = 0.07, 0.655
    for i, (val, lab) in enumerate(tiles):
        r, c = divmod(i, 3)
        stat_tile(fig, x0 + c * (tw + gap), y0 - r * (th + gap), tw, th, val, lab)

    # ---- grafiek 1: tempo per km (van onder naar boven, hoger = sneller)
    per_km = grp in ("run", "ride", "walk") and len(speeds) >= 2
    hr_box = [0.09, 0.125, 0.84, 0.160] if per_km else [0.09, 0.20, 0.84, 0.30]
    if per_km:
        ax1 = fig.add_axes([0.09, 0.365, 0.84, 0.160])
        ax1.set_facecolor(BG)
    if per_km and speeds:
        smin, smax = min(speeds), max(speeds)
        rng = (smax - smin) or 1.0
        base = smin - rng * 0.9
        colors = [ACCENT if sp >= avg_kmh else SLOW for sp in speeds]
        ax1.bar(idx, [sp - base for sp in speeds], bottom=base, color=colors,
                width=0.78, zorder=3)
        ax1.axhline(avg_kmh, color=MUTED, lw=1.4, ls="--", zorder=2)
        top = smax
        dense = len(speeds) > 12                             # smalle balken: geen labelachtergrond
        if block and block["kind"] in ("blok", "finish") and block["splits"] and block["target"]:
            # doellijn over de km van het kernblok: per km zie je of je erboven of eronder zat
            tgt = 3600 / block["target"]
            x0b, x1b = min(block["splits"]) - 0.5, max(block["splits"]) + 0.5
            ax1.hlines(tgt, x0b, x1b, colors=TXT, lw=2.2, zorder=2.5 if dense else 4)
            at_end = max(block["splits"]) >= max(idx) - 1    # blok loopt (bijna) tot het einde: label links
            ax1.text(x0b if at_end else x1b, tgt, (f"doel {blocks.fmt_pace(block['target'])} " if at_end
                     else f" doel {blocks.fmt_pace(block['target'])}"), color=TXT, fontsize=12,
                     fontweight="bold", ha="right" if at_end else "left", va="center", zorder=5,
                     bbox=dict(facecolor=BG, edgecolor="none", pad=1))
            top, base = max(top, tgt), min(base, tgt - rng * 0.3)
        ax1.set_ylim(base, top + rng * 0.34)
        # Labels mogen elkaar niet raken: kleiner bij veel km, en bij heel lange
        # lopen enkel om de andere balk (anders "5:395:385:37").
        n = len(speeds)
        fs, step = min(13, 210 / n), 1
        if fs < 10.5:
            fs, step = min(13, 420 / n), 2
        for k, (xi, sp) in enumerate(zip(idx, speeds)):
            if k % step:
                continue
            pace = (f"{sp:.1f}".replace(".", ",") if grp == "ride" else fmt_pace(3600 / sp)) if sp else "–"
            # iets boven de balk, met achtergrond: leesbaar als de doellijn erdoor loopt
            ax1.annotate(pace, (xi, sp), xytext=(0, 4), textcoords="offset points", ha="center", va="bottom",
                         color=TXT, fontsize=fs, fontweight="bold", zorder=6,
                         bbox=None if dense else dict(facecolor=BG, edgecolor="none", pad=1))
    if per_km:
        ax1.set_title("Snelheid per km  (km/u · hoger = sneller)" if grp == "ride"
                      else "Tempo per km  (min/km · hoger = sneller)", color=TXT, fontsize=20,
                      loc="left", pad=10, fontweight="bold")
        ax1.set_xticks(idx)
        ax1.tick_params(colors=MUTED, labelsize=min(13, 300 / max(1, len(idx))))
        ax1.set_yticks([])
        for sp in ax1.spines.values():
            sp.set_visible(False)

    # ---- grafiek 2: gedetailleerde hartslag (volledige Strava-stream) --
    ax2 = fig.add_axes(hr_box)
    ax2.set_facecolor(BG)
    hr_data = (streams.get("heartrate") or {}).get("data")
    dist_data = (streams.get("distance") or {}).get("data")
    time_data = (streams.get("time") or {}).get("data")
    by_time = not (sports.has_distance(grp) and grp != "swim" and dist_data and max(dist_data or [0]) > 50)
    x_data = (np.array(time_data) / 60.0 if time_data else None) if by_time else         (np.array(dist_data) / 1000.0 if dist_data else None)
    if hr_data and x_data is not None and len(hr_data) == len(x_data):
        xs = x_data
        ys = np.array(hr_data, dtype=float)
        ax2.plot(xs, ys, color=ACCENT, lw=1.8, zorder=3)
        ax2.fill_between(xs, ys, ys.min() - 4, color=ACCENT, alpha=0.10, zorder=2)
        ax2.set_xlim(0, xs.max())
    else:  # fallback: per-km gemiddelden
        hrs = [s.get("average_heartrate") for s in splits]
        valid = [(i, h) for i, h in zip(idx, hrs) if h]
        if valid:
            xs, ys = zip(*valid)
            ax2.plot(xs, ys, color=ACCENT, lw=3, marker="o", ms=6, zorder=3)
            ax2.fill_between(xs, ys, min(ys) - 5, color=ACCENT, alpha=0.10, zorder=2)
    if avg_hr:
        ax2.axhline(avg_hr, color=MUTED, lw=1.2, ls="--", zorder=1)
    ax2.set_title("Hartslag  (bpm · per minuut)" if by_time else "Hartslag  (bpm · volledige registratie)",
                  color=TXT, fontsize=20,
                  loc="left", pad=10, fontweight="bold")
    ax2.tick_params(colors=MUTED, labelsize=13)
    ax2.grid(axis="y", color=GRID, lw=0.8)
    for sp in ax2.spines.values():
        sp.set_visible(False)
    if not ax2.lines:           # geen hartslagmeter: liever geen grafiek dan een lege
        ax2.remove()

    # ---- footer: datum + logo midden onder ----------------------------
    fig.text(0.5, 0.086, nl_date(ddate), color=MUTED, fontsize=20,
             ha="center", va="center")
    place_logo(fig, width_px=150, xo=(1080 - 150) // 2, yo=42, alpha=0.9)  # midden onder

    out_dir = out_dir or (cards_dir() / month_folder(ddate))
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / safe_filename(ddate, raw_title)
    fig.savefig(out_path, facecolor=BG)
    plt.close(fig)
    return out_path


def latest_run_id(tok: str) -> int | None:
    after = int((dt.datetime.now() - dt.timedelta(days=30)).timestamp())
    acts = strava_recent_activities(tok, after)
    runs = [a for a in acts if a.get("type") == "Run" or a.get("sport_type") == "Run"]
    runs.sort(key=lambda x: x["start_date_local"], reverse=True)
    return runs[0]["id"] if runs else None


def generate(tok: str, aid: int, title: str | None = None,
             target_pace: str | None = None, out_dir: Path | None = None, note: str | None = None) -> Path:
    """Haalt run + HR-stream op en bouwt de recap-kaart. Voor gebruik vanuit de sync."""
    d = strava_activity_detail(tok, aid)
    streams = strava_streams(tok, aid)
    return build_card(d, streams, title, target_pace, out_dir, note=note)


def main() -> None:
    cfg = load_config()
    tok = strava_access_token(cfg)
    aid = int(sys.argv[1]) if len(sys.argv) > 1 else latest_run_id(tok)
    title = sys.argv[2] if len(sys.argv) > 2 else None
    target_pace = sys.argv[3] if len(sys.argv) > 3 else None
    if not aid:
        sys.exit("Geen run gevonden.")
    out = generate(tok, aid, title, target_pace)
    print(f"OK -> {out}")


if __name__ == "__main__":
    main()

"""Wekelijks trainingsrapport (zondag) -> Notion-marathonpagina.

Vergelijkt deze kalenderweek (ma-zo) met de vorige week en zet een
compact rapport onderaan de Notion-pagina. Herbruikt de Strava-toegang
van strava_sync.py en de Notion-helpers van notion_api.py.
"""
from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).parent))
from strava_sync import load_config, strava_access_token, strava_recent_activities  # noqa: E402
import notion_api as na  # noqa: E402

RACE_DAY = dt.date(2026, 10, 18)


def fmt_pace(total_s: float, km: float) -> str:
    if km <= 0 or total_s <= 0:
        return "-"
    s = total_s / km
    return f"{int(s // 60)}:{int(s % 60):02d}/km"


def fmt_km(km: float) -> str:
    return f"{km:.1f}".replace(".", ",") + " km"


def week_stats(runs: list[dict], start: dt.date, end: dt.date) -> dict:
    sel = [a for a in runs if start <= dt.date.fromisoformat(a["start_date_local"][:10]) <= end]
    km = sum(a["distance"] for a in sel) / 1000
    tijd = sum(a.get("moving_time", 0) for a in sel)
    langste = max((a["distance"] / 1000 for a in sel), default=0)
    return {"runs": len(sel), "km": km, "tijd": tijd, "pace": fmt_pace(tijd, km),
            "langste": langste}


def main() -> None:
    cfg = load_config()
    tok = strava_access_token(cfg)

    vandaag = dt.date.today()
    ma_deze = vandaag - dt.timedelta(days=vandaag.weekday())
    ma_vorige = ma_deze - dt.timedelta(days=7)

    after = int(dt.datetime.combine(ma_vorige, dt.time.min).timestamp())
    acts = strava_recent_activities(tok, after)
    runs = [a for a in acts if a.get("type") == "Run" or a.get("sport_type") == "Run"]

    nu = week_stats(runs, ma_deze, ma_deze + dt.timedelta(days=6))
    vorig = week_stats(runs, ma_vorige, ma_vorige + dt.timedelta(days=6))

    diff = nu["km"] - vorig["km"]
    trend = "▲" if diff > 0.05 else ("▼" if diff < -0.05 else "▬")
    dagen = (RACE_DAY - vandaag).days

    titel = (f"📊 Weekrapport {ma_deze.strftime('%d/%m')}–"
             f"{(ma_deze + dt.timedelta(days=6)).strftime('%d/%m')}")
    samenvatting = (f"{fmt_km(nu['km'])} in {nu['runs']} run(s) "
                    f"({trend} {'+' if diff >= 0 else ''}{f'{diff:.1f}'.replace('.', ',')} km t.o.v. vorige week) · "
                    f"gem. {nu['pace']} · nog {dagen} dagen tot Antwerpen (doel: sub-3)")

    blokken = [
        na.divider(),
        na.heading2(titel),
        na.paragraph(na.rt(samenvatting)),
        na.table(
            ["", "Deze week", "Vorige week"],
            [
                ["Kilometers", fmt_km(nu["km"]), fmt_km(vorig["km"])],
                ["Runs", str(nu["runs"]), str(vorig["runs"])],
                ["Gem. tempo", nu["pace"], vorig["pace"]],
                ["Langste run", fmt_km(nu["langste"]), fmt_km(vorig["langste"])],
            ],
        ),
    ]
    na.append_children(na.page_id(), blokken)
    print(f"Weekrapport geplaatst in Notion: {samenvatting}")


if __name__ == "__main__":
    main()

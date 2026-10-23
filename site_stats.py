"""Genereert strava.json voor de dE3p-website (Road to Antwerp Marathon-widget).

Draait mee in run.ps1 na elke sync. Herbruikt de Strava-API-toegang
van strava_sync.py (zelfde .env / refresh token).
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from strava_sync import load_config, strava_access_token, strava_recent_activities  # noqa: E402

SITE_JSON = Path(r"D:\PROJECT\dE3p\website\strava.json")


def fmt_pace(moving_s: float, km: float) -> str | None:
    if km <= 0 or moving_s <= 0:
        return None
    s = moving_s / km
    return f"{int(s // 60)}:{int(s % 60):02d}/km"


def main() -> None:
    cfg = load_config()
    token = strava_access_token(cfg)

    now = dt.datetime.now()
    monday = (now - dt.timedelta(days=now.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0)
    after = int((now - dt.timedelta(days=14)).timestamp())

    acts = strava_recent_activities(token, after)
    runs = [a for a in acts
            if a.get("type") == "Run" or a.get("sport_type") == "Run"]
    week = [a for a in runs
            if dt.datetime.strptime(a["start_date_local"][:10], "%Y-%m-%d") >= monday]
    week_km = sum(a["distance"] for a in week) / 1000

    data = {
        "updated": now.strftime("%Y-%m-%d %H:%M"),
        "week_km": round(week_km, 1),
        "week_runs": len(week),
        "last_run": None,
    }
    if runs:
        last = max(runs, key=lambda a: a["start_date_local"])
        km = last["distance"] / 1000
        data["last_run"] = {
            "date": last["start_date_local"][:10],
            "km": round(km, 1),
            "pace": fmt_pace(last.get("moving_time", 0), km),
        }

    SITE_JSON.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"strava.json bijgewerkt: {data['week_km']} km deze week ({data['week_runs']} runs), "
          f"laatste run: {data['last_run']}")


if __name__ == "__main__":
    main()

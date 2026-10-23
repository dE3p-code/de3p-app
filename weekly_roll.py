"""
Wekelijkse roll van het Notion-marathonschema.

Wat het doet zodra een nieuwe week begint (maandag):
  1. archiveert de afgewerkte 'huidige week' als subpagina onder 'Voltooide weken'
     (met de ECHTE tabel zoals die op de pagina staat, incl. ingevulde trainingen);
  2. verwijdert de twee actieve weken van de hoofdpagina;
  3. genereert vers de nieuwe huidige + volgende week (deterministisch, marathon_plan.py)
     en plaatst ze terug tussen 'Voltooide weken' en 'Kilometeropbouw'.

Het doet NIETS zolang de eerste actieve week nog de huidige week is.

Gebruik:
  python weekly_roll.py --preview              # toon de gegenereerde 2 weken (geen Notion)
  python weekly_roll.py --dry-run              # lees Notion, toon wat er zou gebeuren
  python weekly_roll.py --apply                # voer de roll echt uit
  python weekly_roll.py --dry-run --today 2026-06-29   # test met een andere datum
"""

from __future__ import annotations

import argparse
import re
import sys
from datetime import date

import marathon_plan as mp
import notion_api as na

MONTHS = {"jan": 1, "feb": 2, "mrt": 3, "apr": 4, "mei": 5, "jun": 6,
          "jul": 7, "aug": 8, "sep": 9, "okt": 10, "nov": 11, "dec": 12}
HEADER = ["Dag", "Training", "Afstand", "Doelpace", "Details"]


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #
def week_to_blocks(wk: mp.WeekPlan, marker: str) -> list[dict]:
    rows = [[r.dag, r.training, r.afstand, r.doelpace, r.details] for r in wk.rows]
    total = f"Weekkilometers lopen (plan): ~{round(wk.target)} km"
    return [
        na.heading2(f"\U0001f5d3️ Week {wk.number} — {wk.label}  ({marker})"),
        na.quote(na.rt_focus(wk.focus)),
        na.table(HEADER, rows),
        na.paragraph(na.rt(total, bold=True)),
        na.divider(),
    ]


# --------------------------------------------------------------------------- #
# Parsing van de bestaande pagina
# --------------------------------------------------------------------------- #
def parse_heading(text: str) -> tuple[int | None, str]:
    m = re.search(r"Week\s+(\d+)\s*[—-]\s*(.+)", text)
    if not m:
        return None, ""
    num = int(m.group(1))
    label = re.split(r"\s*\(", m.group(2))[0].strip()
    return num, label


def parse_label_start(label: str) -> date | None:
    """'22 t/m 28 jun 2026' of '29 jun t/m 5 jul 2026' -> startdatum."""
    try:
        left, right = re.split(r"\bt/m\b", label)
    except ValueError:
        return None
    left, right = left.strip(), right.strip()
    year_m = re.search(r"(\d{4})", right)
    year = int(year_m.group(1)) if year_m else date.today().year
    left_day = int(re.search(r"(\d{1,2})", left).group(1))
    month_word = re.search(r"([a-z]{3})", left.lower())
    if not month_word:
        month_word = re.search(r"([a-z]{3})", right.lower())
    month = MONTHS.get(month_word.group(1)) if month_word else None
    if not month:
        return None
    return date(year, month, left_day)


def sum_loop_km(rows: list[list[str]]) -> str:
    """Tel enkel de km van afgewerkte (✅) loopdagen — geen plan, geen fiets."""
    total = 0.0
    for r in rows[1:]:
        if len(r) < 3:
            continue
        training = r[1]
        if "✅" not in training:                              # alleen afgewerkt
            continue
        low = training.lower()
        if "fiets" in low or "🚲" in training or "🏊" in training or "🏋" in training or "zwem" in low or "fitness" in low:
            continue                                         # geen fiets-, zwem- of fitness-km
        m = re.search(r"(\d+(?:[.,]\d+)?)\s*km", r[2])
        if m:
            total += float(m.group(1).replace(",", "."))
    if not total:
        return "0 km"
    return f"{total:.2f}".rstrip("0").rstrip(".").replace(".", ",") + " km"


# --------------------------------------------------------------------------- #
# Roll
# --------------------------------------------------------------------------- #
def find_layout(children: list[dict]) -> tuple[int, str, int]:
    """Geef (index Voltooide-weken-block, page-id ervan, index Kilometeropbouw-heading)."""
    volt_idx = volt_id = km_idx = None
    for i, blk in enumerate(children):
        if volt_idx is None and blk["type"] == "child_page" \
                and "voltooide weken" in na.child_page_title(blk).lower():
            volt_idx, volt_id = i, blk["id"]
        if km_idx is None and volt_idx is not None and blk["type"].startswith("heading") \
                and "kilometeropbouw" in na.plain(blk).lower():
            km_idx = i
    if volt_idx is None or km_idx is None:
        raise SystemExit("Kon de 'Voltooide weken'- of 'Kilometeropbouw'-ankers niet vinden.")
    return volt_idx, volt_id, km_idx


def roll(today: date, dry_run: bool) -> None:
    pid = na.page_id()
    children = na.get_children(pid)
    volt_idx, volt_id, km_idx = find_layout(children)
    active = children[volt_idx + 1:km_idx]

    headings = [b for b in active if b["type"] == "heading_2"]
    if not headings:
        raise SystemExit("Geen actieve week-koppen gevonden tussen de ankers.")

    first = headings[0]
    num, label = parse_heading(na.plain(first))
    finishing_monday = parse_label_start(label)
    if not finishing_monday:
        raise SystemExit(f"Kon de startdatum niet lezen uit: '{label}'")

    current_monday = mp.monday_of(today)
    if finishing_monday >= current_monday:
        print(f"Geen roll nodig: huidige week ({label}) is nog actueel (vandaag {today}).")
        return

    print(f"Roll nodig: '{label}' is afgelopen -> archiveren; nieuwe weken vanaf {current_monday}.")

    # --- 1. archiefinhoud van de afgewerkte week opbouwen (echte tabel van de pagina) ---
    fin_quote = next((b for b in active if b["type"] == "quote"), None)
    fin_table = next((b for b in active if b["type"] == "table"), None)
    focus_body = na.plain(fin_quote).split("Focus:", 1)[-1].strip() if fin_quote else ""
    rows: list[list[str]] = []
    if fin_table:
        for rw in na.get_children(fin_table["id"]):
            if rw["type"] == "table_row":
                rows.append(["".join(t.get("plain_text", "") for t in cell)
                             for cell in rw["table_row"]["cells"]])
    loop_km = sum_loop_km(rows)
    archive_title = f"✅ Week {num} — {label} ({loop_km})"
    archive_children = []
    if focus_body:
        archive_children.append(na.quote(na.rt_focus(focus_body)))
    if rows:
        archive_children.append(na.table(rows[0], rows[1:]))
    archive_children.append(na.paragraph(na.rt(f"Weekkilometers lopen: {loop_km}", bold=True)))

    # --- 2. nieuwe weken genereren (huidige + volgende + volgende volgende) ---
    cur = mp.generate_week(current_monday)
    nxt = mp.generate_week(current_monday + mp.timedelta(weeks=1))
    nxt2 = mp.generate_week(current_monday + mp.timedelta(weeks=2))
    new_blocks = ([na.divider()]
                  + week_to_blocks(cur, "huidige week")
                  + week_to_blocks(nxt, "volgende week")
                  + week_to_blocks(nxt2, "volgende volgende week"))

    if dry_run:
        print(f"\n[dry-run] ARCHIVEREN als subpagina onder 'Voltooide weken':")
        print(f"   titel: {archive_title}  ({len(rows)} rijen)")
        print(f"\n[dry-run] {len(active)} actieve blokken zouden verwijderd worden.")
        print(f"\n[dry-run] NIEUW op de hoofdpagina:")
        for wk in (cur, nxt, nxt2):
            print(f"   Week {wk.number} — {wk.label}  (~{round(wk.target)} km)")
        return

    # --- 3. uitvoeren ---
    na.create_subpage(volt_id, archive_title, archive_children, icon_emoji="\U0001f4c1")
    print(f"Gearchiveerd: {archive_title}")
    for blk in active:
        na.delete_block(blk["id"])
    print(f"{len(active)} oude blokken verwijderd.")
    na.append_children(pid, new_blocks, after=volt_id)
    print(f"Nieuwe weken geplaatst: Week {cur.number} (huidig) + {nxt.number} + {nxt2.number}.")


def preview(today: date) -> None:
    base = mp.monday_of(today)
    weeks = [(mp.generate_week(base), "huidige week"),
             (mp.generate_week(base + mp.timedelta(weeks=1)), "volgende week"),
             (mp.generate_week(base + mp.timedelta(weeks=2)), "volgende volgende week")]
    for wk, marker in weeks:
        print(f"\n=== Week {wk.number} — {wk.label}  ({marker}) — doel ~{round(wk.target)} km ===")
        print("Focus:", wk.focus)
        for r in wk.rows:
            print(f"  {r.dag:16} | {r.training[:54]:54} | {r.afstand:9} | {r.doelpace}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Wekelijkse roll van het marathonschema")
    ap.add_argument("--preview", action="store_true", help="toon 2 gegenereerde weken (geen Notion)")
    ap.add_argument("--dry-run", action="store_true", help="lees Notion, toon plan, schrijf niets")
    ap.add_argument("--apply", action="store_true", help="voer de roll echt uit")
    ap.add_argument("--today", help="datum overschrijven (YYYY-MM-DD), voor tests")
    args = ap.parse_args()

    today = date.fromisoformat(args.today) if args.today else date.today()

    if args.preview:
        preview(today)
        return
    if args.apply:
        roll(today, dry_run=False)
        return
    if args.dry_run:
        roll(today, dry_run=True)
        return
    ap.print_help()
    sys.exit("\nKies --preview, --dry-run of --apply.")


if __name__ == "__main__":
    main()

"""
Deterministische marathon-planregels — Marathon Antwerpen 18 okt 2026.

HEROPBOUW-VERSIE (2 sep 2026): na een onderbreking door vakantie + blessure
(nog restlast, kon 30+ min pijnvrij lopen) is het plan omgebouwd van een vol
sub-3-schema (68 km piek, 4:15/km) naar een voorzichtige 6-weekse heropbouw.
Doel: zo dicht mogelijk bij sub-3, reële finish 3:10–3:30; blessurevrij finishen
gaat vóór de tijd.

Genereert per week de 7 dagen (zelfde structuur/kolommen als het Notion-schema):
Dag | Training | Afstand | Doelpace | Details.

De weekstructuur wordt gekozen op basis van 'weeks_to_race' (wtr):
  5 = basis      (7–13 sep)   geen harde intervallen
  4 = mp1        (14–20 sep)  eerste marathonpace-blok
  3 = tempo      (21–27 sep)  tempo + MP-finish in de lange duurloop
  2 = piek       (28 sep–4 okt) grootste lange duurloop + BESLISMOMENT
  1 = taper      (5–11 okt)
  0 = racewoche  (12–18 okt)

Alle getallen komen UIT DEZE REGELS. Een LLM mag hooguit de focus-/coachingzin
verzorgen (zie weekly_roll.py), nooit de afstanden of paces.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta

# --------------------------------------------------------------------------- #
# Profiel
# --------------------------------------------------------------------------- #
RACE_DATE = date(2026, 10, 18)            # zondag
RACE_MONDAY = RACE_DATE - timedelta(days=RACE_DATE.weekday())  # 12 okt 2026

# Ankerpunt enkel nog voor de doorlopende weeknummering (Week 6 = 22 jun 2026).
ANCHOR_MONDAY = date(2026, 6, 22)
ANCHOR_WEEK_NUMBER = 6

PACES = {
    "herstel": "5:20–5:45/km",
    "easy": "5:10–5:35/km",
    "duur": "5:10–5:35/km",
    "tempo": "±4:25/km",
    "interval": "±4:20/km",
    "mp": "±4:40/km",          # 3 okt: haalbaar marathontempo 4:35–4:45 (doel ±3:15), niet meer sub-3
    "mp_soft": "±4:35/km",
}

# Heropbouwschema per weeks_to_race: weekvolume (km) + lange duurloop (km) + fase.
COMEBACK: dict[int, dict] = {
    5: {"total": 31, "long": 14, "fase": "basis"},   # 7–13 sep
    4: {"total": 40, "long": 18, "fase": "mp1"},     # 14–20 sep
    3: {"total": 48, "long": 22, "fase": "tempo"},   # 21–27 sep
    2: {"total": 55, "long": 28, "fase": "piek"},    # 28 sep–4 okt (beslismoment)
    1: {"total": 41, "long": 16, "fase": "taper"},   # 5–11 okt
}
DEFAULT_SPEC = {"total": 28, "long": 12, "fase": "basis"}  # veiligheidsval (wtr > 5)

WEEKDAYS_NL = ["Maandag", "Dinsdag", "Woensdag", "Donderdag", "Vrijdag", "Zaterdag", "Zondag"]
MONTHS_NL = ["", "jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"]


# --------------------------------------------------------------------------- #
# Datums
# --------------------------------------------------------------------------- #
def monday_of(d: date) -> date:
    return d - timedelta(days=d.weekday())


def nl_date(d: date) -> str:
    return f"{d.day} {MONTHS_NL[d.month]}"


def week_range_label(monday: date) -> str:
    sunday = monday + timedelta(days=6)
    if monday.month == sunday.month:
        return f"{monday.day} t/m {sunday.day} {MONTHS_NL[sunday.month]} {sunday.year}"
    return f"{nl_date(monday)} t/m {nl_date(sunday)} {sunday.year}"


def week_number_for(monday: date) -> int:
    return ANCHOR_WEEK_NUMBER + (monday - ANCHOR_MONDAY).days // 7


def weeks_to_race(monday: date) -> int:
    return (RACE_MONDAY - monday).days // 7


def fmt_km(value: float) -> str:
    rounded = round(value * 2) / 2          # op 0,5 km
    return f"{rounded:.1f}".replace(".", ",")


# --------------------------------------------------------------------------- #
# Weekgeneratie
# --------------------------------------------------------------------------- #
@dataclass
class DayRow:
    dag: str
    training: str
    afstand: str
    doelpace: str
    details: str


@dataclass
class WeekPlan:
    number: int
    monday: date
    label: str
    focus: str
    rows: list[DayRow] = field(default_factory=list)
    target: float = 0.0


def _row(monday: date, offset: int, training: str, afstand: str, pace: str, details: str) -> DayRow:
    d = monday + timedelta(days=offset)
    return DayRow(f"{WEEKDAYS_NL[offset]} {d.strftime('%d/%m')}", training, afstand, pace, details)


def _rest_fri(monday: date) -> DayRow:
    return _row(monday, 4, "🛑 Rust", "—", "—", "Vaste rustdag vrijdag.")


def _bike_sun(monday: date) -> DayRow:
    return _row(monday, 6, "🚲 Fiets", "60–90 min", "Rustig", "Vaste fietsdag — actief herstel.")


def _gym(monday: date, offset: int, kracht: str, zwem: str, duur: str = "± 1 u") -> DayRow:
    """Fitness + zwemmen in Wezenberg (één bezoek). Zwemtempo's uit Jens' eigen zwembeurten
    (aug–sep 2025: 1,8–2,7 km in sets, ±1:56–2:11/100 m)."""
    return _row(monday, offset, "🏋️ Fitness + 🏊 zwemmen", duur, "Rustig", f"Wezenberg: {kracht} Daarna {zwem}")


def strides(n: int) -> str:
    """Uitleg bij 'versnellingen' (strides), zodat het schema zelf zegt wat je moet doen."""
    return (f"Versnellingen: na de rustige km {n}× ±20 s vlot versnellen (±5 km-tempo, níét sprinten), "
            "telkens 60–90 s wandelen of joggen ertussen.")


def _race_week(monday: date, num: int, label: str) -> WeekPlan:
    rows = [
        _row(monday, 0, "Rustige duurloop", f"{fmt_km(6)} km", PACES["easy"],
             "Heel rustig, benen soepel."),
        _row(monday, 1, "Korte tune-up — 2 km IL + 3 km @ ±4:40 + 1 km UL", f"{fmt_km(6)} km",
             PACES["mp"], "Kort op wedstrijdtempo, niet moe maken."),
        _row(monday, 2, "Rustig + 4 versnellingen", f"{fmt_km(5)} km", PACES["easy"], strides(4)),
        _row(monday, 3, "Heel losjes (of rust)", f"{fmt_km(4)} km", PACES["herstel"],
             "Benen soepel houden."),
        _row(monday, 4, "🛑 Rust", "—", "—", "Rust + koolhydraten opladen."),
        _row(monday, 5, "Losjes + 3 versnellingen (of rust)", f"{fmt_km(3)} km", "Rustig",
             f"{strides(3)} Vroeg naar bed."),
        _row(monday, 6, "🏁 MARATHON ANTWERPEN", "42,2 km", "±4:40–4:45/km",
             "Start ±4:45/km. Drink bij elke post een paar slokken; gel rond 45 min en dan om de "
             "35–40 min, telkens mét water. Voelt het na 30 km licht én pijnvrij → geleidelijk versnellen."),
    ]
    focus = ("Raceweek: uitrusten, benen wakker houden. Start bewust rustig (±4:45/km), drink en eet "
             "volgens plan en bouw na 30 km op als het pijnvrij voelt. Doel ±3:15 (3:13–3:20).")
    return WeekPlan(num, monday, label, focus, rows, 24.0)


def _after_race_week(monday: date, num: int, label: str) -> WeekPlan:
    """Week na de marathon: eerst echt herstellen (wandelen, fietsen), pas op het einde kort lopen."""
    rows = [
        _row(monday, 0, "🛑 Rust", "—", "—", "Dag na de marathon: wandelen mag, eten, drinken en slapen."),
        _row(monday, 1, "🚶 Wandelen", "30–45 min", "Rustig", "Benen losmaken. Nog niet lopen."),
        _row(monday, 2, "🏊 Zwemmen heel rustig", "1.000–1.500 m", "±2:10/100 m",
             "Wezenberg. Losjes doorzwemmen, trager dan je gewone ±2:00/100 m: vooral crawl en rugslag "
             "(schoolslag met het hoofd boven water belast je rug). Zware benen? Korter of wandelen."),
        _row(monday, 3, "🛑 Rust", "—", "—", "Spierpijn of stijve benen? Volkomen normaal, geef het tijd."),
        _rest_fri(monday),                          # vrijdag = altijd rust, ook na de marathon
        _row(monday, 5, "Eerste herstelloopje", f"{fmt_km(4)} km", PACES["herstel"],
             "20–25 min heel rustig. Pijn of zware benen? Dan nog niet: wandel of fiets."),
        _bike_sun(monday),
    ]
    focus = ("Herstel na de marathon: de eerste dagen niet lopen, wel wandelen en fietsen. Pas op het "
             "einde van de week kort en heel rustig. Proficiat met je marathon!")
    return WeekPlan(num, monday, label, focus, rows, 4.0)


def _rebuild_week(monday: date, num: int, label: str, k: int) -> WeekPlan:
    """Na de herstelweek: rustig terug opbouwen, nog zonder harde trainingen."""
    base = min(7.0, 5.0 + k)
    rows = [
        _row(monday, 0, "Rustige duurloop", f"{fmt_km(base)} km", PACES["easy"], "Gesprekstempo."),
        _gym(monday, 1, "Fitness A op je horloge (Garmin-agenda): benen + romp, ±45 min. Oefeningen: Notion "
                        "'Fitness Wezenberg — oefeningen'.",
             "±1.000 m rustig uitzwemmen (±2:05/100 m), crawl en rugslag."),
        _row(monday, 2, "Rustig + 4 versnellingen", f"{fmt_km(base)} km", PACES["easy"], strides(4)),
        _gym(monday, 3, "Fitness B op je horloge (Garmin-agenda): rug, romp en bovenlichaam, benen licht "
                        "(zaterdag lange duurloop), 30–40 min.",
             "1.500 m: 300 m inzwemmen, 4× 200 m vlot (±1:55–2:00/100 m, 20 s rust), 400 m uitzwemmen.",
             "± 1¼ u"),
        _rest_fri(monday),
        _row(monday, 5, "Lange duurloop", f"{fmt_km(base + 3)} km", PACES["duur"], "Rustig, op gevoel."),
        _row(monday, 6, "🚲 Fiets (of Wezenberg)", "60–90 min", "Rustig",
             "Vaste fietsdag. Zin in een 3e keer Wezenberg? Dan een zwemtraining zoals je gewoon bent "
             "(2.000 m, bv. 4× 500 m rustig, 30 s rust) + Fitness B licht (2 sets) i.p.v. fietsen."),
    ]
    focus = ("Terug opbouwen na de marathon: rustige kilometers, nog geen harde trainingen. Dinsdag en donderdag "
             "naar Wezenberg (fitness + zwemmen), zondag fietsen of een 3e keer Wezenberg.")
    return WeekPlan(num, monday, label, focus, rows, round(base * 2 + base + 3, 1))


def generate_week(monday: date) -> WeekPlan:
    monday = monday_of(monday)
    num = week_number_for(monday)
    label = week_range_label(monday)
    wtr = weeks_to_race(monday)

    if wtr == 0:
        return _race_week(monday, num, label)
    if wtr == -1:                                   # de week ná de marathon (was per ongeluk nog eens een racewoche)
        return _after_race_week(monday, num, label)
    if wtr < -1:
        return _rebuild_week(monday, num, label, -wtr - 1)

    spec = COMEBACK.get(wtr, DEFAULT_SPEC)
    fase, total, long_km = spec["fase"], spec["total"], spec["long"]
    rows: list[DayRow] = []

    if fase == "basis":
        rows.append(_row(monday, 0, "Herstelloop", f"{fmt_km(5)} km", PACES["herstel"],
                         "Heel rustig, benen losmaken."))
        rows.append(_row(monday, 1, "Rustige duurloop + 6 versnellingen", f"{fmt_km(7)} km",
                         PACES["easy"],
                         f"{strides(6)} Alleen pijnvrij; nog géén harde intervallen."))
        rows.append(_row(monday, 2, "Rustige duurloop", f"{fmt_km(5)} km", PACES["duur"],
                         "Losse aerobe km."))
        rows.append(_row(monday, 3, "🚲 Fiets of 4 km heel rustig", "45–60 min / 4,0 km", "Rustig",
                         "Blessurebuffer: fiets bij restlast, anders kort en losjes."))
        rows.append(_rest_fri(monday))
        rows.append(_row(monday, 5, "Lange duurloop", f"{fmt_km(long_km)} km", PACES["duur"],
                         "Gesprekstempo, op gevoel. Stop bij pijn."))
        rows.append(_bike_sun(monday))
        focus = ("Heropbouw na de onderbreking: rustige basis terugpakken, nog géén harde "
                 f"intervallen. Plan ~{total} km lopen.")

    elif fase == "mp1":
        rows.append(_row(monday, 0, "Herstelloop", f"{fmt_km(6)} km", PACES["herstel"], "Rustig."))
        rows.append(_row(monday, 1, "Eerste marathonpace-blok — 2 km IL + 4 km @ ±4:30 + 2 km UL",
                         f"{fmt_km(8)} km", PACES["mp"],
                         "Alleen pijnvrij; anders volledig rustig lopen."))
        rows.append(_row(monday, 2, "Rustige duurloop", f"{fmt_km(6)} km", PACES["duur"],
                         "Losse aerobe km."))
        rows.append(_row(monday, 3, "🚲 Fiets of 4 km heel rustig", "45–60 min / 4,0 km", "Rustig",
                         "Blessurebuffer."))
        rows.append(_rest_fri(monday))
        rows.append(_row(monday, 5, "Lange duurloop", f"{fmt_km(long_km)} km", PACES["duur"],
                         "Gesprekstempo, op gevoel."))
        rows.append(_bike_sun(monday))
        focus = f"Eerste marathonpace-prikkel als de blessure het toelaat. Plan ~{total} km lopen."

    elif fase == "tempo":
        rows.append(_row(monday, 0, "Herstelloop", f"{fmt_km(6)} km", PACES["herstel"], "Rustig."))
        rows.append(_row(monday, 1, "Tempo/drempel — 2 km IL + 6 km @ ±4:25 + 2 km UL",
                         f"{fmt_km(10)} km", PACES["tempo"],
                         "Pijnvrij → tempo; restlast → marathonpace ±4:35 of rustig."))
        rows.append(_row(monday, 2, "Rustige duurloop", f"{fmt_km(7)} km", PACES["duur"],
                         "Aerobe km."))
        rows.append(_row(monday, 3, "Rustig + 6 versnellingen (of fiets)", f"{fmt_km(5)} km",
                         PACES["easy"], f"{strides(6)} Restlast? Dan fietsen."))
        rows.append(_rest_fri(monday))
        rows.append(_row(monday, 5, "Lange duurloop met MP-finish — laatste 5 km @ ±4:35",
                         f"{fmt_km(long_km)} km", PACES["duur"],
                         "Laatste 5 km op marathonpace-gevoel, alleen pijnvrij."))
        rows.append(_bike_sun(monday))
        focus = f"Kwaliteit toevoegen + marathonpace in de lange duurloop. Plan ~{total} km lopen."

    elif fase == "piek":
        rows.append(_row(monday, 0, "Herstelloop", f"{fmt_km(6)} km", PACES["herstel"], "Rustig."))
        rows.append(_row(monday, 1, "Kwaliteit — 2 km IL + 5 km @ ±4:20 + 2 km UL", f"{fmt_km(9)} km",
                         PACES["interval"], "Alleen pijnvrij; anders marathonpace ±4:35."))
        rows.append(_row(monday, 2, "Rustige duurloop", f"{fmt_km(7)} km", PACES["duur"],
                         "Aerobe km."))
        rows.append(_row(monday, 3, "Rustig + 6 versnellingen", f"{fmt_km(5)} km", PACES["easy"],
                         f"{strides(6)} Restlast? Dan fietsen."))
        rows.append(_rest_fri(monday))
        rows.append(_row(monday, 5, "Lange duurloop — middenblok 8 km op MP-gevoel ±4:40",
                         f"{fmt_km(long_km)} km", PACES["duur"],
                         "Sleutelsessie én BESLISMOMENT. Alleen pijnvrij het MP-blok; "
                         "voeding/drinken oefenen."))
        rows.append(_bike_sun(monday))
        focus = ("Grootste lange duurloop + marathonpace. Na zaterdag beslissen we sub-3 vs. reële "
                 f"tijd (3:10–3:30). Plan ~{total} km lopen.")

    elif fase == "taper":
        rows.append(_row(monday, 0, "Herstelloop", f"{fmt_km(6)} km", PACES["herstel"], "Rustig."))
        rows.append(_row(monday, 1, "Marathonpace-scherpte — 2 km IL + 5 km @ ±4:40 + 1 km UL",
                         f"{fmt_km(8)} km", PACES["mp"], "Je wedstrijdtempo inslijpen: vlot maar niet forceren."))
        rows.append(_row(monday, 2, "Rustige duurloop", f"{fmt_km(6)} km", PACES["duur"],
                         "Aerobe km."))
        rows.append(_row(monday, 3, "Rustig + 6 versnellingen", f"{fmt_km(5)} km", PACES["easy"],
                         strides(6)))
        rows.append(_rest_fri(monday))
        rows.append(_row(monday, 5, "Lange duurloop (ingekort) — generale repetitie met water + gel",
                         f"{fmt_km(long_km)} km", PACES["duur"],
                         "Rustig, alles zoals op de marathon: drinkbus/gordel mee, om de 15–20 min een paar "
                         "slokken, 1 gel rond 45 min mét water. Test wat je maag verdraagt."))
        rows.append(_bike_sun(monday))
        focus = (f"Taperweek: volume omlaag naar ~{total} km, benen scherp houden. Fris worden "
                 "richting de marathon.")

    else:  # veiligheidsval
        rows.append(_row(monday, 0, "Herstelloop", f"{fmt_km(5)} km", PACES["herstel"],
                         "Heel rustig."))
        rows.append(_row(monday, 1, "Rustige duurloop", f"{fmt_km(6)} km", PACES["easy"],
                         "Aeroob, op gevoel."))
        rows.append(_row(monday, 2, "Rustige duurloop", f"{fmt_km(5)} km", PACES["duur"],
                         "Losse km."))
        rows.append(_row(monday, 3, "🚲 Fiets", "45–60 min", "Rustig", "Actief herstel."))
        rows.append(_rest_fri(monday))
        rows.append(_row(monday, 5, "Lange duurloop", f"{fmt_km(long_km)} km", PACES["duur"],
                         "Gesprekstempo, op gevoel."))
        rows.append(_bike_sun(monday))
        focus = f"Rustige week. Plan ~{total} km lopen."

    return WeekPlan(num, monday, label, focus, rows, float(total))


def generate_weeks(start_monday: date, count: int) -> list[WeekPlan]:
    return [generate_week(start_monday + timedelta(weeks=i)) for i in range(count)]


if __name__ == "__main__":
    today = date.today()
    plans = generate_weeks(monday_of(today), 7)
    for wk in plans:
        print(f"\n=== Week {wk.number} — {wk.label}  (doel ~{round(wk.target)} km lopen) ===")
        print("Focus:", wk.focus)
        for r in wk.rows:
            print(f"  {r.dag:16} | {r.training[:60]:60} | {r.afstand:9} | {r.doelpace}")

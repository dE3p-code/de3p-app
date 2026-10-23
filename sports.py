"""Sporten: welke Strava-activiteiten bij welke groep horen, met Nederlandse namen.

Groepen bepalen welke cijfers er toe doen (tempo per km, snelheid, tempo per 100 m
of enkel tijd en hartslag). Het schema en de doeltempo's blijven voor lopen.
"""
from __future__ import annotations

# groep → (naam, Strava sport_types)
GROUPS: dict[str, tuple[str, tuple[str, ...]]] = {
    "run": ("Lopen", ("Run", "TrailRun", "VirtualRun")),
    "ride": ("Fietsen", ("Ride", "VirtualRide", "GravelRide", "MountainBikeRide", "EBikeRide",
                         "EMountainBikeRide", "Velomobile", "Handcycle")),
    "swim": ("Zwemmen", ("Swim",)),
    "walk": ("Wandelen", ("Walk", "Hike")),
    "racket": ("Racketsport", ("Tennis", "Padel", "Squash", "Badminton", "Pickleball", "TableTennis",
                               "Racquetball")),
}

# Nederlandse naam per Strava-type (wat je in de app en op de kaart ziet)
NAMES = {
    "Run": "Lopen", "TrailRun": "Traillopen", "VirtualRun": "Lopen (binnen)",
    "Ride": "Fietsen", "VirtualRide": "Fietsen (binnen)", "GravelRide": "Gravel", "MountainBikeRide": "Mountainbike",
    "EBikeRide": "E-bike", "EMountainBikeRide": "E-mountainbike", "Velomobile": "Velomobiel", "Handcycle": "Handbike",
    "Swim": "Zwemmen", "Walk": "Wandelen", "Hike": "Hiken",
    "WeightTraining": "Krachttraining", "Crossfit": "CrossFit", "Workout": "Workout",
    "HighIntensityIntervalTraining": "HIIT", "Pilates": "Pilates", "Yoga": "Yoga",
    "StairStepper": "Traploper", "Elliptical": "Crosstrainer",
    "Tennis": "Tennis", "Padel": "Padel", "Squash": "Squash", "Badminton": "Badminton",
    "Pickleball": "Pickleball", "TableTennis": "Tafeltennis", "Racquetball": "Racquetball",
    "Rowing": "Roeien", "VirtualRow": "Roeien (binnen)", "Kayaking": "Kajakken", "Canoeing": "Kanoën",
    "StandUpPaddling": "Suppen", "Surfing": "Surfen", "Kitesurf": "Kitesurfen", "Windsurf": "Windsurfen",
    "AlpineSki": "Skiën", "BackcountrySki": "Toerskiën", "NordicSki": "Langlaufen", "Snowboard": "Snowboarden",
    "IceSkate": "Schaatsen", "InlineSkate": "Skeeleren", "RollerSki": "Rolskiën", "RockClimbing": "Klimmen",
    "Golf": "Golf", "Soccer": "Voetbal", "Basketball": "Basketbal", "Volleyball": "Volleybal",
    "Cricket": "Cricket", "Dance": "Dansen", "Boxing": "Boksen", "MartialArts": "Vechtsport",
    "Wheelchair": "Rolstoel", "Skateboard": "Skateboarden", "Sail": "Zeilen",
}

_TYPE_TO_GROUP = {t: g for g, (_, types) in GROUPS.items() for t in types}


def sport_type(a: dict) -> str:
    return a.get("sport_type") or a.get("type") or ""


def group(a: dict) -> str:
    """'run', 'ride', 'swim', 'walk', 'racket' of 'other' (kracht, yoga e.d. = 'other')."""
    return _TYPE_TO_GROUP.get(sport_type(a), "other")


def name(a: dict) -> str:
    """Nederlandse naam van de sport, bv. 'Tennis' of 'Krachttraining'."""
    t = sport_type(a)
    return NAMES.get(t) or GROUPS.get(group(a), ("",))[0] or t or "Training"


# Voor welke sporten er automatisch een recap-kaart komt (Instellingen → Recap-kaarten).
# E-bike staat apart: veel mensen pendelen ermee en willen daar geen kaart van.
CARD_CHOICES = [("run", "Lopen"), ("ride", "Fietsen"), ("ebike", "E-bike"), ("swim", "Zwemmen"),
                ("walk", "Wandelen"), ("racket", "Racketsport"), ("other", "Andere sporten")]
DEFAULT_CARDS = ("run", "ride", "swim", "racket", "other")


def card_key(a: dict) -> str:
    return "ebike" if sport_type(a) in ("EBikeRide", "EMountainBikeRide") else group(a)


def has_distance(grp: str) -> bool:
    return grp in ("run", "ride", "swim", "walk")

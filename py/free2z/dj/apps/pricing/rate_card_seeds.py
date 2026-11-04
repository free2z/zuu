"""Rate-card seed migrations: the ONLY way a new card version reaches prod.

A rate card is immutable once published, and so is a seed migration once it
has run anywhere: ``manage.py migrate`` never re-runs an applied migration,
and every seed's ``seed()`` returns early when its version already exists.
EDITING an old ``000N_seed_rate_card_vN.py`` therefore changes what a FRESH
database gets while prod keeps the card it already has -- two different
"vN" cards, silently. So:

* repricing, adding or removing a model = a NEW migration
  ``pricing/NNNN_seed_rate_card_v<N+1>.py`` (copy the newest one, bump
  ``VERSION``, paste the new ``ROWS``); never an edit to an applied one;
* ``test_rate_card.py`` pins every existing seed's content to a recorded
  digest (history does not change), and compares ``seed_ai_models.LINEUP``
  against the NEWEST seed only, with a failure message naming this remedy.

This module finds the seed migrations by filename, so the newest version is
derived from the migrations directory, never hardwired.
"""
import importlib
import re
from pathlib import Path

SEED_MIGRATION_RE = re.compile(r"^(\d{4})_seed_rate_card_v(\d+)\.py$")
MIGRATIONS_PACKAGE = "dj.apps.pricing.migrations"
MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"


def seed_migrations():
    """``[(version, migration_name, module), ...]`` sorted by version.

    Refuses (ValueError) a seed whose filename version and ``VERSION``
    disagree, or two seeds claiming one version -- either would make "the
    newest card" ambiguous.
    """
    found = []
    for path in sorted(MIGRATIONS_DIR.glob("*_seed_rate_card_v*.py")):
        match = SEED_MIGRATION_RE.match(path.name)
        if not match:
            raise ValueError(f"unrecognised rate-card seed filename: {path.name}")
        module = importlib.import_module(f"{MIGRATIONS_PACKAGE}.{path.stem}")
        version = int(match.group(2))
        if module.VERSION != version:
            raise ValueError(
                f"{path.name}: VERSION = {module.VERSION} but the filename says v{version}")
        found.append((version, path.stem, module))
    found.sort(key=lambda item: item[0])
    versions = [v for v, _, _ in found]
    if len(versions) != len(set(versions)):
        raise ValueError(f"two seed migrations claim one rate-card version: {versions}")
    return found


def newest_seed():
    """``(version, migration_name, module)`` of the newest seed migration."""
    seeds = seed_migrations()
    if not seeds:
        raise ValueError("no rate-card seed migration found")
    return seeds[-1]


def seed_rows(module):
    """A seed migration's ROWS as dicts keyed like ``RateCardModel``."""
    return [dict(zip(module.COLUMNS, row)) for row in module.ROWS]


def next_seed_migration_name():
    """The filename the NEXT rate card's seed migration should have.

    The number is the next free migration number in the pricing app, which
    may belong to a non-seed migration landed meanwhile; ``make
    migration-leaves`` still has the final say.
    """
    version, _, _ = newest_seed()
    numbers = [
        int(p.name[:4]) for p in MIGRATIONS_DIR.glob("[0-9][0-9][0-9][0-9]_*.py")
    ]
    return f"{max(numbers) + 1:04d}_seed_rate_card_v{version + 1}.py"

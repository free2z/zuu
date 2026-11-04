"""Find alias keys that point at more than one canonical tag.

Run this read-only check before deploying the canonical hub resolver::

    python manage.py audit_tag_alias_conflicts
    python manage.py audit_tag_alias_conflicts --fail-on-conflict

Both the indexed ``name_key`` and the source-derived :func:`tag_key` are
checked.  The latter is important because bulk/raw imports can leave the
denormalized column stale while the public read path still derives its key
from ``TagAlias.name``.
"""

from collections import defaultdict

from django.core.management.base import BaseCommand, CommandError

from dj.apps.tagging.models import TagAlias, tag_key


def _conflicts(rows, key_name, key_func):
    grouped = defaultdict(list)
    for row in rows:
        grouped[key_func(row)].append(row)
    return [
        (key_name, key, members)
        for key, members in sorted(grouped.items())
        if len({row["canonical_id"] for row in members}) > 1
    ]


class Command(BaseCommand):
    help = (
        "Find TagAlias keys that map to multiple canonical tags. Checks both "
        "the stored name_key and the source-derived tag_key."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--fail-on-conflict",
            action="store_true",
            help="Exit with an error when any conflicting key is found.",
        )

    def handle(self, *args, **options):
        rows = list(
            TagAlias.objects.order_by("pk").values(
                "pk", "name", "name_key", "canonical_id"
            )
        )
        conflicts = _conflicts(rows, "name_key", lambda row: row["name_key"])
        conflicts += _conflicts(
            rows, "tag_key", lambda row: tag_key(row["name"])
        )

        self.stdout.write(
            f"Scanned {len(rows)} tag aliases; found "
            f"{len(conflicts)} conflicting keys."
        )
        for key_name, key, members in conflicts:
            canonical_ids = sorted({row["canonical_id"] for row in members})
            aliases = ", ".join(
                f"{row['pk']}:{row['name']!r}" for row in members
            )
            self.stdout.write(self.style.ERROR(
                f"CONFLICT {key_name}={key!r}: "
                f"canonical_ids={canonical_ids}; aliases={aliases}"
            ))

        if conflicts and options["fail_on_conflict"]:
            raise CommandError(
                f"{len(conflicts)} conflicting tag-alias keys found."
            )

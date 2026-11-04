"""Repair Cantonese addressing without replacing content or historical evidence.

Fail closed on collisions, including source/translation collisions in either
storage shape even if the source mirror is absent. Never pick a winner or delete a row. See the
backend README for the inventory, dry-run and deployment coordination policy.
"""
import re

from django.db import migrations, transaction
from langcodes import Language, standardize_tag, tag_is_valid
from langcodes.tag_parser import LanguageTagError


COLUMNS = (
    ("zPage", "source_language"),
    ("zPage", "detected_language"),
    ("ZPageTranslation", "language"),
    ("ZPageVariant", "language"),
)


def canonical_yue(value):
    """Only registry-recognized yue labels; leave all other data untouched."""
    if not value or value.strip().lower().split("-", 1)[0] != "yue":
        return value
    # Freeze the current registry's validation/default for this language so
    # replaying history does not acquire future product regional defaults.
    raw = value.strip()
    if len(raw) > 35 or not re.fullmatch(r"[A-Za-z0-9]{1,8}(-[A-Za-z0-9]{1,8})*", raw):
        return value
    try:
        tag = standardize_tag(raw)
        if len(tag) > 35 or not tag_is_valid(tag) or any(len(part) == 1 for part in tag.split("-")):
            return value
        parsed = Language.get(tag)
    except LanguageTagError:
        return value
    rebuilt = "-".join(part for part in (
        parsed.language, parsed.script, parsed.territory, *(parsed.variants or ()),
    ) if part)
    if parsed.language != "yue" or rebuilt.casefold() != tag.casefold():
        return value
    return "yue-Hant" if tag == "yue" else tag


def plan(apps, alias):
    """Read-only preflight shared by the dry-run and the locked migration.

    Store distinct labels/counts, not content. Inspect all languages for affected
    pages so an existing canonical destination cannot hide from the preflight.
    """
    changes = []
    for name, field in COLUMNS:
        model = apps.get_model("g12f", name)
        labels = model.objects.using(alias).order_by().values_list(field, flat=True).distinct()
        for old in sorted(labels, key=lambda value: value or ""):
            new = canonical_yue(old)
            if new != old:
                count = model.objects.using(alias).filter(**{field: old}).count()
                changes.append((name, field, old, new, count))

    affected = set()
    for name, field, old, new, count in changes:
        if field == "detected_language":
            continue  # metadata, not a variant identity
        model = apps.get_model("g12f", name)
        key = "pk" if name == "zPage" else "zpage_id"
        affected.update(model.objects.using(alias).filter(**{field: old}).values_list(key, flat=True))

    collisions = []
    # Batch the IN lists and row scans. Distinct labels, affected page IDs
    # and collision diagnostics are retained for the complete preflight.
    affected = sorted(affected)
    for offset in range(0, len(affected), 500):
        page_ids = affected[offset:offset + 500]
        legacy = {}
        sources = {}
        for name in ("zPage", "ZPageTranslation", "ZPageVariant"):
            model = apps.get_model("g12f", name)
            source = name == "zPage"
            field = "source_language" if source else "language"
            key = "pk" if source else "zpage_id"
            seen = legacy if name != "ZPageVariant" else {}
            rows = model.objects.using(alias).filter(**{key + "__in": page_ids}).order_by("pk")
            fields = ("pk", key, field)
            if name == "ZPageVariant":
                fields += ("origin",)
            for row in rows.values_list(*fields):
                pk, page_id, language = row[:3]
                canonical = canonical_yue(language)
                identity = (page_id, canonical)
                previous_rows = [seen.get(identity)]
                if name == "ZPageVariant" and row[3] != "source":
                    # A human/AI variant is distinct from the source even if
                    # no source mirror exists. Keep variant/translation mirrors
                    # allowed; only the source identity crosses this boundary.
                    previous_rows.append(sources.get(identity))
                for previous in previous_rows:
                    if previous and (language != canonical or previous[2] != canonical):
                        collisions.append(
                            f"page={page_id} language={canonical!r}: "
                            f"{previous[0]}#{previous[1]} ({previous[2]!r}) / "
                            f"{name}#{pk} ({language!r})"
                        )
                seen[identity] = (name, pk, language)
                if source:
                    sources[identity] = (name, pk, language)
    return changes, collisions


def forwards(apps, schema_editor):
    alias = schema_editor.connection.alias
    # Also atomic when explicitly re-run by an operator/test. SHARE ROW
    # EXCLUSIVE blocks concurrent INSERT/UPDATE/DELETE but permits readers.
    with transaction.atomic(using=alias):
        with schema_editor.connection.cursor() as cursor:
            cursor.execute("SET LOCAL lock_timeout = '3s'")
            tables = sorted({apps.get_model("g12f", name)._meta.db_table for name, _ in COLUMNS})
            quoted = ", ".join(schema_editor.quote_name(table) for table in tables)
            cursor.execute(f"LOCK TABLE {quoted} IN SHARE ROW EXCLUSIVE MODE")
        changes, collisions = plan(apps, alias)
        if collisions:
            raise RuntimeError("Cantonese language collisions; no rows changed:\n" + "\n".join(collisions))
        for name, field, old, new, count in changes:
            # QuerySet.update avoids save hooks, dual writes, auto_now, paid
            # work, publication events and history mutation. Primary keys stay.
            apps.get_model("g12f", name).objects.using(alias).filter(
                **{field: old}
            ).update(**{field: new})


class Migration(migrations.Migration):
    dependencies = [("g12f", "0121_creator_deletion_schedule")]
    operations = [
        # No lossy reverse: cannot distinguish originally canonical rows from
        # relabelled rows. Rollback leaves these valid canonical tags in place.
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]

import re
import unicodedata

import django.db.models.deletion
from django.db import migrations, models, transaction


# This migration must remain self-contained.  Importing the live models or
# slug helper makes a future Unicode-rule change silently change the meaning
# of an already-applied migration.  These functions are the rules that were
# shipped with 0003, frozen here for replay and rollback tooling.
_KEEP_CATEGORIES = frozenset("LNM")
_DASH_RUN_RE = re.compile(r"-{2,}")
_SLUG_MAX_LENGTH = 200


def _migration_tag_key(name):
    return " ".join((name or "").split()).casefold()[:300]


def _migration_slugify_tag(name):
    text = unicodedata.normalize("NFC", name or "")
    text = unicodedata.normalize("NFC", text.lower())
    slug = "".join(
        character
        if unicodedata.category(character)[0] in _KEEP_CATEGORIES
        else "-"
        for character in text
    )
    slug = _DASH_RUN_RE.sub("-", slug).strip("-")
    if len(slug) > _SLUG_MAX_LENGTH:
        slug = slug[:_SLUG_MAX_LENGTH]
        boundary = slug.rfind("-")
        if boundary > 0:
            slug = slug[:boundary]
        slug = slug.strip("-")
    return slug


class AddFieldIfMissing(migrations.AddField):
    """Apply an AddField again after a non-atomic migration interruption."""

    def database_forwards(
        self, app_label, schema_editor, from_state, to_state
    ):
        model = from_state.apps.get_model(app_label, self.model_name)
        field = to_state.apps.get_model(
            app_label, self.model_name
        )._meta.get_field(self.name)
        with schema_editor.connection.cursor() as cursor:
            columns = schema_editor.connection.introspection.get_table_description(
                cursor, model._meta.db_table
            )
        if any(column.name == field.column for column in columns):
            return
        super().database_forwards(
            app_label, schema_editor, from_state, to_state
        )


class CreateModelIfMissing(migrations.CreateModel):
    """Apply a CreateModel again after its table already committed."""

    def database_forwards(
        self, app_label, schema_editor, from_state, to_state
    ):
        model = to_state.apps.get_model(app_label, self.name)
        with schema_editor.connection.cursor() as cursor:
            tables = schema_editor.connection.introspection.table_names(cursor)
        if model._meta.db_table in tables:
            return
        super().database_forwards(
            app_label, schema_editor, from_state, to_state
        )


def populate_tag_identity(apps, schema_editor):
    Tag = apps.get_model("taggit", "Tag")
    TagAlias = apps.get_model("tagging", "TagAlias")
    TagIdentity = apps.get_model("tagging", "TagIdentity")
    db = schema_editor.connection.alias

    # 0003 is deliberately non-atomic so a large corpus does not hold every
    # Tag row lock until the migration finishes.  Each batch locks its source
    # rows before deriving values.  A rolling new pod's post_save upsert must
    # wait on the same Tag row and therefore cannot insert a newer identity
    # which this batch subsequently overwrites with an older name.
    last_pk = 0
    while True:
        with transaction.atomic(using=db):
            batch = list(
                Tag.objects.using(db)
                .select_for_update()
                .filter(pk__gt=last_pk)
                .order_by("pk")[:1000]
            )
            if not batch:
                break
            desired = {
                tag.pk: (
                    _migration_tag_key(tag.name),
                    _migration_slugify_tag(tag.name),
                )
                for tag in batch
            }
            identities = [
                TagIdentity(
                    tag_id=tag.pk,
                    name_key=desired[tag.pk][0],
                    slug=desired[tag.pk][1],
                )
                for tag in batch
            ]
            # A new-code signal may have populated a row after the table was
            # created but before this batch acquired the Tag lock.  The
            # conflict is harmless; the locked source row and the following
            # update make the result deterministic and current.
            TagIdentity.objects.using(db).bulk_create(
                identities, batch_size=1000, ignore_conflicts=True
            )
            identities = list(
                TagIdentity.objects.using(db)
                .filter(tag_id__in=desired)
                .order_by("tag_id")
            )
            for identity in identities:
                identity.name_key, identity.slug = desired[identity.tag_id]
            TagIdentity.objects.using(db).bulk_update(
                identities, ["name_key", "slug"], batch_size=1000
            )
            last_pk = batch[-1].pk

    # Old application images did not know about `slug`, and data imports can
    # still create rows whose derived projections are stale. Repair BOTH
    # columns from the source name. New application images can write rows after
    # this point; TagAlias.save() supplies the same values, while the repair
    # command remains available for old bulk imports.
    last_alias_pk = 0
    while True:
        with transaction.atomic(using=db):
            aliases = list(
                TagAlias.objects.using(db)
                .select_for_update()
                .filter(pk__gt=last_alias_pk)
                .order_by("pk")[:1000]
            )
            if not aliases:
                break
            for alias in aliases:
                alias.name_key = _migration_tag_key(alias.name)
                alias.slug = _migration_slugify_tag(alias.name)
            TagAlias.objects.using(db).bulk_update(
                aliases, ["name_key", "slug"], batch_size=1000
            )
            # A punctuation-only alias intentionally derives to the empty
            # slug. Advance by primary key so valid empty projections and a
            # retry after an interrupted non-atomic run both make progress.
            last_alias_pk = aliases[-1].pk

class Migration(migrations.Migration):
    dependencies = [
        ("tagging", "0002_tagalias_normalization_run"),
    ]

    operations = [
        AddFieldIfMissing(
            model_name="tagalias",
            name="slug",
            field=models.CharField(
                blank=True,
                db_default="",
                db_index=True,
                default="",
                max_length=200,
            ),
        ),
        CreateModelIfMissing(
            name="TagIdentity",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                (
                    "name_key",
                    models.CharField(db_index=True, max_length=300),
                ),
                (
                    "slug",
                    models.CharField(
                        blank=True,
                        db_index=True,
                        default="",
                        max_length=200,
                    ),
                ),
                (
                    "tag",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="tag_identity",
                        to="taggit.tag",
                    ),
                ),
            ],
        ),
        migrations.RunPython(
            populate_tag_identity,
            migrations.RunPython.noop,
        ),
    ]

    # See populate_tag_identity: per-batch transactions are the rollout
    # compatibility mechanism for old images (which do not maintain the new
    # projections) and new images (whose signal upserts wait on each locked
    # source row).  The public read path also verifies source tags and can
    # repair drift, so a deploy may safely straddle this migration.
    atomic = False

"""Create ZPageVariant (#980 M1, step 3 of 4).

The target shape from #980 §3.1: one row per language per zPage, including the
source. Empty on creation, so the table, both uniqueness constraints and the
lookup index all build instantly and take no lock on anything that is being
read or written concurrently.

Kept atomic (unlike the backfill that follows) for the same reason 0090 was:
table creation, its constraints and its migration record either all commit or
all roll back, so a failed deploy leaves nothing half-built for the retry to
trip over.

The two constraints are the whole design:

``uniq_zpage_variant_language``
    One row per language per page. This is what makes ``?lang=xx`` a lookup
    instead of a resolution algorithm.

``uniq_zpage_source_variant``
    A *partial* unique index — ``UNIQUE (zpage_id) WHERE origin = 'source'`` —
    so at most one variant per page is the original. This is what makes
    "change the source language" a single-row UPDATE rather than a
    reconciliation between two tables, which is the root cause #980 §1.5
    identifies for the immutable ``source_language``.

``ai_model`` is ``SET_NULL``: retiring or reseeding an ``AIModel`` must never
cascade into deleting a creator's content.
"""
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("g12f", "0098_zpage_detection_columns"),
        # The ai_model FK. Pinned at the current openai leaf so the FK target
        # is guaranteed to exist when this runs.
        ("openai", "0016_seed_multiprovider_ai_models"),
    ]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout = '3s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.CreateModel(
            name="ZPageVariant",
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
                    "language",
                    models.CharField(
                        help_text=(
                            "BCP-47 tag, validated against f2z.languages."
                        ),
                        max_length=35,
                    ),
                ),
                ("title", models.CharField(max_length=128)),
                ("description", models.CharField(blank=True, max_length=255)),
                ("content", models.TextField(max_length=100000)),
                (
                    "is_published",
                    models.BooleanField(db_index=True, default=False),
                ),
                (
                    "origin",
                    models.CharField(
                        choices=[
                            ("source", "Source"),
                            ("human", "Human translation"),
                            ("ai", "AI translation"),
                        ],
                        default="human",
                        help_text=(
                            "Where this variant's text came from. Exactly one "
                            "variant per zPage is the source."
                        ),
                        max_length=16,
                    ),
                ),
                (
                    "source_digest",
                    models.CharField(
                        blank=True,
                        help_text=(
                            "SHA-256 of the source variant's content this "
                            "variant was translated from. Three states, and "
                            "callers MUST honour all three: NULL on the "
                            "source variant itself (it has no source); NULL "
                            "on a variant whose provenance we never recorded "
                            "(every row the #980 M2 backfill created from a "
                            "legacy ZPageTranslation) -- that is *unknown*, "
                            "not *stale*; and a digest that either matches "
                            "the current source content (fresh) or does not "
                            "(stale). Rendering NULL as 'Stale' would fire on "
                            "~100% of existing translations, which is the "
                            "#805 mistake."
                        ),
                        max_length=64,
                        null=True,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "ai_model",
                    models.ForeignKey(
                        blank=True,
                        help_text=(
                            "The model that produced this variant, when "
                            "origin='ai'. SET_NULL because retiring a model "
                            "must never delete a creator's content."
                        ),
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="openai.aimodel",
                    ),
                ),
                (
                    "zpage",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="variants",
                        to="g12f.zpage",
                    ),
                ),
            ],
            options={"ordering": ["language"]},
        ),
        migrations.AddConstraint(
            model_name="zpagevariant",
            constraint=models.UniqueConstraint(
                fields=("zpage", "language"),
                name="uniq_zpage_variant_language",
            ),
        ),
        migrations.AddConstraint(
            model_name="zpagevariant",
            constraint=models.UniqueConstraint(
                condition=models.Q(("origin", "source")),
                fields=("zpage",),
                name="uniq_zpage_source_variant",
            ),
        ),
        migrations.AddIndex(
            model_name="zpagevariant",
            index=models.Index(
                fields=["zpage", "is_published"],
                name="g12f_zpage_variant_pub_idx",
            ),
        ),
    ]

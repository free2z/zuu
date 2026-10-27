"""Detection provenance columns on zPage (#980 M1, step 2 of 4).

Four nullable columns recording how we learned a page's language. Nothing
reads or writes them in this wave — the detector that fills them is P5/wave 2c
— so this is a pure schema addition with zero behavioral surface.

They are added now, with the rest of the schema, for one reason: adding a
column takes ACCESS EXCLUSIVE on ``g12f_zpage``, and doing it once as part of a
migration series that already has that lock in hand is cheaper and less risky
than a second exclusive-lock deploy against the same table later.

Cost in PostgreSQL 11+: catalog-only. A nullable column with no default is
recorded in ``pg_attribute`` and never touches a heap page, so this is O(1)
regardless of table size.
"""
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("g12f", "0097_widen_language_columns")]

    operations = [
        migrations.RunSQL(
            "SET LOCAL lock_timeout = '3s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.AddField(
            model_name="zpage",
            name="detected_language",
            field=models.CharField(
                blank=True,
                help_text=(
                    "Most recent machine-detected language of the source "
                    "text."
                ),
                max_length=35,
                null=True,
            ),
        ),
        migrations.AddField(
            model_name="zpage",
            name="detection_confidence",
            field=models.FloatField(
                blank=True,
                help_text=(
                    "Detector confidence, 0.0-1.0. Low confidence is not an "
                    "error: it drives a soft 'is this right?' affordance, "
                    "never a block."
                ),
                null=True,
            ),
        ),
        migrations.AddField(
            model_name="zpage",
            name="detected_at",
            field=models.DateTimeField(
                blank=True,
                help_text="When detection last ran. NULL means it never has.",
                null=True,
            ),
        ),
        migrations.AddField(
            model_name="zpage",
            name="language_source",
            field=models.CharField(
                blank=True,
                choices=[("detected", "Detected"), ("creator", "Creator")],
                help_text=(
                    "Whether source_language came from the detector or from "
                    "the creator. A creator override is never overwritten by "
                    "a later detection."
                ),
                max_length=16,
                null=True,
            ),
        ),
    ]

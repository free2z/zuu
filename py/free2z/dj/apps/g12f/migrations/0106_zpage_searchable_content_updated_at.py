"""Issue #511 — separate search freshness from general page activity.

``zPage.updated_at`` is a reader-facing activity timestamp and is refreshed by
metadata/settings saves. Search freshness must instead describe the title and
body that the full-text path actually searches. The nullable field makes the
schema additive during a rolling deploy; existing rows safely fall back to
their immutable creation time rather than trusting the historically
over-broad ``updated_at`` value. Existing rows are intentionally not backfilled:
that would make metadata activity look like searchable-content activity. The
resulting demotion of legacy rows until their next title/body edit is a
deliberate rollout behavior.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("g12f", "0105_creator_kt_account_epoch"),
    ]

    operations = [
        migrations.AddField(
            model_name="zpage",
            name="searchable_content_updated_at",
            field=models.DateTimeField(
                blank=True,
                editable=False,
                help_text=(
                    "Most recent change to the title or body used by search "
                    "ranking. NULL is retained as a safe fallback for rolling "
                    "deployments."
                ),
                null=True,
            ),
        ),
    ]

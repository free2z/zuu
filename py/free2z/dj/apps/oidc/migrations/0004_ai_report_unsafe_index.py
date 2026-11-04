# A partial index for the AI-output-report surge count.
#
# Both readers of unsafe reports filter exactly `reason = 'unsafe'` and a
# trailing-hour `unsafe_at` window: `ai_reports._paid_unsafe_reporters`
# (`application_id = %s AND reason = 'unsafe' AND unsafe_at >= now() - 1h`,
# run on every unsafe submission) and the 5-minute sweep
# `ai_reports.reevaluate_surges` (`reason = 'unsafe' AND unsafe_at >= since`).
# Before this, the count walked every report of the app through the
# (application, -created_at) index, which cannot bound an old report that was
# escalated recently. The index's WHERE is the readers' predicate verbatim.
#
# The table is new (oidc 0002) and small, but CONCURRENTLY costs nothing and
# never blocks report intake; it is this repo's established pattern
# (g12f 0094/0095, uploads 0015). PostgreSQL forbids CONCURRENTLY inside a
# transaction, hence atomic=False. A failed concurrent build leaves an INVALID
# index behind; the leading DROP ... IF EXISTS lets a re-run of the deploy
# clean that up and retry, including the window where the DDL committed but
# Django's migration record did not.

from django.db import migrations, models
from django.db.models import Q


INDEX_NAME = "oidc_aireport_app_unsafe"


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("oidc", "0003_application_child_directed"),
    ]

    operations = [
        migrations.RunSQL(
            "SET lock_timeout = '3s';",
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunSQL(
                    f"DROP INDEX CONCURRENTLY IF EXISTS {INDEX_NAME};",
                    reverse_sql=migrations.RunSQL.noop,
                ),
                migrations.RunSQL(
                    f"CREATE INDEX CONCURRENTLY {INDEX_NAME} "
                    "ON oidc_aioutputreport (application_id, unsafe_at) "
                    "WHERE reason = 'unsafe';",
                    reverse_sql=f"DROP INDEX CONCURRENTLY IF EXISTS {INDEX_NAME};",
                ),
            ],
            state_operations=[
                migrations.AddIndex(
                    model_name="aioutputreport",
                    index=models.Index(
                        fields=["application", "unsafe_at"],
                        name=INDEX_NAME,
                        condition=Q(reason="unsafe"),
                    ),
                ),
            ],
        ),
        # Session-level SET (atomic=False): restore it, or every later
        # migration in this deploy would inherit the 3s budget.
        migrations.RunSQL(
            "RESET lock_timeout;",
            reverse_sql=migrations.RunSQL.noop,
        ),
    ]

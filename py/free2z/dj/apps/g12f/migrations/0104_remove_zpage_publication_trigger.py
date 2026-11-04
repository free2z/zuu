from django.db import migrations


LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '3s';"
DROP_TRIGGER_SQL = (
    "DROP TRIGGER IF EXISTS g12f_zpage_publication_timestamp "
    "ON g12f_zpage;"
)

# The trigger stays installed during the migration/deploy phase. Cloud Build
# removes it only after the new deployment passes its exact healthcheck, so a
# failed rollout can roll code back without leaving old pods unprotected.
PUBLICATION_FUNCTION_SQL = """
CREATE OR REPLACE FUNCTION g12f_set_zpage_published_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.is_published AND NEW.published_at IS NULL THEN
            NEW.published_at := CURRENT_TIMESTAMP;
        END IF;
    ELSIF OLD.is_published THEN
        -- Normal ORM saves include is_published even when its value did not
        -- change. Preserve the original event through edits and unpublishes;
        -- a legacy published row has created_at as its only durable fallback.
        NEW.published_at := COALESCE(
            OLD.published_at,
            OLD.created_at,
            CURRENT_TIMESTAMP
        );
    ELSIF NEW.is_published THEN
        -- First draft -> published transition. A new task/model writer may
        -- provide its capture time, while a rolling old pod gets DB time.
        -- If this is a re-publication, OLD.published_at wins permanently.
        NEW.published_at := COALESCE(
            OLD.published_at,
            NEW.published_at,
            CURRENT_TIMESTAMP
        );
    END IF;
    RETURN NEW;
END;
$$;
"""
CREATE_TRIGGER_SQL = """
CREATE TRIGGER g12f_zpage_publication_timestamp
BEFORE INSERT OR UPDATE OF is_published ON g12f_zpage
FOR EACH ROW EXECUTE FUNCTION g12f_set_zpage_published_at();
"""


def leave_publication_trigger_in_place(apps, schema_editor):
    # Deliberately a no-op. This migration is the durable marker that the
    # application-side invariant is ready; the destructive DDL belongs to the
    # post-healthcheck deployment step.
    return None


def restore_publication_trigger(apps, schema_editor):
    connection = schema_editor.connection
    with connection.cursor() as cursor:
        cursor.execute(LOCK_TIMEOUT_SQL)
        # Forward migration intentionally leaves the trigger in place, so a
        # normal downgrade must also be safe when it is still present.
        cursor.execute(DROP_TRIGGER_SQL)
        cursor.execute(PUBLICATION_FUNCTION_SQL)
        cursor.execute(CREATE_TRIGGER_SQL)


class Migration(migrations.Migration):
    dependencies = [("g12f", "0103_pageorder_unique_series_page")]

    operations = [
        migrations.RunPython(
            leave_publication_trigger_in_place,
            restore_publication_trigger,
        ),
    ]

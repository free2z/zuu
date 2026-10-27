from django.db import migrations, models, transaction
from django.db.models import F
from django.db.models.functions import Coalesce


BATCH_SIZE = 500
PUBLICATION_INDEX_NAME = "g12f_zpage_pub_published_idx"
CHRONOLOGICAL_INDEX_NAME = "g12f_zpage_chrono_idx"
CREATOR_CHRONOLOGICAL_INDEX_NAME = "g12f_zpage_creator_chrono_idx"
LOCK_TIMEOUT = "3s"
LOCK_TIMEOUT_SQL = f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}';"
# Each concurrent DROP/CREATE gets a deployment-scale wall-clock cap. The
# Cloud Build deployment has a two-hour ceiling; even a retry that needs all
# six statements is bounded to 90 minutes, leaving time for the short,
# separately lock-bounded trigger/backfill work. This is intentionally not the
# three-second request-scale lock wait: a concurrent index build does not queue
# ordinary zPage reads/writes while it waits for an old snapshot to end.
CONCURRENT_INDEX_STATEMENT_TIMEOUT = "15min"

# The partial public index is ideal for anonymous/public feeds. Logged-in
# non-mine feeds additionally include the requester's drafts, so their
# ``is_published OR creator_id`` predicate needs an all-row ordering index.
# A creator-leading version covers an own-profile feed without walking that
# global index until it happens to encounter the creator's pages.
INDEX_SPECS = (
    (
        PUBLICATION_INDEX_NAME,
        "CREATE INDEX CONCURRENTLY "
        f"{PUBLICATION_INDEX_NAME} ON g12f_zpage "
        "((COALESCE(published_at, created_at)) DESC, id DESC) "
        "WHERE is_published;",
        ("COALESCE(published_at, created_at)", "id DESC"),
        "is_published",
    ),
    (
        CHRONOLOGICAL_INDEX_NAME,
        "CREATE INDEX CONCURRENTLY "
        f"{CHRONOLOGICAL_INDEX_NAME} ON g12f_zpage "
        "((COALESCE(published_at, created_at)) DESC, id DESC);",
        ("COALESCE(published_at, created_at)", "id DESC"),
        None,
    ),
    (
        CREATOR_CHRONOLOGICAL_INDEX_NAME,
        "CREATE INDEX CONCURRENTLY "
        f"{CREATOR_CHRONOLOGICAL_INDEX_NAME} ON g12f_zpage "
        "(creator_id, (COALESCE(published_at, created_at)) DESC, id DESC);",
        ("creator_id", "COALESCE(published_at, created_at)", "id DESC"),
        None,
    ),
)


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
DROP_TRIGGER_SQL = (
    "DROP TRIGGER IF EXISTS g12f_zpage_publication_timestamp "
    "ON g12f_zpage;"
)
CREATE_TRIGGER_SQL = """
CREATE TRIGGER g12f_zpage_publication_timestamp
BEFORE INSERT OR UPDATE OF is_published ON g12f_zpage
FOR EACH ROW EXECUTE FUNCTION g12f_set_zpage_published_at();
"""
DROP_FUNCTION_SQL = "DROP FUNCTION IF EXISTS g12f_set_zpage_published_at();"


def _set_local_lock_timeout(connection):
    """Bound a lock wait inside the caller's short transaction."""
    with connection.cursor() as cursor:
        cursor.execute(LOCK_TIMEOUT_SQL)


def install_publication_trigger(apps, schema_editor):
    """Install the rollout guard in one lock-bounded atomic operation.

    The trigger is intentionally stricter than the model: bulk updates and
    old pods bypass ``zPage.save()``. It also means an ordinary ORM/admin save
    cannot repair a stored timestamp, because Django writes ``is_published``
    on every save and the trigger restores the original value. A deliberate
    data correction must therefore be a reviewed direct UPDATE that omits
    ``is_published`` (or a controlled trigger disable/reinstall), never an
    incidental edit that can race a stale deployment writer.
    """
    connection = schema_editor.connection
    with transaction.atomic(using=connection.alias):
        _set_local_lock_timeout(connection)
        with connection.cursor() as cursor:
            cursor.execute(PUBLICATION_FUNCTION_SQL)
            cursor.execute(DROP_TRIGGER_SQL)
            cursor.execute(CREATE_TRIGGER_SQL)


def remove_publication_trigger(apps, schema_editor):
    """Reverse trigger installation with the same bounded table lock wait."""
    connection = schema_editor.connection
    with transaction.atomic(using=connection.alias):
        _set_local_lock_timeout(connection)
        with connection.cursor() as cursor:
            cursor.execute(DROP_TRIGGER_SQL)
            cursor.execute(DROP_FUNCTION_SQL)


def backfill_published_at(apps, schema_editor):
    """Give existing published rows a stable, conservative timestamp.

    The trigger is installed first, so rows written after the initial primary
    key snapshot get a real publication timestamp and cannot make this loop
    grow forever. Existing rows are selected and updated in small committed
    batches. Every batch rechecks both publication state and NULL-ness under
    row locks, so a concurrent publisher cannot be overwritten with a legacy
    ``created_at`` fallback. A blocked row makes this deploy attempt fail
    within the lock budget; the idempotent next attempt resumes safely.
    """
    ZPage = apps.get_model("g12f", "zPage")
    connection = schema_editor.connection
    db_alias = connection.alias
    queryset = ZPage.objects.using(db_alias)

    # Protect even the snapshot query from sitting behind a queued DDL lock.
    with transaction.atomic(using=db_alias):
        _set_local_lock_timeout(connection)
        last_existing_pk = queryset.order_by("-pk").values_list(
            "pk", flat=True,
        ).first()
    if last_existing_pk is None:
        return

    last_pk = 0
    while True:
        # Keep each batch transactional but independent: a restart sees only
        # the rows that are still NULL, while normal writers keep short waits.
        with transaction.atomic(using=db_alias):
            _set_local_lock_timeout(connection)
            page_ids = list(
                queryset.select_for_update().filter(
                    pk__gt=last_pk,
                    pk__lte=last_existing_pk,
                    is_published=True,
                    published_at__isnull=True,
                ).order_by("pk").values_list("pk", flat=True)[:BATCH_SIZE]
            )
            if not page_ids:
                return
            queryset.filter(
                pk__in=page_ids,
                is_published=True,
                published_at__isnull=True,
            ).update(published_at=F("created_at"))
            last_pk = page_ids[-1]


def sweep_remaining_published_at(apps, schema_editor):
    """Close the rollout window with a bounded, normally empty final sweep.

    The trigger handles rows written after the snapshot, so successful batches
    leave this UPDATE empty in the normal case. It remains as a guarded
    defensive catch for a write that committed in the tiny field/trigger
    handoff window; its transaction-local timeout ensures it never leaves a
    session setting behind or waits forever behind an incompatible lock.
    """
    ZPage = apps.get_model("g12f", "zPage")
    connection = schema_editor.connection
    with transaction.atomic(using=connection.alias):
        _set_local_lock_timeout(connection)
        ZPage.objects.using(connection.alias).filter(
            is_published=True,
            published_at__isnull=True,
        ).update(published_at=F("created_at"))


def _run_concurrent_index_sql(connection, statement):
    """Run bounded concurrent DDL without a session-GUC leak.

    A concurrent index build may need to wait for pre-existing transaction
    snapshots, but unlike the short atomic DDL above it does *not* queue normal
    readers or writers behind an ACCESS EXCLUSIVE table lock. Giving that safe
    wait the migration's three-second lock timeout made routine live traffic
    cancel deployments. Disable only that lock timeout, and apply a
    deployment-scale statement timeout that caps the *whole* concurrent
    operation (snapshot wait plus build) instead. Restore both connection
    settings in ``finally`` so the non-atomic migration cannot poison a pooled
    test or deployment connection.
    """
    with connection.cursor() as cursor:
        cursor.execute("SHOW lock_timeout")
        previous_lock_timeout = cursor.fetchone()[0]
        cursor.execute("SHOW statement_timeout")
        previous_statement_timeout = cursor.fetchone()[0]
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT set_config('lock_timeout', %s, false)",
                ["0"],
            )
            cursor.execute(
                "SELECT set_config('statement_timeout', %s, false)",
                [CONCURRENT_INDEX_STATEMENT_TIMEOUT],
            )
            cursor.execute(statement)
    finally:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT set_config('statement_timeout', %s, false)",
                [previous_statement_timeout],
            )
            cursor.execute(
                "SELECT set_config('lock_timeout', %s, false)",
                [previous_lock_timeout],
            )


def _index_is_current(connection, name, definition_parts, predicate):
    """Return whether a named index is valid, ready, and has our shape.

    A process can die after ``CREATE INDEX CONCURRENTLY`` commits and before
    Django records this migration. Preserve that valid completed work on a
    retry. An invalid leftover (or a surprising same-name manual index) is
    safely replaced instead of being mistaken for the desired support index.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT i.indisvalid, i.indisready,
                   pg_get_indexdef(i.indexrelid),
                   pg_get_expr(i.indpred, i.indrelid)
            FROM pg_index i
            JOIN pg_class index_class ON index_class.oid = i.indexrelid
            JOIN pg_class table_class ON table_class.oid = i.indrelid
            WHERE index_class.relname = %s
              AND table_class.relname = 'g12f_zpage'
            """,
            [name],
        )
        row = cursor.fetchone()
    if row is None:
        return False

    valid, ready, definition, actual_predicate = row
    return (
        valid
        and ready
        and all(part in definition for part in definition_parts)
        and (
            actual_predicate is None
            if predicate is None
            else (
                actual_predicate is not None
                and predicate in actual_predicate
            )
        )
    )


def rebuild_publication_indexes(apps, schema_editor):
    """Build missing/invalid feed indexes without dropping valid retries."""
    connection = schema_editor.connection
    for name, create_sql, definition_parts, predicate in INDEX_SPECS:
        if _index_is_current(
            connection, name, definition_parts, predicate,
        ):
            continue
        # ``IF EXISTS`` handles either an invalid partial build or an
        # unexpected valid-but-wrong same-name index. A valid expected index
        # never reaches this branch, so a retry cannot create an indexless
        # window after a previous successful deployment attempt.
        _run_concurrent_index_sql(
            connection,
            f"DROP INDEX CONCURRENTLY IF EXISTS {name};",
        )
        _run_concurrent_index_sql(connection, create_sql)


def drop_publication_indexes(apps, schema_editor):
    connection = schema_editor.connection
    for name, _, _, _ in reversed(INDEX_SPECS):
        _run_concurrent_index_sql(
            connection,
            f"DROP INDEX CONCURRENTLY IF EXISTS {name};",
        )


class Migration(migrations.Migration):
    """Complete a restart-safe, low-lock publication timestamp rollout.

    ``0101`` commits only the nullable compatibility column. This non-atomic
    migration then installs the DB-level old-pod guard under a short bounded
    lock, backfills legacy published rows in restartable 500-row transactions,
    and builds matching public, authenticated-homepage, and creator-profile
    expression indexes concurrently. Concurrent builds deliberately wait for
    old transaction snapshots rather than inheriting the three-second DDL lock
    timeout. Each is bounded by a 15-minute statement timeout and preserves
    the connection's prior lock/statement settings even when it fails, avoiding
    a session-level timeout leak into unrelated work.
    """

    atomic = False

    dependencies = [("g12f", "0101_zpage_published_at")]

    operations = [
        migrations.RunPython(
            install_publication_trigger,
            remove_publication_trigger,
            atomic=False,
        ),
        migrations.RunPython(
            backfill_published_at,
            migrations.RunPython.noop,
            atomic=False,
        ),
        migrations.RunPython(
            sweep_remaining_published_at,
            migrations.RunPython.noop,
            atomic=False,
        ),
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunPython(
                    rebuild_publication_indexes,
                    drop_publication_indexes,
                    atomic=False,
                ),
            ],
            state_operations=[
                migrations.AddIndex(
                    model_name="zpage",
                    index=models.Index(
                        Coalesce("published_at", "created_at").desc(),
                        models.F("id").desc(),
                        condition=models.Q(is_published=True),
                        name=PUBLICATION_INDEX_NAME,
                    ),
                ),
                migrations.AddIndex(
                    model_name="zpage",
                    index=models.Index(
                        Coalesce("published_at", "created_at").desc(),
                        models.F("id").desc(),
                        name=CHRONOLOGICAL_INDEX_NAME,
                    ),
                ),
                migrations.AddIndex(
                    model_name="zpage",
                    index=models.Index(
                        models.F("creator_id"),
                        Coalesce("published_at", "created_at").desc(),
                        models.F("id").desc(),
                        name=CREATOR_CHRONOLOGICAL_INDEX_NAME,
                    ),
                ),
            ],
        ),
    ]

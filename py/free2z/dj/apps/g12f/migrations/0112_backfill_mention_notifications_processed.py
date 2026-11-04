from django.db import migrations, transaction
from django.db.models import F


BATCH_SIZE = 500
LOCK_TIMEOUT = "3s"


def _set_local_lock_timeout(connection):
    with connection.cursor() as cursor:
        cursor.execute(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'")


def mark_historical_publications_processed(apps, schema_editor):
    ZPage = apps.get_model("g12f", "zPage")
    connection = schema_editor.connection
    queryset = ZPage.objects.using(connection.alias)
    with transaction.atomic(using=connection.alias):
        _set_local_lock_timeout(connection)
        max_pk = (
            queryset.filter(published_at__isnull=False)
            .order_by("-pk").values_list("pk", flat=True).first()
        )
    if max_pk is None:
        return
    last_pk = 0
    while True:
        with transaction.atomic(using=connection.alias):
            _set_local_lock_timeout(connection)
            ids = list(
                queryset.select_for_update().filter(
                    pk__gt=last_pk, pk__lte=max_pk,
                    published_at__isnull=False,
                    mention_notifications_processed_at__isnull=True,
                ).order_by("pk").values_list("pk", flat=True)[:BATCH_SIZE]
            )
            if not ids:
                return
            queryset.filter(
                pk__in=ids, published_at__isnull=False,
                mention_notifications_processed_at__isnull=True,
            ).update(mention_notifications_processed_at=F("published_at"))
            last_pk = ids[-1]


class Migration(migrations.Migration):
    atomic = False
    dependencies = [("g12f", "0111_creator_mention_notifications_enabled_and_more")]
    operations = [
        migrations.RunPython(mark_historical_publications_processed, migrations.RunPython.noop),
    ]

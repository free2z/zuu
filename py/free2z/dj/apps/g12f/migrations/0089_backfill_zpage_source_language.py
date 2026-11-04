from django.db import migrations


BATCH_SIZE = 500


def label_existing_zpages_as_undetermined(apps, schema_editor):
    ZPage = apps.get_model("g12f", "zPage")
    last_existing_pk = ZPage.objects.order_by("-pk").values_list(
        "pk", flat=True
    ).first()
    if last_existing_pk is None:
        return

    # This migration is deliberately non-atomic. Commit small, idempotent
    # batches so editors are never blocked behind a table-wide UPDATE. Rows
    # inserted by old pods already receive the database default from 0088 and
    # therefore cannot be swept into the legacy `und` set, even after a retry.
    while True:
        page_ids = list(
            ZPage.objects.filter(
                pk__lte=last_existing_pk,
                source_language__isnull=True,
            ).order_by("pk").values_list("pk", flat=True)[:BATCH_SIZE]
        )
        if not page_ids:
            return
        ZPage.objects.filter(pk__in=page_ids).update(source_language="und")


class Migration(migrations.Migration):
    # A failed process can rerun the data operation: it only changes rows that
    # are still NULL, and 0088 has already been durably recorded.
    atomic = False

    dependencies = [("g12f", "0088_add_zpage_source_language")]

    operations = [
        migrations.RunPython(
            label_existing_zpages_as_undetermined,
            migrations.RunPython.noop,
        ),
    ]

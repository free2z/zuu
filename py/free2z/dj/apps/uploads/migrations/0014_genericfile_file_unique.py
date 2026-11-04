# #2105: one storage key, one GenericFile row.
#
# Prod had 2 duplicate groups (4 rows, 23,154 total) when this was written,
# both one creator's 2023-2024 photos: `XOZOKDIP/IMG_1628.JPG` (ids 7415,
# 13634) and `XOZOKDIP/IMG_9127.JPG` (ids 7377, 7720). The owner's rule is
# that no user row is merged, repointed or deleted automatically, so instead
# of deduping, this migration:
#
#   1. adds `legacy_shared_file` (db_default FALSE -- a pod on the previous
#      release can still INSERT during the rollout);
#   2. flags every row of a pre-existing duplicate group except the oldest
#      (lowest pk), which keeps the claim on the name;
#   3. adds a UNIQUE index on `file` over the unflagged rows only;
#   4. points `upload_to` at `get_unreferenced_upload_path` (state only, no
#      DDL -- `sqlmigrate` prints nothing for it).
#
# Step 1's ALTER TABLE takes ACCESS EXCLUSIVE and holds it to the end of this
# (atomic) migration, so no row can be inserted between the scan in step 2
# and the index build in step 3 -- a concurrent duplicate cannot wedge the
# deploy. The table is ~23k rows; the lock is held for well under a second.
#
# That lock is only cheap once held. WAITING for it queues every later reader
# of the table (media auth, zPage lists joining images) behind this migration,
# so the wait is bounded: a busy table fails the deploy at a safe point
# (rolled back, nothing changed; re-run the deploy) instead of stalling the
# site behind, say, an image-generation transaction mid-upload. Same pattern
# and bounds as efm/0002.
#
# Retry-safe: step 2 is idempotent (it recomputes the groups from scratch).
# Reverse drops the constraint and the column; the rows are never touched.

import django.core.validators
from django.db import migrations, models
from django.db.models import Count, Min

import dj.apps.uploads.models


LOCK_TIMEOUT = "5s"
STATEMENT_TIMEOUT = "30s"


def bound_the_lock_wait(apps, schema_editor):
    # SET LOCAL is scoped to this migration's transaction. Guarded on vendor:
    # sqlite (the documented DBHOST-less local database) has no such SQL.
    if schema_editor.connection.vendor != "postgresql":
        return
    schema_editor.execute(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'")
    schema_editor.execute(
        f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}'")


def flag_legacy_shared_files(apps, schema_editor):
    GenericFile = apps.get_model('uploads', 'GenericFile')
    manager = GenericFile._base_manager.using(schema_editor.connection.alias)
    groups = (
        manager.order_by().values('file')
        .annotate(n=Count('pk'), keep=Min('pk'))
        .filter(n__gt=1)
    )
    for group in groups:
        manager.filter(file=group['file']).exclude(
            pk=group['keep'],
        ).update(legacy_shared_file=True)


class Migration(migrations.Migration):

    dependencies = [
        ('uploads', '0013_pendinguploadblobdeletion'),
    ]

    operations = [
        migrations.RunPython(bound_the_lock_wait, bound_the_lock_wait),
        migrations.AddField(
            model_name='genericfile',
            name='legacy_shared_file',
            field=models.BooleanField(
                db_default=False, default=False, editable=False),
        ),
        migrations.RunPython(
            flag_legacy_shared_files, migrations.RunPython.noop,
        ),
        migrations.AddConstraint(
            model_name='genericfile',
            constraint=models.UniqueConstraint(
                condition=models.Q(('legacy_shared_file', False)),
                fields=('file',),
                name='uploads_genericfile_file_uniq',
            ),
        ),
        migrations.AlterField(
            model_name='genericfile',
            name='file',
            field=models.FileField(upload_to=dj.apps.uploads.models.get_unreferenced_upload_path, validators=[django.core.validators.FileExtensionValidator(allowed_extensions=['avif', 'avifs', 'gif', 'heic', 'heics', 'heif', 'heifs', 'jpe', 'jpeg', 'jpg', 'm4a', 'm4b', 'm4v', 'mov', 'mp3', 'mp4', 'oga', 'ogg', 'opus', 'pdf', 'png', 'qt', 'wav', 'webm', 'webp'])]),
        ),
    ]

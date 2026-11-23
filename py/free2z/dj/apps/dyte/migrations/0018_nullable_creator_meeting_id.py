from django.db import migrations, models
from django.db.migrations.exceptions import IrreversibleError


def normalize_blank_meeting_ids(apps, schema_editor):
    """Turn the legacy missing-ID sentinel into an actual missing value.

    The unique constraint allowed at most one empty string. Keep that row and
    all its lifecycle/cleanup evidence intact; PostgreSQL permits any number
    of NULL values under a unique constraint.
    """
    CreatorMeeting = apps.get_model('dyte', 'CreatorMeeting')
    CreatorMeeting.objects.filter(meeting_id='').update(meeting_id=None)


def refuse_reverse_with_pending_rows(apps, schema_editor):
    """Do not collapse pending NULL rows into the old unique empty string."""
    CreatorMeeting = apps.get_model('dyte', 'CreatorMeeting')
    if CreatorMeeting.objects.filter(meeting_id__isnull=True).exists():
        raise IrreversibleError(
            "Cannot restore non-null unique meeting_id while pending rows exist"
        )


class Migration(migrations.Migration):
    dependencies = [
        ('dyte', '0017_merge_host_start_zero_probe'),
    ]

    operations = [
        migrations.AlterField(
            model_name='creatormeeting',
            name='meeting_id',
            field=models.CharField(
                blank=True, default=None, max_length=64, null=True, unique=True,
            ),
        ),
        # Reverse is allowed only when there are no pending NULL rows; it then
        # leaves the data untouched and can safely tighten the schema. With
        # even one pending row it fails before changing schema or data. Never
        # collapse multiple pending rows into '' or fabricate provider IDs.
        migrations.RunPython(
            normalize_blank_meeting_ids,
            refuse_reverse_with_pending_rows,
        ),
    ]

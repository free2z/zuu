from django.db import migrations, models


def backfill_recording_creator_id_snapshots(apps, schema_editor):
    RecordingDeliveryTarget = apps.get_model('dyte', 'RecordingDeliveryTarget')
    RecordingDelivery = apps.get_model('dyte', 'RecordingDelivery')

    RecordingDeliveryTarget.objects.filter(
        creator_id_snapshot__isnull=True,
        creator_id__isnull=False,
    ).update(creator_id_snapshot=models.F('creator_id'))
    RecordingDelivery.objects.filter(
        creator_id_snapshot__isnull=True,
        creator_id__isnull=False,
    ).update(creator_id_snapshot=models.F('creator_id'))


class Migration(migrations.Migration):

    dependencies = [
        ('dyte', '0012_recordingdeliverytarget'),
    ]

    operations = [
        migrations.AddField(
            model_name='recordingdeliverytarget',
            name='creator_id_snapshot',
            field=models.PositiveBigIntegerField(
                blank=True, editable=False, null=True,
            ),
        ),
        migrations.AddField(
            model_name='recordingdelivery',
            name='creator_id_snapshot',
            field=models.PositiveBigIntegerField(
                blank=True, editable=False, null=True,
            ),
        ),
        migrations.RunPython(
            code=backfill_recording_creator_id_snapshots,
            reverse_code=migrations.RunPython.noop,
        ),
    ]

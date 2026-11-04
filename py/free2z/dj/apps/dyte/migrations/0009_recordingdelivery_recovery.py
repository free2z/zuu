from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('dyte', '0008_webhookdelivery'),
        ('g12f', '0105_creator_kt_account_epoch'),
    ]

    operations = [
        migrations.AddField(
            model_name='recordingdelivery',
            name='creator',
            field=models.ForeignKey(
                blank=True,
                editable=False,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='dyte_recording_deliveries',
                to='g12f.creator',
            ),
        ),
        migrations.AddField(
            model_name='recordingdelivery',
            name='download_url',
            field=models.TextField(default='', editable=False),
        ),
        migrations.AddField(
            model_name='recordingdelivery',
            name='first_failure_at',
            field=models.DateTimeField(blank=True, editable=False, null=True),
        ),
        migrations.AddField(
            model_name='recordingdelivery',
            name='last_failure_status',
            field=models.PositiveSmallIntegerField(
                blank=True, editable=False, null=True,
            ),
        ),
        migrations.AddField(
            model_name='recordingdelivery',
            name='meeting_pk',
            field=models.PositiveBigIntegerField(
                blank=True, editable=False, null=True,
            ),
        ),
        migrations.AddField(
            model_name='recordingdelivery',
            name='next_retry_at',
            field=models.DateTimeField(blank=True, editable=False, null=True),
        ),
        migrations.AddField(
            model_name='recordingdelivery',
            name='recovery_started_at',
            field=models.DateTimeField(blank=True, editable=False, null=True),
        ),
        migrations.AddField(
            model_name='recordingdelivery',
            name='recovery_queued_at',
            field=models.DateTimeField(blank=True, editable=False, null=True),
        ),
        migrations.AddField(
            model_name='recordingdelivery',
            name='retry_count',
            field=models.PositiveIntegerField(default=0, editable=False),
        ),
        migrations.AddField(
            model_name='recordingdelivery',
            name='retry_exhausted_at',
            field=models.DateTimeField(blank=True, editable=False, null=True),
        ),
        migrations.AddField(
            model_name='recordingdelivery',
            name='stuck_alerted_at',
            field=models.DateTimeField(blank=True, editable=False, null=True),
        ),
    ]

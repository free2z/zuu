import django.db.models.deletion
from django.db import migrations, models
from django.utils import timezone


def backfill_recording_delivery_targets(apps, schema_editor):
    """Preserve each existing provider room's owner and access tier."""
    CreatorMeeting = apps.get_model('dyte', 'CreatorMeeting')
    RecordingDeliveryTarget = apps.get_model('dyte', 'RecordingDeliveryTarget')

    for meeting in CreatorMeeting.objects.exclude(
        meeting_id__startswith='pending:',
    ).iterator():
        RecordingDeliveryTarget.objects.get_or_create(
            provider_meeting_id=meeting.meeting_id,
            provider_session_id=meeting.provider_session_id,
            defaults={
                'creator_id': meeting.creator_id,
                'creator_meeting_id': meeting.pk,
                'meeting_type': meeting.meeting_type,
                'is_public': meeting.is_public,
            },
        )


class Migration(migrations.Migration):

    dependencies = [
        ('dyte', '0011_stream_lifecycle_schema'),
        ('g12f', '0105_creator_kt_account_epoch'),
    ]

    operations = [
        migrations.CreateModel(
            name='RecordingDeliveryTarget',
            fields=[
                (
                    'id',
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name='ID',
                    ),
                ),
                ('provider_meeting_id', models.CharField(max_length=64)),
                ('provider_session_id', models.UUIDField(blank=True, null=True)),
                (
                    'meeting_type',
                    models.CharField(
                        choices=[
                            ('private', 'Private'),
                            ('broadcast', 'Broadcast'),
                            ('ppv', 'Pay Per View'),
                            ('subscribers-only', 'Subscribers Only'),
                        ],
                        max_length=20,
                    ),
                ),
                ('is_public', models.BooleanField()),
                ('created_at', models.DateTimeField(default=timezone.now)),
                (
                    'creator',
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name='dyte_recording_targets',
                        to='g12f.creator',
                    ),
                ),
                (
                    'creator_meeting',
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name='recording_delivery_targets',
                        to='dyte.creatormeeting',
                    ),
                ),
            ],
            options={
                'constraints': [
                    models.UniqueConstraint(
                        fields=('provider_meeting_id', 'provider_session_id'),
                        name='dyte_recording_target_room_session_uniq',
                    ),
                    models.UniqueConstraint(
                        condition=models.Q(('provider_session_id__isnull', True)),
                        fields=('provider_meeting_id',),
                        name='dyte_recording_target_legacy_room_uniq',
                    ),
                ],
            },
        ),
        migrations.RunPython(
            code=backfill_recording_delivery_targets,
            reverse_code=migrations.RunPython.noop,
        ),
    ]

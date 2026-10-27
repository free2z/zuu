import django.db.models.deletion
from django.db import migrations, models
from django.utils import timezone


class Migration(migrations.Migration):

    dependencies = [
        ('dyte', '0010_creatormeeting_host_session'),
    ]

    operations = [
        migrations.AddField(
            model_name='creatormeeting',
            name='lifecycle_state',
            field=models.CharField(
                choices=[
                    ('offline', 'Offline'),
                    ('starting', 'Starting'),
                    ('live', 'Live'),
                    ('ending', 'Ending'),
                    ('create_unknown', 'Provider create outcome unknown'),
                ],
                db_default='offline',
                db_index=True,
                default='offline',
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name='creatormeeting',
            name='provider_session_id',
            field=models.UUIDField(blank=True, editable=False, null=True),
        ),
        migrations.AddField(
            model_name='creatormeeting',
            name='start_id',
            field=models.UUIDField(blank=True, editable=False, null=True),
        ),
        migrations.AddField(
            model_name='creatormeeting',
            name='handshake_managed',
            field=models.BooleanField(
                db_default=False, default=False, editable=False,
            ),
        ),
        migrations.AddField(
            model_name='creatormeeting',
            name='provider_room_cleanup_claimed',
            field=models.BooleanField(
                db_default=False, default=False, editable=False,
            ),
        ),
        migrations.AddField(
            model_name='creatormeeting',
            name='provider_session_started_at',
            field=models.DateTimeField(blank=True, editable=False, null=True),
        ),
        migrations.AddField(
            model_name='creatormeeting',
            name='private_lease_id',
            field=models.UUIDField(blank=True, editable=False, null=True),
        ),
        migrations.AddField(
            model_name='creatormeeting',
            name='private_lease_created_at',
            field=models.DateTimeField(blank=True, editable=False, null=True),
        ),
        migrations.AddField(
            model_name='creatormeeting',
            name='private_lease_adopted_at',
            field=models.DateTimeField(blank=True, editable=False, null=True),
        ),
        migrations.AddField(
            model_name='creatormeeting',
            name='create_unknown_title',
            field=models.CharField(
                blank=True, editable=False, max_length=255, null=True,
            ),
        ),
        migrations.AddField(
            model_name='creatormeeting',
            name='create_unknown_attempts',
            field=models.PositiveSmallIntegerField(
                db_default=0, default=0, editable=False,
            ),
        ),
        migrations.AddField(
            model_name='creatormeeting',
            name='create_unknown_next_attempt_at',
            field=models.DateTimeField(
                blank=True, db_index=True, editable=False, null=True,
            ),
        ),
        migrations.CreateModel(
            name='ProviderRoomCleanup',
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
                ('provider_meeting_id', models.CharField(max_length=64, unique=True)),
                ('provider_session_id', models.UUIDField(blank=True, null=True)),
                ('start_id', models.UUIDField(blank=True, editable=False, null=True)),
                (
                    'status',
                    models.CharField(
                        choices=[
                            ('pending', 'Pending'),
                            ('in_progress', 'In progress'),
                            ('complete', 'Complete'),
                        ],
                        db_index=True,
                        default='pending',
                        max_length=16,
                    ),
                ),
                ('attempts', models.PositiveIntegerField(default=0)),
                (
                    'next_attempt_at',
                    models.DateTimeField(
                        blank=True, db_index=True, default=timezone.now, null=True,
                    ),
                ),
                ('lease_until', models.DateTimeField(blank=True, null=True)),
                ('lease_token', models.UUIDField(blank=True, editable=False, null=True)),
                ('last_error', models.CharField(blank=True, default='', max_length=255)),
                ('completed_at', models.DateTimeField(blank=True, null=True)),
                ('created_at', models.DateTimeField(default=timezone.now)),
                (
                    'creator',
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name='dyte_provider_room_cleanups',
                        to='g12f.creator',
                    ),
                ),
                (
                    'creator_meeting',
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name='provider_room_cleanups',
                        to='dyte.creatormeeting',
                    ),
                ),
                (
                    'meeting_type',
                    models.CharField(
                        blank=True,
                        choices=[
                            ('private', 'Private'),
                            ('broadcast', 'Broadcast'),
                            ('ppv', 'Pay Per View'),
                            ('subscribers-only', 'Subscribers Only'),
                        ],
                        max_length=20,
                        null=True,
                    ),
                ),
                (
                    'price_per_minute',
                    models.DecimalField(
                        blank=True, decimal_places=2, max_digits=6, null=True,
                    ),
                ),
            ],
            options={
                'indexes': [
                    models.Index(
                        fields=['status', 'next_attempt_at'],
                        name='dyte_cleanup_retry_idx',
                    ),
                ],
            },
        ),
    ]

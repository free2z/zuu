import uuid
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='PublicationExportJob',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('status', models.CharField(choices=[('queued', 'Queued'), ('running', 'Running'), ('ready', 'Ready'), ('failed', 'Failed'), ('expired', 'Expired')], db_index=True, default='queued', max_length=16)),
                ('complete', models.BooleanField(default=False, help_text='Whether the export completed without missing assets or unsupported directives.')),
                ('warnings', models.JSONField(blank=True, default=list, help_text='Explicit list of user-safe warnings encountered during export generation.')),
                ('error_message', models.TextField(blank=True, help_text='User-safe failure details if the export job failed.')),
                ('file_path', models.CharField(blank=True, help_text='Internal storage key in private export storage.', max_length=512)),
                ('file_name', models.CharField(blank=True, help_text='Stable filename for Content-Disposition attachment download.', max_length=255)),
                ('file_size', models.BigIntegerField(blank=True, help_text='Size of completed archive in bytes.', null=True)),
                ('checksum_sha256', models.CharField(blank=True, help_text='SHA-256 hex digest of the completed archive ZIP file.', max_length=64)),
                ('article_count', models.PositiveIntegerField(default=0, help_text='Number of articles included in the export.')),
                ('asset_count', models.PositiveIntegerField(default=0, help_text='Number of distinct media assets bundled in the export.')),
                ('created_at', models.DateTimeField(auto_now_add=True, db_index=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('started_at', models.DateTimeField(blank=True, null=True)),
                ('completed_at', models.DateTimeField(blank=True, null=True)),
                ('expires_at', models.DateTimeField(blank=True, db_index=True, null=True)),
                ('creator', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='publication_export_jobs', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'verbose_name': 'Publication Export Job',
                'verbose_name_plural': 'Publication Export Jobs',
                'ordering': ['-created_at'],
                'indexes': [
                    models.Index(fields=['creator', 'status', '-created_at'], name='exports_pub_creator_stat_idx'),
                    models.Index(fields=['status', 'expires_at'], name='exports_pub_stat_exp_idx'),
                ],
                'constraints': [
                    models.UniqueConstraint(
                        condition=models.Q(status__in=['queued', 'running']),
                        fields=['creator'],
                        name='unique_active_publication_export_job',
                    ),
                ],
            },
        ),
    ]

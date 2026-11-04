from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('dyte', '0014_creatormeeting_host_start_claim')]  # noqa: RUF012

    operations = [  # noqa: RUF012
        migrations.AddField(
            model_name='creatormeeting',
            name='host_start_claim_at',
            field=models.DateTimeField(blank=True, editable=False, null=True),
        ),
        migrations.AlterField(
            model_name='providerroomcleanup',
            name='provider_meeting_id',
            field=models.CharField(blank=True, max_length=64, null=True, unique=True),
        ),
        migrations.AlterField(
            model_name='providerroomcleanup',
            name='status',
            field=models.CharField(
                choices=[
                    ('pending', 'Pending'),
                    ('in_progress', 'In progress'),
                    ('complete', 'Complete'),
                    ('manual_review', 'Manual review required'),
                ], db_index=True, default='pending', max_length=16,
            ),
        ),
    ]

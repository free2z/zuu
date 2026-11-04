from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('dyte', '0013_recording_creator_id_snapshot')]

    operations = [
        migrations.AddField(
            model_name='creatormeeting',
            name='zero_probe_since',
            field=models.DateTimeField(
                blank=True,
                help_text=(
                    'First consecutive provider zero; live-state clearing '
                    'waits a bounded grace so a transient zero cannot hide '
                    'an active room.'
                ),
                null=True,
            ),
        ),
    ]

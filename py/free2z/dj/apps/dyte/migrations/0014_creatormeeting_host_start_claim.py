from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('dyte', '0013_recording_creator_id_snapshot')]

    operations = [
        migrations.AddField(
            model_name='creatormeeting',
            name='host_start_claim',
            field=models.UUIDField(blank=True, editable=False, null=True),
        ),
    ]

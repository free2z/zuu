from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ('dyte', '0018_nullable_creator_meeting_id'),
    ]

    operations = [
        migrations.AddField(
            model_name='creatormeeting', name='host_peer_id',
            field=models.UUIDField(null=True, blank=True, editable=False),
        ),
        migrations.AddField(
            model_name='creatormeeting', name='host_joined_at',
            field=models.DateTimeField(null=True, blank=True, editable=False),
        ),
        migrations.AddField(
            model_name='creatormeeting', name='host_left_at',
            field=models.DateTimeField(null=True, blank=True, editable=False),
        ),
    ]

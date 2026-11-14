from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ('events', '0016_alter_event_type'),
    ]

    operations = [
        migrations.AddField(
            model_name='event',
            name='provider_session_id',
            field=models.UUIDField(blank=True, editable=False, null=True),
        ),
    ]

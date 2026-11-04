"""Bind durable lease phase evidence to the token and attempt that wrote it."""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('jobs', '0006_joblease_body_phase'),
    ]

    operations = [
        migrations.AddField(
            model_name='joblease',
            name='phase_token',
            field=models.UUIDField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='joblease',
            name='phase_attempt',
            field=models.IntegerField(blank=True, null=True),
        ),
    ]

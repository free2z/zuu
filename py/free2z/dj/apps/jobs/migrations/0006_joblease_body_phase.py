"""Persist the body-entry fence on each job lease.

Existing lease rows are conservatively treated as unknown. Only a new lease
acquisition explicitly writes ``before_body``; middleware advances it to
``body_started`` before entering user task code.
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('jobs', '0005_operator_queue_controls'),
    ]

    operations = [
        migrations.AddField(
            model_name='joblease',
            name='phase',
            field=models.CharField(
                db_default='unknown', default='unknown',
                max_length=24),
        ),
    ]

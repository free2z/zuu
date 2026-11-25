"""Additive only: legacy contexts cannot claim proof of the current factor.

No credential mutation during migrate or a mixed-fleet deployment. Deploy
all enforcement pods before the separately approved bounded token retirement.
"""
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('identity', '0003_backfill_passwordless_identity_fallbacks')]
    operations = [migrations.AddField(
        model_name='authcontext', name='otp_binding',
        field=models.CharField(max_length=64, default='', db_default='', blank=True),
    )]

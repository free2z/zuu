"""Accept a content-free per-call ``features`` object in gateway claim metadata.

Function body only, same signature, same grants: ``gateway_metadata_valid``
is replaced in place to also accept an OPTIONAL ``features`` object on the
request metadata (rationale and member table in ``_call_features``). Every
existing rule is unchanged. Reversal restores the 0004 body verbatim; no data
is touched either way.
"""
from django.db import migrations

from ._call_features import REVERSE_SQL, SQL


class Migration(migrations.Migration):
    dependencies = [
        ('ledger', '0005_call_recovery'),
    ]

    operations = [
        migrations.RunSQL(SQL, reverse_sql=REVERSE_SQL),
    ]

"""Existing-call recovery survives a grant-generation change (#2295).

Function bodies only, same signatures, same grants: ``call_read``,
``call_claim`` and ``call_complete`` are replaced in place and a private
``call_owner`` helper is added (never granted to the gateway role). The
rationale and the three predicates are documented in ``_call_recovery``.
Reversal restores the 0004 bodies verbatim; no data is touched either way.
"""
from django.db import migrations

from ._call_recovery import REVERSE_SQL, SQL


class Migration(migrations.Migration):
    dependencies = [
        ('ledger', '0004_gateway_calls'),
    ]

    operations = [
        migrations.RunSQL(SQL, reverse_sql=REVERSE_SQL),
    ]

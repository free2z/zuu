"""Allow a closed set of sampling field names, never values, in features.

Deploy BEFORE updated gateways admit sampling traffic while ledger_features_meta
is true, including deployments where that flag was already enabled under 0006.
Until this validator is live, hold sampling traffic or disable that flag on every
updated gateway. No deployment flag is changed by this migration.

Forward validation still admits old eight-member feature objects and omitted
features. Reverse restores the 0006 validator, so hold sampling traffic or disable
the flag before reversing: sampling metadata would again fail call claims.
Stored call records are not rewritten in either direction.
"""
from django.db import migrations

from ._call_features import SQL as previous

SQL = previous.replace("       ELSE RETURN false;", """       ELSIF fk='sampling' THEN
         IF jsonb_typeof(fv)<>'array' THEN RETURN false;END IF;
         IF jsonb_array_length(fv)>11 OR EXISTS(SELECT 1 FROM jsonb_array_elements(fv) x
           WHERE jsonb_typeof(x)<>'string' OR (x#>>'{}') NOT IN
           ('temperature','top_p','top_k','stop','seed','logprobs','top_logprobs','frequency_penalty','presence_penalty','n','logit_bias')) THEN RETURN false;END IF;
       ELSE RETURN false;""")


class Migration(migrations.Migration):
    dependencies = [("ledger", "0006_call_features")]
    operations = [migrations.RunSQL(SQL, previous)]

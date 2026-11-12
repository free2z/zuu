"""Queue opt-in notices under the same creator lock as gateway admission.

The pending flag coalesces refusals until dispatch. A dispatch attempt starts a
24-hour cooldown, including failed or suppressed attempts. Preference changes
clear pending work; their generation fences a previously claimed delivery.
Install before gateways relying on the pre-hold completion path are deployed.
"""
from django.db import migrations

from ._call_recovery import SQL as CALL_SQL
from ._l2_lifecycle import SQL as LIFECYCLE_SQL


def definition(source, name):
    start = source.index('CREATE ' + name)
    end = source.index('END $$;', start) + len('END $$;')
    return source[start:end]


hold = definition(LIFECYCLE_SQL, 'FUNCTION ledger.hold_internal').replace(
    'CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION', 1,
)
old_refusal = "IF NOT FOUND THEN status:='insufficient_balance';RETURN NEXT;RETURN;END IF;"
assert hold.count(old_refusal) == 1
hold = hold.replace(old_refusal, """IF NOT FOUND THEN
        IF p_app_id <> '00000000-0000-4000-8000-000000000001'::uuid THEN
            PERFORM ledger.queue_low_balance_notice(cr.id);
        END IF;
        status:='insufficient_balance';RETURN NEXT;RETURN;END IF;""")

complete = definition(CALL_SQL, 'OR REPLACE FUNCTION ledger.call_complete').replace(
    'ledger.call_complete(', 'ledger.call_complete_economic_v0(', 1,
)
anchor = "   status:='recorded';"
assert complete.count(anchor) == 1
complete = complete.replace(anchor, """   status:='recorded';
   IF p_no_hold AND p_app <> '00000000-0000-4000-8000-000000000001'::uuid
      AND p_completion->'error'->>'code'='insufficient_balance'
      AND EXISTS(SELECT 1 FROM ledger.gateway_identity(p_subject,p_app,p_aep,p_agen)) THEN
     PERFORM ledger.queue_low_balance_notice(owner);
   END IF;""")

SQL = r"""
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='10s';
CREATE FUNCTION ledger.queue_low_balance_notice(p_creator bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  -- The caller holds the creator lock, before any ledger account lock.
  -- Optional notice storage must not change the financial refusal.
  BEGIN
    UPDATE public.g12f_creator SET low_balance_notice_pending=true, low_balance_notice_pending_epoch=kt_account_epoch
    WHERE id=p_creator AND is_active AND low_balance_notice_enabled
      AND (NOT low_balance_notice_pending OR low_balance_notice_pending_epoch IS DISTINCT FROM kt_account_epoch)
      AND (low_balance_notice_attempted_at IS NULL OR
           low_balance_notice_attempted_at <= now()-interval '24 hours');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'low balance notice enqueue failed: %', SQLSTATE;
  END;
END $$;
REVOKE ALL ON FUNCTION ledger.queue_low_balance_notice(bigint) FROM PUBLIC;
""" + hold + '\n' + complete

REVERSE = """
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s';
LOCK TABLE public.g12f_creator IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.g12f_creator WHERE low_balance_notice_enabled
      OR low_balance_notice_generation <> 0 OR low_balance_notice_pending OR low_balance_notice_pending_epoch IS NOT NULL
      OR low_balance_notice_attempted_at IS NOT NULL OR low_balance_notice_locale <> 'en') THEN
    RAISE EXCEPTION 'low balance preference state exists; roll forward';
  END IF;
END $$;
""" + (
    definition(LIFECYCLE_SQL, 'FUNCTION ledger.hold_internal').replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION', 1)
    + '\n' + definition(CALL_SQL, 'OR REPLACE FUNCTION ledger.call_complete').replace(
        'ledger.call_complete(', 'ledger.call_complete_economic_v0(', 1)
    + '\nDROP FUNCTION ledger.queue_low_balance_notice(bigint);'
)


class Migration(migrations.Migration):
    dependencies = [
        ('g12f', '0123_low_balance_notice'),
        ('ledger', '0007_sampling_features'),
        ('economy', '0003_live_zec_note_funding'),
    ]
    operations = [migrations.RunSQL(SQL, REVERSE)]

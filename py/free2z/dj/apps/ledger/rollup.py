"""Two-phase AI split settlement (ledger-v2 §8).

Each batch owns only the rollup/queue rows. Developer credit runs in a
separate transaction with creator-first locking. A crash between phases
leaves a durable pending credit; neither a watermark nor a user loop inside
one transaction can lose late commits or invert the creator lock order.
"""
from collections import defaultdict

from django.db import connection, transaction

from . import api
from dj.apps.economy.epoch import pin_supported_policy


def set_worker_timeouts(cursor):
    # A wall-clock loop cannot interrupt a blocked SQL call. Each worker
    # transaction bounds both lock acquisition and statement execution.
    cursor.execute("SET LOCAL lock_timeout = '250ms'")
    cursor.execute("SET LOCAL statement_timeout = '2s'")


def contention_error(exc):
    cause = exc.__cause__
    return getattr(cause, 'sqlstate', getattr(cause, 'pgcode', None)) in {'55P03', '57014'}


@transaction.atomic
def consume_split_batch(limit=10000):
    """Drain one queue batch atomically; SQLSTATE 55P03 means another tick won."""
    policy_version = pin_supported_policy()
    with connection.cursor() as cursor:
        set_worker_timeouts(cursor)
        cursor.execute("SELECT name FROM ledger_rollup_state WHERE name='ai_rollup' FOR UPDATE NOWAIT")
        if cursor.fetchone() is None:
            raise RuntimeError('ledger rollup seed missing')
        if policy_version == 1:
            cursor.execute('SELECT 1 FROM ledger_ai_split_queue LIMIT 1')
            if cursor.fetchone():
                raise RuntimeError('legacy SDK split queue requires explicit disposition')
        cursor.execute('DELETE FROM ledger_ai_split_queue WHERE usage_id IN '
                       '(SELECT usage_id FROM ledger_ai_split_queue ORDER BY usage_id '
                       'LIMIT %s FOR UPDATE SKIP LOCKED) '
                       'RETURNING usage_id,developer_creator_id,provider_m2z,developer_m2z,platform_m2z', [limit])
        rows = cursor.fetchall()
        if not rows:
            return 0
        provider = sum(row[2] for row in rows)
        platform = sum(row[4] + (row[3] if row[1] is None else 0) for row in rows)
        developers = defaultdict(int)
        for _, developer, _, markup, _ in rows:
            if developer is not None:
                developers[developer] += markup
        clearing = api.system_account_id('sys:ai_clearing')
        batch = f'rollup:{min(row[0] for row in rows)}:{max(row[0] for row in rows)}'
        transfers = []
        if provider > 0:
            transfers.append((clearing, api.system_account_id('sys:provider_cost'), provider, 'provider'))
        if platform > 0:
            transfers.append((clearing, api.system_account_id('sys:platform_revenue'), platform, 'platform'))
        elif platform < 0:
            transfers.append((api.system_account_id('sys:platform_revenue'), clearing, -platform, 'platform'))
        for source, dest, amount, suffix in transfers:
            result = api.post_transfer(source, dest, amount, 'ai_rollup', 'batch', batch, f'{batch}:{suffix}')
            if result.status != 'posted':
                raise RuntimeError(f'ledger rollup post refused: {result.status}')
        pending = [(developer, markup) for developer, markup in sorted(developers.items()) if markup > 0]
        if pending:
            # One bounded statement, not up to 10,000 sequential round trips
            # inside a transaction that must drain before pooler shutdown.
            cursor.execute('INSERT INTO ledger_dev_markup_pending(developer_creator_id,amount_m2z) '
                           'SELECT developer,amount FROM unnest(%s::bigint[],%s::bigint[]) '
                           'AS pending(developer,amount) ORDER BY developer '
                           'ON CONFLICT(developer_creator_id) DO UPDATE '
                           'SET amount_m2z=ledger_dev_markup_pending.amount_m2z+EXCLUDED.amount_m2z',
                           [[item[0] for item in pending], [item[1] for item in pending]])
        cursor.execute("UPDATE ledger_rollup_state SET last_run_at=now(),rows_consumed=rows_consumed+%s WHERE name='ai_rollup'", [len(rows)])
        return len(rows)


@transaction.atomic
def credit_developer(developer_id):
    """Claim a durable pending row after the creator/account locks, exactly once."""
    policy_version = pin_supported_policy()
    with connection.cursor() as cursor:
        set_worker_timeouts(cursor)
    if policy_version == 1:
        from dj.apps.ledger.models import LedgerDevMarkupPending
        if LedgerDevMarkupPending.objects.filter(developer_creator_id=developer_id).exists():
            raise RuntimeError('legacy SDK developer liability requires explicit disposition')
    creator = api.lock_creator(developer_id)
    if creator is None:
        raise RuntimeError('pending developer no longer exists')
    api.lock_account(creator.id, creator.balance)
    with connection.cursor() as cursor:
        cursor.execute('DELETE FROM ledger_dev_markup_pending WHERE developer_creator_id=%s RETURNING amount_m2z', [developer_id])
        row = cursor.fetchone()
        if row is None:
            return 0
        amount = row[0]
        api.credit_with_repay(api.system_account_id('sys:ai_clearing'), developer_id,
                              amount, 'ai_rollup', 'dev', str(developer_id))
        return amount
